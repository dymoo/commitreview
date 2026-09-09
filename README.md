<p align="center">
  <img src="assets/shipyard-hero.png" alt="A ship under construction in a dark industrial shipyard" width="100%" />
</p>

# Shipyard

## GitHub-first code factory

Shipyard is for work that has already been thought through. Your local coding
tool—Codex or Claude Code—uses Matt Pocock's skills to make a ticket safe for a
fresh agent context. Shipyard then performs bounded work in GitHub Actions:
implementation, independent adversarial review, and a hand-off for your final
merge decision.

**Released now:** Shipyard Cloud Reviewer at `dymoo/shipyard@v3` and Cloud
Coder at `dymoo/shipyard/cloud-coder@v4`. The released Reviewer v3 contract does
not include the new optional reasoning-effort input; merging this change does
not move existing tags. Consumers that need it must pin a supporting immutable
revision until a separate release updates the tag.

## The loop

```text
Your laptop: Codex or Claude Code + Matt's skills
  /triage → /wayfinder → /to-spec → /to-tickets
  Agent Brief + acceptance checks + complexity score
                         │
                         ▼
GitHub Actions: Shipyard Cloud Coder
  first commits → tests → bounded repair pass
                         │
                         ▼
GitHub Actions: Shipyard Cloud Reviewer
  independent adversarial review of the draft PR
                         │
                         ▼
ready-for-human → your local coding tool or you decide to merge
```

Shipyard does not have a separate orchestration product. The local coding tool
remains responsible for planning, queuing, escalation and merge judgement;
Shipyard is the factory floor inside GitHub Actions.

## Start here: bootstrap Shipyard in a repository

Shipyard has two local skills. `setup-shipyard` installs the factory safely in
a repository; `shipyard` turns a vague request into the small, testable Agent
Brief that Cloud Coder can safely execute. Both run in your local Codex or
Claude Code session; neither is loaded into the cloud agent.

1. Install Matt Pocock's real skills first: `/triage`, `/wayfinder`,
   `/to-spec`, `/to-tickets`, `/implement`, `/tdd` and `/code-review`.
2. In Codex, ask the `skill-installer` to install both local skills:

   ```text
   https://github.com/dymoo/shipyard/tree/main/skills/setup-shipyard
   https://github.com/dymoo/shipyard/tree/main/skills/shipyard
   ```

3. In the target repository, run `setup-shipyard`. It verifies Matt's real
   skills before modifying anything, installs the guarded Coder/Reviewer
   workflows, and merges the local-agent contract into `AGENTS.md`.
4. Use the `shipyard` skill to define a leaf Issue, then apply
   `ready-for-agent` only after its Agent Brief is complete.

The [local-tool setup guide](docs/shipyard-llm-setup.md) has the full
installation and operating instructions.

## Matt's skills are the core dependency

Shipyard requires Matt's real workflows rather than a generic “plan then code”
prompt:

1. `/triage` turns a raw issue or draft PR into a durable Agent Brief.
2. `/wayfinder` resolves large or uncertain initiatives before coding begins.
3. `/to-spec` and `/to-tickets` publish small, dependency-ordered leaf tickets.
4. `ready-for-agent` means the brief names desired behaviour, acceptance checks,
   affected boundary, test command, dependencies and risks.

The local tool keeps the planning skills. Cloud Coder receives only a controlled
implementation subset—`/implement`, TDD, debugging, code review and Ponytail—
plus the approved brief. It refuses incomplete, blocked or fork-originated work
instead of reopening product design in GitHub Actions.

See [the bootstrap skill](skills/setup-shipyard/SKILL.md), [the Shipyard
workflow skill](skills/shipyard/SKILL.md), the
[local-tool guide](docs/shipyard-llm-setup.md) and the
[GitHub Issues workflow](docs/agents/issue-tracker.md).

## Reviewer reference

Do **not** create a reviewer-only workflow from this README. Run
`setup-shipyard`; it installs the canonical Reviewer and Coder workflows
together, verifies Matt's local-skill dependency, and writes the repository
agent contract. The maintained
[Reviewer example](examples/workflows/shipyard-reviewer.yml) is an audit
reference, not a separate setup path.

Cloud Reviewer needs an OpenAI-compatible Chat Completions endpoint with tool
calling. It is API-key-only; a ChatGPT or Codex subscription is not a GitHub
Actions credential. The bootstrap configures the model-key and hand-off-token
secret names without exposing their values. Its Reviewer workflow intentionally
has **no checkout**: `pull_request_target` is safe only because the action reads
the pull-request snapshot and never executes its code. Do not add a head-ref
checkout, install, build or shell step.

An owner, member or collaborator can request focused guidance with
`@shipyard check the migration for data loss`.

