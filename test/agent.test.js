import test from 'node:test';
import assert from 'node:assert/strict';
import { runTool, normalisePath, toolLoop, TOOLS } from '../src/agent.js';
import { DEFAULT_IGNORES } from '../src/config.js';

const repo = {
  list: async () => ['src/a.js', 'src/b.js', 'dist/bundle.js'],
  read: async (path) =>
    ({ 'src/a.js': 'line one\nline two\nline three', 'src/b.js': 'calls aThing()', 'dist/bundle.js': 'built' })[path] ??
    null,
};
const config = { ignore: DEFAULT_IGNORES, maxFileBytes: 400000 };

test('the agent exposes only three read-only repository tools', () => {
  assert.deepEqual(
    TOOLS.map((tool) => tool.function.name),
    ['search', 'read_file', 'list_files'],
  );
});

test('read_file returns numbered lines and enforces repository boundaries', async () => {
  const ok = JSON.parse(await runTool('read_file', { path: 'src/a.js' }, { repo, config }));
  assert.match(ok.content, /^\s+1 {2}line one$/m);
  assert.equal(ok.of, 3);

  const ignored = JSON.parse(await runTool('read_file', { path: 'dist/bundle.js' }, { repo, config }));
  assert.match(ignored.error, /excluded/);

  const escaped = JSON.parse(await runTool('read_file', { path: '../../../etc/passwd' }, { repo, config }));
  assert.match(escaped.error, /repository-relative/);
  const absolute = JSON.parse(await runTool('read_file', { path: '/etc/passwd' }, { repo, config }));
  assert.match(absolute.error, /repository-relative/);
  assert.equal(normalisePath('src/../src/a.js'), 'src/a.js');
});

test('search reports exact text hits without accepting executable patterns', async () => {
  const hit = JSON.parse(await runTool('search', { query: 'aThing' }, { repo, config }));
  assert.equal(hit.matches, 1);
  assert.deepEqual(hit.hits[0], { path: 'src/b.js', line: 1, text: 'calls aThing()' });

  const literal = JSON.parse(await runTool('search', { query: '([' }, { repo, config }));
  assert.equal(literal.matches, 0, 'regular-expression syntax is treated as text');
});

test('list_files honours ignores and globs', async () => {
  const all = JSON.parse(await runTool('list_files', {}, { repo, config }));
  assert.deepEqual(all.paths, ['src/a.js', 'src/b.js']);

  const globbed = JSON.parse(await runTool('list_files', { glob: 'src/b*' }, { repo, config }));
  assert.deepEqual(globbed.paths, ['src/b.js']);
});

test('bad tool calls return errors rather than escaping the loop', async () => {
  assert.match(JSON.parse(await runTool('read_file', {}, { repo, config })).error, /required/);
  assert.match(JSON.parse(await runTool('rm_rf', {}, { repo, config })).error, /unknown tool/);
  assert.match(
    JSON.parse(await runTool('list_files', { glob: '*'.repeat(501) }, { repo, config })).error,
    /glob is too long/,
  );
});

test('the tool loop keeps assistant calls and tool results paired', async () => {
  /** @type {Array<{role?: string, tool_calls?: unknown[]}>|undefined} */
  let secondRequest;
  let requests = 0;
  const llm = {
    send: async (messages) => {
      requests++;
      if (requests === 1) {
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: Array.from({ length: 10 }, (_, index) => ({
              id: `call-${index}`,
              type: 'function',
              function: { name: 'list_files', arguments: '{}' },
            })),
          },
        };
      }
      secondRequest = structuredClone(messages);
      return { message: { content: 'done' } };
    },
    complete: async () => 'closed',
  };

  const result = await toolLoop(llm, {
    system: 'system',
    user: 'user',
    repo,
    config,
    turns: 2,
    closing: 'close',
  });

  assert.equal(result.calls, 8);
  assert.ok(secondRequest);
  const assistant = secondRequest.find((message) => message.role === 'assistant');
  assert.ok(assistant?.tool_calls);
  assert.equal(assistant.tool_calls.length, 8);
  assert.equal(secondRequest.filter((message) => message.role === 'tool').length, 8);
});
