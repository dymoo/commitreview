import test from 'node:test';
import assert from 'node:assert/strict';
import { isReviewRequest, findThread } from '../src/chat.js';
import { renderConversation } from '../src/review.js';
import { runTool } from '../src/agent.js';
import { DEFAULT_IGNORES, BOT_SIGNATURE } from '../src/config.js';

test('a bare mention or "review" means review; anything else is a question', () => {
  for (const bare of ['', '   ', 'review', 'Review', 're-review', 'take another look', 'again', 'check']) {
    assert.ok(isReviewRequest(bare), `"${bare}" should run a review`);
  }
  for (const question of [
    'why is this a race?',
    'review the migration for data loss',
    'is the retry backoff correct?',
    'what happens if the queue is full',
  ]) {
    assert.ok(!isReviewRequest(question), `"${question}" should be answered, not reviewed`);
  }
});

const CONVERSATION = {
  commits: [{ sha: 'abc1234def', commit: { message: 'Add retry\n\nlong body ignored' } }],
  issueComments: [
    { created_at: '2026-01-02', user: { login: 'alice' }, body: 'Why not use the existing helper?' },
    { created_at: '2026-01-03', user: { login: 'bot' }, body: 'summary <!-- commitreview:summary -->' },
  ],
  reviews: [{ submitted_at: '2026-01-04', state: 'CHANGES_REQUESTED', user: { login: 'bob' }, body: 'Needs a test.' }],
  reviewComments: [
    { id: 1, created_at: '2026-01-05', user: { login: 'bob' }, path: 'src/a.js', line: 12, body: 'Is this bounded?' },
    { id: 2, in_reply_to_id: 1, created_at: '2026-01-06', user: { login: 'alice' }, body: 'Yes, capped at 10.' },
  ],
};

test('the conversation renders commits, discussion and inline threads', () => {
  const text = renderConversation(CONVERSATION);
  assert.ok(text.includes('abc1234 Add retry'));
  assert.ok(!text.includes('long body ignored'), 'only the commit subject is useful');
  assert.ok(text.includes('@alice: Why not use the existing helper?'));
  assert.ok(text.includes('@bob (review: CHANGES_REQUESTED): Needs a test.'));
  assert.ok(text.includes('on src/a.js:12'));
  assert.ok(text.includes('@alice: Yes, capped at 10.'), 'a reply belongs under its root');
});

test('our own comments are excluded so the reviewer does not read itself', () => {
  assert.ok(!renderConversation(CONVERSATION).includes('commitreview:summary'));
});

// The summary carries a marker of its own, but the bot's free-text comments —
// chat answers, error notices, the review wrapper — only carry BOT_SIGNATURE.
// Without it they read back as human discussion and compound across re-runs.
test('the bot signature keeps our free-text comments out of the conversation', () => {
  const conversation = {
    issueComments: [
      { created_at: '2026-01-02', user: { login: 'alice' }, body: 'A genuine human question.' },
      { created_at: '2026-01-03', user: { login: 'bot' }, body: `Here is my answer.\n${BOT_SIGNATURE}` },
    ],
    reviews: [
      {
        submitted_at: '2026-01-04',
        user: { login: 'bot' },
        body: `**commitreview** left 2 comments.\n${BOT_SIGNATURE}`,
      },
    ],
  };
  const text = renderConversation(conversation);
  assert.ok(text.includes('A genuine human question.'), 'a real human comment survives');
  assert.ok(!text.includes('Here is my answer.'), 'our chat answer is filtered');
  assert.ok(!text.includes('left 2 comments'), 'our review wrapper is filtered');
});

test('an empty or missing conversation renders to nothing', () => {
  assert.equal(renderConversation(null), '');
  assert.equal(renderConversation({}), '');
});

test('a reply is matched to its whole thread, oldest first', () => {
  const thread = findThread(CONVERSATION, 2);
  assert.equal(thread.rootId, 1);
  assert.equal(thread.path, 'src/a.js');
  assert.equal(thread.line, 12);
  assert.deepEqual(
    thread.messages.map((m) => m.who),
    ['bob', 'alice'],
  );
  assert.equal(findThread(CONVERSATION, 999), null);
});

test('markers are stripped from thread messages handed to the model', () => {
  const conversation = {
    reviewComments: [
      { id: 5, user: { login: 'x' }, path: 'a.js', body: 'real text <!-- commitreview:fp=abc123abc123 -->' },
    ],
  };
  assert.equal(findThread(conversation, 5).messages[0].body, 'real text');
});

const repo = {
  list: async () => ['src/a.js', 'src/b.js', 'dist/bundle.js'],
  read: async (p) =>
    ({ 'src/a.js': 'line one\nline two\nline three', 'src/b.js': 'calls aThing()', 'dist/bundle.js': 'built' })[p] ??
    null,
};
const toolConfig = { ignore: DEFAULT_IGNORES, maxFileBytes: 400000 };

test('read_file returns numbered lines and refuses what it should', async () => {
  const ok = JSON.parse(await runTool('read_file', { path: 'src/a.js' }, { repo, config: toolConfig }));
  assert.match(ok.content, /^\s+1 {2}line one$/m);
  assert.equal(ok.of, 3);

  const missing = JSON.parse(await runTool('read_file', { path: 'nope.js' }, { repo, config: toolConfig }));
  assert.match(missing.error, /does not exist/);

  // An ignored path is excluded from review, so it is excluded from the agent.
  const ignored = JSON.parse(await runTool('read_file', { path: 'dist/bundle.js' }, { repo, config: toolConfig }));
  assert.match(ignored.error, /excluded/);

  const noPath = JSON.parse(await runTool('read_file', {}, { repo, config: toolConfig }));
  assert.match(noPath.error, /required/);
});

test('search reports hits with locations and rejects a bad pattern', async () => {
  const hit = JSON.parse(await runTool('search', { pattern: 'aThing' }, { repo, config: toolConfig }));
  assert.equal(hit.matches, 1);
  assert.deepEqual(hit.hits[0], { path: 'src/b.js', line: 1, text: 'calls aThing()' });

  const bad = JSON.parse(await runTool('search', { pattern: '([' }, { repo, config: toolConfig }));
  assert.match(bad.error, /invalid regular expression/);
});

test('list_files honours the ignore list and a glob', async () => {
  const all = JSON.parse(await runTool('list_files', {}, { repo, config: toolConfig }));
  assert.deepEqual(all.paths, ['src/a.js', 'src/b.js']);

  const globbed = JSON.parse(await runTool('list_files', { glob: 'src/b*' }, { repo, config: toolConfig }));
  assert.deepEqual(globbed.paths, ['src/b.js']);
});

test('an unknown tool is an error, not a crash', async () => {
  const out = JSON.parse(await runTool('rm_rf', {}, { repo, config: toolConfig }));
  assert.match(out.error, /unknown tool/);
});
