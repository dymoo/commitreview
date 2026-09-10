# Working on Shipyard

Conventions for this repository, for humans and for coding agents. Shipyard
reads this file when reviewing its own pull requests, so a rule written here is
a rule it will enforce. Keep it true.

## Non-negotiables

These are load-bearing. A change that breaks one is wrong even if it passes.

- **No cloud-reviewer runtime dependencies.** `action.yml` runs `src/index.js`
  directly, with no build step and no `dist/` bundle, so the code that is
  audited is the code that executes. The companion `preflight/action.yml` does
  the same for `preflight/`. Only `node:` builtins and relative imports in
  cloud-reviewer runtime source. Dev dependencies are fine.
- **Node 20 is the floor.** `runs.using: node20`. Anything newer must be feature
  detected or avoided.
- **Repository code is never executed.** We read the pull request's files; we do
  not run them, build them, or install from them. This is the single property
  that makes `pull_request_target` safe with this action, and it is why the
  workflow needs no checkout.
- **The cloud-reviewer is read-only.** Its tools may list, read and search. No
  writes, shell, network, or path that escapes the extracted repository root.
- **Tool calling is required, not probed.** Parameters like `response_format` are
  dropped when an endpoint rejects them; tool calling is not — an endpoint that
  cannot drive tools is rejected with a clear error, never degraded to a
  diff-only review. Do not add a non-tool retrieval fallback.
- **Anchors come from the diff, never from a model.** A model may reword a
  finding; only `anchorFinding` decides its `path`, `line` and `side`. Any code
  path that lets a model response set those is a bug.
- **Review policy comes from the base commit.** Pull request authors control the
  head snapshot, including any instruction files they change. Contributor rules
  used as review policy are therefore read at `pr.base.sha`; head content
  remains untrusted evidence.
- **Secrets are masked before use.** Every API key goes through `core.mask()` at
  the moment it is read, before anything else can log it.

## Product surface

Shipyard is a GitHub-first code factory with two coordinated actions,
`cloud-reviewer` and `cloud-coder`. The user's local
Codex or Claude Code session owns Matt Pocock skill workflows, ticket
definition, final merge judgement and escalation; GitHub Actions owns bounded
implementation and independent review work.

`cloud-reviewer` is the existing v2 source-bearing review path: one model
investigates with `list_files`, `read_file` and exact-text `search`; one review
pass proposes findings; one skeptic verifies each candidate; diff-derived
anchors produce inline comments and one sticky summary. Its trust boundary is
read-only and must remain so.

`cloud-coder` is a separate, sandboxed companion action. It consumes only a
fully specified Agent Brief, implements and tests a bounded work item, performs
bounded adversarial repair, and hands the resulting draft PR to
`cloud-reviewer`. It never merges code; `ready-for-human` returns merge
judgement to the user's local coding session or a human.

Cloud Coder advertises only approved skill names and descriptions in its base
context. Its host-owned `load_skill(name)` tool reads full immutable bodies on
demand; the allowlist is implementation, TDD, debugging, code review and
Ponytail. Planning skills stay in the local coding session and are never loaded
by the cloud executor.

The review action's public inputs are exactly `api-key`, `base-url`, `model`,
`reasoning-effort`, `github-token`, `handoff-token`, `instructions` and `ignore`.
When omitted, reasoning effort uses the provider default; an explicit validated
value is sent unchanged. The released `dymoo/shipyard@v3` reference does not
accept this new input; consumers must pin a supporting immutable revision until
it is released. The self-review workflow pins a supporting immutable revision
and selects `deepseek/deepseek-v4.1-flash` with explicit `max` effort. Its dedicated
`OPENROUTER_REVIEWER_API_KEY` is separate from the Coder's `LLM_API_KEY`;
`OPENROUTER_REVIEWER_ENABLED` must be `true` only after that key and the existing
hand-off secret are configured. The generic `@v3` examples remain unchanged.
When its base URL is exactly OpenRouter, the shared client adds the fixed public app
attribution headers `HTTP-Referer: https://github.com/dymoo/shipyard` and
`X-OpenRouter-Title: Shipyard`, plus one `session_id` derived from the opaque
GitHub workflow-run identifier to keep provider prompt caches sticky. It never
enables OpenRouter response caching: turns are stateful and account-level ZDR
forbids it. The source-free OpenRouter preflight has a separate exact interface:
`api-key`, `required-models`, `model`, `key-limit-usd`,
`key-limit-reset` and `diagnostic-provider`. Authentication is API-key-only.
ChatGPT subscription OAuth is deferred in
`docs/codex-chatgpt-auth.md`.

