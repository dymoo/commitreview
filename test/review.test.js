import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFinding, dedupeFindings, systemPrompt } from '../src/review.js';
import { fingerprint, collectFingerprints, commentBody, renderSummary, SUMMARY_MARKER } from '../src/post.js';
import { containsPhrase, extractFocus, severityRank } from '../src/config.js';

const PATHS = ['src/app.js', 'lib/deep/util.ts'];

test('normalises a well-formed finding', () => {
  const f = normalizeFinding(
    {
      path: 'src/app.js',
      line: '42',
      side: 'right',
      severity: 'HIGH',
      category: 'security',
      title: ' SQL injection ',
      body: 'user input reaches the query',
      confidence: 0.9,
    },
    PATHS,
  );
  assert.equal(f.path, 'src/app.js');
  assert.equal(f.line, 42);
  assert.equal(f.side, 'RIGHT');
  assert.equal(f.severity, 'high');
  assert.equal(f.title, 'SQL injection');
  assert.equal(f.confidence, 0.9);
});

test('recovers a path the model shortened, but never invents one', () => {
  assert.equal(normalizeFinding({ path: './src/app.js', title: 'x' }, PATHS).path, 'src/app.js');
  assert.equal(normalizeFinding({ path: 'util.ts', title: 'x' }, PATHS).path, 'lib/deep/util.ts');
  assert.equal(normalizeFinding({ path: 'somewhere/else.js', title: 'x' }, PATHS), null);
  assert.equal(normalizeFinding({ title: 'x' }, PATHS), null);
});

test('rejects findings with nothing to say', () => {
  assert.equal(normalizeFinding(null, PATHS), null);
  assert.equal(normalizeFinding({ path: 'src/app.js' }, PATHS), null);
});

test('clamps confidence and defaults an unknown severity', () => {
  const f = normalizeFinding({ path: 'src/app.js', title: 'x', severity: 'catastrophic', confidence: 5 }, PATHS);
  assert.equal(f.severity, 'medium');
  assert.equal(f.confidence, 1);
  assert.equal(normalizeFinding({ path: 'src/app.js', title: 'x', confidence: 'nonsense' }, PATHS).confidence, 0.6);
});

test('the same defect found twice is reported once', () => {
  const findings = [
    { path: 'a.js', line: 3, title: 'Null deref' },
    { path: 'a.js', line: 3, title: 'null  DEREF!' },
    { path: 'a.js', line: 4, title: 'Null deref' },
  ];
  assert.equal(dedupeFindings(findings).length, 2);
});

test('severity ordering puts critical first', () => {
  assert.ok(severityRank('critical') < severityRank('high'));
  assert.ok(severityRank('low') < severityRank('nit'));
  assert.equal(severityRank('bogus'), severityRank('low'));
});

test('the system prompt teaches the column format and forbids context anchors', () => {
  const p = systemPrompt({ maxFindings: 5, instructions: 'Prefer async/await.' });
  assert.ok(p.includes("marker '~'"));
  assert.ok(p.includes('NEVER reference'));
  assert.ok(p.includes('untrusted'));
  assert.ok(p.includes('Prefer async/await.'));
  assert.ok(p.includes('at most 5 findings'));
});

test('fingerprints follow the code, not the line number', () => {
  const a = fingerprint({ path: 'a.js', title: 'Null deref', line: 10 }, '  return user.name;');
  const b = fingerprint({ path: 'a.js', title: 'null deref!', line: 87 }, '  return user.name;');
  const c = fingerprint({ path: 'a.js', title: 'Null deref', line: 10 }, '  return account.name;');
  assert.equal(a, b, 'a rebase must not re-post the same finding');
  assert.notEqual(a, c, 'a different line of code is a different finding');
  assert.match(a, /^[0-9a-f]{12}$/);
});

test('fingerprints are read back out of existing comment bodies', () => {
  const fp = fingerprint({ path: 'a.js', title: 'x', line: 1 }, 'code');
  const body = commentBody(
    { severity: 'high', category: 'correctness', title: 'x', body: 'why', confidence: 0.8, fp, line: 5 },
    { path: 'a.js', line: 5, side: 'RIGHT' },
    { suggestions: true },
  );
  assert.deepEqual([...collectFingerprints([body])], [fp]);
  assert.equal(collectFingerprints(['no markers here']).size, 0);
});