## Let an LLM bootstrap it

Paste this into Codex, Claude Code or another trusted local coding tool:

```text
Run `setup-shipyard` in this repository. First verify Matt Pocock's real skills
are available. Then read AGENTS.md, CONTRIBUTING.md and existing GitHub Actions
workflows before installing Shipyard's canonical Reviewer and Coder workflows.
Do not create a reviewer-only workflow or put a secret value in a file. Show the
complete diff, identify required secret names and Variables, and leave Coder
disabled until its dedicated runner and digest-pinned image are confirmed.
```

## Models

Model choice is repository configuration, never Shipyard action code. The
Coder requires a low-complexity model for scores 1–3 and a high-complexity
model for scores 4–5; reasoning effort is optional for the Reviewer and each
Coder tier. Omit it to use the provider default; an explicit value is validated
and sent unchanged.

Our current recommendation is GPT-5.6 Luna at `xhigh` for scores 1–3 and
GPT-5.6 Terra at `xhigh` for scores 4–5: the useful unit is cost per
_accepted_ PR, not cost per raw token. DeepSeek V4 Flash remains an evaluated
cost-sensitive alternative. These are recommendations, not defaults.

## Cloud Coder configuration reference

Do **not** manually add a Coder workflow from this section. `setup-shipyard`
installs the canonical Coder and Reviewer workflows together. This section is
the human-readable configuration reference it uses.

Cloud Coder is triggered by an **Issue**, not by a pull request. Your local
Codex or Claude Code session must use the Shipyard/Matt Pocock workflow to make
the Issue exceptionally clear, place the Agent Brief in its body, then add
`ready-for-agent`. The canonical
[Coder example](examples/workflows/shipyard-coder.yml) deliberately has no
checkout: Shipyard downloads the default-branch snapshot itself, and repository
code runs only inside the sandboxed Docker copy.

The maintained examples target ARC's `shipyard-runners` scale-set label. Install
that as a dedicated, repository-scoped runner with Docker available; it receives
model and GitHub credentials and must not be shared with untrusted workloads.
For a non-ARC runner, replace that label with your dedicated runner label. Keep
ordinary CI on GitHub-hosted runners unless it independently needs your local
environment.

Set these repository **Variables** before enabling the Coder:

| Variable                                          | Purpose                                            |
| ------------------------------------------------- | -------------------------------------------------- |
| `LLM_BASE_URL`                                    | OpenAI-compatible API base URL.                    |
| `SHIPYARD_CODER_READY`                            | Set to `true` only after both Coder secrets exist. |
| `SHIPYARD_CODER_LOW_COMPLEXITY_MODEL`             | Model for Agent Brief complexity scores 1–3.       |
| `SHIPYARD_CODER_HIGH_COMPLEXITY_MODEL`            | Model for Agent Brief complexity scores 4–5.       |
| `SHIPYARD_CODER_LOW_COMPLEXITY_REASONING_EFFORT`  | Optional effort for scores 1–3.                    |
| `SHIPYARD_CODER_HIGH_COMPLEXITY_REASONING_EFFORT` | Optional effort for scores 4–5.                    |
| `LLM_MODEL`                                       | Reviewer model.                                    |

The two model variables are required. Leave either reasoning-effort variable
empty when its provider does not support that parameter. Set
`SHIPYARD_CODER_READY` to `true` only after you create both `LLM_API_KEY` and
`SHIPYARD_HANDOFF_TOKEN`; set it to any other value before removing or rotating
either secret. This makes the workflow skip before allocating the dedicated
runner when the factory is not ready.

Cloud Coder v4 has no model defaults or model-branded inputs. Configure the two
generic tier Variables above; existing v3 installations remain available at
`cloud-coder@v3`.

This repository's own pilot Agent Briefs use the official digest-pinned Node 20
image and `npm test`, because that command uses only Node's built-in test
runner. A consumer whose Agent Brief declares another test command must publish
an image containing that toolchain and use its immutable digest.

This repository's own reviewer pilot uses `z-ai/glm-5.3-flash` through OpenRouter
with explicit `high` reasoning and a supporting immutable action revision. It
uses a dedicated `OPENROUTER_REVIEWER_API_KEY`, not the Coder's `LLM_API_KEY`.
Keep its `OPENROUTER_REVIEWER_ENABLED` Variable absent or `false` until the new
key and existing `SHIPYARD_HANDOFF_TOKEN` are configured; set it to `true` to
activate, and clear it before removing or rotating either secret. The reviewer
key must allow only this model and retain strict ZDR/no-training routing with
both OpenRouter input/output logging options off and an owner-selected spending
cap. Account/member guardrails can further restrict it; key creation does not
prove model eligibility. Verify an actual review after activation. Coder model
variables and credentials remain unchanged. These pilot settings do not change
the configurable, released-version workflow examples above.

