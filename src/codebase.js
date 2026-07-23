/**
 * Codebase primitives: what the diff calls, what calls the diff, and the rules
 * that govern it.
 *
 * The agentic investigation (agent.js) drives these to answer the two questions
 * a diff cannot — what does a called function actually return, and who depends
 * on what changed — via `extractSymbols` (which identifiers the change defines
 * vs uses) and `scanRepository` (where they are defined and referenced). The
 * project's own rules are gathered by `collectInstructionDocs` and rendered by
 * `renderConventions`; they reach the reviewer on every run.
 *
 * ponytail: identifier extraction is regex, not a parser. It over-collects on
 * some languages and misses clever indirection. That is acceptable — this feeds
 * a model, not a compiler. Swap in tree-sitter if precision starts to matter.
 */
import { matchAny } from './context.js';

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

/**
 * Render collected instruction documents into the "project rules" block the
 * reviewer treats as binding. Kept separate from retrieval because the rules
 * reach the reviewer on every run, whatever the investigation surfaces — a
 * change that violates a documented rule is a finding even when it compiles.
 */
export function renderConventions(docs) {
  if (!docs.length) return '';
  const blocks = docs.map((d) => `--- ${d.path} (${d.why}) ---\n${d.content}`);
  return (
    `## Project rules and conventions\n\n` +
    `These are this repository's own instructions to contributors and coding agents. ` +
    `Treat them as binding: code that violates a rule stated here is a finding, ` +
    `with category "convention", even when it would otherwise be correct. ` +
    `Where a rule contradicts your general preferences, the rule wins.\n\n${blocks.join('\n\n')}`
  );
}
