---
name: shipyard
description: Prepare exceptionally well-defined GitHub work for Shipyard Cloud Coder and Cloud Reviewer using Matt Pocock's skills, then perform the local final-review hand-off.
---

# Shipyard

Use Shipyard from a local interactive coding tool. Shipyard's GitHub Actions
perform bounded implementation and review; this skill owns the quality of the
work handed to them and the final local decision.

## Hard dependency

Before doing anything, confirm that Matt Pocock's real skills are available:
`triage`, `wayfinder`, `to-spec`, `to-tickets`, `implement`, `tdd` and
`code-review`.

If any required skill is absent, stop. Tell the user Shipyard depends on Matt's
workflows and ask them to install/configure those skills first. Do not imitate
the missing skill with an ad-hoc prompt.

## Prepare a work item

1. Route an incoming issue or draft PR through `/triage`.
2. When the work is large, uncertain or multi-ticket, use `/wayfinder`; do not
   hand an initiative directly to an implementation agent.
3. Use `/to-spec` and `/to-tickets` to publish small, dependency-ordered leaf
   tickets. Each must fit one fresh agent context.
4. Do not apply `ready-for-agent` until the latest Agent Brief names:
   - desired behaviour and non-goals;
   - acceptance checks and the exact validation command;
   - affected files or boundary, dependencies and blockers;
   - relevant security, compatibility and operational risks;
   - complexity score from 1 to 5.

## Dispatch policy

`ready-for-agent` is the only Shipyard dispatch gate. It means the ticket is
safe for a fresh agent to implement without product discovery.

- Scores 1–3 route to GPT-5.6 Luna at `xhigh` reasoning by default.
- Scores 4–5 route to GPT-5.6 Terra at `high` or `xhigh` with heightened
  adversarial review.
- DeepSeek V4 Flash is a cost-sensitive alternative only after it has passed
  equivalent accepted-PR evaluation for the repository.

Never dispatch incomplete, blocked or fork-originated work. Never use a score
as a substitute for a complete brief.

## Cloud Coder skill context

Cloud Coder must follow the same lazy skill-loading pattern as Codex and Claude
Code. Its base context advertises only the name and one-line description of its
allowed skills. A host-owned `load_skill(name)` tool returns the complete,
immutable body only when the model selects it.

The Cloud Coder allowlist is `implement`, `tdd`, `diagnosing-bugs`,
`code-review` and `ponytail-review`. It must not expose or load `triage`,
`wayfinder`, `to-spec`, `to-tickets` or domain-modelling skills: those planning
workflows belong to the local coding session that created the Agent Brief.

## Receive the result

Cloud Coder creates or updates a same-repository draft PR, runs checks, then
performs bounded repair after independent Cloud Reviewer findings. It marks the
item `ready-for-human` when its bounded run ends.

At that point, use the local tool's normal review workflow. Verify the Agent
Brief, diff, tests, Cloud Reviewer findings and remaining risks. Decide to
merge, request a targeted follow-up, or send the item back through `/triage`.
Shipyard never auto-merges.

## Current release boundary

Cloud Reviewer is released as `dymoo/shipyard@v3` and Cloud Coder as
`dymoo/shipyard/cloud-coder@v4`. The unreleased Reviewer reasoning-effort input
is not part of `@v3`; consumers using it must pin a supporting immutable
revision until a separate release updates the tag. Merging main does not move
existing tags. Before applying `ready-for-agent`, confirm the repository has
both workflows. Shipyard accepts their fixed repair hand-off only
with a HMAC proof bound to the repository, direction, Issue, PR, repair round and exact
head commit; it stores no shared secret in the dispatch payload and exposes none
to either model.
