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

/**
 * Review perspectives. One generic pass finds the obvious; a pass that has been
 * told to care about exactly one thing finds what a generic pass skims past.
 * `depth` decides how many of these run — always in this order, most valuable
 * first, so `review-passes: 2` means general plus security.
 */
export const LENSES = [
  {
    key: 'general',
    focus: `Review everything. Weight logic errors, unhandled failures and edge cases the change introduces.`,
  },
  {
    key: 'security',
    focus: `Review as a security engineer, and report only security defects.
Look for: injection of any kind, missing or incorrect authorisation, secrets or
tokens reaching logs or responses, unsafe deserialisation, path traversal,
SSRF, unvalidated redirects, weak or misused cryptography, timing-sensitive
comparisons, and input that crosses a trust boundary without validation.
Trace where the data comes from before deciding it is safe.`,
  },
  {
    key: 'concurrency-and-resources',
    focus: `Review as an engineer who has debugged production outages, and report
only concurrency and resource defects. Look for: races on shared state, missing
await, lost updates, check-then-act without a lock, deadlock ordering, unclosed
handles, connections or streams, unbounded queues, caches and retries, missing
cleanup on the error path, and work that grows with input inside a hot loop.`,
  },
  {
    key: 'integration',
    focus: `Review as the engineer who owns the callers, and report only defects
that appear at the seams. Look for: signature, return-type and thrown-error
changes whose existing callers were not updated, contract changes to APIs,
events or database schemas, migrations that are not backwards compatible or not
reversible, config and feature flags read but never set, and behaviour that
changes for existing data. The codebase context lists the existing callers —
check them one by one.`,
  },
];

/**
 * The taste pass. Runs alongside whatever lenses `depth` selected, because the
 * thing it looks for is orthogonal to correctness: not "does this work" but
 * "was this decided".
 *
 * Its restraint half is a condensed form of the ponytail rules by Dietrich
 * Gebert (https://github.com/dietrichgebert/ponytail), used with credit.
 */
export const TASTE_LENS = {
  key: 'taste',
  focus: `Review this change for consistency and restraint — what a codebase's most senior
maintainer notices and no linter ever will.

You are looking for slop. Not "an AI wrote this", and not "this is ugly" —
slop is complexity that was never actually decided on. Generating code costs
almost nothing now; deciding what should exist costs exactly what it always
did. The gap between those two rates fills with un-made decisions wearing the
costume of code. Every individual piece looks locally plausible. The damage
only shows in aggregate: in the seams, in the sixth month, in the incident
review.

So the question behind every finding here is:

    Was this complexity deliberately chosen, integrated with what already
    exists in this repository, and could a maintainer explain and own it?

Report:

  Reinvention. The change writes something this repository already has. You
  have the codebase — go and check, then cite the existing helper by
  path:line. This is the single most valuable thing you can find.

  Inconsistency. It does something a different way from the rest of the
  codebase for no stated reason: a second error-handling idiom, a second date
  format, a second way to fetch, a second state pattern, naming that matches
  nothing around it. A product that reads as though it were built by strangers
  who never met gets that way one plausible inconsistency at a time.

  Structural asymmetry. A sibling path does something this one does not — an
  authorisation check, validation, a transaction, a rate limit, cleanup on the
  error path. This is not a style problem. The most expensive failures live
  here, because the code is not wrong, the pattern is simply absent. Cite the
  sibling that has it.

  Unrequested abstraction. An interface with one implementation, a factory for
  one product, a config option for a value that never changes, a wrapper called
  once, scaffolding for a future that has not arrived. Ask what would break if
  it were inlined. If the answer is nothing, that is the finding.

  A dependency reached for too early. A new package for something the standard
  library, an already-installed dependency, or the platform does natively. Also
  flag a package you cannot confirm exists — a plausible-looking name that no
  one can verify is a known supply-chain attack surface, not a typo.

  Volume without weight. Many lines doing little: blocks duplicated with one
  value changed, a hand-rolled version of a language feature, defensive layers
  guarding against nothing reachable, code that is dead on arrival.

  Tests that cannot fail. A test that mocks the very thing it claims to test,
  asserts on its own fixture, or would still pass with the feature deleted.
  Say which of those it is.

  Negative space. What a change of this kind normally carries and this one does
  not: the error state, the empty state, pagination, a limit on something
  metered, the cleanup path.

The following are correct as they stand. Reporting one as slop is itself a
review defect:

  * Input validation at a trust boundary, error handling that prevents data
    loss, security controls, and accessibility basics. These are load-bearing.
    Simplicity is never a reason to remove them.
  * A shortcut that carries a comment naming its own ceiling and upgrade path,
    such as \`// ponytail: global lock, per-account if throughput matters\`.
    That is a decision, recorded — the opposite of slop.
  * Code that is merely longer, newer, or less familiar than you would have
    written yourself.
  * A stated, deliberate exception to a convention.
  * Anything whose only fault is that you would have named it differently.`,

  admission: `Every finding here must cite the thing it is measured against — the existing
helper, the sibling that has the check, the convention it breaks — with a path
and a line drawn from the codebase context you were given. Keep a finding only
when all of these hold:

  1. You can name the specific existing code it should have used, matched, or
     been consistent with, and you have its location.
  2. You checked that this thing actually exists, rather than assuming a
     codebase like this one would have it.
  3. You can say in one sentence what to do instead: reuse X, match Y, inline
     Z, delete it.
  4. It is not one of the load-bearing categories listed above.

A finding without that comparison is an opinion, and opinions are the failure
mode of this review. Discard it.

severity here:
  high    a structural asymmetry with security or data-integrity consequences
  medium  reinvention of something that already exists, or a test that cannot fail
  low     inconsistency with an established convention, unrequested abstraction
  nit     naming and clarity`,
};

