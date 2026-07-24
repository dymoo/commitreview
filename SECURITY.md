# Security

## Reporting a vulnerability

Open a [private security advisory](https://github.com/dymoo/commitreview/security/advisories/new).
Do not open a public issue for an exploitable report.

## Threat model

commitreview runs inside GitHub Actions. There is no hosted service or
telemetry. It makes network requests to exactly two configured authorities:
GitHub's API and the required `base-url`.

**Credentials.** The model API key and GitHub token are registered with the
runner's secret masker immediately after they are read. The model key is sent
only to `base-url` in an `Authorization` header. There is no default or fallback
model endpoint.

**Data sent to the model.** A review can send the pull request title,
description and focused mention; changed hunks and surrounding source;
repository instruction documents from the base commit; and non-ignored
repository files selected by the read-only investigation. This is intentionally
broader than the diff.
Paths matching `ignore` are excluded from file selection, instruction discovery
and agent tools. The built-in list covers generated, vendored and build output,
not secrets; add sensitive paths explicitly.

**Untrusted input.** A pull request author controls code, file names and pull
request prose that reach the model. Prompts fence these as data, but prompt
instructions are not a security boundary. Treat findings as untrusted advice
and never automate merges from them.

**Pull request code is never executed.** The action downloads GitHub's repository
snapshot at the head commit, extracts it to a temporary directory and reads
files. It does not run, build, install or check out the pull request. Reads
reject traversal, backslashes and paths outside the snapshot; symlink targets
are resolved and checked before reading. The temporary snapshot is removed after
context collection, including on failure.

This makes `pull_request_target` safe for the recommended workflow only while
that workflow also avoids checking out or executing the pull request head.

**Agent boundary.** The model has only `list_files`, `read_file` and exact-text
`search`. Calls are bounded and respect ignores. There is no write tool, shell,
repository-code execution or agent network access. Endpoints that reject tool
calling fail rather than silently degrading.

**Posted model text.** GitHub sanitises rendered Markdown. commitreview also
neutralises user mentions and strips its reserved fingerprint markers from
model-authored prose before posting it.

**Who can spend the key.** Automatic `pull_request` and `pull_request_target`
events are not author-gated; on a public repository, any opened pull request can
cause a review. The `@commitreview` comment trigger is fixed to repository
owners, members and collaborators. There is no input that disables that gate.

**Permissions.** The action needs `contents: read` and
`pull-requests: write`. It never writes repository contents, pushes, approves or
requests changes. Reviews use the `COMMENT` event.

## Supply chain

There are no runtime dependencies and no bundled build output. `action.yml`
runs `src/index.js` directly on Node 20, so the audited source is the executed
source. Pin an immutable release when required:

```yaml
- uses: dymoo/commitreview@v2.0.0
```