Cloud Coder's separate public inputs are `api-key`, `base-url`,
`low-complexity-model`, `high-complexity-model`,
`low-complexity-reasoning-effort`, `high-complexity-reasoning-effort`,
`github-token`, `handoff-token` and `sandbox-image`. Scores 1–3 use the
configured low-complexity model and scores 4–5 use the configured
high-complexity model; reasoning effort is optional and omitted when empty. It
uses generic tier inputs only in v4; the unchanged v3 tag retains the legacy
Luna/Terra-named interface for existing callers. The Coder workflow requires
the non-secret `SHIPYARD_CODER_READY` repository Variable to equal `true`
before it allocates its dedicated runner; operators set it only after its model
and hand-off secrets exist, and clear it before either secret is removed or
rotated. It
triggers from an `issues` label event for `ready-for-agent` or its one trusted
`shipyard-repair` repository dispatch; it accepts an open Issue rather than a
PR. The workflow must grant only
`contents: write`, `issues: write` and
`pull-requests: write`, must not check out repository code, and must pass a
SHA-256 digest-pinned test image with a fixed job timeout. The Coder's host-side broker creates one
`shipyard/issue-<number>` branch, one non-force commit and one draft PR only
after the fixed Agent Brief test command passes in a no-network container.
It then emits the `shipyard-review` repository-dispatch event; the separate
Cloud Reviewer workflow must listen for that event so it runs with its own
configured model and API key. Both actions accept that dispatch only with an
HMAC proof over its repository, direction, Issue, PR, repair round and exact head SHA;
they never put the shared secret in event storage or model context. For Coder-dispatched reviews
only, the review
host either emits one `shipyard-repair` event with bot-authored, verified
findings or changes the Coder draft to ready-for-review and applies
`ready-for-human`; it never lets the review model invoke GitHub mutations. The
review workflow skips ordinary pull-request events for generated
`shipyard/issue-*` branches so the repository-dispatch run is the only Coder
review-and-handoff authority. Both workflows filter repository-dispatch events
to their Shipyard action before a runner starts; a recognised dispatch without
its configured HMAC token/proof fails visibly.

Shipyard's own pilot Coder workflow is `.github/workflows/shipyard-coder.yml`.
It reads its Coder low/high model tiers and optional reasoning efforts from
repository Variables, plus the shared hand-off secret and digest-pinned Node 20
sandbox image. Shipyard's pilot Agent Briefs use `npm test`; a consumer whose Brief
declares another command must publish a test-toolchain image and pass that
image's immutable digest instead. Cloud Coder and Cloud Reviewer run on the ARC
release-name label `shipyard-runners`. That runner is dedicated,
repository-scoped infrastructure with Docker; it receives model and GitHub
credentials and must not be shared with unrelated untrusted workloads. Ordinary
CI remains on GitHub-hosted runners. A non-ARC install must replace the example
label with its own dedicated runner label.

## Agent skills

- **Issue tracker:** GitHub Issues in `dymoo/shipyard`. See
  `docs/agents/issue-tracker.md` for the operating model.
- **Triage labels:** Use the canonical Matt Pocock labels documented in
  `docs/agents/triage-labels.md`. Do not create one-off process labels.
- **Domain documentation:** This is a single-context repository; its tracked
  domain context lives in `docs/agents/domain.md`.
- **Shipyard setup skill:** `skills/setup-shipyard/SKILL.md` is the portable
  bootstrap. It verifies Matt Pocock's real skills before installing guarded
  workflows and a focused repository-agent contract. Its bundled
  `validate.mjs` checks non-secret setup inputs before edits, accepts only its
  complete bundled workflow and agent-contract templates after installation,
  and verifies pre-enable live Variables, secret names, a registered runner
  behind the configured label, and the organisation runner-group isolation
  policy through `gh`. Setup keeps Coder disabled until validation completes;
  it never substitutes an ad-hoc prompt for a missing Matt workflow.
- **Shipyard local skill:** `skills/shipyard/SKILL.md` is the portable operating
  integration used after bootstrap. It requires Matt Pocock's real skills and
  must not reproduce their workflows as an ad-hoc prompt.

## Layout

One responsibility per file. If you cannot say what a file is for in one line,
it needs splitting.

| File              | Owns                                                                     |
| ----------------- | ------------------------------------------------------------------------ |
| `src/index.js`    | Orchestration. No business logic.                                        |
| `src/config.js`   | Seven inputs, fixed limits and event resolution                          |
| `src/handoff.js`  | HMAC proof for Coder/Reviewer dispatches                                 |
| `src/prompts.js`  | Every prompt. The product's actual IP.                                   |
| `src/schema.js`   | JSON Schemas for structured replies. Authoritative.                      |
| `src/review.js`   | The model passes: find and refute                                        |
| `src/findings.js` | The finding data model: normalise, merge, fingerprint                    |
| `src/diff.js`     | Diff parsing and comment anchoring                                       |
| `src/context.js`  | File selection, context widening, chunking                               |
| `src/codebase.js` | Base-commit project-rule discovery                                       |
| `src/repo.js`     | Repository access at the head commit                                     |
| `src/agent.js`    | Read-only tools and the bounded investigation loop                       |
| `src/llm.js`      | OpenAI-compatible client, defensive JSON                                 |
| `src/github.js`   | REST client                                                              |
| `src/post.js`     | Comment and summary rendering, posting                                   |
| `src/core.js`     | The small `@actions/core` replacement                                    |
| `preflight/`      | Source-free OpenRouter policy and route verification                     |
| `cloud-coder/`    | Separate Coder boundary: skills, mutable workspace and sandbox prototype |

