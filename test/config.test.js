import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig, readEvent, containsPhrase, extractFocus } from '../src/config.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'commitreview-event-'));

function withEnv(values, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, values);
  try {
    return fn();
  } finally {
    process.env = saved;
  }
}

function withEvent(eventName, payload, fn) {
  const eventPath = path.join(tmp, `${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(eventPath, JSON.stringify(payload));
  return withEnv(
    {
      GITHUB_REPOSITORY: 'o/r',
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
    body: '@commitreview focus on auth',
    author_association: 'OWNER',
    user: { type: 'User' },
  },
  ...overrides,
});

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

test('trigger matching has a boundary and focus is bounded', () => {
  assert.ok(containsPhrase('hey @COMMITREVIEW please look'));
  assert.ok(!containsPhrase('@commitreviewer go'));
  assert.equal(extractFocus('@commitreview check the migration'), 'check the migration');
  assert.equal(extractFocus('@commitreview'), '');
});

test('configuration has six public inputs and no URL fallback', () => {
  const values = {
    'INPUT_API-KEY': 'model-secret',
    'INPUT_BASE-URL': 'https://models.example/v1///',
    INPUT_MODEL: 'reviewer',
    'INPUT_GITHUB-TOKEN': 'github-secret',
    INPUT_INSTRUCTIONS: 'Use integer pence.',
    INPUT_IGNORE: 'private/**\n*.pem',
    GITHUB_API_URL: 'https://github.example/api/v3/',
  };
  const config = withEnv(values, readConfig);
  assert.equal(config.baseUrl, 'https://models.example/v1');
  assert.equal(config.githubApiUrl, 'https://github.example/api/v3');
  assert.equal(config.instructions, 'Use integer pence.');
  assert.ok(config.ignore.includes('private/**'));

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

test('action metadata exposes only the six supported inputs', () => {
  const action = fs.readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
  const inputBlock = action.slice(action.indexOf('inputs:'), action.indexOf('\noutputs:'));
  const names = [...inputBlock.matchAll(/^ {2}([a-z-]+):$/gm)].map((match) => match[1]);
  assert.deepEqual(names, ['api-key', 'base-url', 'model', 'github-token', 'instructions', 'ignore']);
  assert.match(inputBlock, /base-url:\n {4}description:[^\n]+\n {4}required: true/);
  assert.ok(!inputBlock.includes('https://api.openai.com'));
});
