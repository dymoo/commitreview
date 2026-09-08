# Domain context

Shipyard is a GitHub Actions software factory with two coordinated components:
`cloud-reviewer` and `cloud-coder`. The user's local Codex or Claude Code
session uses Matt Pocock's skills to create exceptionally well-defined work,
queues it, and gives the final merge approval.

`cloud-reviewer` source exposes an eight-input review action; released `@v3`
remains seven-input until a separate tag update. It performs a
constrained, read-only model investigation. The reviewed repository is
untrusted evidence: the action may list, read, and search its files, but must
never execute its code, write into it, access paths outside its extracted root,
or let model text choose review anchors.

`cloud-coder` is a distinct sandboxed action and trust boundary. It receives an
AFK-ready Agent Brief, writes an initial draft PR, runs bounded adversarial
repair, and hands that PR to `cloud-reviewer`. It never auto-merges. The coder
must not weaken the reviewer's non-negotiables or share its credential model.
Both actions accept a repository-dispatch hand-off only with a HMAC proof bound
to the repository, direction, Issue, PR, repair round and exact head commit; no secret
reaches model or event storage.