Dependencies point one way: `index.js` → everything, and modules do not import
their callers. `post.js` must not import `review.js`; anything both need lives in
`findings.js` or `config.js`.

## Checks

There is no compiler, so the checks a compiler would give us are assembled
explicitly. All four must pass, and `npm run check-all` runs them:

| Command                | Catches                                                    |
| ---------------------- | ---------------------------------------------------------- |
| `npm run format:check` | Formatting. Prettier decides; never hand-format.           |
| `npm run lint`         | Correctness and modern-JS discipline, plus JSDoc validity. |
| `npm run typecheck`    | `tsc --checkJs` reading the JSDoc annotations as types.    |
| `npm test`             | Behaviour.                                                 |

Fix what they report; do not silence them. A rule that is genuinely wrong for
this codebase gets turned off in `eslint.config.js` **with a comment saying
why** — as `jsdoc/check-tag-names` is, because JSDoc is this project's type
system and its `@typedef` tags are load-bearing rather than redundant.

## Style

- Plain ESM with JSDoc types. Annotate types in JSDoc; fix type errors by
  describing the type, not by loosening the checker.
- `const` by default, `let` only when reassigned, never `var`. `===` except
  against `null`. Template literals over concatenation.
- Every `catch` either handles the error or explains in a comment why it is safe
  to swallow. An empty, unexplained `catch` is how a failure becomes a mystery.
- An error thrown in place of a caught one carries the original as its `cause`.
- Async work that shares a cache caches the _promise_, not the result, so two
  concurrent callers cannot both start the same fetch.
- Prefer a named function at module scope over a nested arrow when it is more
  than a line or two.
- British spelling in prose and comments. Identifiers stay in whatever spelling
  the surrounding code and the GitHub API already use.

## Comments

Comments say **why**, never what. The code already says what.

```js
// Good — explains a decision the reader cannot infer:
// A snapped anchor points near the finding, not exactly at it, so a committable
// suggestion there would replace the wrong line.

// Bad — restates the code:
// Loop over the findings and push each one.
```

A comment that survives is one that would stop someone "simplifying" the line
away. If a line looks odd and is correct, say why it is correct.

## Deliberate shortcuts

Mark them, and name the ceiling and the upgrade path:

```js
// ponytail: chars/4 is close enough for budgeting; swap in a real tokenizer
// only if truncation starts biting.
```

A shortcut recorded this way is a decision. An unmarked shortcut is a bug
waiting for someone to discover it the hard way. The review treats the first as
fine and the second as a possible finding, so write the comment.

## Tests

`node:test`, no frameworks, no fixtures beyond `test/fixtures.js`, no network.

- Anchoring, chunking, JSON extraction and fingerprinting are where this class of
  tool breaks. A change to any of them lands with a test.
- Test names read as claims about behaviour: `snaps a near miss to the closest
changed line and flags it`, not `test anchorFinding 3`.
- Assert on behaviour, not on prose. Prompt tests match on content with
  whitespace normalised, never on where a line happens to wrap.
- `test/e2e.test.js` runs the real entrypoint against a stub GitHub API and a
  stub model. Anything touching orchestration, event handling or the request
  sequence belongs there.
- Cloud Coder tests must prove the admission gate, lazy allowlisted skill
  loading, workspace containment and Docker isolation without running Docker
  or repository code in the test process.

## Prompts

`src/prompts.js` is edited with the same care as code, because it is the
product.

- State the gates a finding must **pass**. Never write a list of things not to
  report — models underweight negation, so a "do not" line is the weakest
  instruction in the file.
- Every skeptic holds a kill mandate and defaults to "not real" when unsure. A
  false positive costs more than a missed nit.
- Skeptics never see the finder's severity or confidence. Those anchor.
- Untrusted material is fenced with BEGIN/END markers and labelled as data.
- The JSON shape a prompt asks for is the **fallback** description; `src/schema.js`
  is the authoritative contract sent to endpoints that support Structured
  Outputs. Change the schema and the prose together — `test/schema.test.js` fails
  if they drift.
- A token the model must emit and the parser must match (verdict words, side,
  the bot marker) is defined once in `config.js` and interpolated into both the
  prompt and the parser. Never hand-write it in two places.
