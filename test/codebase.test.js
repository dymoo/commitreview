import test from 'node:test';
import assert from 'node:assert/strict';
import { collectInstructionDocs, renderConventions } from '../src/codebase.js';

const fakeRepo = (files) => ({
  kind: 'test',
  list: async () => Object.keys(files),
  read: async (path) => (path in files ? files[path] : null),
});

test('collects repository and directory-scoped instructions', async () => {
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
  const paths = docs.map((doc) => doc.path);
  assert.ok(paths.includes('AGENTS.md'));
  assert.ok(paths.includes('src/api/AGENTS.md'));
  assert.ok(paths.includes('.cursor/rules/security.mdc'));
  assert.ok(paths.includes('docs/style.md'));
  assert.ok(!paths.includes('src/unrelated/AGENTS.md'));
  assert.ok(!paths.includes('README.md'));
});

test('instruction imports resolve relatively, survive cycles and honour ignores', async () => {
  const repo = fakeRepo({
    'AGENTS.md': 'See @docs/a.md and @private/secret.md',
    'docs/a.md': 'See @./b.md and @../AGENTS.md',
    'docs/b.md': 'the actual rule',
    'private/secret.md': 'must never reach the model',
  });
  const docs = await collectInstructionDocs(repo, [], ['private/**']);
  const paths = docs.map((doc) => doc.path);
  assert.deepEqual(paths.sort(), ['AGENTS.md', 'docs/a.md', 'docs/b.md']);
  assert.equal(new Set(paths).size, paths.length);
});

test('rendered base-commit rules are evidence and cite their source', async () => {
  const repo = fakeRepo({
    'AGENTS.md': 'All money is integer pence.',
    'src/api/AGENTS.md': 'Every handler must be idempotent.',
  });
  const docs = await collectInstructionDocs(repo, ['src/api/handler.js']);
  const text = renderConventions(docs);
  assert.ok(text.includes('All money is integer pence.'));
  assert.ok(text.includes('Every handler must be idempotent.'));
  assert.ok(text.includes('base commit'));
  assert.ok(text.includes('evidence'));
  assert.ok(text.includes('AGENTS.md'));
  assert.equal(renderConventions([]), '');
});