Use `dymoo/shipyard/cloud-coder@v4` in the copied workflow. Both actions must
receive the same `SHIPYARD_HANDOFF_TOKEN`; Shipyard uses it only to sign and
verify context-bound HMAC hand-offs, never stores it in the dispatch payload,
and never exposes it to either model.

Before enabling it, replace the example `sandbox-image` with an image pinned to
an actual SHA-256 digest. That image must already contain the repository's test
toolchain because the test container has no network. The Coder reads the Brief,
creates `shipyard/issue-<number>`, writes one non-force commit, opens a draft
PR, dispatches Cloud Reviewer in its separate workflow, and comments back on
the source Issue. It never auto-merges.

The workflow needs `contents: write`, `issues: write` and `pull-requests:
write` because Shipyard's host-side broker creates the branch, draft PR and
run comment. Its 45-minute job limit is deliberate: the model does not receive
that token or a shell, but an agentic run must still have an unambiguous end.

The Coder has no model defaults. It takes its two model tiers and optional
reasoning efforts from repository Variables; routing remains controlled by the
Agent Brief complexity score.

## What Cloud Reviewer guarantees

- One investigator, one review pass and a skeptic for each candidate.
- Only `list_files`, `read_file` and exact-text `search` over the PR snapshot.
- Diff-derived anchors: a model never chooses an inline comment location.
- Base-commit instructions, so a PR cannot rewrite its own review policy.
- No checkout, shell, network tool or write path inside the reviewed snapshot.
- Fail-closed review coverage: a non-ignored file without usable textual review
  evidence fails the run instead of claiming a clean review.
- No completion-token cap. The provider/model owns completion length, while each
  logical model call has one ten-minute deadline shared by retries.

The public inputs are `api-key`, `base-url`, `model`, `reasoning-effort`,
`github-token`, `handoff-token`, `instructions` and `ignore`. Omit
`reasoning-effort` to use the provider default. Allowed values are `low`,
`medium`, `high`, `xhigh` and `max`; explicit values are sent unchanged and are
never removed during endpoint-parameter retries. See
[SECURITY.md](SECURITY.md) and the maintained
[workflow example](examples/workflows/shipyard-reviewer.yml). The canonical
`@v3` example intentionally omits the unreleased input; a supporting immutable
workflow revision may pass `vars.LLM_REASONING_EFFORT` to `reasoning-effort`.

### OpenRouter preflight

For private source sent through OpenRouter, put Shipyard's source-free preflight
directly before the reviewer:

```yaml
- uses: dymoo/shipyard/preflight@v3
  with:
    api-key: ${{ secrets.OPENROUTER_API_KEY }}
    required-models: |
      deepseek/deepseek-v4-flash-0731
    model: deepseek/deepseek-v4-flash-0731
    key-limit-usd: ${{ vars.OPENROUTER_KEY_LIMIT_USD }}
    key-limit-reset: daily

- uses: dymoo/shipyard@v3
  with:
    api-key: ${{ secrets.OPENROUTER_API_KEY }}
    base-url: https://openrouter.ai/api/v1
    model: deepseek/deepseek-v4-flash-0731
```

The preflight sends no repository content. It fails closed unless the live key
has the exact spend limit/reset interval, an exact model allowlist, a ZDR route
and a strict synthetic tool call. The reviewer itself applies the same strict
OpenRouter provider policy whenever that exact base URL is used. Those requests
also carry OpenRouter's public app-attribution headers: title `Shipyard` and
URL `https://github.com/dymoo/shipyard`.

Shipyard keeps each Cloud Coder or Cloud Reviewer run on one OpenRouter sticky
session, so providers can reuse the stable system prompt, Agent Brief, tool
schemas and earlier transcript prefix through supported prompt caching. The
review summary reports cache-read and cache-write tokens when the provider
returns them. Shipyard does not enable OpenRouter response caching: agent turns
are intentionally stateful and account-level ZDR forbids it.

## Security and development

Shipyard Cloud Reviewer masks keys immediately and sends requests only to GitHub
and the configured provider. Its runtime has no third-party dependencies and
runs audited source directly on Node 20. Tests use `node:test`, do not use the
network, and exercise the entrypoint against stub APIs.

```bash
npm install
npm run check-all
```

Read [SECURITY.md](SECURITY.md) for the threat model and
[the Pi research note](docs/research/pi-coding-agent.md) for the minimal-core,
mandatory-sandbox design that informs Cloud Coder.

Licensed under [MIT](LICENSE).
