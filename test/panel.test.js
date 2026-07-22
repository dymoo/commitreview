import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePanel, TASTE_LENS, LENSES } from '../src/config.js';
import { synthesise } from '../src/review.js';
import { systemPrompt, TASTE_REFUTE_SYSTEM, REFUTE_SYSTEM } from '../src/prompts.js';

const LEAD = { model: 'kimi-k3', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'lead-key' };

test('a panel entry states what it needs and inherits the rest', () => {
  const panel = parsePanel(
    `model: gpt-5.6
     base-url: https://api.openai.com/v1
     api-key: openai-key

     model: kimi-k3-thinking`,
    LEAD,
  );

  assert.equal(panel.length, 2);
  assert.deepEqual(panel[0], {
    model: 'gpt-5.6',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'openai-key',
    label: 'gpt-5.6',
  });
  // A second model on the lead's provider is a one-line entry.
  assert.deepEqual(panel[1], {
    model: 'kimi-k3-thinking',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'lead-key',
    label: 'kimi-k3-thinking',
  });
});

test('a panel entry accepts a label, comments and list dashes', () => {
  const panel = parsePanel(
    `# the other lab
     - model: claude-sonnet-4-5
       base-url: https://api.anthropic.com/v1
       api-key: anthropic-key
       label: claude`,
    LEAD,
  );
  assert.equal(panel[0].label, 'claude');
  assert.equal(panel[0].model, 'claude-sonnet-4-5');
});

test('an empty panel is not an error', () => {
  assert.deepEqual(parsePanel('', LEAD), []);
  assert.deepEqual(parsePanel('   \n\n  ', LEAD), []);
});

test('a malformed panel entry fails loudly rather than silently reviewing with one model', () => {
  assert.throws(() => parsePanel('base-url: https://x/v1', LEAD), /missing "model"/);
  assert.throws(() => parsePanel('model: x\nthis is not a pair', LEAD), /not "key: value"/);
  assert.throws(() => parsePanel('model: x', { ...LEAD, apiKey: '' }), /no api-key/);
});

test('trailing slashes on a panel base-url are normalised like the lead', () => {
  assert.equal(parsePanel('model: m\nbase-url: https://x/v1///', LEAD)[0].baseUrl, 'https://x/v1');
});

test('the taste lens brings its own admission test, not the defect one', () => {
  const taste = systemPrompt({ maxFindings: 5 }, { lens: TASTE_LENS });
  assert.ok(taste.includes('Was this complexity deliberately chosen'));
  assert.ok(taste.includes('You can name the specific existing code'));
  // The defect gate asks for a crash trigger, which taste findings do not have.
  assert.ok(!taste.includes('Can you name the concrete input'));

  const general = systemPrompt({ maxFindings: 5 }, { lens: LENSES[0] });
  assert.ok(general.includes('Can you name the concrete input'));
  assert.ok(!general.includes('Was this complexity deliberately chosen'));
});

test('the taste lens protects the things simplicity must never remove', () => {
  const taste = systemPrompt({ maxFindings: 5 }, { lens: TASTE_LENS });
  for (const guarded of ['Input validation at a trust boundary', 'security controls', 'accessibility basics']) {
    assert.ok(taste.includes(guarded), `${guarded} must be named as off-limits`);
  }
  // A shortcut that records its own ceiling is a decision, not slop.
  assert.ok(taste.includes('ponytail: global lock'));
});

test('taste findings are judged by a skeptic that does not require a crash', () => {
  // The defect skeptic kills anything that is "a preference rather than a
  // defect", which would destroy every taste finding by construction.
  assert.ok(REFUTE_SYSTEM.includes('preference'));
  assert.ok(TASTE_REFUTE_SYSTEM.includes('Do not kill it merely because the code would still run'));
  assert.ok(TASTE_REFUTE_SYSTEM.includes('never slop'));
});

/** A model that returns one canned JSON payload. */
const fakeLLM = (payload) => ({
  label: 'lead',
  usage: { requests: 0, prompt: 0, completion: 0 },
  json: async () => payload,
});

const FINDINGS = [
  { path: 'a.js', line: 1, side: 'RIGHT', severity: 'low', title: 'A', body: 'a', confidence: 0.5, foundBy: ['kimi'] },
  { path: 'b.js', line: 2, side: 'RIGHT', severity: 'low', title: 'B', body: 'b', confidence: 0.5, foundBy: ['gpt'] },
  { path: 'c.js', line: 3, side: 'RIGHT', severity: 'low', title: 'C', body: 'c', confidence: 0.5, foundBy: ['gpt'] },
];

test('synthesis rewords and merges but can never relocate a finding', async () => {
  const llm = fakeLLM({
    summary: 'Adds a cache.',
    keep: [
      { index: 0, title: 'Clearer title', severity: 'high', merged: [1] },
      // A hostile or confused response tries to move a finding to another file.
      { index: 2, path: 'evil.js', line: 9999, side: 'LEFT' },
    ],
    drop: [],
  });

  const out = await synthesise(llm, FINDINGS, { pr: { number: 1, title: 't' } });
  assert.equal(out.summary, 'Adds a cache.');
  assert.equal(out.findings.length, 2);

  assert.equal(out.findings[0].title, 'Clearer title');
  assert.equal(out.findings[0].severity, 'high');
  assert.deepEqual(out.findings[0].foundBy, ['kimi', 'gpt'], 'a merge credits both models');
  assert.equal(out.findings[0].path, 'a.js', 'the anchor is never taken from the model');

  // Fields the synthesis tried to invent are ignored entirely.
  assert.equal(out.findings[1].path, 'c.js');
  assert.equal(out.findings[1].line, 3);
  assert.equal(out.findings[1].side, 'RIGHT');
});

test('synthesis ignores out-of-range and repeated indices', async () => {
  const llm = fakeLLM({ keep: [{ index: 0 }, { index: 0 }, { index: 99 }, { index: -1 }, { index: 'x' }] });
  const out = await synthesise(llm, FINDINGS, { pr: { number: 1 } });
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].path, 'a.js');
});

test('an unusable synthesis keeps every finding rather than losing them', async () => {
  for (const bad of [null, {}, { keep: 'nonsense' }]) {
    const out = await synthesise(fakeLLM(bad), FINDINGS, { pr: { number: 1 } });
    assert.equal(out.findings.length, 3, 'findings survive a failed synthesis');
  }
  // A synthesis that keeps nothing is treated as a failure, not as "all clear".
  const emptied = await synthesise(fakeLLM({ keep: [] }), FINDINGS, { pr: { number: 1 } });
  assert.equal(emptied.findings.length, 3);
});

test('a single finding skips synthesis entirely', async () => {
  let called = false;
  const llm = { label: 'x', json: async () => ((called = true), {}) };
  const out = await synthesise(llm, [FINDINGS[0]], { pr: { number: 1 } });
  assert.equal(called, false);
  assert.deepEqual(out.findings, [FINDINGS[0]]);
});
