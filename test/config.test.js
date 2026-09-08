import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig, readEvent, containsPhrase, extractFocus } from '../src/config.js';
import { createHandoffProof } from '../src/handoff.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-event-'));

function withEnv(values, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, values);
  try {
    return fn();
  } finally {
    process.env = saved;
  }
}

function withEvent(eventName, payload, fn, repository = 'o/r') {
  const eventPath = path.join(tmp, `${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(eventPath, JSON.stringify(payload));
  return withEnv(
    {
      GITHUB_REPOSITORY: repository,
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: eventPath,
    },
    fn,
  );
}

const comment = (overrides = {}) => ({
  issue: { number: 7, pull_request: {} },
  comment: {
    id: 99,
    body: '@shipyard focus on auth',
    author_association: 'OWNER',
    user: { type: 'User' },
  },
  ...overrides,
});

function reviewDispatch(overrides = {}) {
  const payload = { pull_request: 42, issue: 7, repair_round: 0, head_sha: 'headsha', ...overrides };
  return {
    action: 'shipyard-review',
    client_payload: {
      ...payload,
      handoff_proof: createHandoffProof('handoff-secret', {
        direction: 'review',
        owner: 'o',
        repo: 'r',
        issue: payload.issue,
        pull: payload.pull_request,
        repairRound: payload.repair_round,
        headSha: payload.head_sha,
      }),
    },
  };
}

test('a collaborator mention schedules a focused review', () => {
  const ctx = withEvent('issue_comment', comment(), readEvent);
  assert.equal(ctx.prNumber, 7);
  assert.equal(ctx.trigger, 'mention');
  assert.equal(ctx.focus, 'focus on auth');
});

test('comment reviews use a fixed author gate and ignore non-PR comments', () => {
  const outsider = comment();
  outsider.comment.author_association = 'NONE';
  assert.match(withEvent('issue_comment', outsider, readEvent).skip, /not allowed/);

  const bot = comment();
  bot.comment.user.type = 'Bot';
  assert.match(withEvent('issue_comment', bot, readEvent).skip, /bot/);

  assert.match(withEvent('issue_comment', comment({ issue: { number: 7 } }), readEvent).skip, /not on a pull request/);
});

test('pull request events run and unrelated events skip', () => {
  const pull = withEvent('pull_request_target', { pull_request: { number: 3 } }, readEvent);
  assert.equal(pull.prNumber, 3);
  assert.equal(pull.trigger, 'pull_request_target');
  assert.match(withEvent('push', {}, readEvent).skip, /unsupported event/);
});

test('a Shipyard repository dispatch schedules the named pull request', () => {
  const ctx = withEvent('repository_dispatch', reviewDispatch(), () => readEvent('handoff-secret'));
  assert.equal(ctx.prNumber, 42);
  assert.equal(ctx.trigger, 'cloud-coder');
  assert.equal(ctx.codingIssue, 7);
  assert.equal(ctx.repairRound, 0);
  assert.equal(ctx.headSha, 'headsha');
  assert.match(
    withEvent('repository_dispatch', reviewDispatch({ issue: undefined }), () => readEvent('handoff-secret')).skip,
    /Issue, commit, and repair round/,
  );
  assert.equal(
    withEvent('repository_dispatch', { action: 'other', client_payload: { pull_request: 42 } }, readEvent).skip,
    'repository dispatch is not for Shipyard review',
  );
});

test('a forged Cloud Coder review dispatch cannot enter the reviewer workflow', () => {
  const dispatch = reviewDispatch();
  dispatch.client_payload.handoff_proof = 'forged';
  assert.throws(
    () => withEvent('repository_dispatch', dispatch, () => readEvent('handoff-secret')),
    /requires a valid hand-off token and proof/i,
  );
});

test('a Coder review dispatch without the configured hand-off token fails visibly', () => {
  assert.throws(
    () => withEvent('repository_dispatch', reviewDispatch(), readEvent),
    /requires a valid hand-off token and proof/i,
  );
});

test('a proof from another repository cannot enter the reviewer workflow', () => {
  assert.throws(
    () => withEvent('repository_dispatch', reviewDispatch(), () => readEvent('handoff-secret'), 'other/r'),
    /requires a valid hand-off token and proof/i,
  );
});

test('trigger matching has a boundary and focus is bounded', () => {
  assert.ok(containsPhrase('hey @SHIPYARD please look'));
  assert.ok(!containsPhrase('@shipyarder go'));
  assert.equal(extractFocus('@shipyard check the migration'), 'check the migration');
  assert.equal(extractFocus('@shipyard'), '');
});

test('configuration has eight public inputs and no URL fallback', () => {
  const values = {
    'INPUT_API-KEY': 'model-secret',
    'INPUT_BASE-URL': 'https://models.example/v1///',
    INPUT_MODEL: 'reviewer',
    'INPUT_REASONING-EFFORT': 'high',
    'INPUT_GITHUB-TOKEN': 'github-secret',
    'INPUT_HANDOFF-TOKEN': 'handoff-secret',
    INPUT_INSTRUCTIONS: 'Use integer pence.',
    INPUT_IGNORE: 'private/**\n*.pem',
    GITHUB_API_URL: 'https://github.example/api/v3/',
  };
  const config = withEnv(values, readConfig);
  assert.equal(config.baseUrl, 'https://models.example/v1');
  assert.equal(config.githubApiUrl, 'https://github.example/api/v3');
  assert.equal(config.instructions, 'Use integer pence.');
  assert.equal(config.reasoningEffort, 'high');
  assert.equal(config.requestTimeoutMs, 600000);
  assert.equal(config.handoffToken, 'handoff-secret');
  assert.ok(config.ignore.includes('private/**'));

  const withoutReasoningEffort = { ...values };
  delete withoutReasoningEffort['INPUT_REASONING-EFFORT'];
  assert.equal(withEnv(withoutReasoningEffort, readConfig).reasoningEffort, '');
  assert.throws(
    () => withEnv({ ...values, 'INPUT_REASONING-EFFORT': 'unsupported' }, readConfig),
    /reasoning-effort.*low.*medium.*high.*xhigh.*max/i,
  );

  const withoutBase = { ...values };
  delete withoutBase['INPUT_BASE-URL'];
  assert.throws(
    () =>
      withEnv(withoutBase, () => {
        delete process.env['INPUT_BASE-URL'];
        return readConfig();
      }),
    /base-url.*required/,
  );

  assert.throws(
    () => withEnv({ ...values, 'INPUT_BASE-URL': 'file:///tmp/model' }, readConfig),
    /base-url must be an absolute HTTP\(S\) URL/,
  );
  assert.throws(
    () => withEnv({ ...values, 'INPUT_BASE-URL': 'https://models.example/v1?token=oops' }, readConfig),
    /must not contain a query string/,
  );
});

test('action metadata exposes only the eight supported inputs', () => {
  const action = fs.readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
  const inputBlock = action.slice(action.indexOf('inputs:'), action.indexOf('\noutputs:'));
  const names = [...inputBlock.matchAll(/^ {2}([a-z-]+):$/gm)].map((match) => match[1]);
  assert.deepEqual(names, [
    'api-key',
    'base-url',
    'model',
    'reasoning-effort',
    'github-token',
    'handoff-token',
    'instructions',
    'ignore',
  ]);
  assert.match(inputBlock, /base-url:\n {4}description:[^\n]+\n {4}required: true/);
  assert.match(inputBlock, /reasoning-effort:\n {4}description:[^\n]+\n {4}required: false/);
  assert.ok(!inputBlock.includes('https://api.openai.com'));
});
