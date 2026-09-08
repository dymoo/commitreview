import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { validateInstalled, validatePreflight } from '../skills/setup-shipyard/validate.mjs';

const CONFIG = {
  repository: 'dymoo/example',
  runnerLabel: 'shipyard-runners',
  runnerGroupId: '42',
  modelSecret: 'LLM_API_KEY',
  handoffSecret: 'SHIPYARD_HANDOFF_TOKEN',
  sandboxImage: 'registry.example/ci@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  baseUrl: 'https://provider.example/v1',
  reviewerModel: 'provider/reviewer',
  lowComplexityModel: 'provider/low',
  highComplexityModel: 'provider/high',
  lowComplexityReasoningEffort: 'xhigh',
  highComplexityReasoningEffort: 'xhigh',
  readRemote() {
    return 'git@github.com:dymoo/example.git';
  },
  execute(_file, args) {
    if (args[0] === 'api' && args[1] === '/orgs/dymoo/actions/runner-groups/42') {
      return JSON.stringify({
        visibility: 'selected',
        allows_public_repositories: false,
        restricted_to_workflows: true,
        selected_workflows: [
          'dymoo/example/.github/workflows/shipyard-coder.yml@refs/heads/main',
          'dymoo/example/.github/workflows/shipyard-reviewer.yml@refs/heads/main',
        ],
      });
    }
    if (args[0] === 'api' && args.includes('/orgs/dymoo/actions/runner-groups/42/repositories')) {
      return 'dymoo/example';
    }
    if (args[0] === 'api' && args.includes('/orgs/dymoo/actions/runner-groups/42/runners')) {
      return 'self-hosted\nshipyard-runners';
    }
    if (args[0] === 'repo' && args[1] === 'view') return 'main';
    if (args[0] === 'variable' && args[1] === 'list') {
      return JSON.stringify(
        Object.entries({
          LLM_BASE_URL: 'https://provider.example/v1',
          LLM_MODEL: 'provider/reviewer',
          SHIPYARD_CODER_LOW_COMPLEXITY_MODEL: 'provider/low',
          SHIPYARD_CODER_HIGH_COMPLEXITY_MODEL: 'provider/high',
          SHIPYARD_CODER_LOW_COMPLEXITY_REASONING_EFFORT: 'xhigh',
          SHIPYARD_CODER_HIGH_COMPLEXITY_REASONING_EFFORT: 'xhigh',
          SHIPYARD_CODER_READY: 'false',
        }).map(([name, value]) => ({ name, value })),
      );
    }
    if (args[0] === 'secret' && args[1] === 'list') {
      return JSON.stringify([{ name: 'LLM_API_KEY' }, { name: 'SHIPYARD_HANDOFF_TOKEN' }]);
    }
    throw new Error(`Unexpected gh command: ${args.join(' ')}`);
  },
};

function configuredWorkflow(name) {
  return fs
    .readFileSync(new URL(`../skills/setup-shipyard/templates/${name}`, import.meta.url), 'utf8')
    .replaceAll('shipyard-runners', CONFIG.runnerLabel)
    .replaceAll('secrets.LLM_API_KEY', `secrets.${CONFIG.modelSecret}`)
    .replaceAll('secrets.SHIPYARD_HANDOFF_TOKEN', `secrets.${CONFIG.handoffSecret}`)
    .replace('ghcr.io/acme/project-ci@sha256:replace-with-a-real-image-digest', CONFIG.sandboxImage);
}

function writeInstalledFactory(root) {
  const workflowDirectory = path.join(root, '.github', 'workflows');
  fs.mkdirSync(workflowDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'AGENTS.md'),
    fs.readFileSync(new URL('../skills/setup-shipyard/templates/AGENTS.md', import.meta.url)),
  );
  for (const name of ['shipyard-reviewer.yml', 'shipyard-coder.yml']) {
    fs.writeFileSync(path.join(workflowDirectory, name), configuredWorkflow(name));
  }
}

test('the setup skill requires Matt workflows before configuring Shipyard', () => {
  const skill = fs.readFileSync(new URL('../skills/setup-shipyard/SKILL.md', import.meta.url), 'utf8');

  for (const name of ['triage', 'wayfinder', 'to-spec', 'to-tickets', 'implement', 'tdd', 'code-review']) {
    assert.match(skill, new RegExp(`^${name}$`, 'm'));
  }
  assert.match(skill, /report the exact missing names and stop/i);
  assert.match(skill, /Do not imitate the\s+missing workflow/i);
});

