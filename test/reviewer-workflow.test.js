import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(new URL('../.github/workflows/shipyard-reviewer.yml', import.meta.url), 'utf8');

test('the reviewer pilot uses isolated GLM high credentials and an effort-supporting pin', () => {
  assert.match(workflow, /uses: dymoo\/shipyard@efec252b39c55bc3d902d14d59286660046f9776/);
  assert.match(workflow, /model: z-ai\/glm-5\.3-flash/);
  assert.match(workflow, /reasoning-effort: high/);
  assert.match(workflow, /base-url: https:\/\/openrouter\.ai\/api\/v1/);
  assert.match(workflow, /secrets\.OPENROUTER_REVIEWER_API_KEY/);
  assert.doesNotMatch(workflow, /secrets\.LLM_API_KEY|vars\.LLM_MODEL|vars\.LLM_BASE_URL/);
});

test('the reviewer pilot retains readiness and trusted hand-off boundaries without checkout', () => {
  assert.match(workflow, /vars\.OPENROUTER_REVIEWER_ENABLED == 'true'/);
  assert.match(workflow, /handoff-token: \$\{\{ secrets\.SHIPYARD_HANDOFF_TOKEN \}\}/);
  assert.match(workflow, /github\.event\.action == 'shipyard-review'/);
  assert.match(workflow, /!startsWith\(github\.event\.pull_request\.head\.ref, 'shipyard\/issue-'\)/);
  assert.doesNotMatch(workflow, /uses: actions\/checkout|run:/);
});
