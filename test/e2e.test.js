/**
 * End-to-end run of the real entrypoint against a stub GitHub API and a stub
 * OpenAI-compatible endpoint. Everything the unit tests cannot reach — input
 * parsing, event resolution, the request sequence, what actually gets POSTed —
 * runs here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { APP_DIFF, APP_CONTENT } from './fixtures.js';

const ENTRY = fileURLToPath(new URL('../src/index.js', import.meta.url));

const FINDINGS = {
  summary: 'Adds a null guard around the user lookup.',
  findings: [
    {
      path: 'src/app.js',
      line: 12,
      side: 'RIGHT',
      severity: 'high',
      category: 'correctness',
      title: 'Returns null instead of a 404',
      body: 'When the user is missing the handler returns null, which the router renders as an empty 200.',
      confidence: 0.8,
    },
    {
      path: 'src/app.js',
      line: 4000,
      side: 'RIGHT',
      severity: 'medium',
      category: 'correctness',
      title: 'Hallucinated line that cannot be anchored',
      body: 'This line is nowhere near a hunk.',
      confidence: 0.4,
    },
  ],
};

/** A real gzipped tar laid out the way GitHub's tarball endpoint lays one out. */
function makeTarball(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commitreview-src-'));
  const top = 'o-r-headsha';
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, top, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const archive = path.join(dir, 'repo.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', dir, top]);
  return fs.readFileSync(archive);
}

const REPO_FILES = {
  'src/app.js': APP_CONTENT,
  'src/db.js': 'export const db = {\n  get(id) { return rows[id]; }, // undefined when missing\n};\n',
  'AGENTS.md': '# Rules\nEvery handler must return a Response.\n',
};

/** Serves both APIs and records everything it was asked to write. */
async function stubServer({ llmReply, rejectTools = false, repoFiles = REPO_FILES }) {
  const captured = { reviews: [], issueComments: [], llmRequests: [] };
  const tarball = makeTarball(repoFiles);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (status, body, type = 'application/json') => {
        res.writeHead(status, { 'content-type': type });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };

      if (url.pathname === `/repos/o/r/tarball/headsha`) {
        res.writeHead(200, { 'content-type': 'application/gzip' });
        return res.end(tarball);
      }

      if (url.pathname === '/v1/chat/completions') {
        const body = JSON.parse(raw);
        captured.llmRequests.push(body);
        if (rejectTools && body.tools) {
          return send(400, { error: { message: 'this model does not support tools' } });
        }
        const reply = llmReply(body);
        // A string is plain content; an object is a whole assistant message,
        // which is how a test drives tool calls.
        const message = typeof reply === 'string' ? { content: reply } : reply;
        return send(200, {
          choices: [{ message }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
      }
      if (url.pathname === '/repos/o/r/pulls/1' && req.method === 'GET') {
        if ((req.headers.accept || '').includes('diff')) return send(200, APP_DIFF, 'text/plain');
        return send(200, {
          number: 1,
          state: 'open',
          title: 'Guard the lookup',
          body: '',
          head: { sha: 'headsha' },
          base: { ref: 'main' },
        });
      }
      if (url.pathname === '/repos/o/r/contents/src/app.js') return send(200, APP_CONTENT, 'text/plain');
      if (url.pathname === '/repos/o/r/pulls/1/comments' && req.method === 'GET') return send(200, []);
      if (url.pathname === '/repos/o/r/issues/1/comments' && req.method === 'GET') return send(200, []);
      if (url.pathname === '/repos/o/r/pulls/1/reviews' && req.method === 'GET') return send(200, []);
      if (url.pathname === '/repos/o/r/pulls/1/commits') {
        return send(200, [{ sha: 'abc1234def', commit: { message: 'Guard the user lookup\n\nlonger body' } }]);
      }
      if (url.pathname === '/repos/o/r/pulls/1/reviews' && req.method === 'POST') {
        captured.reviews.push(JSON.parse(raw));
        return send(200, { id: 1 });
      }
      if (url.pathname === '/repos/o/r/issues/1/comments' && req.method === 'POST') {
        captured.issueComments.push(JSON.parse(raw));
        return send(201, { id: 2, html_url: 'https://example.invalid/c/2' });
      }
      send(404, { message: `unstubbed ${req.method} ${url.pathname}` });
    });
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(null));
  });
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { server, captured, port: address.port };
}

