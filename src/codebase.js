/**
 * Codebase context: what the diff calls, and what calls the diff.
 *
 * A reviewer that only sees a diff cannot answer the two questions that decide
 * most real defects — what does this function I am calling actually return, and
 * who else depends on the thing I just changed. So before reviewing we pull:
 *
 *   definitions  for symbols the changed lines *use* but do not define
 *   references   for symbols the changed lines *define or modify*, found
 *                elsewhere in the repository (the callers a change can break)
 *   conventions  the project's own agent/contributor instructions, if any
 *
 * ponytail: identifier extraction is regex, not a parser. It over-collects on
 * some languages and misses clever indirection. That is acceptable — this feeds
 * a model, not a compiler. Swap in tree-sitter if precision starts to matter.
 */
import { matchAny, estimateTokens } from './context.js';

const IDENT = '[A-Za-z_$][A-Za-z0-9_$]*';

/** Definition-ish forms across the languages people actually open PRs in. */
const DEFINITION_PATTERNS = [
  new RegExp(
    `\\b(?:function|class|def|fn|func|struct|interface|type|enum|trait|impl|module|record)\\s+(${IDENT})`,
    'g',
  ),
  new RegExp(
    `\\b(?:const|let|var|val|static|public|private|protected|export)\\s+(?:async\\s+)?(${IDENT})\\s*[=:(]`,
    'g',
  ),
  new RegExp(`^\\s*(?:async\\s+)?(${IDENT})\\s*\\([^)]*\\)\\s*[{:]`, 'gm'),
  new RegExp(`^\\s*(${IDENT})\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\()`, 'gm'),
];

const CALL_PATTERN = new RegExp(`\\b(${IDENT})\\s*\\(`, 'g');
const MEMBER_PATTERN = new RegExp(`\\.(${IDENT})\\s*\\(`, 'g');

/** Keywords and names too common to be worth searching for. */
const STOPWORDS = new Set(
  `if else for while return switch case break continue try catch finally throw new delete typeof instanceof void
   await async function class const let var def fn func struct interface type enum impl trait pub use mod match
   in is not and or none true false null nil undefined self this super print len str int float bool list dict set
   map filter reduce push pop get set add remove has key value data result value item index count size length
   error err log info warn debug test expect assert it describe require import export from default do end then
   string number object array boolean promise callback options config params args kwargs value2 foo bar baz
   printf sprintf println echo range make append copy panic recover defer go select chan var1`
    .split(/\s+/)
    .filter(Boolean),
);

const TEXT_EXTENSIONS =
  /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|py|pyi|rb|go|rs|java|kt|kts|scala|swift|c|h|cc|cpp|hpp|cs|php|ex|exs|erl|clj|hs|ml|sh|bash|zsh|sql|graphql|proto|tf|vue|svelte|astro)$/i;

/**
 * Repositories increasingly carry their rules in agent instruction files, and a
 * change that breaks a documented rule is a real finding even when the code
 * compiles. These are read at the root, alongside every changed file, and
 * followed through their imports.
 */
const ROOT_INSTRUCTION_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'CONVENTIONS.md',
  'CONTRIBUTING.md',
  'STYLEGUIDE.md',
  '.cursorrules',
  '.windsurfrules',
  '.rules',
  '.github/copilot-instructions.md',
  '.github/CONTRIBUTING.md',
  '.github/AGENTS.md',
  'docs/CONTRIBUTING.md',
  'docs/ARCHITECTURE.md',
  'ARCHITECTURE.md',
];

/** Read from every directory on the path to a changed file, nearest last. */
const SCOPED_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules'];

/** Claude Code's `@path/to/file.md` import, and ordinary markdown links. */
const IMPORT_PATTERN = /(?:^|[\s(])@([\w./-]+\.(?:md|mdc|txt))\b/g;
const MARKDOWN_LINK_PATTERN = /\[[^\]]*\]\(\s*(?!https?:)([\w./-]+\.(?:md|mdc))\s*\)/g;

const INSTRUCTION_DOC_BUDGET = 60000;
const INSTRUCTION_DOC_LINES = 300;

const isInteresting = (name) => name.length >= 3 && !STOPWORDS.has(name) && !STOPWORDS.has(name.toLowerCase());

function matchAll(text, pattern) {
  const out = [];
  pattern.lastIndex = 0;
  for (const m of text.matchAll(pattern)) out.push(m[1]);
  return out;
}

/**
 * Split the identifiers touched by the diff into the ones this change *defines*
 * and the ones it merely *uses*.
 * @param {import('./diff.js').DiffFile[]} files
 */
