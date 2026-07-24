import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff } from '../src/diff.js';
import {
  matchGlob,
  matchAny,
  selectFiles,
  renderFile,
  buildChunks,
  sliceAround,
  estimateTokens,
} from '../src/context.js';
import { DEFAULT_IGNORES } from '../src/config.js';
import { APP_DIFF, BINARY_DIFF, APP_CONTENT, CONFIG } from './fixtures.js';

test('glob matching follows the usual segment rules', () => {
  assert.ok(matchGlob('src/a.js', 'src/*.js'));
  assert.ok(!matchGlob('src/deep/a.js', 'src/*.js'));
  assert.ok(matchGlob('src/deep/a.js', 'src/**/*.js'));
  assert.ok(matchGlob('a.js', '**/*.js'));
  assert.ok(matchGlob('x/y/dist/main.js', '**/dist/**'));
  assert.ok(!matchGlob('x/y/distant/main.js', '**/dist/**'));
  assert.ok(matchGlob('a/b.ts', 'a/?.ts'));
  assert.ok(!matchGlob('a/bb.ts', 'a/?.ts'));
});

test('a slashless pattern also matches the basename', () => {
  assert.ok(matchGlob('deep/nested/notes.md', '*.md'));
  assert.ok(!matchGlob('deep/nested/notes.md', 'docs/*.md'));
});

test('default ignores catch lockfiles and build output', () => {
  for (const p of ['pnpm-lock.yaml', 'web/dist/index.js', 'go.sum', 'src/app.min.js', 'proto/user.pb.go']) {
    assert.ok(matchAny(p, DEFAULT_IGNORES), `${p} should be ignored`);
  }
  assert.ok(!matchAny('src/app.js', DEFAULT_IGNORES));
});

test('selectFiles reports why each file was skipped', () => {
  const files = parseDiff([APP_DIFF, BINARY_DIFF].join('\n'));
  const { selected, skipped } = selectFiles(files, { ...CONFIG, ignore: ['**/*.png'] });
  assert.deepEqual(
    selected.map((f) => f.path),
    ['src/app.js'],
  );
  assert.equal(skipped[0].path, 'logo.png');
  assert.equal(skipped[0].reason, 'binary');
});

test('max-files is reported rather than silently applied', () => {
  const files = parseDiff(APP_DIFF);
  const capped = selectFiles(files, { ...CONFIG, maxFiles: 0 });
  assert.equal(capped.selected.length, 0);
  assert.match(capped.skipped[0].reason, /max-files/);
});

test('rendering widens each hunk with real source and keeps both line numbers correct', () => {
  const file = parseDiff(APP_DIFF)[0];
  const [block] = renderFile(file, APP_CONTENT, CONFIG);
  const rows = block.text.split('\n');

  assert.match(rows[0], /^FILE: src\/app\.js \[modified, \+2 -1\]$/);
  assert.equal(rows[1], '@@ new lines 7-17 @@');

  const parse = (row) => ({
    old: row.slice(0, 6).trim(),
    new: row.slice(7, 13).trim(),
    mark: row[14],
    text: row.slice(16),
  });

  // Widened context before the hunk: unchanged, so old === new.
  assert.deepEqual(parse(rows[2]), { old: '7', new: '7', mark: '~', text: 'line 7' });
  // The hunk itself.
  assert.deepEqual(parse(rows[5]), { old: '10', new: '10', mark: ' ', text: '  const id = req.params.id;' });
  assert.deepEqual(parse(rows[6]), { old: '11', new: '', mark: '-', text: '  const user = db.get(id);' });
  assert.deepEqual(parse(rows[7]), { old: '', new: '11', mark: '+', text: '  const user = await db.get(id);' });
  // Widened context after the hunk: one net line was added, so old lags by one.
  assert.deepEqual(parse(rows[11]), { old: '14', new: '15', mark: '~', text: 'line 15' });
  assert.deepEqual(parse(rows[13]), { old: '16', new: '17', mark: '~', text: 'line 17' });
});

test('rendering without file content falls back to the raw hunks', () => {
  const file = parseDiff(APP_DIFF)[0];
  const [block] = renderFile(file, null, CONFIG);
  assert.ok(!block.text.includes('~'));
  assert.ok(block.text.includes('@@ new lines 10-14 @@'));
});

test('a file larger than one request is split into several blocks', () => {
  const file = parseDiff(APP_DIFF)[0];
  const blocks = renderFile(file, APP_CONTENT, { ...CONFIG, chunkTokens: 1000 });
  assert.ok(blocks.length >= 1);
  for (const b of blocks) assert.ok(b.tokens <= 1000, `block of ${b.tokens} tokens exceeds the request budget`);
});

test('one oversized hunk is truncated within the advertised request budget', () => {
  const source = 'x'.repeat(12000);
  const file = parseDiff(
    ['diff --git a/huge.js b/huge.js', '--- /dev/null', '+++ b/huge.js', '@@ -0,0 +1,1 @@', `+${source}`].join('\n'),
  )[0];
  const [block] = renderFile(file, source, { ...CONFIG, contextLines: 0, chunkTokens: 1000 });
  assert.ok(block.tokens <= 1000, `block of ${block.tokens} tokens exceeds the request budget`);
  assert.match(block.text, /hunk truncated/);
});

test('chunking packs blocks up to the request budget and drops over the total budget', () => {
  const blocks = Array.from({ length: 6 }, (_, i) => ({
    path: `f${i}.js`,
    text: 'x'.repeat(4000), // ~1000 tokens
    tokens: 1000,
  }));

  const packed = buildChunks(blocks, { chunkTokens: 2500, maxInputTokens: 100000 });
  assert.equal(packed.chunks.length, 3);
  assert.deepEqual(packed.chunks[0].paths, ['f0.js', 'f1.js']);
  assert.equal(packed.dropped.length, 0);

  const budgeted = buildChunks(blocks, { chunkTokens: 2500, maxInputTokens: 2000 });
  assert.equal(budgeted.dropped.length, 4);
  assert.match(budgeted.dropped[0].reason, /max-input-tokens/);
});

test('sliceAround centres on the requested line', () => {
  const text = Array.from(
    { length: 4000 },
    (_, i) => `${String(i + 1).padStart(6)} ${String(i + 1).padStart(6)}   line`,
  ).join('\n');
  const slice = sliceAround(text, 2000, 2000);
  assert.ok(slice.length < text.length);
  assert.ok(slice.includes('  2000   2000'));
  assert.ok(slice.startsWith('… earlier hunks omitted …'));
  assert.equal(sliceAround('short', 1, 2000), 'short');
});

test('token estimate is proportional to length', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens(''), 0);
});