const isRefutation = (body) => String(body.messages[0].content).includes('kill mandate');

async function runAction(port, extraInputs = {}) {
  const { __event, ...inputs } = extraInputs;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'commitreview-'));
  const eventPath = path.join(tmp, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify(__event || { pull_request: { number: 1 } }));
  const outputPath = path.join(tmp, 'output.txt');
  fs.writeFileSync(outputPath, '');

  const env = {
    PATH: process.env.PATH,
    GITHUB_API_URL: `http://127.0.0.1:${port}`,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: outputPath,
    GITHUB_STEP_SUMMARY: path.join(tmp, 'summary.md'),
    RUNNER_TEMP: tmp,
    'INPUT_API-KEY': 'secret-key',
    INPUT_MODEL: 'stub-model',
    'INPUT_BASE-URL': `http://127.0.0.1:${port}/v1`,
    'INPUT_GITHUB-TOKEN': 'gh-token',
    // Repository context is exercised separately; most cases only care about
    // the review pipeline itself.
    'INPUT_REPO-CONTEXT': 'off',
    ...inputs,
  };

  const child = spawn(process.execPath, [ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  const code = await new Promise((resolve) => {
    child.on('close', resolve);
  });

  return { code, stdout, stderr, tmp, outputs: parseOutputs(fs.readFileSync(outputPath, 'utf8')) };
}

function parseOutputs(text) {
  const out = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^([a-z-]+)<<(.+)$/.exec(lines[i]);
    if (!m) continue;
    const end = lines.indexOf(m[2], i + 1);
    out[m[1]] = lines.slice(i + 1, end).join('\n');
    i = end;
  }
  return out;
}

test('reviews a pull request, anchors what it can and demotes what it cannot', async (t) => {
  const { server, captured, port } = await stubServer({
    llmReply: (body) =>
      isRefutation(body) ? '{"verdict":"real","reason":"confirmed in the diff"}' : JSON.stringify(FINDINGS),
  });
  t.after(() => server.close());

  const run = await runAction(port);
  assert.equal(run.code, 0, `action failed:\n${run.stderr}`);

  // The model was given real surrounding source, not just the three-line diff context.
  const findPass = captured.llmRequests.find((b) => !isRefutation(b));
  assert.match(findPass.messages[1].content, /^\s+7\s+7 ~ line 7$/m);
  assert.match(findPass.messages[1].content, /^\s+12 \+ {3}if \(!user\) return null;$/m);
  assert.match(findPass.messages[1].content, /^\s+11\s+- {3}const user = db\.get\(id\);$/m);

  // Both findings were verified; only the anchorable one became an inline comment.
  assert.equal(captured.llmRequests.filter(isRefutation).length, 2);
  assert.equal(captured.reviews.length, 1);
  assert.equal(captured.reviews[0].comments.length, 1);
  assert.deepEqual(
    {
      path: captured.reviews[0].comments[0].path,
      line: captured.reviews[0].comments[0].line,
      side: captured.reviews[0].comments[0].side,
    },
    { path: 'src/app.js', line: 12, side: 'RIGHT' },
  );
  assert.equal(captured.reviews[0].commit_id, 'headsha');
  assert.match(captured.reviews[0].comments[0].body, /Returns null instead of a 404/);

  const summary = captured.issueComments[0].body;
  assert.match(summary, /<!-- commitreview:summary -->/);
  assert.match(summary, /\*\*2 findings\*\*/);
  assert.match(summary, /could not be anchored/);
  assert.match(summary, /Hallucinated line/);

  assert.equal(run.outputs.reviewed, 'true');
  assert.equal(run.outputs.findings, '2');
  assert.ok(fs.existsSync(run.outputs['findings-json']));
  // ::add-mask:: is the one place the key is allowed: the runner consumes that
  // line and redacts the value everywhere else. It must appear nowhere else.
  const loggedWithoutMaskCommands = run.stdout
    .split('\n')
    .filter((l) => !l.startsWith('::add-mask::'))
    .join('\n');
  assert.ok(run.stdout.includes('::add-mask::secret-key'), 'the API key must be registered for masking');
  assert.ok(!loggedWithoutMaskCommands.includes('secret-key'), 'the API key must never reach the log');
  assert.ok(!loggedWithoutMaskCommands.includes('gh-token'), 'the GitHub token must never reach the log');
});

