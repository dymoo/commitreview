import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// This skill installs independently of the action's source tree. Keep its input
// guard self-contained rather than importing the reviewer's runtime config.
const VALID_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;
const RUNNER_LABEL = /^[A-Za-z0-9_.-]+$/;
const IMAGE_DIGEST =
  /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const RUNNER_GROUP_ID = /^[1-9]\d*$/;
const GITHUB_HOSTED_RUNNERS = new Set([
  'ubuntu-latest',
  'ubuntu-24.04',
  'ubuntu-22.04',
  'ubuntu-20.04',
  'windows-latest',
  'windows-2025',
  'windows-2022',
  'windows-2019',
  'macos-latest',
  'macos-15',
  'macos-14',
  'macos-13',
  'macos-13-large',
]);
const SKILL_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const OPTIONS = new Set([
  '--mode',
  '--root',
  '--repository',
  '--runner-label',
  '--runner-group-id',
  '--model-secret',
  '--handoff-secret',
  '--sandbox-image',
  '--base-url',
  '--reviewer-model',
  '--low-complexity-model',
  '--high-complexity-model',
  '--low-complexity-reasoning-effort',
  '--high-complexity-reasoning-effort',
]);

export function validatePreflight(config) {
  requiredDirectory(config.root, 'Repository root');
  if (!REPOSITORY.test(config.repository)) throw new Error('Repository must be in owner/repository form.');
  if (localRepository(config) !== config.repository) {
    throw new Error('--repository must match the local origin remote.');
  }
  if (
    !RUNNER_LABEL.test(config.runnerLabel) ||
    !RUNNER_GROUP_ID.test(config.runnerGroupId) ||
    config.runnerLabel === 'self-hosted' ||
    GITHUB_HOSTED_RUNNERS.has(config.runnerLabel)
  ) {
    throw new Error('Runner label must be a dedicated GitHub label, never "self-hosted".');
  }
  for (const [name, value] of [
    ['Model secret', config.modelSecret],
    ['Hand-off secret', config.handoffSecret],
  ]) {
    if (!SECRET_NAME.test(value)) throw new Error(`${name} must be a GitHub Actions secret name.`);
  }
  if (config.modelSecret === config.handoffSecret) {
    throw new Error('Model and hand-off secrets must use different names.');
  }
  if (!IMAGE_DIGEST.test(config.sandboxImage)) {
    throw new Error('Sandbox image must be pinned to a lowercase SHA-256 digest.');
  }
  for (const [name, value] of [
    ['Base URL', config.baseUrl],
    ['Reviewer model', config.reviewerModel],
    ['Low-complexity model', config.lowComplexityModel],
    ['High-complexity model', config.highComplexityModel],
  ]) {
    if (typeof value !== 'string' || value.trim() !== value || !value) throw new Error(`${name} is required.`);
  }
  try {
    const url = new URL(config.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('invalid URL');
    }
  } catch {
    throw new Error('Base URL must be an absolute HTTP(S) URL without credentials, query, or fragment.');
  }
  for (const [name, value] of [
    ['Low-complexity reasoning effort', config.lowComplexityReasoningEffort],
    ['High-complexity reasoning effort', config.highComplexityReasoningEffort],
  ]) {
    if (value && !VALID_REASONING_EFFORTS.has(value)) {
      throw new Error(`${name} must be one of ${[...VALID_REASONING_EFFORTS].join(', ')}.`);
    }
  }
}

export function validateInstalled(config) {
  validatePreflight(config);
  validateWorkflow(config, 'shipyard-reviewer.yml');
  validateWorkflow(config, 'shipyard-coder.yml');
  validateAgents(config.root);
  validateLiveConfiguration(config);
  validateRunnerGroup(config);
}

