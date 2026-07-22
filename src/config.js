import fs from 'node:fs';
import * as core from './core.js';

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'nit'];
/** Lower rank is more severe. */
export const severityRank = (s) => {
  const i = SEVERITIES.indexOf(String(s || '').toLowerCase());
  return i === -1 ? SEVERITIES.indexOf('low') : i;
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

export function readConfig() {
  const apiKey = core.getInput('api-key');
  if (!apiKey) {
    throw new Error(
      'Input "api-key" is required and resolved to an empty value. If this is a pull request from a fork, ' +
        'note that GitHub does not expose secrets to `pull_request` runs — use `pull_request_target` or the ' +
        'comment trigger instead. See https://github.com/dymoo/commitreview#security',
    );
  }
  // Masked immediately so nothing downstream can leak it into the log.
  core.mask(apiKey);

  const model = core.getInput('model');
  if (!model) throw new Error('Input "model" is required.');

  const minSeverity = core.getInput('min-severity', 'low').toLowerCase();
  if (!SEVERITIES.includes(minSeverity)) {
    throw new Error(`Input "min-severity" must be one of ${SEVERITIES.join(', ')}`);
  }
  const failOn = core.getInput('fail-on', 'none').toLowerCase();
  if (failOn !== 'none' && !SEVERITIES.includes(failOn)) {
    throw new Error(`Input "fail-on" must be "none" or one of ${SEVERITIES.join(', ')}`);
  }
  const summaryMode = core.getInput('summary-mode', 'sticky').toLowerCase();
  if (!['sticky', 'new', 'off'].includes(summaryMode)) {
    throw new Error('Input "summary-mode" must be sticky, new or off');
  }
  const jsonMode = core.getInput('json-mode', 'auto').toLowerCase();
  if (!['auto', 'on', 'off'].includes(jsonMode)) {
    throw new Error('Input "json-mode" must be auto, on or off');
  }

  const githubToken = core.getInput('github-token');
  if (!githubToken) throw new Error('Input "github-token" is required.');
  core.mask(githubToken);

  return {
    apiKey,
    model,
    baseUrl: core.getInput('base-url', 'https://api.openai.com/v1').replace(/\/+$/, ''),
    githubToken,
    prNumber: core.getNumber('pr-number', 0) || null,
    triggerPhrase: core.getInput('trigger-phrase', '@commitreview'),
    allowedAssociations: core.getCsv('allowed-associations', 'OWNER,MEMBER,COLLABORATOR').map((s) => s.toUpperCase()),

    include: core.getLines('include'),
    ignore: [...(core.getBool('use-default-ignores', true) ? DEFAULT_IGNORES : []), ...core.getLines('ignore')],

    maxFiles: core.getNumber('max-files', 60),
    maxFileBytes: core.getNumber('max-file-bytes', 400000),
    contextLines: Math.max(0, core.getNumber('context-lines', 20)),
    maxInputTokens: core.getNumber('max-input-tokens', 120000),
    chunkTokens: core.getNumber('chunk-tokens', 30000),
    concurrency: Math.max(1, core.getNumber('concurrency', 4)),

    maxFindings: core.getNumber('max-findings', 25),
    minSeverity,
    refute: core.getBool('refute', true),
    refuteVotes: Math.max(1, core.getNumber('refute-votes', 1)),
    instructions: core.getInput('instructions', ''),

    inlineComments: core.getBool('inline-comments', true),
    summaryMode,
    suggestions: core.getBool('suggestions', true),
    failOn,
    dryRun: core.getBool('dry-run', false),

    temperature: core.getNumber('temperature', 0.1),
    maxOutputTokens: core.getNumber('max-output-tokens', 8000),
    jsonMode,
    requestTimeoutMs: core.getNumber('request-timeout', 180) * 1000,
  };
}

/**
 * @typedef {object} EventContext
 * @property {string} owner
 * @property {string} repo
 * @property {string} eventName
 * @property {any} payload
 * @property {number|null} commentId
 * @property {boolean} [commentIsReview] the comment lives on a review, not the issue timeline
 * @property {number|null} [prNumber]
 * @property {string} [trigger]
 * @property {string} [focus]
 * @property {string} [skip] why no review is wanted for this event
 */

/**
 * Work out which pull request to review and whether we are allowed to.
 * Returns `{ skip: reason }` when the event does not ask for a review.
 * @returns {EventContext}
 */
export function readEvent(config) {
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || '/').split('/');
  if (!owner || !repo) throw new Error('GITHUB_REPOSITORY is not set — is this running in GitHub Actions?');

  const eventName = process.env.GITHUB_EVENT_NAME || '';
  let payload = {};
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && fs.existsSync(eventPath)) {
    payload = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  }

  const base = { owner, repo, eventName, payload, commentId: null };

  // Comment events are gated before anything else: a pr-number input must never
  // be a way around the author-association check.
  if (eventName === 'issue_comment' || eventName === 'pull_request_review_comment') {
    const isPr = eventName === 'pull_request_review_comment' || payload.issue?.pull_request;
    if (!isPr) return { ...base, skip: 'comment is not on a pull request' };

    const body = payload.comment?.body || '';
    const phrase = config.triggerPhrase;
    if (phrase && !containsPhrase(body, phrase)) {
      return { ...base, skip: `comment does not contain ${phrase}` };
    }

    const association = String(payload.comment?.author_association || '').toUpperCase();
    const allowed = config.allowedAssociations;
    if (!allowed.includes('ANY') && !allowed.includes(association)) {
      return {
        ...base,
        skip: `author association ${association || 'UNKNOWN'} is not in allowed-associations`,
      };
    }
    if (payload.comment?.user?.type === 'Bot') return { ...base, skip: 'comment was posted by a bot' };

    return {
      ...base,
      prNumber: config.prNumber ?? (payload.issue?.number || payload.pull_request?.number),
      commentId: payload.comment?.id ?? null,
      commentIsReview: eventName === 'pull_request_review_comment',
      trigger: 'mention',
      // Anything after the trigger phrase is treated as a focus instruction.
      focus: extractFocus(body, phrase),
    };
  }

  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    return { ...base, prNumber: config.prNumber ?? payload.pull_request?.number, trigger: eventName };
  }

  if (config.prNumber) return { ...base, prNumber: config.prNumber, trigger: 'input' };

  return { ...base, skip: `unsupported event "${eventName}" and no pr-number input` };
}

/** Word-boundary-ish match so "@commitreviewer" does not fire "@commitreview". */
export function containsPhrase(body, phrase) {
  const i = body.toLowerCase().indexOf(phrase.toLowerCase());
  if (i === -1) return false;
  const after = body[i + phrase.length];
  return after === undefined || !/[\w-]/.test(after);
}

export function extractFocus(body, phrase) {
  const i = body.toLowerCase().indexOf(phrase.toLowerCase());
  if (i === -1) return '';
  return body
    .slice(i + phrase.length)
    .trim()
    .slice(0, 2000);
}
