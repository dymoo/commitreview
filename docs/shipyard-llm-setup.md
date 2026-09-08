# Shipyard local-tool setup

Shipyard has two places of work:

- Your **local coding tool** (Codex or Claude Code) uses Matt Pocock's skills to
  define, queue and finally judge work.
- **GitHub Actions** runs Shipyard Cloud Coder and Shipyard Cloud Reviewer once
  the local tool has made the work safe for a fresh agent context.

The local tool is not a Shipyard-branded product. It remains the decision-maker
and can use a strong planning model such as GPT-5.6 Sol at `xhigh` reasoning.

## Required dependency: Matt Pocock's skills

Install Matt Pocock's skills before installing or invoking the Shipyard skill.
Shipyard depends on their actual workflows; it does not recreate a looser
approximation in a GitHub Actions prompt.

The minimum workflow is:

```text
/triage → /wayfinder → /to-spec → /to-tickets → ready-for-agent
```

Use `/wayfinder` only when an initiative is genuinely uncertain or broad. Use
`/triage` for an incoming issue or draft PR. Every executable leaf ticket gets a
durable Agent Brief and fits a fresh implementation context.

## Bootstrap Shipyard, then install the operating skill

For Codex, ask a session with the `skill-installer` skill to install both:

```text
https://github.com/dymoo/shipyard/tree/main/skills/setup-shipyard
https://github.com/dymoo/shipyard/tree/main/skills/shipyard
```

Run `setup-shipyard` inside each target repository first. It checks that the
local tool exposes Matt's real skill names, installs guarded versioned workflows
and a focused `AGENTS.md` contract, and leaves Coder disabled until the runner,
pinned image, Variables and secret names are confirmed.

For another local coding tool, copy
[`skills/setup-shipyard/SKILL.md`](../skills/setup-shipyard/SKILL.md) and
[`skills/shipyard/SKILL.md`](../skills/shipyard/SKILL.md) into that tool's normal
project or user skill location. The tool must expose the Matt skills above under
their real names; otherwise stop and install/configure them before using either
Shipyard skill.

## Local-to-cloud hand-off

1. Triage the incoming issue or trusted same-repository draft PR.
2. Use Wayfinder for foggy initiatives; publish a spec and leaf tickets rather
   than giving Cloud Coder an initiative-sized prompt.
3. Place the latest Agent Brief on the leaf work item. It must state the desired
   change, acceptance checks, files/boundary, test command, dependencies,
   risks, and complexity score.
4. Apply `ready-for-agent`. This is the dispatch gate for Cloud Coder.
5. Cloud Coder produces first commits and tests. Cloud Reviewer independently
   reviews the draft; it either requests one repair with verified findings or
   marks the draft ready for review. Cloud Coder may make that one repair.
6. The workflow applies `ready-for-human` to the pull request. Return to the local coding tool or a
   human for final review, merge, or re-triage. Shipyard never auto-merges.

## Cloud Coder context contract

Cloud Coder does not receive every installed skill body in its system prompt.
Like Codex and Claude Code, it sees only the names and one-line descriptions of
approved implementation skills, then calls a host-owned `load_skill(name)` tool
to read one complete immutable skill when it needs it. This preserves context
for the Agent Brief, repository and tests.

The coder may load `implement`, `tdd`, `diagnosing-bugs`, `code-review` and
`ponytail-review`. It cannot load planning skills such as `triage`, `wayfinder`,
`to-spec`, `to-tickets` or domain modelling: those are deliberately consumed by
the local session before dispatch.

## Current release boundary

Cloud Reviewer is available as `dymoo/shipyard@v3` and Cloud Coder as
`dymoo/shipyard/cloud-coder@v4`; see the README for the exact workflows. The
unreleased Reviewer reasoning-effort input is not accepted by `@v3`; consumers
must pin a supporting immutable revision until a separate release updates the
tag. Their
repository-dispatch hand-offs require a HMAC proof bound to their direction,
repository, Issue, PR, repair round and exact head commit. The shared secret is never
retained in event payloads or exposed to a model.