/**
 * How hard to look. Every value here is only a default — an explicit input
 * always wins, so `depth: thorough` with `refute-votes: 1` does what it says.
 */
export const DEPTH_PRESETS = {
  quick: {
    contextLines: 8,
    maxInputTokens: 40000,
    chunkTokens: 20000,
    refuteVotes: 1,
    maxFindings: 15,
    minSeverity: 'medium',
    repoContext: 'off',
    maxRelatedTokens: 0,
    lenses: 1,
    agentTurns: 6,
  },
  standard: {
    contextLines: 20,
    maxInputTokens: 120000,
    chunkTokens: 30000,
    refuteVotes: 1,
    maxFindings: 25,
    minSeverity: 'low',
    repoContext: 'auto',
    maxRelatedTokens: 25000,
    lenses: 1,
    agentTurns: 12,
  },
  thorough: {
    contextLines: 40,
    maxInputTokens: 400000,
    chunkTokens: 60000,
    refuteVotes: 3,
    maxFindings: 40,
    minSeverity: 'nit',
    repoContext: 'auto',
    maxRelatedTokens: 90000,
    lenses: 4,
    agentTurns: 28,
  },
};

/**
 * Parse the `panel` input: blank-line-separated blocks of `key: value`.
 *
 *     model: gpt-5.6
 *     base-url: https://api.openai.com/v1
 *     api-key: ${{ secrets.OPENAI_KEY }}
 *
 *     model: claude-sonnet-4-5
 *     api-key: ${{ secrets.ANTHROPIC_KEY }}
 *
 * It reads as YAML because it sits in a YAML file, but it is parsed as lines,
 * so the action stays dependency-free. Anything a block leaves out is
 * inherited from the lead model, which makes a second model on the same
 * provider a one-line entry.
 *
 * @returns {{model: string, baseUrl: string, apiKey: string, label: string}[]}
 */
