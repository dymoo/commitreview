import fs from 'node:fs';
import * as core from './core.js';

export const SEVERITIES = ['critical', 'high', 'medium', 'low'];
export const VERDICT_REAL = 'real';
export const VERDICT_NOT_REAL = 'not_real';
export const BOT_SIGNATURE = '<!-- commitreview:bot -->';

/** Lower rank is more severe. */
export const severityRank = (severity) => {
  const rank = SEVERITIES.indexOf(String(severity || '').toLowerCase());
  return rank === -1 ? SEVERITIES.indexOf('low') : rank;
};

export const DEFAULT_IGNORES = [
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/bun.lock',
  '**/bun.lockb',
  '**/Cargo.lock',
  '**/composer.lock',
  '**/Gemfile.lock',
  '**/poetry.lock',
  '**/uv.lock',
  '**/go.sum',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/*.snap',
  '**/__snapshots__/**',
  '**/dist/**',
  '**/build/**',
  '**/node_modules/**',
  '**/vendor/**',
  '**/.yarn/**',
  '**/*.pb.go',
  '**/*_pb2.py',
  '**/*_pb2.pyi',
  '**/*.pb.cc',
  '**/*.pb.h',
  '**/*.generated.*',
  '**/generated/**',
  '**/*.svg',
];

const TRIGGER_PHRASE = '@commitreview';
const ALLOWED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * Product limits are deliberate constants, not user-facing tuning knobs.
 * Raising one changes cost or safety and therefore belongs in a reviewed
 * release rather than an opaque workflow input.
 */
const LIMITS = {
  agentTurns: 12,
  maxFiles: 60,
  maxFileBytes: 400000,
  contextLines: 20,
  maxInputTokens: 120000,
  chunkTokens: 30000,
  concurrency: 4,
  maxFindings: 25,
  minSeverity: 'low',
  temperature: 0.1,
  maxOutputTokens: 16000,
  requestTimeoutMs: 180000,
};

export function readConfig() {
  const apiKey = requiredInput('api-key');
  core.mask(apiKey);

  const githubToken = requiredInput('github-token');
  core.mask(githubToken);

  const baseUrl = requiredHttpUrl('base-url', requiredInput('base-url'));
  const model = requiredInput('model');
  const githubApiUrl = requiredHttpUrl('GITHUB_API_URL', requiredEnv('GITHUB_API_URL'));

  return {
    apiKey,
    baseUrl,
    model,
    githubToken,
    githubApiUrl,
    instructions: core.getInput('instructions'),
    ignore: [...DEFAULT_IGNORES, ...core.getLines('ignore')],
    ...LIMITS,
  };
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

function requiredHttpUrl(name, value) {
  const cleaned = value.replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(cleaned);
  } catch (err) {
    throw new Error(`${name} must be an absolute HTTP(S) URL.`, { cause: err });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`${name} must be an absolute HTTP(S) URL without embedded credentials.`);
  }
  if (parsed.search || parsed.hash) throw new Error(`${name} must not contain a query string or fragment.`);
  return cleaned;
}

/**
 * @typedef {object} EventContext
 * @property {string} owner
 * @property {string} repo
 * @property {string} eventName
 * @property {any} payload
 * @property {number|null} [prNumber]
 * @property {string} [trigger]
 * @property {string} [focus]
 * @property {string} [skip]
 */

/**
 * Resolve the pull request and apply the fixed comment-trigger author gate.
 * @returns {EventContext}
 */
export function readEvent() {
  const [owner, repo] = requiredEnv('GITHUB_REPOSITORY').split('/');
  if (!owner || !repo) throw new Error('GITHUB_REPOSITORY must be in owner/repository form.');

  const eventName = requiredEnv('GITHUB_EVENT_NAME');
  const eventPath = requiredEnv('GITHUB_EVENT_PATH');
  if (!fs.existsSync(eventPath)) throw new Error(`GITHUB_EVENT_PATH does not exist: ${eventPath}`);
  const payload = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const base = { owner, repo, eventName, payload };

  if (eventName === 'issue_comment') {
    if (!payload.issue?.pull_request) return { ...base, skip: 'comment is not on a pull request' };

    const body = payload.comment?.body || '';
    if (!containsPhrase(body, TRIGGER_PHRASE)) {
      return { ...base, skip: `comment does not contain ${TRIGGER_PHRASE}` };
    }
    if (payload.comment?.user?.type === 'Bot') return { ...base, skip: 'comment was posted by a bot' };

    const association = String(payload.comment?.author_association || '').toUpperCase();
    if (!ALLOWED_ASSOCIATIONS.has(association)) {
      return { ...base, skip: `author association ${association || 'UNKNOWN'} is not allowed` };
    }

    return {
      ...base,
      prNumber: payload.issue.number,
      trigger: 'mention',
      focus: extractFocus(body, TRIGGER_PHRASE),
    };
  }

  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    return { ...base, prNumber: payload.pull_request?.number, trigger: eventName };
  }

  return { ...base, skip: `unsupported event "${eventName}"` };
}

/** Word-boundary-ish match so "@commitreviewer" does not trigger a review. */
export function containsPhrase(body, phrase = TRIGGER_PHRASE) {
  const index = body.toLowerCase().indexOf(phrase.toLowerCase());
  if (index === -1) return false;
  const after = body[index + phrase.length];
  return after === undefined || !/[\w-]/.test(after);
}

export function extractFocus(body, phrase = TRIGGER_PHRASE) {
  const index = body.toLowerCase().indexOf(phrase.toLowerCase());
  if (index === -1) return '';
  return body
    .slice(index + phrase.length)
    .trim()
    .slice(0, 2000);
}
