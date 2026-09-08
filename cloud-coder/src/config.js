import fs from 'node:fs';
import * as core from '../../src/core.js';
import { validateReasoningEffort } from '../../src/config.js';
import { verifiesHandoffProof } from '../../src/handoff.js';

const REQUIRED_SECTIONS = [
  'Desired behaviour',
  'Non-goals',
  'Acceptance checks',
  'Test command',
  'Complexity',
  'Risks',
];

/** Parse the brief before spending a model request or touching a sandbox. */
export function parseAgentBrief(brief) {
  if (typeof brief !== 'string' || brief.trim() === '') throw new Error('Agent Brief is required.');
  const sections = new Map();
  let name = null;
  let content = [];
  for (const line of brief.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (name) sections.set(name, content.join('\n').trim());
      name = heading[1].trim().toLowerCase();
      content = [];
    } else if (name) {
      content.push(line);
    }
  }
  if (name) sections.set(name, content.join('\n').trim());

  for (const name of REQUIRED_SECTIONS) {
    if (!sections.get(name.toLowerCase())) throw new Error(`Agent Brief is missing required section "${name}".`);
  }

  const complexity = Number(sections.get('complexity'));
  if (!Number.isInteger(complexity) || complexity < 1 || complexity > 5) {
    throw new Error('Agent Brief complexity must be an integer from 1 to 5.');
  }

  const testCommand = sections.get('test command');
  if (testCommand.includes('\n') || testCommand.includes('\r')) {
    throw new Error('Agent Brief test command must be one non-empty line.');
  }
  return { complexity, testCommand };
}

/** Reject unsafe admission before the model sees source or receives tools. */
export function assertAdmissibleIssue(issue) {
  if (!issue || issue.state !== 'open') throw new Error('Cloud Coder accepts only open Issues.');
  if (issue.pull_request) throw new Error('Cloud Coder accepts an Issue rather than a pull request.');
  if (!issue.labels?.some((label) => label.name === 'ready-for-agent')) {
    throw new Error('Cloud Coder requires the ready-for-agent label.');
  }
}

const LIMITS = Object.freeze({ requestTimeoutMs: 600000 });

/** Read the separate Cloud Coder Action contract. */
export function readConfig() {
  const apiKey = requiredInput('api-key');
  core.mask(apiKey);
  const githubToken = requiredInput('github-token');
  core.mask(githubToken);
  const handoffToken = requiredInput('handoff-token');
  core.mask(handoffToken);
  return {
    apiKey,
    githubToken,
    handoffToken,
    baseUrl: requiredUrl('base-url', requiredInput('base-url')),
    lowComplexityModel: requiredInput('low-complexity-model'),
    highComplexityModel: requiredInput('high-complexity-model'),
    lowComplexityReasoningEffort: validateReasoningEffort(
      core.getInput('low-complexity-reasoning-effort'),
      'low-complexity-reasoning-effort',
    ),
    highComplexityReasoningEffort: validateReasoningEffort(
      core.getInput('high-complexity-reasoning-effort'),
      'high-complexity-reasoning-effort',
    ),
    sandboxImage: requiredInput('sandbox-image'),
    githubApiUrl: requiredUrl('GITHUB_API_URL', requiredEnv('GITHUB_API_URL')),
    ...LIMITS,
  };
}

export function modelForComplexity(config, complexity) {
  if (!Number.isInteger(complexity) || complexity < 1 || complexity > 5) {
    throw new Error('Cloud Coder complexity must be an integer from 1 to 5.');
  }
  return complexity <= 3 ? config.lowComplexityModel : config.highComplexityModel;
}

export function reasoningEffortForComplexity(config, complexity) {
  if (!Number.isInteger(complexity) || complexity < 1 || complexity > 5) {
    throw new Error('Cloud Coder complexity must be an integer from 1 to 5.');
  }
  return complexity <= 3 ? config.lowComplexityReasoningEffort : config.highComplexityReasoningEffort;
}

/** Resolve a new ready-for-agent Issue or one bounded reviewer-repair event. */
export function readIssueEvent(handoffToken = '') {
  const [owner, repo] = requiredEnv('GITHUB_REPOSITORY').split('/');
  if (!owner || !repo) throw new Error('GITHUB_REPOSITORY must be in owner/repository form.');
  const eventName = requiredEnv('GITHUB_EVENT_NAME');
  const eventPath = requiredEnv('GITHUB_EVENT_PATH');
  if (!fs.existsSync(eventPath)) throw new Error(`GITHUB_EVENT_PATH does not exist: ${eventPath}`);
  const payload = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  if (eventName === 'repository_dispatch') {
    if (payload.action !== 'shipyard-repair')
      return { owner, repo, skip: 'repository dispatch is not for Shipyard repair' };
    const issueNumber = payload.client_payload?.issue;
    const pullNumber = payload.client_payload?.pull_request;
    const repairRound = payload.client_payload?.repair_round;
    const headSha = payload.client_payload?.head_sha;
    if (
      !Number.isInteger(issueNumber) ||
      !Number.isInteger(pullNumber) ||
      repairRound !== 1 ||
      typeof headSha !== 'string' ||
      !headSha
    ) {
      return { owner, repo, skip: 'repair dispatch did not include the expected Issue, PR, commit, and round' };
    }
    if (
      !handoffToken ||
      !verifiesHandoffProof(
        handoffToken,
        { direction: 'repair', owner, repo, issue: issueNumber, pull: pullNumber, repairRound, headSha },
        payload.client_payload?.handoff_proof,
      )
    ) {
      throw new Error('Shipyard repair dispatch requires a valid hand-off token and proof.');
    }
    return { owner, repo, issueNumber, pullNumber, repairRound, headSha };
  }
  if (eventName !== 'issues' || payload.action !== 'labeled' || payload.label?.name !== 'ready-for-agent') {
    return { owner, repo, skip: 'event is not a ready-for-agent Issue label' };
  }
  if (!Number.isInteger(payload.issue?.number)) return { owner, repo, skip: 'event did not include an Issue number' };
  return { owner, repo, issueNumber: payload.issue.number };
}

function requiredInput(name) {
  const value = core.getInput(name);
  if (value) return value;
  throw new Error(`Input "${name}" is required and resolved to an empty value.`);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (value) return value;
  throw new Error(`${name} is required.`);
}

function requiredUrl(name, value) {
  const cleaned = value.replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(cleaned);
  } catch (error) {
    throw new Error(`${name} must be an absolute HTTP(S) URL.`, { cause: error });
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${name} must be an absolute HTTP(S) URL without credentials, query, or fragment.`);
  }
  return cleaned;
}
