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
import { spawn } from 'node:child_process';
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

/** Serves both APIs and records everything it was asked to write. */
async function stubServer({ llmReply }) {
  const captured = { reviews: [], issueComments: [], llmRequests: [] };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (status, body, type = 'application/json') => {
        res.writeHead(status, { 'content-type': type });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };

      if (url.pathname === '/v1/chat/completions') {
        const body = JSON.parse(raw);
        captured.llmRequests.push(body);
        return send(200, {
          choices: [{ message: { content: llmReply(body) } }],
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

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(null)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { server, captured, port: address.port };
}

const isRefutation = (body) => String(body.messages[0].content).startsWith('You are verifying');

async function runAction(port, extraInputs = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'commitreview-'));
  const eventPath = path.join(tmp, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 1 } }));
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
    ...extraInputs,
  };

  const child = spawn(process.execPath, [ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  const code = await new Promise((r) => child.on('close', r));

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

test('an unrelated event is skipped without spending a request', async (t) => {
  const { server, captured, port } = await stubServer({ llmReply: () => '{}' });
  t.after(() => server.close());

  const run = await runAction(port, { GITHUB_EVENT_NAME: 'push' });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(captured.llmRequests.length, 0);
  assert.equal(run.outputs.reviewed, 'false');
});
