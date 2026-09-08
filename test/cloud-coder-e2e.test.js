/** End-to-end Cloud Coder run against stub APIs and a fake credential-free Docker command. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHandoffProof } from '../src/handoff.js';

const ENTRY = fileURLToPath(new URL('../cloud-coder/src/index.js', import.meta.url));
const IMAGE = `example.test/shipyard@sha256:${'a'.repeat(64)}`;

function makeTarball(files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-coder-source-'));
  const top = 'o-r-base-sha';
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(directory, top, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const archive = path.join(directory, 'repo.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', directory, top]);
  const data = fs.readFileSync(archive);
  fs.rmSync(directory, { recursive: true, force: true });
  return data;
}

async function stubServer() {
  const archive = makeTarball({ 'src/original.js': 'export const original = true;\n' });
  const captured = { dispatches: [], pulls: [], refUpdates: [], modelRequests: 0, modelBodies: [] };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      const send = (status, body, type = 'application/json') => {
        response.writeHead(status, { 'content-type': type });
        response.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      if (url.pathname === '/repos/o/r/tarball/base-sha') {
        response.writeHead(200, { 'content-type': 'application/gzip' });
        return response.end(archive);
      }
      if (url.pathname === '/repos/o/r/issues/7' && request.method === 'GET') {
        return send(200, issue());
      }
      if (url.pathname === '/repos/o/r/pulls' && request.method === 'GET') return send(200, []);
      if (url.pathname === '/repos/o/r/git/ref/heads/shipyard%2Fissue-7' && request.method === 'GET') {
        return send(404, { message: 'not found' });
      }
      if (url.pathname === '/repos/o/r' && request.method === 'GET') return send(200, { default_branch: 'main' });
      if (url.pathname === '/repos/o/r/git/ref/heads/main' && request.method === 'GET') {
        return send(200, { object: { sha: 'base-sha' } });
      }
      if (url.pathname === '/repos/o/r/git/refs' && request.method === 'POST') return send(201, {});
      if (url.pathname === '/repos/o/r/git/commits/base-sha' && request.method === 'GET') {
        return send(200, { tree: { sha: 'base-tree' } });
      }
      if (url.pathname === '/repos/o/r/git/trees/base-tree' && request.method === 'GET') return send(200, { tree: [] });
      if (url.pathname === '/repos/o/r/git/blobs' && request.method === 'POST') return send(201, { sha: 'new-blob' });
      if (url.pathname === '/repos/o/r/git/trees' && request.method === 'POST') return send(201, { sha: 'next-tree' });
      if (url.pathname === '/repos/o/r/git/commits' && request.method === 'POST')
        return send(201, { sha: 'next-commit' });
      if (url.pathname === '/repos/o/r/git/refs/heads/shipyard%2Fissue-7' && request.method === 'PATCH') {
        captured.refUpdates.push(JSON.parse(raw));
        return send(200, {});
      }
      if (url.pathname === '/repos/o/r/pulls' && request.method === 'POST') {
        captured.pulls.push(JSON.parse(raw));
        return send(201, { number: 12 });
      }
      if (url.pathname === '/repos/o/r/dispatches' && request.method === 'POST') {
        captured.dispatches.push(JSON.parse(raw));
        return send(204, '');
      }
      if (url.pathname === '/repos/o/r/issues/7/comments' && request.method === 'POST') return send(201, { id: 1 });
      if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
        captured.modelRequests++;
        captured.modelBodies.push(JSON.parse(raw));
        return send(200, modelReply(captured.modelRequests));
      }
      return send(404, { message: `unstubbed ${request.method} ${url.pathname}` });
    });
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(null));
  });
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { server, captured, port: address.port };
}

function issue() {
  return {
    number: 7,
    title: 'Add generated file',
    state: 'open',
    labels: [{ name: 'ready-for-agent' }],
    body: [
      '## Desired behaviour',
      'Create one generated source file.',
      '## Non-goals',
      'No refactor.',
      '## Acceptance checks',
      'The file exists.',
      '## Test command',
      'npm test',
      '## Complexity',
      '1',
      '## Risks',
      'None.',
    ].join('\n'),
  };
}

function modelReply(number) {
  const calls = [
    ['write_file', '{"path":"src/generated.js","content":"export const generated = true;\\n"}'],
    ['run_tests', '{}'],
    ['finish', '{"summary":"Added the generated source file and ran the required tests."}'],
  ];
  const [name, argumentsText] = calls[number - 1] || calls[2];
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id: `call-${number}`, type: 'function', function: { name, arguments: argumentsText } }],
        },
      },
    ],
  };
}

async function runAction(port, dockerDirectory) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-coder-run-'));
  const eventPath = path.join(directory, 'event.json');
  const outputPath = path.join(directory, 'output.txt');
  fs.writeFileSync(
    eventPath,
    JSON.stringify({ action: 'labeled', label: { name: 'ready-for-agent' }, issue: { number: 7 } }),
  );
  fs.writeFileSync(outputPath, '');
  const env = {
    PATH: `${dockerDirectory}:${process.env.PATH}`,
    GITHUB_API_URL: `http://127.0.0.1:${port}`,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_EVENT_NAME: 'issues',
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: outputPath,
    'INPUT_API-KEY': 'model-secret',
    'INPUT_GITHUB-TOKEN': 'github-secret',
    'INPUT_HANDOFF-TOKEN': 'handoff-secret',
    'INPUT_BASE-URL': `http://127.0.0.1:${port}/v1`,
    'INPUT_LOW-COMPLEXITY-MODEL': 'low-model',
    'INPUT_HIGH-COMPLEXITY-MODEL': 'high-model',
    'INPUT_LOW-COMPLEXITY-REASONING-EFFORT': 'xhigh',
    'INPUT_HIGH-COMPLEXITY-REASONING-EFFORT': 'xhigh',
    'INPUT_SANDBOX-IMAGE': IMAGE,
  };
  const child = spawn(process.execPath, [ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const code = await new Promise((resolve) => {
    child.on('close', resolve);
  });
  const output = fs.readFileSync(outputPath, 'utf8');
  fs.rmSync(directory, { recursive: true, force: true });
  return { code, stdout, stderr, output };
}

test('the Cloud Coder entrypoint tests and publishes one draft before dispatching review', async (t) => {
  const { server, captured, port } = await stubServer();
  t.after(() => server.close());
  const dockerDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-fake-docker-'));
  t.after(() => fs.rmSync(dockerDirectory, { recursive: true, force: true }));
  const docker = path.join(dockerDirectory, 'docker');
  fs.writeFileSync(docker, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(docker, 0o755);

  const run = await runAction(port, dockerDirectory);
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  assert.equal(captured.modelRequests, 3);
  assert.ok(captured.modelBodies.every((body) => body.reasoning_effort === 'xhigh'));
  assert.deepEqual(captured.pulls, [
    {
      title: 'Shipyard: Add generated file',
      head: 'shipyard/issue-7',
      base: 'main',
      draft: true,
      body: 'Implements #7. Generated by Shipyard Cloud Coder; awaiting Cloud Reviewer and human review.',
    },
  ]);
  assert.deepEqual(captured.refUpdates, [{ sha: 'next-commit', force: false }]);
  assert.deepEqual(captured.dispatches, [
    {
      event_type: 'shipyard-review',
      client_payload: {
        pull_request: 12,
        issue: 7,
        repair_round: 0,
        head_sha: 'next-commit',
        handoff_proof: createHandoffProof('handoff-secret', {
          direction: 'review',
          owner: 'o',
          repo: 'r',
          issue: 7,
          pull: 12,
          repairRound: 0,
          headSha: 'next-commit',
        }),
      },
    },
  ]);
  assert.match(run.output, /dispatched/);
  assert.match(run.output, /pull-request/);
  const logged = run.stdout
    .split('\n')
    .filter((line) => !line.startsWith('::add-mask::'))
    .join('\n');
  assert.ok(!logged.includes('model-secret'));
  assert.ok(!logged.includes('github-secret'));
  assert.ok(!logged.includes('handoff-secret'));
});
