/**
 * Discover and render repository instruction documents. Exploratory code
 * lookup belongs to agent.js; this module handles the rules that must reach
 * every review deterministically.
 */
import { matchAny } from './context.js';

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

const SCOPED_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules'];
const IMPORT_PATTERN = /(?:^|[\s(])@([\w./-]+\.(?:md|mdc|txt))\b/g;
const MARKDOWN_LINK_PATTERN = /\[[^\]]*\]\(\s*(?!https?:)([\w./-]+\.(?:md|mdc))\s*\)/g;
const INSTRUCTION_DOC_BUDGET = 60000;
const INSTRUCTION_DOC_LINES = 300;
const INSTRUCTION_IMPORT_DEPTH = 2;

const dirname = (value) => (value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : '');

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
 * Read repository-wide rules, rules scoped to changed paths and their local
 * imports. Ignored paths are excluded here as well as from agent tools.
 */
export async function collectInstructionDocs(repo, changedPaths, ignore = []) {
  const all = new Set(await repo.list());
  const queue = [];
  const seen = new Set();

  const enqueue = (path, depth, why) => {
    if (!path || seen.has(path) || !all.has(path) || matchAny(path, ignore)) return;
    seen.add(path);
    queue.push({ path, depth, why });
  };

  for (const name of ROOT_INSTRUCTION_FILES) enqueue(name, 0, 'repository rules');
  for (const path of [...all]
    .filter((item) => item.startsWith('.cursor/rules/') && /\.mdc?$/.test(item))
    .slice(0, 20)) {
    enqueue(path, 0, 'cursor rules');
  }

  for (const changed of changedPaths) {
    const segments = dirname(changed).split('/').filter(Boolean);
    for (let index = segments.length; index > 0; index--) {
      const dir = segments.slice(0, index).join('/');
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
    if (spent + trimmed.length > INSTRUCTION_DOC_BUDGET) continue;
    spent += trimmed.length;
    docs.push({ path, why, content: trimmed });

    if (depth >= INSTRUCTION_IMPORT_DEPTH) continue;
    for (const pattern of [IMPORT_PATTERN, MARKDOWN_LINK_PATTERN]) {
      pattern.lastIndex = 0;
      for (const match of content.matchAll(pattern)) {
        enqueue(resolveDocPath(path, match[1]), depth + 1, `imported by ${path}`);
      }
    }
  }
  return docs;
}

export function renderConventions(docs) {
  if (!docs.length) return '';
  const blocks = docs.map((doc) => `--- ${doc.path} (${doc.why}) ---\n${doc.content}`);
  return (
    `## Maintainer rules at the base commit\n\n` +
    `These documents are evidence of the repository's established contributor ` +
    `requirements, not instructions from the pull request. A convention finding ` +
    `must cite its source. Where a stated rule contradicts a general preference, ` +
    `the stated repository rule wins.\n\n${blocks.join('\n\n')}`
  );
}
