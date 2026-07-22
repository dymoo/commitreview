import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEvent } from '../src/config.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'commitreview-event-'));

function withEvent(eventName, payload, fn) {
  const file = path.join(tmp, `${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  const saved = { ...process.env };
  process.env.GITHUB_REPOSITORY = 'o/r';
  process.env.GITHUB_EVENT_NAME = eventName;
  process.env.GITHUB_EVENT_PATH = file;
  try {
    return fn();
  } finally {
    process.env = saved;
  }
}

const defaults = {
  prNumber: null,
  triggerPhrase: '@commitreview',
  allowedAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'],
};

const comment = (over = {}) => ({
  issue: { number: 7, pull_request: {} },
  comment: { id: 99, body: '@commitreview have a look', author_association: 'OWNER', user: { type: 'User' } },
  ...over,
});

test('a mention from a collaborator schedules a review', () => {
  const ctx = withEvent('issue_comment', comment(), () => readEvent(defaults));
  assert.equal(ctx.prNumber, 7);
  assert.equal(ctx.trigger, 'mention');
  assert.equal(ctx.commentId, 99);
  assert.equal(ctx.focus, 'have a look');
});

test('a mention from an outsider is refused', () => {
  const payload = comment();
  payload.comment.author_association = 'NONE';
  const ctx = withEvent('issue_comment', payload, () => readEvent(defaults));
  assert.match(ctx.skip, /allowed-associations/);
  assert.equal(ctx.prNumber, undefined);
});

test('pr-number cannot be used to walk around the author gate', () => {
  const payload = comment();
  payload.comment.author_association = 'NONE';
  const ctx = withEvent('issue_comment', payload, () => readEvent({ ...defaults, prNumber: 7 }));
  assert.match(ctx.skip, /allowed-associations/);
});

test('allowed-associations ANY opens the gate deliberately', () => {
  const payload = comment();
  payload.comment.author_association = 'NONE';
  const ctx = withEvent('issue_comment', payload, () => readEvent({ ...defaults, allowedAssociations: ['ANY'] }));
  assert.equal(ctx.trigger, 'mention');
});

test('a comment without the trigger phrase, on an issue, or from a bot is ignored', () => {
  const noPhrase = comment();
  noPhrase.comment.body = 'looks good to me';
  assert.match(withEvent('issue_comment', noPhrase, () => readEvent(defaults)).skip, /does not contain/);

  const notPr = comment({ issue: { number: 7 } });
  assert.match(withEvent('issue_comment', notPr, () => readEvent(defaults)).skip, /not on a pull request/);

  const bot = comment();
  bot.comment.user.type = 'Bot';
  assert.match(withEvent('issue_comment', bot, () => readEvent(defaults)).skip, /bot/);
});

test('a review comment is marked so the reaction goes to the right endpoint', () => {
  const payload = {
    pull_request: { number: 12 },
    comment: { id: 5, body: '@commitreview', author_association: 'MEMBER', user: { type: 'User' } },
  };
  const ctx = withEvent('pull_request_review_comment', payload, () => readEvent(defaults));
  assert.equal(ctx.prNumber, 12);
  assert.equal(ctx.commentIsReview, true);
});

test('pull request events review the pull request they carry', () => {
  const ctx = withEvent('pull_request_target', { pull_request: { number: 3 } }, () => readEvent(defaults));
  assert.equal(ctx.prNumber, 3);
  assert.equal(ctx.trigger, 'pull_request_target');
});

test('an unrelated event is skipped unless pr-number says otherwise', () => {
  assert.match(withEvent('push', {}, () => readEvent(defaults)).skip, /unsupported event/);
  const forced = withEvent('workflow_dispatch', {}, () => readEvent({ ...defaults, prNumber: 42 }));
  assert.equal(forced.prNumber, 42);
  assert.equal(forced.trigger, 'input');
});
