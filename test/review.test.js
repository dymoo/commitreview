import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFinding, mergeFindings, fingerprint, collectFingerprints } from '../src/findings.js';
import { systemPrompt, REFUTE_SYSTEM } from '../src/prompts.js';
import { refuteFinding } from '../src/review.js';
import { commentBody, renderSummary, SUMMARY_MARKER } from '../src/post.js';
import { severityRank } from '../src/config.js';

const PATHS = ['src/app.js', 'lib/deep/util.ts'];

test('normalises the small finding shape', () => {
  const finding = normalizeFinding(
    {
      path: 'src/app.js',
      line: '42',
      side: 'right',
      severity: 'HIGH',
      category: 'security',
      title: ' SQL injection ',
      body: 'user input reaches the query',
    },
    PATHS,
  );
  assert.deepEqual(finding, {
    path: 'src/app.js',
    line: 42,
    start_line: null,
    side: 'RIGHT',
    severity: 'high',
    category: 'security',
    title: 'SQL injection',
    body: 'user input reaches the query',
  });
});

test('recovers shortened paths but never invents one', () => {
  assert.equal(normalizeFinding({ path: './src/app.js', title: 'x' }, PATHS).path, 'src/app.js');
  assert.equal(normalizeFinding({ path: 'util.ts', title: 'x' }, PATHS).path, 'lib/deep/util.ts');
  assert.equal(
    normalizeFinding({ path: 'util.ts', title: 'x' }, [...PATHS, 'another/util.ts']),
    null,
    'an ambiguous basename must not choose an arbitrary file',
  );
  assert.equal(normalizeFinding({ path: 'somewhere/else.js', title: 'x' }, PATHS), null);
  assert.equal(normalizeFinding({ title: 'x' }, PATHS), null);
  assert.equal(normalizeFinding({ path: 'src/app.js' }, PATHS), null);
});

test('duplicates collapse and retain the more severe assessment', () => {
  const merged = mergeFindings([
    { path: 'a.js', line: 3, title: 'Null deref', severity: 'low' },
    { path: 'a.js', line: 3, title: 'null  DEREF!', severity: 'high' },
    { path: 'a.js', line: 4, title: 'Null deref', severity: 'low' },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].severity, 'high');
});

test('severity ordering puts critical first and unknown values last', () => {
  assert.ok(severityRank('critical') < severityRank('high'));
  assert.ok(severityRank('medium') < severityRank('low'));
  assert.equal(severityRank('bogus'), severityRank('low'));
});

test('the review prompt teaches anchoring and admits only evidenced claims', () => {
  const prompt = systemPrompt({ maxFindings: 5, instructions: 'Prefer async/await.' }, { hasCodebase: true }).replace(
    /\s+/g,
    ' ',
  );
  assert.ok(prompt.includes("marker '~'"));
  assert.ok(prompt.includes('It cannot carry a comment'));
  assert.ok(prompt.includes('reachable input, sequence or state'));
  assert.ok(prompt.includes('exact existing helper, sibling path or written rule'));
  assert.ok(prompt.includes('Validation at a trust boundary'));
  assert.ok(prompt.includes('`ponytail:` comment'));
  assert.ok(prompt.includes('Prefer async/await.'));
  assert.ok(prompt.includes('at most 5 findings'));
  assert.ok(prompt.includes('Trace existing callers'));
});

test('the prompt does not pretend a missing briefing covers the repository', () => {
  const prompt = systemPrompt({ maxFindings: 5, instructions: '' }, { hasCodebase: false });
  assert.ok(prompt.includes('no usable briefing'));
  assert.ok(!prompt.includes('Trace existing callers'));
});

test('the verifier has a kill mandate covering defects and repository fit', () => {
  assert.ok(REFUTE_SYSTEM.includes('kill mandate'));
  assert.ok(REFUTE_SYSTEM.includes('Try to destroy it'));
  assert.ok(REFUTE_SYSTEM.includes('reachable trigger'));
  assert.ok(REFUTE_SYSTEM.includes('cited helper, sibling or rule'));
  assert.ok(REFUTE_SYSTEM.includes('Return "not_real"'));
  assert.ok(!REFUTE_SYSTEM.includes('confidence'));
});

