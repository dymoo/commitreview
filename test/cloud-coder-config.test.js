import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertAdmissibleIssue,
  modelForComplexity,
  parseAgentBrief,
  readConfig,
  reasoningEffortForComplexity,
} from '../cloud-coder/src/config.js';

const BRIEF = `## Desired behaviour
Add the missing guard.

## Non-goals
Do not alter the public API.

## Acceptance checks
- Missing input returns a 400 response.

## Test command
npm test

## Complexity
3

## Risks
Avoid changing the response schema.`;

test('parses an AFK-ready Agent Brief with a bounded complexity score', () => {
  assert.deepEqual(parseAgentBrief(BRIEF), { complexity: 3, testCommand: 'npm test' });
});

test('rejects an incomplete Agent Brief before dispatch', () => {
  assert.throws(() => parseAgentBrief('## Desired behaviour\nDo a thing.'), /missing required section/i);
  assert.throws(() => parseAgentBrief(BRIEF.replace('\n3\n', '\n6\n')), /complexity/i);
  assert.throws(() => parseAgentBrief(BRIEF.replace('npm test', 'npm test\nrm -rf /')), /one non-empty line/i);
});

test('accepts only an open ready-for-agent Issue', () => {
  const issue = {
    state: 'open',
    labels: [{ name: 'ready-for-agent' }],
  };

  assert.doesNotThrow(() => assertAdmissibleIssue(issue));
  assert.throws(() => assertAdmissibleIssue({ ...issue, state: 'closed' }), /open Issue/i);
  assert.throws(() => assertAdmissibleIssue({ ...issue, labels: [] }), /ready-for-agent/i);
  assert.throws(() => assertAdmissibleIssue({ ...issue, pull_request: {} }), /Issue rather than a pull request/i);
});

test('routes low and mid complexity to the configured low tier, higher complexity to the configured high tier', () => {
  const config = {
    lowComplexityModel: 'low-model',
    highComplexityModel: 'high-model',
    lowComplexityReasoningEffort: 'xhigh',
    highComplexityReasoningEffort: 'high',
  };
  assert.equal(modelForComplexity(config, 1), 'low-model');
  assert.equal(modelForComplexity(config, 3), 'low-model');
  assert.equal(modelForComplexity(config, 4), 'high-model');
  assert.equal(modelForComplexity(config, 5), 'high-model');
  assert.equal(reasoningEffortForComplexity(config, 1), 'xhigh');
  assert.equal(reasoningEffortForComplexity(config, 5), 'high');

  const withoutReasoningEffort = {
    lowComplexityModel: 'low-model',
    highComplexityModel: 'high-model',
    lowComplexityReasoningEffort: '',
    highComplexityReasoningEffort: '',
  };
  assert.equal(reasoningEffortForComplexity(withoutReasoningEffort, 1), '');
  assert.equal(reasoningEffortForComplexity(withoutReasoningEffort, 5), '');
});

test('requires generic model tier inputs', (t) => {
  const keys = [
    'GITHUB_API_URL',
    'INPUT_API-KEY',
    'INPUT_BASE-URL',
    'INPUT_GITHUB-TOKEN',
    'INPUT_HANDOFF-TOKEN',
    'INPUT_LOW-COMPLEXITY-MODEL',
    'INPUT_HIGH-COMPLEXITY-MODEL',
    'INPUT_LOW-COMPLEXITY-REASONING-EFFORT',
    'INPUT_HIGH-COMPLEXITY-REASONING-EFFORT',
    'INPUT_SANDBOX-IMAGE',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, {
    GITHUB_API_URL: 'https://api.github.test',
    'INPUT_API-KEY': 'model-secret',
    'INPUT_BASE-URL': 'https://model.test/v1',
    'INPUT_GITHUB-TOKEN': 'github-secret',
    'INPUT_HANDOFF-TOKEN': 'handoff-secret',
    'INPUT_LOW-COMPLEXITY-MODEL': 'configured-low',
    'INPUT_HIGH-COMPLEXITY-MODEL': 'configured-high',
    'INPUT_LOW-COMPLEXITY-REASONING-EFFORT': 'high',
    'INPUT_HIGH-COMPLEXITY-REASONING-EFFORT': 'xhigh',
    'INPUT_SANDBOX-IMAGE': 'example.test/image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });
  const config = readConfig();
  assert.equal(config.lowComplexityModel, 'configured-low');
  assert.equal(config.highComplexityModel, 'configured-high');
  assert.equal(config.lowComplexityReasoningEffort, 'high');
  assert.equal(config.highComplexityReasoningEffort, 'xhigh');

  process.env['INPUT_HIGH-COMPLEXITY-REASONING-EFFORT'] = 'unsupported';
  assert.throws(() => readConfig(), /high-complexity-reasoning-effort.*low.*medium.*high.*xhigh.*max/i);
  process.env['INPUT_HIGH-COMPLEXITY-REASONING-EFFORT'] = 'xhigh';

  delete process.env['INPUT_HIGH-COMPLEXITY-MODEL'];
  assert.throws(() => readConfig(), /high-complexity-model.*required/i);
});
