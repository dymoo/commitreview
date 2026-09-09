import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readIssueEvent } from '../cloud-coder/src/config.js';
import { createHandoffProof } from '../src/handoff.js';

function repairDispatch(overrides = {}) {
  const payload = { issue: 7, pull_request: 12, repair_round: 1, head_sha: 'headsha', ...overrides };
  return {
    action: 'shipyard-repair',
    client_payload: {
      ...payload,
      handoff_proof: createHandoffProof('handoff-secret', {
        direction: 'repair',
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

test('Cloud Coder action declares the bounded implementation contract', () => {
  const action = fs.readFileSync(new URL('../cloud-coder/action.yml', import.meta.url), 'utf8');
  assert.match(action, /^name: Shipyard Cloud Coder$/m);
  assert.match(action, /sandbox-image:/);
  assert.match(action, /low-complexity-model:/);
  assert.match(action, /high-complexity-model:/);
  assert.match(action, /low-complexity-model:\n {4}description:.*\n {4}required: true/);
  assert.match(action, /high-complexity-model:\n {4}description:.*\n {4}required: true/);
  assert.match(action, /low-complexity-reasoning-effort:/);
  assert.match(action, /high-complexity-reasoning-effort:/);
  assert.doesNotMatch(action, /(?:luna|terra)-(?:model|reasoning-effort)/);
  assert.match(action, /handoff-token:/);
  assert.doesNotMatch(action, /gpt-5\.6-(?:luna|terra)/);
  assert.match(action, /main: src\/index\.js/);
});

test('the Shipyard pilot workflow routes only ready Issues through a pinned Node sandbox', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/shipyard-coder.yml', import.meta.url), 'utf8');
  assert.match(workflow, /^name: Shipyard Cloud Coder$/m);
  assert.match(workflow, /github\.event\.label\.name == 'ready-for-agent'/);
  assert.match(workflow, /github\.event\.issue\.state == 'open'/);
  assert.match(workflow, /github\.event\.action == 'shipyard-repair'/);
  assert.match(workflow, /vars\.SHIPYARD_CODER_READY == 'true'/);
  assert.match(workflow, /low-complexity-model: \$\{\{ vars\.SHIPYARD_CODER_LOW_COMPLEXITY_MODEL \}\}/);
  assert.match(workflow, /high-complexity-model: \$\{\{ vars\.SHIPYARD_CODER_HIGH_COMPLEXITY_MODEL \}\}/);
  assert.match(workflow, /runs-on: shipyard-runners/);
  assert.match(workflow, /sandbox-image: node:20-bookworm-slim@sha256:[a-f0-9]{64}/);
  assert.match(workflow, /handoff-token: \$\{\{ secrets\.SHIPYARD_HANDOFF_TOKEN \}\}/);

  const example = fs.readFileSync(new URL('../examples/workflows/shipyard-coder.yml', import.meta.url), 'utf8');
  assert.match(example, /vars\.SHIPYARD_CODER_READY == 'true'/);
  assert.match(example, /vars\.LLM_BASE_URL != ''/);
  assert.match(example, /vars\.SHIPYARD_CODER_LOW_COMPLEXITY_MODEL != ''/);
  assert.match(example, /vars\.SHIPYARD_CODER_HIGH_COMPLEXITY_MODEL != ''/);
  assert.match(example, /github\.event\.issue\.state == 'open'/);
});

test('the Shipyard reviewer pilot targets the dedicated ARC scale set', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/shipyard-reviewer.yml', import.meta.url), 'utf8');
  assert.match(workflow, /^name: Shipyard Cloud Reviewer$/m);
  assert.match(workflow, /runs-on: shipyard-runners/);
  assert.match(workflow, /vars\.OPENROUTER_REVIEWER_ENABLED == 'true'/);

  const example = fs.readFileSync(new URL('../examples/workflows/shipyard-reviewer.yml', import.meta.url), 'utf8');
  assert.match(example, /vars\.LLM_BASE_URL != ''/);
  assert.match(example, /vars\.LLM_MODEL != ''/);

  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /Do \*\*not\*\* create a reviewer-only workflow from this README/);
  assert.match(readme, /`setup-shipyard`/);
  assert.doesNotMatch(readme, /^## Add Shipyard Cloud Reviewer$/m);
});

test('dispatches only when ready-for-agent labels an Issue', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-coder-event-'));
  const eventPath = path.join(dir, 'event.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const previous = Object.fromEntries(
    ['GITHUB_REPOSITORY', 'GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH'].map((key) => [key, process.env[key]]),
  );
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, {
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_EVENT_NAME: 'issues',
    GITHUB_EVENT_PATH: eventPath,
  });
  fs.writeFileSync(
    eventPath,
    JSON.stringify({ action: 'labeled', label: { name: 'ready-for-agent' }, issue: { number: 7 } }),
  );
  assert.deepEqual(readIssueEvent('handoff-secret'), { owner: 'o', repo: 'r', issueNumber: 7 });

  fs.writeFileSync(eventPath, JSON.stringify({ action: 'labeled', label: { name: 'bug' }, issue: { number: 7 } }));
  assert.match(readIssueEvent('handoff-secret').skip, /ready-for-agent/i);

  process.env.GITHUB_EVENT_NAME = 'repository_dispatch';
  fs.writeFileSync(eventPath, JSON.stringify(repairDispatch()));
  assert.deepEqual(readIssueEvent('handoff-secret'), {
    owner: 'o',
    repo: 'r',
    issueNumber: 7,
    pullNumber: 12,
    repairRound: 1,
    headSha: 'headsha',
  });

  fs.writeFileSync(
    eventPath,
    JSON.stringify({
      ...repairDispatch(),
      client_payload: { ...repairDispatch().client_payload, handoff_proof: 'forged' },
    }),
  );
  assert.throws(() => readIssueEvent('handoff-secret'), /requires a valid hand-off token and proof/i);

  fs.writeFileSync(eventPath, JSON.stringify(repairDispatch({ repair_round: 2 })));
  assert.match(readIssueEvent('handoff-secret').skip, /expected Issue, PR, commit, and round/i);
});