export function extractSymbols(files) {
  const defined = new Set();
  const used = new Set();

  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type === ' ') continue;
        for (const pattern of DEFINITION_PATTERNS) {
          for (const name of matchAll(line.text, pattern)) if (isInteresting(name)) defined.add(name);
        }
        for (const name of matchAll(line.text, CALL_PATTERN)) if (isInteresting(name)) used.add(name);
        for (const name of matchAll(line.text, MEMBER_PATTERN)) if (isInteresting(name)) used.add(name);
      }
    }
  }

  // A symbol the change defines is not something the change needs explained.
  for (const name of defined) used.delete(name);
  return { defined, used };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function looksLikeDefinition(line, symbol) {
  const s = escapeRe(symbol);
  return new RegExp(
    `\\b(?:function|class|def|fn|func|struct|interface|type|enum|trait|impl|const|let|var|val|static|public|private|protected|export|record|module)\\s+(?:async\\s+)?${s}\\b|^\\s*(?:async\\s+)?${s}\\s*\\(|^\\s*${s}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\()`,
  ).test(line);
}

/**
 * One pass over the repository collecting definition and reference hits for a
 * set of symbols. Single combined regex per line, so this stays linear in the
 * size of the repository rather than in symbols × lines.
 */
export async function scanRepository(repo, { wanted, skipPaths, ignore, maxFiles = 4000, maxFileBytes = 400000 }) {
  const symbols = [...wanted].slice(0, 120);
  if (!symbols.length) return new Map();

  const combined = new RegExp(`\\b(${symbols.map(escapeRe).join('|')})\\b`);
  const skip = new Set(skipPaths);
  /** @type {Map<string, {defs: {path: string, line: number}[], refs: {path: string, line: number}[]}>} */
  const hits = new Map(symbols.map((s) => [s, { defs: [], refs: [] }]));

  const all = await repo.list();
  const candidates = all
    .filter((p) => !skip.has(p) && TEXT_EXTENSIONS.test(p) && !matchAny(p, ignore))
    .slice(0, maxFiles);

  for (const path of candidates) {
    const content = await repo.read(path);
    if (!content || content.length > maxFileBytes || !combined.test(content)) continue;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 400 || !combined.test(line)) continue;
      for (const symbol of symbols) {
        if (!new RegExp(`\\b${escapeRe(symbol)}\\b`).test(line)) continue;
        const bucket = hits.get(symbol);
        const where = looksLikeDefinition(line, symbol) ? bucket.defs : bucket.refs;
        if (where.length < 12) where.push({ path, line: i + 1 });
      }
    }
  }
  return hits;
}