export function parsePanel(text, lead) {
  const blocks = String(text || '')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  return blocks.map((block, i) => {
    /** @type {Record<string, string>} */
    const fields = {};
    for (const line of block.split('\n')) {
      const trimmed = line.trim().replace(/^-\s*/, '');
      if (!trimmed || trimmed.startsWith('#')) continue;
      const at = trimmed.indexOf(':');
      if (at === -1) throw new Error(`Panel entry ${i + 1} has a line that is not "key: value": ${trimmed}`);
      fields[trimmed.slice(0, at).trim().toLowerCase()] = trimmed.slice(at + 1).trim();
    }

    const model = fields.model || fields.name;
    if (!model) throw new Error(`Panel entry ${i + 1} is missing "model".`);

    const ownBaseUrl = fields['base-url'] || fields.url;
    const ownKey = fields['api-key'] || fields.key;

    // A key may only be inherited along with the endpoint it belongs to.
    // Otherwise naming a second provider and forgetting its key would send the
    // lead's credential to that provider — a silent disclosure, not a default.
    if (ownBaseUrl && !ownKey && ownBaseUrl.replace(/\/+$/, '') !== lead.baseUrl) {
      throw new Error(
        `Panel entry ${i + 1} ("${model}") sets its own base-url but no api-key. ` +
          `Inheriting the lead model's key would send it to ${ownBaseUrl}. Give this entry its own api-key.`,
      );
    }
    const apiKey = ownKey || lead.apiKey;
    if (!apiKey) throw new Error(`Panel entry ${i + 1} has no api-key and the lead model has none to inherit.`);

    return {
      model,
      baseUrl: (ownBaseUrl || lead.baseUrl).replace(/\/+$/, ''),
      apiKey,
      label: fields.label || model,
    };
  });
}

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

  const depth = core.getInput('depth', 'standard').toLowerCase();
  if (!DEPTH_PRESETS[depth]) {
    throw new Error(`Input "depth" must be one of ${Object.keys(DEPTH_PRESETS).join(', ')}`);
  }
  const preset = DEPTH_PRESETS[depth];

  const repoContext = core.getInput('repo-context', preset.repoContext).toLowerCase();
  if (!['auto', 'off'].includes(repoContext)) throw new Error('Input "repo-context" must be auto or off');

  const agentic = core.getInput('agentic', 'auto').toLowerCase();
  if (!['auto', 'on', 'off'].includes(agentic)) throw new Error('Input "agentic" must be auto, on or off');

  const minSeverity = core.getInput('min-severity', preset.minSeverity).toLowerCase();
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

  const baseUrl = core.getInput('base-url', 'https://api.openai.com/v1').replace(/\/+$/, '');
  const lead = { model, baseUrl, apiKey, label: core.getInput('model-label', model) };
  const panel = [lead, ...parsePanel(core.getInput('panel', ''), lead)];
  // Every panel key is a secret, including ones inherited from the lead.
  for (const member of panel) core.mask(member.apiKey);

  return {
    apiKey,
    model,
    baseUrl,
    panel,
    taste: core.getBool('taste', true),
    githubToken,
    prNumber: core.getNumber('pr-number', 0) || null,
    triggerPhrase: core.getInput('trigger-phrase', '@commitreview'),
    allowedAssociations: core.getCsv('allowed-associations', 'OWNER,MEMBER,COLLABORATOR').map((s) => s.toUpperCase()),

    include: core.getLines('include'),
    ignore: [...(core.getBool('use-default-ignores', true) ? DEFAULT_IGNORES : []), ...core.getLines('ignore')],

    depth,
    repoContext,
    agentic,
    agentTurns: Math.max(1, core.getNumber('agent-turns', preset.agentTurns)),
    maxRelatedTokens: core.getNumber('max-related-tokens', preset.maxRelatedTokens),
    lenses: Math.max(1, Math.min(LENSES.length, core.getNumber('review-passes', preset.lenses))),

    maxFiles: core.getNumber('max-files', 60),
    maxFileBytes: core.getNumber('max-file-bytes', 400000),
    contextLines: Math.max(0, core.getNumber('context-lines', preset.contextLines)),
    maxInputTokens: core.getNumber('max-input-tokens', preset.maxInputTokens),
    chunkTokens: core.getNumber('chunk-tokens', preset.chunkTokens),
    concurrency: Math.max(1, core.getNumber('concurrency', 4)),

    maxFindings: core.getNumber('max-findings', preset.maxFindings),
    minSeverity,
    refute: core.getBool('refute', true),
    refuteVotes: Math.max(1, core.getNumber('refute-votes', preset.refuteVotes)),
    instructions: core.getInput('instructions', ''),

    inlineComments: core.getBool('inline-comments', true),
    summaryMode,
    suggestions: core.getBool('suggestions', true),
    failOn,
    dryRun: core.getBool('dry-run', false),

    temperature: core.getNumber('temperature', 0.1),
    maxOutputTokens: core.getNumber('max-output-tokens', 16000),
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