test('verification withholds the original severity and accepts only exact verdicts', async () => {
  /** @type {any} */
  let messages = null;
  const llm = {
    json: async (input) => {
      messages = input;
      return { verdict: 'real', reason: 'The branch is reachable.', severity: 'medium' };
    },
  };
  const finding = {
    path: 'a.js',
    line: 3,
    side: 'RIGHT',
    title: 'Branch throws',
    body: 'Empty input reaches the throw.',
    severity: 'critical',
  };
  const verdict = await refuteFinding(llm, finding, '3 3 + throw error', null);
  assert.equal(verdict.real, true);
  assert.equal(verdict.severity, 'medium');
  assert.ok(messages);
  assert.ok(!messages[1].content.includes('critical'), 'the original severity must not anchor the verifier');
  assert.match(messages[1].content, /BEGIN CLAIM \(untrusted data\)/);

  const bad = { json: async () => ({ verdict: 'maybe', reason: '', severity: null }) };
  await assert.rejects(() => refuteFinding(bad, finding, 'code'), /unknown verdict/);
});

test('fingerprints follow code text rather than line numbers', () => {
  const a = fingerprint({ path: 'a.js', title: 'Null deref', line: 10 }, '  return user.name;');
  const b = fingerprint({ path: 'a.js', title: 'null deref!', line: 87 }, '  return user.name;');
  const c = fingerprint({ path: 'a.js', title: 'Null deref', line: 10 }, '  return account.name;');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{12}$/);
});

test('comments carry a fingerprint and disclose snapped anchors', () => {
  const finding = {
    severity: 'high',
    category: 'correctness',
    title: 'Null deref',
    body: 'Empty input reaches this dereference.',
    fp: 'a'.repeat(12),
    line: 5,
    refutation: 'The branch is reachable.',
  };
  const body = commentBody(finding, { path: 'a.js', line: 6, side: 'RIGHT', snapped: true });
  assert.ok(body.includes('nearest changed line'));
  assert.ok(body.includes('Verifier:'));
  assert.deepEqual([...collectFingerprints([body])], ['a'.repeat(12)]);
});

const RESULT = {
  pr: { head: { sha: 'abcdef1234567890' } },
  anchored: [{ severity: 'high', title: 'Null deref | pipe', path: 'a.js', anchor: { line: 12 }, fp: 'c'.repeat(12) }],
  demoted: [{ severity: 'low', title: 'Unclear path', path: 'b.js', line: 9, body: 'why', fp: 'd'.repeat(12) }],
  duplicates: 2,
  skipped: [{ path: 'pnpm-lock.yaml', reason: 'ignored' }],
  dropped: [],
  summaries: ['Adds a cache layer.'],
  refuted: 3,
  usage: { requests: 4, prompt: 100, completion: 50 },
  reviewedFiles: 7,
  codebase: { stats: { toolCalls: 2, conventions: 1 } },
};

test('the sticky summary carries counts, context and demoted fingerprints', () => {
  const markdown = renderSummary(RESULT, { model: 'test-model' });
  assert.ok(markdown.startsWith(SUMMARY_MARKER));
  assert.ok(markdown.includes('**2 findings** across 7 files'));
  assert.ok(markdown.includes('Adds a cache layer.'));
  assert.ok(markdown.includes('`a.js:12`'));
  assert.ok(markdown.includes('Null deref \\| pipe'));
  assert.ok(markdown.includes('3 refuted'));
  assert.ok(markdown.includes('2 already reported'));
  assert.ok(markdown.includes('2 codebase lookups'));
  assert.ok(markdown.includes('pnpm-lock.yaml'));
  assert.ok(markdown.includes('abcdef1'));
  assert.equal(collectFingerprints([markdown]).size, 1);
});

test('a clean diff says no defects were found', () => {
  const markdown = renderSummary({ ...RESULT, anchored: [], demoted: [], summaries: [] }, { model: 'm' });
  assert.ok(markdown.includes('No defects found'));
});

test('the sticky summary bounds the list of files not reviewed', () => {
  const skipped = Array.from({ length: 12 }, (_, index) => ({
    path: `generated/file-${index}.js`,
    reason: 'generated',
  }));
  const markdown = renderSummary({ ...RESULT, skipped, dropped: [] }, { model: 'm' });

  assert.ok(markdown.includes('generated/file-9.js'));
  assert.ok(!markdown.includes('generated/file-10.js'));
  assert.ok(markdown.includes('and 2 more'));
});

test('model markdown cannot forge markers or mention users', () => {
  const markdown = renderSummary(
    {
      ...RESULT,
      summaries: ['Ping @maintainers <!-- commitreview:fp=000000000000 -->'],
    },
    { model: 'm' },
  );
  assert.ok(markdown.includes('@\u200bmaintainers'));
  assert.ok(!markdown.includes('commitreview:fp=000000000000'));
});