test('a committable suggestion is offered only for an exact right-side anchor', () => {
  const finding = {
    severity: 'low',
    category: 'correctness',
    title: 't',
    body: 'b',
    confidence: 0.5,
    fp: 'a'.repeat(12),
    suggestion: 'const x = 1;',
    line: 5,
  };
  const exact = commentBody(finding, { path: 'a.js', line: 5, side: 'RIGHT' }, { suggestions: true });
  assert.ok(exact.includes('```suggestion'));

  const snapped = commentBody(finding, { path: 'a.js', line: 6, side: 'RIGHT', snapped: true }, { suggestions: true });
  assert.ok(!snapped.includes('```suggestion'));
  assert.ok(snapped.includes('nearest changed line'));

  const left = commentBody(finding, { path: 'a.js', line: 5, side: 'LEFT' }, { suggestions: true });
  assert.ok(!left.includes('```suggestion'));

  const off = commentBody(finding, { path: 'a.js', line: 5, side: 'RIGHT' }, { suggestions: false });
  assert.ok(!off.includes('```suggestion'));
});

test('a suggestion containing a fence does not break out of its block', () => {
  const body = commentBody(
    {
      severity: 'low',
      category: 'x',
      title: 't',
      body: 'b',
      confidence: 0.5,
      fp: 'b'.repeat(12),
      suggestion: 'const md = `\n```js\ncode\n```\n`;',
      line: 1,
    },
    { path: 'a.js', line: 1, side: 'RIGHT' },
    { suggestions: true },
  );
  assert.ok(body.includes('````suggestion'));
});

const RESULT = {
  pr: { head: { sha: 'abcdef1234567890' } },
  posted: [{ severity: 'high', title: 'Null deref | pipe', path: 'a.js', anchor: { line: 12 }, fp: 'c'.repeat(12) }],
  demoted: [{ severity: 'low', title: 'Unclear name', path: 'b.js', line: 9, body: 'why', fp: 'd'.repeat(12) }],
  duplicates: 2,
  skipped: [{ path: 'pnpm-lock.yaml', reason: 'ignored' }],
  dropped: [],
  summaries: ['Adds a cache layer.'],
  refuted: 3,
  usage: { requests: 4, prompt: 100, completion: 50 },
  reviewedFiles: 7,
};

test('the summary carries its marker, the counts and every fingerprint', () => {
  const md = renderSummary(RESULT, { model: 'glm-4.6' });
  assert.ok(md.startsWith(SUMMARY_MARKER));
  assert.ok(md.includes('**2 findings** across 7 files'));
  assert.ok(md.includes('Adds a cache layer.'));
  assert.ok(md.includes('`a.js:12`'));
  assert.ok(md.includes('Null deref \\| pipe'), 'a pipe in a title must not break the table');
  assert.ok(md.includes('3 refuted'));
  assert.ok(md.includes('2 already reported'));
  assert.ok(md.includes('pnpm-lock.yaml'));
  assert.ok(md.includes('abcdef1'));
  // Demoted findings still need a fingerprint so a re-run does not repeat them.
  assert.equal(collectFingerprints([md]).size, 1);
});

test('a clean diff produces a summary that says so', () => {
  const md = renderSummary({ ...RESULT, posted: [], demoted: [], summaries: [] }, { model: 'm' });
  assert.ok(md.includes('No defects found'));
});

test('the trigger phrase matches on a word boundary', () => {
  assert.ok(containsPhrase('hey @commitreview please look', '@commitreview'));
  assert.ok(containsPhrase('@COMMITREVIEW', '@commitreview'));
  assert.ok(containsPhrase('@commitreview', '@commitreview'));
  assert.ok(!containsPhrase('@commitreviewer go', '@commitreview'));
  assert.ok(!containsPhrase('nothing here', '@commitreview'));
});

test('text after the trigger phrase becomes the focus', () => {
  assert.equal(extractFocus('@commitreview focus on the auth path', '@commitreview'), 'focus on the auth path');
  assert.equal(extractFocus('@commitreview', '@commitreview'), '');
});