test('the setup skill installs only explicit, guarded Shipyard contracts', () => {
  const skill = fs.readFileSync(new URL('../skills/setup-shipyard/SKILL.md', import.meta.url), 'utf8');

  assert.match(skill, /dymoo\/shipyard@v3/);
  assert.match(skill, /dymoo\/shipyard\/cloud-coder@v4/);
  assert.match(skill, /never use the\s+broad `self-hosted` label/i);
  assert.match(skill, /SHA-256 digest-pinned Docker image/i);
  assert.match(skill, /SHIPYARD_CODER_READY=false/);
  assert.match(skill, /Do not enable Coder.*SHIPYARD_CODER_READY=true/is);
  assert.match(skill, /Do not print, write, or request secret values/i);
  assert.match(skill, /replace\s+`secrets\.LLM_API_KEY` and\s+`secrets\.SHIPYARD_HANDOFF_TOKEN`/i);
  assert.match(skill, /same hand-off secret name/i);
  assert.match(skill, /Coder and Reviewer use the confirmed runner label and its private/i);
  assert.match(skill, /complete canonical workflow/i);
  assert.match(skill, /never merge it into a Shipyard workflow/i);
  assert.match(skill, /use `gh secret list` to confirm both\s+names exist/i);
  assert.match(skill, /Clear\s+`SHIPYARD_CODER_READY` before either secret is removed or rotated/i);
  assert.match(skill, /validate\.mjs --mode preflight/);
  assert.match(skill, /validator again in `installed` mode/i);
  assert.match(skill, /Do not manufacture a test\s+Issue or apply `ready-for-agent`/i);
  assert.match(skill, /Merge this exact focused section into the target repository's root/i);
  assert.match(skill, /`templates\/AGENTS\.md` is the validator's source of truth/i);
});

test('the setup validator rejects unsafe inputs before workflow edits', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.doesNotThrow(() => validatePreflight({ root, ...CONFIG }));
  assert.throws(() => validatePreflight({ root, ...CONFIG, runnerLabel: 'self-hosted' }), /dedicated GitHub label/i);
  assert.throws(() => validatePreflight({ root, ...CONFIG, runnerLabel: 'ubuntu-latest' }), /dedicated GitHub label/i);
  assert.throws(() => validatePreflight({ root, ...CONFIG, runnerGroupId: 'none' }), /dedicated GitHub label/i);
  assert.throws(() => validatePreflight({ root, ...CONFIG, sandboxImage: 'node:20' }), /SHA-256 digest/i);
  assert.throws(
    () =>
      validatePreflight({
        root,
        ...CONFIG,
        sandboxImage: 'ghcr.io/acme//project@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    /SHA-256 digest/i,
  );
  assert.throws(() => validatePreflight({ root, ...CONFIG, handoffSecret: CONFIG.modelSecret }), /different names/i);
  assert.throws(() => validatePreflight({ root, ...CONFIG, repository: 'dymoo/other' }), /local origin remote/i);
  assert.throws(() => validatePreflight({ root, ...CONFIG, reviewerModel: '   ' }), /Reviewer model is required/i);
});

test('the setup validator accepts only a guarded installed factory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeInstalledFactory(root);

  assert.doesNotThrow(() => validateInstalled({ root, ...CONFIG }));
  fs.appendFileSync(path.join(root, '.github', 'workflows', 'shipyard-reviewer.yml'), '# uses: dymoo/shipyard@v3\n');
  assert.throws(() => validateInstalled({ root, ...CONFIG }), /canonical Shipyard workflow/i);

  writeInstalledFactory(root);
  const agentsPath = path.join(root, 'AGENTS.md');
  fs.appendFileSync(agentsPath, `\n${fs.readFileSync(agentsPath, 'utf8')}`);
  assert.throws(() => validateInstalled({ root, ...CONFIG }), /complete Shipyard contract/i);

  writeInstalledFactory(root);
  assert.throws(
    () =>
      validateInstalled({
        root,
        ...CONFIG,
        execute(file, args) {
          if (args[0] === 'variable' && args[1] === 'list') {
            return CONFIG.execute(file, args).replace('"false"', '"true"');
          }
          return CONFIG.execute(file, args);
        },
      }),
    /SHIPYARD_CODER_READY must match/i,
  );
  assert.throws(
    () => validateInstalled({ root, ...CONFIG, lowComplexityReasoningEffort: '', highComplexityReasoningEffort: '' }),
    /SHIPYARD_CODER_LOW_COMPLEXITY_REASONING_EFFORT must be unset/i,
  );
  assert.throws(
    () =>
      validateInstalled({
        root,
        ...CONFIG,
        execute(file, args) {
          if (args[0] === 'api' && args[1] === '/orgs/dymoo/actions/runner-groups/42') {
            return JSON.stringify({
              visibility: 'all',
              allows_public_repositories: false,
              restricted_to_workflows: true,
            });
          }
          return CONFIG.execute(file, args);
        },
      }),
    /Runner group must be selected-repository/i,
  );
  assert.throws(
    () =>
      validateInstalled({
        root,
        ...CONFIG,
        execute(file, args) {
          if (args[0] === 'api' && args.includes('/orgs/dymoo/actions/runner-groups/42/runners')) {
            return '';
          }
          return CONFIG.execute(file, args);
        },
      }),
    /registered runner with the configured label/i,
  );
});

test('the bundled templates stay identical to their published workflow examples', () => {
  for (const name of ['shipyard-reviewer.yml', 'shipyard-coder.yml']) {
    const template = fs.readFileSync(new URL(`../skills/setup-shipyard/templates/${name}`, import.meta.url), 'utf8');
    const example = fs.readFileSync(new URL(`../examples/workflows/${name}`, import.meta.url), 'utf8');
    assert.equal(template, example);
  }
});

test('the documented Shipyard contract stays identical to the enforced template', () => {
  const skill = fs.readFileSync(new URL('../skills/setup-shipyard/SKILL.md', import.meta.url), 'utf8');
  const documented =
    /`templates\/AGENTS\.md` is the validator's source of truth\.[\s\S]*?```md\n([\s\S]*?)\n {3}```/.exec(skill)?.[1];
  const template = fs.readFileSync(new URL('../skills/setup-shipyard/templates/AGENTS.md', import.meta.url), 'utf8');

  assert.ok(documented);
  assert.equal(documented.replace(/^ {3}/gm, ''), template.trimEnd());
});

test('the setup validator works when installed without the Shipyard source tree', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-portable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installed = path.join(root, 'setup-shipyard');
  fs.cpSync(new URL('../skills/setup-shipyard/', import.meta.url), installed, { recursive: true });
  const validator = pathToFileURL(path.join(installed, 'validate.mjs')).href;
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
    import assert from 'node:assert/strict';
    import { validatePreflight } from ${JSON.stringify(validator)};
    const config = ${JSON.stringify({ ...CONFIG, root })};
    config.readRemote = () => 'git@github.com:dymoo/example.git';
    validatePreflight(config);
    assert.throws(() => validatePreflight({ ...config, lowComplexityReasoningEffort: 'invalid' }));
  `,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('the setup validator refuses unknown command options', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [
    'skills/setup-shipyard/validate.mjs',
    '--mode',
    'preflight',
    '--root',
    root,
    '--repository',
    CONFIG.repository,
    '--runner-label',
    CONFIG.runnerLabel,
    '--runner-group-id',
    CONFIG.runnerGroupId,
    '--model-secret',
    CONFIG.modelSecret,
    '--handoff-secret',
    CONFIG.handoffSecret,
    '--sandbox-image',
    CONFIG.sandboxImage,
    '--base-url',
    CONFIG.baseUrl,
    '--reviewer-model',
    CONFIG.reviewerModel,
    '--low-complexity-model',
    CONFIG.lowComplexityModel,
    '--high-complexity-model',
    CONFIG.highComplexityModel,
    '--low-complexity-reasoning-effort',
    CONFIG.lowComplexityReasoningEffort,
    '--high-complexity-reasoning-effort',
    CONFIG.highComplexityReasoningEffort,
    '--runner-lable',
    CONFIG.runnerLabel,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr.toString(), /documented --key/i);
});
