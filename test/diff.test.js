import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff, anchorFinding, unquotePath, lineText } from '../src/diff.js';
import { APP_DIFF, DELETED_DIFF, BINARY_DIFF, RENAME_DIFF, ADDED_DIFF } from './fixtures.js';

const only = (diff) => parseDiff(diff)[0];

test('parses a modified file into hunk lines with both line numbers', () => {
  const f = only(APP_DIFF);
  assert.equal(f.path, 'src/app.js');
  assert.equal(f.status, 'modified');
  assert.equal(f.additions, 2);
  assert.equal(f.deletions, 1);
  assert.equal(f.hunks.length, 1);

  assert.deepEqual(
    f.hunks[0].lines.map((l) => [l.type, l.oldLine, l.newLine]),
    [
      [' ', 10, 10],
      ['-', 11, null],
      ['+', null, 11],
      ['+', null, 12],
      [' ', 12, 13],
      [' ', 13, 14],
    ],
  );
});

test('builds side maps that only contain lines GitHub will accept', () => {
  const f = only(APP_DIFF);
  assert.deepEqual(
    [...f.rightLines.keys()].sort((a, b) => a - b),
    [10, 11, 12, 13, 14],
  );
  assert.deepEqual(
    [...f.leftLines.keys()].sort((a, b) => a - b),
    [10, 11, 12, 13],
  );
});

test('recognises deleted, binary, renamed and added files', () => {
  const del = only(DELETED_DIFF);
  assert.equal(del.status, 'deleted');
  assert.equal(del.rightLines.size, 0);
  assert.equal(del.deletions, 2);

  const bin = only(BINARY_DIFF);
  assert.equal(bin.binary, true);
  assert.equal(bin.hunks.length, 0);

  const ren = only(RENAME_DIFF);
  assert.equal(ren.status, 'renamed');
  assert.equal(ren.path, 'c/d.js');
  assert.equal(ren.oldPath, 'a/b.js');

  const add = only(ADDED_DIFF);
  assert.equal(add.status, 'added');
  assert.equal(add.path, 'new.js');
  assert.equal(add.additions, 2);
  assert.deepEqual([...add.rightLines.keys()], [1, 2]);
});

test('parses several files from one diff', () => {
  const files = parseDiff([APP_DIFF, BINARY_DIFF, RENAME_DIFF].join('\n'));
  assert.deepEqual(
    files.map((f) => f.path),
    ['src/app.js', 'logo.png', 'c/d.js'],
  );
});

test('a diff embedded in the diff body does not start a new file', () => {
  const diff = [
    'diff --git a/doc.md b/doc.md',
    '--- a/doc.md',
    '+++ b/doc.md',
    '@@ -1,1 +1,2 @@',
    ' intro',
    '+diff --git a/fake.js b/fake.js',
  ].join('\n');
  const files = parseDiff(diff);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'doc.md');
  assert.equal(files[0].additions, 1);
});

test('unquotes git-escaped paths', () => {
  assert.equal(unquotePath('"src/caf\\303\\251.js"'), 'src/café.js');
  assert.equal(unquotePath('"a b\\tc.js"'), 'a b\tc.js');
  assert.equal(unquotePath('plain.js'), 'plain.js');
});

test('anchors a finding that names a changed line', () => {
  const f = only(APP_DIFF);
  const a = anchorFinding({ path: f.path, line: 12, side: 'RIGHT' }, f);
  assert.deepEqual(a, { path: 'src/app.js', line: 12, side: 'RIGHT' });
});

test('anchors LEFT-side findings on removed lines', () => {
  const f = only(APP_DIFF);
  const a = anchorFinding({ path: f.path, line: 11, side: 'LEFT' }, f);
  assert.equal(a.side, 'LEFT');
  assert.equal(a.line, 11);
});

test('snaps a near miss to the closest changed line and flags it', () => {
  const f = only(APP_DIFF);
  const a = anchorFinding({ path: f.path, line: 9, side: 'RIGHT' }, f);
  assert.equal(a.line, 11);
  assert.equal(a.snapped, true);
});

test('drops a line that is nowhere near a hunk instead of relocating it', () => {
  const f = only(APP_DIFF);
  assert.equal(anchorFinding({ path: f.path, line: 900, side: 'RIGHT' }, f), null);
  assert.equal(anchorFinding({ path: f.path, line: 0, side: 'RIGHT' }, f), null);
  assert.equal(anchorFinding({ path: f.path, line: null, side: 'RIGHT' }, f), null);
});

test('never anchors into a binary file', () => {
  assert.equal(anchorFinding({ path: 'logo.png', line: 1 }, only(BINARY_DIFF)), null);
});

test('falls back to LEFT when the file has no right-hand side', () => {
  const f = only(DELETED_DIFF);
  const a = anchorFinding({ path: f.path, line: 2, side: 'RIGHT' }, f);
  assert.equal(a.side, 'LEFT');
  assert.equal(a.line, 2);
});

test('keeps a multi-line range only when both ends are in the same hunk', () => {
  const f = only(APP_DIFF);
  const ok = anchorFinding({ path: f.path, line: 13, start_line: 11, side: 'RIGHT' }, f);
  assert.equal(ok.start_line, 11);
  assert.equal(ok.start_side, 'RIGHT');

  const bad = anchorFinding({ path: f.path, line: 13, start_line: 99, side: 'RIGHT' }, f);
  assert.equal(bad.start_line, undefined);
});

test('lineText returns the source at a position for fingerprinting', () => {
  const f = only(APP_DIFF);
  assert.equal(lineText(f, 'RIGHT', 12), '  if (!user) return null;');
  assert.equal(lineText(f, 'LEFT', 11), '  const user = db.get(id);');
  assert.equal(lineText(f, 'RIGHT', 999), '');
});
