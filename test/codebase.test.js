import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff } from '../src/diff.js';
import { extractSymbols, scanRepository, collectInstructionDocs, buildCodebaseContext } from '../src/codebase.js';
import { DEFAULT_IGNORES } from '../src/config.js';

/** A repository that lives in an object literal. */
const fakeRepo = (files) => ({
  kind: 'test',
  list: async () => Object.keys(files),
  read: async (p) => (p in files ? files[p] : null),
});

const CONFIG = { ignore: DEFAULT_IGNORES, maxRelatedTokens: 50000, maxFileBytes: 400000 };

const DIFF = [
  'diff --git a/src/user.js b/src/user.js',
  '--- a/src/user.js',
  '+++ b/src/user.js',
  '@@ -1,3 +1,4 @@',
  ' import { fetchAccount } from "./account.js";',
  '-export function loadUser(id) {',
  '+export function loadUser(id, options) {',
  '+  validateOptions(options);',
  '   return fetchAccount(id);',
].join('\n');

test('separates symbols the change defines from symbols it calls', () => {
  const { defined, used } = extractSymbols(parseDiff(DIFF));
  assert.ok(defined.has('loadUser'), 'loadUser is defined by the change');
  assert.ok(used.has('validateOptions'), 'validateOptions is called by the change');
  assert.ok(!used.has('loadUser'), 'a symbol the change defines needs no definition lookup');
  assert.ok(!used.has('if'), 'keywords are not symbols');
});

test('finds definitions and callers in one pass, skipping the changed file', async () => {
  const repo = fakeRepo({
    'src/user.js': 'export function loadUser(id, options) {}',
    'src/account.js': 'export function fetchAccount(id) {\n  return db.get(id);\n}',
    'src/options.js': 'export function validateOptions(o) {\n  return o;\n}',
    'src/routes.js': 'import { loadUser } from "./user.js";\nconst u = loadUser(req.id);\n',
    'dist/bundle.js': 'function loadUser(){} // build output, must be ignored',
  });

  const hits = await scanRepository(repo, {
    wanted: new Set(['loadUser', 'validateOptions', 'fetchAccount']),
    skipPaths: ['src/user.js'],
    ignore: DEFAULT_IGNORES,
  });

  assert.deepEqual(hits.get('validateOptions').defs, [{ path: 'src/options.js', line: 1 }]);
  assert.deepEqual(hits.get('fetchAccount').defs, [{ path: 'src/account.js', line: 1 }]);

  // The caller of the changed function is the whole point of the scan.
  const callers = hits.get('loadUser').refs.map((r) => r.path);
  assert.ok(callers.includes('src/routes.js'));
  assert.ok(!callers.includes('src/user.js'), 'the changed file itself is skipped');
  assert.ok(
    ![...hits.get('loadUser').defs, ...hits.get('loadUser').refs].some((h) => h.path === 'dist/bundle.js'),
    'ignored paths never reach the model',
  );
});

test('collects the instruction files that govern the changed paths', async () => {
  const repo = fakeRepo({
    'AGENTS.md': '# Rules\nAll money is integer pence.',
    'CLAUDE.md': '# Claude\nSee @docs/style.md for naming.',
    'docs/style.md': '# Style\nUse British spelling.',
    'src/api/AGENTS.md': '# API rules\nEvery handler must be idempotent.',
    'src/unrelated/AGENTS.md': '# Unrelated\nShould not be collected.',
    '.cursor/rules/security.mdc': '# Security\nNever log tokens.',
    'README.md': 'not an instruction file',
  });

  const docs = await collectInstructionDocs(repo, ['src/api/handler.js']);
  const paths = docs.map((d) => d.path);

  assert.ok(paths.includes('AGENTS.md'));
  assert.ok(paths.includes('src/api/AGENTS.md'), 'rules scoped to the changed directory apply');
  assert.ok(!paths.includes('src/unrelated/AGENTS.md'), 'rules for untouched directories do not');
  assert.ok(paths.includes('.cursor/rules/security.mdc'));
  assert.ok(paths.includes('docs/style.md'), '@imports are followed');
  assert.ok(!paths.includes('README.md'));
});

test('instruction imports resolve relatively and survive cycles', async () => {
  const repo = fakeRepo({
    'AGENTS.md': 'See @docs/a.md',
    'docs/a.md': 'See @./b.md and @../AGENTS.md',
    'docs/b.md': 'the actual rule',
  });
  const docs = await collectInstructionDocs(repo, []);
  const paths = docs.map((d) => d.path);
  assert.deepEqual(paths.sort(), ['AGENTS.md', 'docs/a.md', 'docs/b.md']);
  assert.equal(new Set(paths).size, paths.length, 'a cycle must not read a file twice');
});

test('the assembled context marks project rules as binding', async () => {
  const repo = fakeRepo({
    'AGENTS.md': 'All money is integer pence.',
    'src/options.js': 'export function validateOptions(o) {\n  return o;\n}',
    'src/routes.js': 'const u = loadUser(req.id);',
  });

  const built = await buildCodebaseContext(repo, parseDiff(DIFF), CONFIG);
  assert.ok(built.text.includes('All money is integer pence.'));
  assert.ok(built.text.includes('Treat them as binding'));
  assert.ok(built.text.includes('validateOptions'), 'definitions of called symbols are included');
  assert.ok(built.text.includes('Existing callers'), 'callers of changed symbols are included');
  assert.equal(built.stats.conventions, 1);
  assert.ok(built.tokens > 0);
});

test('no repository and no budget means no context, not a crash', async () => {
  assert.equal((await buildCodebaseContext(null, [], CONFIG)).text, '');
  const repo = fakeRepo({ 'a.js': 'x' });
  assert.equal((await buildCodebaseContext(repo, parseDiff(DIFF), { ...CONFIG, maxRelatedTokens: 0 })).text, '');
});