test('a refuted finding is never posted', async (t) => {
  const { server, captured, port } = await stubServer({
    llmReply: (body) =>
      isRefutation(body) ? '{"verdict":"not_real","reason":"the router handles null"}' : JSON.stringify(FINDINGS),
  });
  t.after(() => server.close());

  const run = await runAction(port);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(captured.reviews.length, 0);
  assert.match(captured.issueComments[0].body, /No defects found/);
  assert.match(captured.issueComments[0].body, /2 refuted/);
});

test('an unparseable review does not crash the run', async (t) => {
  const { server, captured, port } = await stubServer({ llmReply: () => 'I am afraid I cannot do that.' });
  t.after(() => server.close());

  const run = await runAction(port);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(captured.reviews.length, 0);
  assert.match(captured.issueComments[0].body, /No defects found/);
});

test('dry-run posts nothing', async (t) => {
  const { server, captured, port } = await stubServer({
    llmReply: (body) => (isRefutation(body) ? '{"verdict":"real"}' : JSON.stringify(FINDINGS)),
  });
  t.after(() => server.close());

  const run = await runAction(port, { 'INPUT_DRY-RUN': 'true' });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(captured.reviews.length, 0);
  assert.equal(captured.issueComments.length, 0);
  assert.equal(run.outputs.findings, '2');
});

test('fail-on turns a surviving finding into a failed step', async (t) => {
  const { server, port } = await stubServer({
    llmReply: (body) => (isRefutation(body) ? '{"verdict":"real"}' : JSON.stringify(FINDINGS)),
  });
  t.after(() => server.close());

  const run = await runAction(port, { 'INPUT_FAIL-ON': 'high' });
  assert.equal(run.code, 1);
  assert.match(run.stdout, /at or above severity "high"/);
});

/** A mention carrying a question, on a pull request. */
function mentionEvent(body) {
  return {
    issue: { number: 1, pull_request: {} },
    comment: { id: 42, body, author_association: 'OWNER', user: { login: 'alice', type: 'User' } },
  };
}

test('a mention with a question is answered, not reviewed', async (t) => {
  const { server, captured, port } = await stubServer({
    llmReply: () => 'The retry loop resets `attempt` on success, so the backoff is correct. See `src/app.js:11`.',
  });
  t.after(() => server.close());

  const run = await runAction(port, {
    GITHUB_EVENT_NAME: 'issue_comment',
    __event: mentionEvent('@commitreview is the backoff actually reset between attempts?'),
  });
  assert.equal(run.code, 0, run.stderr);

  // A question is a conversation: no review, no inline comments.
  assert.equal(captured.reviews.length, 0);
  assert.equal(run.outputs.reviewed, 'false');
  assert.equal(captured.issueComments.length, 1);
  assert.match(captured.issueComments[0].body, /backoff is correct/);
  assert.ok(!captured.issueComments[0].body.includes('commitreview:summary'), 'an answer is not a review summary');

  // The question and the discussion reach the model.
  const asked = captured.llmRequests[0].messages[1].content;
  assert.match(asked, /is the backoff actually reset between attempts\?/);
  assert.match(asked, /@alice asked/);
  assert.match(asked, /Guard the user lookup/, 'commit subjects are part of the context');
});

test('a bare mention still runs a review', async (t) => {
  const { server, captured, port } = await stubServer({
    llmReply: (body) => (isRefutation(body) ? '{"verdict":"real"}' : JSON.stringify(FINDINGS)),
  });
  t.after(() => server.close());

  const run = await runAction(port, {
    GITHUB_EVENT_NAME: 'issue_comment',
    __event: mentionEvent('@commitreview'),
  });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.outputs.reviewed, 'true');
  assert.equal(captured.reviews.length, 1);
});