function validateWorkflow(config, name) {
  const filePath = path.join(config.root, '.github', 'workflows', name);
  if (!fs.existsSync(filePath)) throw new Error(`Missing ${filePath}.`);
  const templatePath = path.join(SKILL_DIRECTORY, 'templates', name);
  const expected = configuredTemplate(fs.readFileSync(templatePath, 'utf8'), config);
  const actual = fs.readFileSync(filePath, 'utf8');
  if (normaliseNewlines(actual) !== normaliseNewlines(expected)) {
    throw new Error(`${name} must be the canonical Shipyard workflow with only configured substitutions.`);
  }
}

function requiredDirectory(value, name) {
  if (!value || !fs.statSync(value, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${name} does not exist.`);
  }
}

function configuredTemplate(template, config) {
  return template
    .replaceAll('shipyard-runners', config.runnerLabel)
    .replaceAll('secrets.LLM_API_KEY', `secrets.${config.modelSecret}`)
    .replaceAll('secrets.SHIPYARD_HANDOFF_TOKEN', `secrets.${config.handoffSecret}`)
    .replace('ghcr.io/acme/project-ci@sha256:replace-with-a-real-image-digest', config.sandboxImage);
}

function normaliseNewlines(value) {
  return value.replaceAll('\r\n', '\n');
}

function validateAgents(root) {
  const agentsPath = path.join(root, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) throw new Error('AGENTS.md must contain the Shipyard contract.');
  const actual = markdownSection(fs.readFileSync(agentsPath, 'utf8'), 'Shipyard');
  const templatePath = path.join(SKILL_DIRECTORY, 'templates', 'AGENTS.md');
  const expected = fs.readFileSync(templatePath, 'utf8');
  if (!actual || normaliseNewlines(actual).trimEnd() !== normaliseNewlines(expected).trimEnd()) {
    throw new Error('AGENTS.md must contain the complete Shipyard contract.');
  }
}

function markdownSection(document, name) {
  const headings = [...document.matchAll(new RegExp(`^## ${name}$`, 'gm'))];
  if (headings.length !== 1 || headings[0].index === undefined) return null;
  const heading = headings[0];
  const followingHeading = /^## /gm;
  followingHeading.lastIndex = heading.index + heading[0].length;
  const next = followingHeading.exec(document);
  return document.slice(heading.index, next?.index);
}

function validateLiveConfiguration(config) {
  const expectedVariables = {
    LLM_BASE_URL: config.baseUrl,
    LLM_MODEL: config.reviewerModel,
    SHIPYARD_CODER_LOW_COMPLEXITY_MODEL: config.lowComplexityModel,
    SHIPYARD_CODER_HIGH_COMPLEXITY_MODEL: config.highComplexityModel,
    SHIPYARD_CODER_READY: 'false',
  };
  const variables = Object.fromEntries(
    JSON.parse(runGh(config, ['variable', 'list', '--repo', config.repository, '--json', 'name,value'])).map(
      ({ name, value }) => [name, value],
    ),
  );
  for (const [name, expected] of Object.entries(expectedVariables)) {
    if (variables[name] !== expected) {
      throw new Error(`${name} must match the confirmed pre-enable configuration.`);
    }
  }
  validateOptionalReasoningEffort(
    variables,
    'SHIPYARD_CODER_LOW_COMPLEXITY_REASONING_EFFORT',
    config.lowComplexityReasoningEffort,
  );
  validateOptionalReasoningEffort(
    variables,
    'SHIPYARD_CODER_HIGH_COMPLEXITY_REASONING_EFFORT',
    config.highComplexityReasoningEffort,
  );
  const secretNames = JSON.parse(runGh(config, ['secret', 'list', '--repo', config.repository, '--json', 'name']));
  if (
    !Array.isArray(secretNames) ||
    ![config.modelSecret, config.handoffSecret].every((name) => secretNames.some(({ name: found }) => found === name))
  ) {
    throw new Error('Configured model and hand-off secret names must both exist in the repository.');
  }
}

function validateRunnerGroup(config) {
  const [owner] = config.repository.split('/');
  const group = JSON.parse(runGh(config, ['api', `/orgs/${owner}/actions/runner-groups/${config.runnerGroupId}`]));
  if (group.visibility !== 'selected' || group.allows_public_repositories || !group.restricted_to_workflows) {
    throw new Error('Runner group must be selected-repository, private, and restricted to workflows.');
  }
  const repositories = runGh(config, [
    'api',
    '--paginate',
    `/orgs/${owner}/actions/runner-groups/${config.runnerGroupId}/repositories`,
    '--jq',
    '.repositories[].full_name',
  ]).split('\n');
  if (repositories.length !== 1 || repositories[0] !== config.repository) {
    throw new Error('Runner group must grant access to exactly the target repository.');
  }
  const branch = runGh(config, [
    'repo',
    'view',
    config.repository,
    '--json',
    'defaultBranchRef',
    '--jq',
    '.defaultBranchRef.name',
  ]);
  const expectedWorkflows = [
    `${config.repository}/.github/workflows/shipyard-coder.yml@refs/heads/${branch}`,
    `${config.repository}/.github/workflows/shipyard-reviewer.yml@refs/heads/${branch}`,
  ].sort();
  if (
    !Array.isArray(group.selected_workflows) ||
    JSON.stringify([...group.selected_workflows].sort()) !== JSON.stringify(expectedWorkflows)
  ) {
    throw new Error('Runner group must allow exactly the two Shipyard workflows on the default branch.');
  }
  const labels = runGh(config, [
    'api',
    '--paginate',
    `/orgs/${owner}/actions/runner-groups/${config.runnerGroupId}/runners`,
    '--jq',
    '.runners[].labels[].name',
  ]).split('\n');
  if (!labels.includes(config.runnerLabel)) {
    throw new Error('Runner group must have a registered runner with the configured label before enablement.');
  }
}

function validateOptionalReasoningEffort(variables, name, expected) {
  if (expected ? variables[name] !== expected : Object.hasOwn(variables, name)) {
    throw new Error(`${name} must ${expected ? 'match the configured value' : 'be unset'}.`);
  }
}

function runGh(config, args) {
  try {
    return (config.execute ?? execFileSync)('gh', args, { encoding: 'utf8' }).trim();
  } catch (error) {
    throw new Error('Could not inspect live repository configuration with gh.', { cause: error });
  }
}

function localRepository(config) {
  let remote;
  try {
    remote = (config.readRemote ?? readOrigin)(config.root).trim();
  } catch (error) {
    throw new Error('Could not read the local origin remote.', { cause: error });
  }
  const match = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(remote);
  if (!match) throw new Error('Local origin remote must point to a GitHub owner/repository.');
  return match[1];
}

function readOrigin(root) {
  return execFileSync('git', ['-C', root, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' });
}

function parseArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!OPTIONS.has(key) || !value || values[key])
      throw new Error('Use each documented --key value argument exactly once.');
    values[key] = value;
  }
  const mode = values['--mode'];
  if (!['preflight', 'installed'].includes(mode)) throw new Error('--mode must be preflight or installed.');
  const config = {
    root: values['--root'],
    repository: values['--repository'],
    runnerLabel: values['--runner-label'],
    runnerGroupId: values['--runner-group-id'],
    modelSecret: values['--model-secret'],
    handoffSecret: values['--handoff-secret'],
    sandboxImage: values['--sandbox-image'],
    baseUrl: values['--base-url'],
    reviewerModel: values['--reviewer-model'],
    lowComplexityModel: values['--low-complexity-model'],
    highComplexityModel: values['--high-complexity-model'],
    lowComplexityReasoningEffort: values['--low-complexity-reasoning-effort'],
    highComplexityReasoningEffort: values['--high-complexity-reasoning-effort'],
  };
  return { mode, config };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { mode, config } = parseArguments(process.argv.slice(2));
  if (mode === 'preflight') validatePreflight(config);
  else validateInstalled(config);
  process.stdout.write(`Shipyard ${mode} validation passed.\n`);
}