const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** Resolve `a/b/../c.md` and `./c.md` against a directory, without node:path. */
function resolveDocPath(from, target) {
  const base = target.startsWith('/') ? [] : dirname(from).split('/').filter(Boolean);
  const out = [...base];
  for (const part of target.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/**
 * Every instruction document that governs this change: repository-wide rules,
 * rules scoped to the directories being touched, `.cursor/rules/*`, and whatever
 * those documents import. Imports are followed breadth-first with a depth cap,
 * because an AGENTS.md that pulls in six standards documents is normal now.
 */
export async function collectInstructionDocs(
  repo,
  changedPaths,
  { maxDepth = 2, budget = INSTRUCTION_DOC_BUDGET } = {},
) {
  const all = new Set(await repo.list());
  const queue = [];
  const seen = new Set();

  const enqueue = (path, depth, why) => {
    if (!path || seen.has(path) || !all.has(path)) return;
    seen.add(path);
    queue.push({ path, depth, why });
  };

  for (const name of ROOT_INSTRUCTION_FILES) enqueue(name, 0, 'repository rules');
  for (const path of [...all].filter((p) => p.startsWith('.cursor/rules/') && /\.mdc?$/.test(p)).slice(0, 20)) {
    enqueue(path, 0, 'cursor rules');
  }
  // Directory-scoped rules for the files actually being changed.
  for (const changed of changedPaths) {
    const segments = dirname(changed).split('/').filter(Boolean);
    for (let i = segments.length; i > 0; i--) {
      const dir = segments.slice(0, i).join('/');
      for (const name of SCOPED_INSTRUCTION_FILES) enqueue(`${dir}/${name}`, 0, `rules for ${dir}/`);
    }
  }

  const docs = [];
  let spent = 0;
  while (queue.length) {
    const { path, depth, why } = queue.shift();
    const content = await repo.read(path);
    if (!content) continue;

    const trimmed = content.split('\n').slice(0, INSTRUCTION_DOC_LINES).join('\n');
    if (spent + trimmed.length > budget) continue;
    spent += trimmed.length;
    docs.push({ path, why, content: trimmed });

    if (depth >= maxDepth) continue;
    for (const pattern of [IMPORT_PATTERN, MARKDOWN_LINK_PATTERN]) {
      pattern.lastIndex = 0;
      for (const match of content.matchAll(pattern)) {
        enqueue(resolveDocPath(path, match[1]), depth + 1, `imported by ${path}`);
      }
    }
  }
  return docs;
}

function snippet(lines, at, before, after) {
  const start = Math.max(1, at - before);
  const end = Math.min(lines.length, at + after);
  return Array.from({ length: end - start + 1 }, (_, i) => {
    const n = start + i;
    return `${String(n).padStart(6)} ${n === at ? '>' : ' '} ${lines[n - 1]}`;
  }).join('\n');
}

/**
 * Assemble the codebase context block, newest-value-first and bounded by tokens.
 * @returns {Promise<{text: string, tokens: number, stats: object}>}
 */
export async function buildCodebaseContext(repo, files, config) {
  if (!repo || config.maxRelatedTokens <= 0) {
    return { text: '', tokens: 0, stats: { definitions: 0, references: 0, conventions: 0 } };
  }

  const changedPaths = files.map((f) => f.path);
  const { defined, used } = extractSymbols(files);
  const hits = await scanRepository(repo, {
    wanted: new Set([...used, ...defined]),
    skipPaths: changedPaths,
    ignore: config.ignore,
  });

  const budget = config.maxRelatedTokens;
  let spent = 0;
  const sections = [];
  const stats = { definitions: 0, references: 0, conventions: 0 };
  const fileCache = new Map();
  const readLines = async (p) => {
    if (!fileCache.has(p)) fileCache.set(p, (await repo.read(p))?.split('\n') || []);
    return fileCache.get(p);
  };
  const fits = (text) => spent + estimateTokens(text) <= budget;

  // 1. The project's own rules. Cheap, and they change what counts as a defect.
  const docs = await collectInstructionDocs(repo, changedPaths);
  if (docs.length) {
    const blocks = docs.map((d) => `--- ${d.path} (${d.why}) ---\n${d.content}`);
    const text =
      `## Project rules and conventions\n\n` +
      `These are this repository's own instructions to contributors and coding agents. ` +
      `Treat them as binding: code that violates a rule stated here is a finding, ` +
      `with category "convention", even when it would otherwise be correct. ` +
      `Where a rule contradicts your general preferences, the rule wins.\n\n${blocks.join('\n\n')}`;
    if (fits(text)) {
      sections.push(text);
      spent += estimateTokens(text);
      stats.conventions = docs.length;
    }
  }

  // 2. Definitions of what the changed code calls.
  const definitionBlocks = [];
  for (const symbol of used) {
    const found = hits.get(symbol)?.defs ?? [];
    for (const hit of found.slice(0, 2)) {
      const lines = await readLines(hit.path);
      if (!lines.length) continue;
      const block = `### ${symbol} — defined at ${hit.path}:${hit.line}\n${snippet(lines, hit.line, 1, 14)}`;
      if (!fits(block)) break;
      definitionBlocks.push(block);
      spent += estimateTokens(block);
      stats.definitions++;
    }
  }
  if (definitionBlocks.length) {
    sections.push(`## Definitions of symbols the changed code calls\n\n${definitionBlocks.join('\n\n')}`);
  }

  // 3. Callers of what the change modifies — the blast radius.
  const referenceBlocks = [];
  for (const symbol of defined) {
    const found = hits.get(symbol)?.refs ?? [];
    if (!found.length) continue;
    const rows = [];
    for (const hit of found.slice(0, 8)) {
      const lines = await readLines(hit.path);
      if (!lines.length) continue;
      rows.push(`${hit.path}:${hit.line}\n${snippet(lines, hit.line, 1, 2)}`);
    }
    if (!rows.length) continue;
    const block = `### ${symbol} — used in ${found.length} place${found.length === 1 ? '' : 's'} outside this change\n${rows.join('\n')}`;
    if (!fits(block)) break;
    referenceBlocks.push(block);
    spent += estimateTokens(block);
    stats.references++;
  }
  if (referenceBlocks.length) {
    sections.push(
      `## Existing callers of symbols this change modifies\n` +
        `Check each one against the new behaviour — these are what a signature or contract change breaks.\n\n${referenceBlocks.join(
          '\n\n',
        )}`,
    );
  }

  const text = sections.join('\n\n');
  return { text, tokens: estimateTokens(text), stats };
}