test('the agent investigates with tools, and the findings pass carries the briefing', async (t) => {
  const { server, captured, port } = await stubServer({
    llmReply: (body) => {
      const system = String(body.messages[0].content);
      if (system.startsWith('You are investigating')) {
        // First turn: ask to read a file. Second turn: hand over the briefing.
        const alreadyRead = body.messages.some((m) => m.role === 'tool');
        if (!alreadyRead) {
          return {
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/db.js"}' } },
            ],
          };
        }
        return '## Evidence\n`src/db.js:2` — `get` returns undefined for a missing row, it does not throw.';
      }
      if (isRefutation(body)) return '{"verdict":"real"}';
      return JSON.stringify(FINDINGS);
    },
  });
  t.after(() => server.close());

  const run = await runAction(port, { 'INPUT_REPO-CONTEXT': 'auto', INPUT_AGENTIC: 'on' });
  assert.equal(run.code, 0, run.stderr);

  // The tool call was actually served from the repository.
  const toolResults = captured.llmRequests.flatMap((b) => b.messages.filter((m) => m.role === 'tool'));
  assert.ok(toolResults.length >= 1, 'the agent read a file');
  assert.match(toolResults[0].content, /undefined when missing/);

  // The briefing reaches the review pass as codebase context.
  const findPass = captured.llmRequests.find((b) =>
    String(b.messages[0].content).startsWith('You are a staff engineer'),
  );
  assert.match(findPass.messages[1].content, /BEGIN CODEBASE CONTEXT/);
  assert.match(findPass.messages[1].content, /it does not throw/);
  assert.match(String(findPass.messages[0].content), /work\s+through the listed callers/);

  assert.match(captured.issueComments[0].body, /codebase lookup/);
});

test('an endpoint that rejects tool calling falls back instead of failing', async (t) => {
  const { server, captured, port } = await stubServer({
    llmReply: (body) => (isRefutation(body) ? '{"verdict":"real"}' : JSON.stringify(FINDINGS)),
    rejectTools: true,
  });
  t.after(() => server.close());

  const run = await runAction(port, { 'INPUT_REPO-CONTEXT': 'auto', INPUT_AGENTIC: 'auto' });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(captured.reviews.length, 1, 'the review still happened');
  // Exactly one probe: the rejection is what discovers the limitation, and it
  // must not be repeated for every later request.
  assert.equal(captured.llmRequests.filter((b) => b.tools).length, 1);
  assert.ok(run.stdout.includes('Endpoint rejected tool calling'));
});

test('a panel reviews with every model, cross-checks, and lets the lead reconcile', async (t) => {
  const seenModels = [];
  const { server, captured, port } = await stubServer({
    llmReply: (body) => {
      seenModels.push(body.model);
      const system = String(body.messages[0].content);
      if (system.startsWith('You are the lead reviewer')) {
        return JSON.stringify({ summary: 'Reconciled.', keep: [{ index: 0, title: 'Merged title' }] });
      }
      if (isRefutation(body)) return '{"verdict":"real","reason":"confirmed"}';
      return JSON.stringify(FINDINGS);
    },
  });
  t.after(() => server.close());

  const run = await runAction(port, {
    INPUT_PANEL: `model: second-model\napi-key: second-key`,
    'INPUT_MODEL-LABEL': 'lead-model',
  });
  assert.equal(run.code, 0, run.stderr);

  // Both models actually reviewed.
  assert.ok(seenModels.includes('stub-model'), 'the lead model reviewed');
  assert.ok(seenModels.includes('second-model'), 'the panel member reviewed');

  // Agreement across models is recorded rather than deduplicated away.
  const posted = captured.reviews[0].comments[0].body;
  assert.match(posted, /found independently by lead-model and second-model/);

  // The lead reconciled, and the summary names the panel.
  assert.match(posted, /Merged title/);
  assert.match(captured.issueComments[0].body, /panel: `lead-model`, `second-model`/);
  assert.match(captured.issueComments[0].body, /Reconciled\./);

  // Neither key ever reaches the log.
  const logged = run.stdout
    .split('\n')
    .filter((l) => !l.startsWith('::add-mask::'))
    .join('\n');
  assert.ok(!logged.includes('second-key'), 'a panel api-key must be masked too');
  assert.ok(run.stdout.includes('::add-mask::second-key'));
});

test('a malformed panel fails the run rather than quietly reviewing with one model', async (t) => {
  const { server, port } = await stubServer({ llmReply: () => '{}' });
  t.after(() => server.close());

  const run = await runAction(port, { INPUT_PANEL: 'base-url: https://example.invalid/v1' });
  assert.equal(run.code, 1);
  assert.match(run.stdout, /missing "model"/);
});

test('an unrelated event is skipped without spending a request', async (t) => {
  const { server, captured, port } = await stubServer({ llmReply: () => '{}' });
  t.after(() => server.close());

  const run = await runAction(port, { GITHUB_EVENT_NAME: 'push' });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(captured.llmRequests.length, 0);
  assert.equal(run.outputs.reviewed, 'false');
});