- When you change a prompt, change the test that pins the behaviour you were
  relying on.

## Before opening a pull request

```bash
npm run check-all   # format, lint, typecheck, tests
```

Keep the diff to one purpose. If it does two things, it is two pull requests.

## Changelog

- 2026-08-04: Added the `setup-shipyard` local bootstrap skill. It verifies
  Matt's real workflows before configuring guarded Shipyard Actions and the
  target repository's agent contract, with preflight, exact canonical
  installed-state validation, a live pre-enable `gh` configuration check, a
  private workflow-restricted organisation runner group, an origin-remote
  repository check, a registered runner behind the configured label, and a
  requirement that omitted optional reasoning-effort Variables are unset. Its
  non-atomic setup order is recoverable: keep Coder disabled, inspect or fix
  partial state, then enable only after successful live validation.
- 2026-08-04: Exposed an optional validated Reviewer reasoning effort, preserving
  provider defaults when omitted and failing rather than dropping an explicit
  effort on endpoint rejection.
- 2026-08-04: Added the non-secret `SHIPYARD_CODER_READY` admission gate so a
  missing Coder secret does not allocate a privileged runner.
- 2026-08-04: Made Cloud Coder model tiers and reasoning effort repository
  configuration rather than Luna/Terra action defaults. Cloud Coder v4 uses only
  generic tier inputs; the unchanged v3 tag retains the legacy interface.
- 2026-08-04: Removed the obsolete `temperature` request parameter and its
  fallback retry from both Coder and Reviewer model calls; reasoning models now
  use their provider defaults without an avoidable failed request.
- 2026-08-04: Tagged exact OpenRouter requests with Shipyard's fixed public
  GitHub URL and display title for app attribution; no custom provider endpoint
  receives those headers.
- 2026-08-04: Made exact OpenRouter Coder and Reviewer calls use one
  run-scoped sticky prompt-cache session, and exposed provider cache-read/write
  token counts in the review summary without enabling response caching.
- 2026-08-04: Targeted Cloud Coder and Cloud Reviewer workflows and examples at
  the dedicated ARC `shipyard-runners` scale set; ordinary CI remains
  GitHub-hosted.
- 2026-08-04: Added Shipyard's first Cloud Coder pilot workflow, using a
  digest-pinned Node 20 sandbox and the existing `npm test` command; documented
  local Shipyard-skill installation in the README.
- 2026-08-04: Bound Coder/Reviewer repository-dispatch hand-offs to HMAC proofs
  over repository, direction, Issue, PR, repair round and head SHA, without storing the
  shared secret in the payload. The receiver also verifies the live PR head.
- 2026-08-04: Hardened Cloud Coder publication and hand-off: verify the base
  ref immediately before creating its branch, preserve regular-file mode, fail
  reviewer-dispatch errors visibly, mask Coder keys immediately, and exercise
  the entrypoint sequence end to end. The synthetic OpenRouter preflight also
  omits optional temperature so Luna's strict tool route remains eligible.
- 2026-08-04: Made the OpenRouter client recognise its parameter-routing 404
  response and retry without only the optional temperature field; tool calling,
  ZDR and required-parameter routing remain fixed.
- 2026-08-04: Completed the finite Cloud Coder/Reviewer loop: one dispatched
  reviewer repair, protected non-force repair commit, then `ready-for-human`
  hand-off by a fixed host-side transition; generated branches skip duplicate
  pull-request review runs.
- 2026-08-04: Added the Cloud Coder Issue-to-draft-PR vertical slice: a
  label-gated Issue Action, bounded coding tools, archive workspace, final
  no-network test, non-force Git Data commit and draft PR broker.
- 2026-08-04: Added the isolated Cloud Coder v1 security prototype: strict
  Issue Brief admission, lazy immutable implementation skills, contained
  workspace edits and a credential-free no-network Docker test boundary.
- 2026-08-04: Removed the review client's completion-token cap; providers and
  models now control output length while request and input-context limits remain
  fixed.
- 2026-08-04: Rebranded the product as Shipyard, a GitHub-first code factory;
  Cloud Coder dispatch now depends on Matt Pocock's local planning skills while
  Cloud Reviewer retains its separate read-only trust boundary.
- 2026-08-04: Configured Matt Pocock agent workflows for GitHub Issues,
  canonical triage labels and single-context domain documentation.
- 2026-08-01: v2.0.2 added a source-free OpenRouter preflight for exact key
  limits, effective model allowlists, ZDR routing and strict synthetic tool
  compatibility before source-bearing review.
- 2026-07-24: v2 narrowed the action to one context-aware review path, six
  inputs, three read-only tools and API-key authentication. Project rules now
  come from the base commit, and removed surfaces include chat, panels, depth
  presets, tuning knobs, suggestions, gates and output files.
