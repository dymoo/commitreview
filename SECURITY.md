# Security

## Reporting a vulnerability

Open a [private security advisory](https://github.com/dymoo/commitreview/security/advisories/new).
Please do not open a public issue for anything exploitable.

## Threat model

commitreview runs inside your GitHub Actions runner. There is no hosted service,
no telemetry and no third party. It makes network requests to exactly two places:
the GitHub API, and the `base-url` you configure.

**Your API key** is registered with the runner's secret masker on the first line
of execution, before any other work happens, so it cannot appear in logs. It is
sent only to `base-url`, in an `Authorization` header.

**What is sent to the model:** the changed hunks, surrounding source from the
changed files, and the pull request title and description. Nothing else from the
repository. Paths matching `ignore` are never read. If a path must never leave
the repository, add it to `ignore` — the default list covers lockfiles, build
output and vendored code, not secrets.

**The diff is untrusted input.** A pull request author controls the code, the
comments and the file names that reach the model. Prompts label the diff as data
and instruct the model to report injection attempts rather than follow them, but
no such instruction is a guarantee. Treat findings as advice from an untrusted
source: read them, do not automate merges on them.

**No code from the pull request is executed or checked out.** The action reads
the diff and file contents through the GitHub API. This is why
`pull_request_target` is safe with commitreview specifically — but only as long
as your workflow does not also check out the head ref. Do not add
`actions/checkout` with `ref: ${{ github.event.pull_request.head.sha }}` to a
`pull_request_target` workflow.

**Who can spend your key.** Comment triggers are restricted to the author
associations in `allowed-associations`, which defaults to owners, members and
collaborators; a `pr-number` input cannot bypass that gate. The automatic
`pull_request` / `pull_request_target` trigger is deliberately not gated — on a
public repository, anyone who opens a pull request causes a review. See
[Security in the README](README.md#security) for how to gate it.

**Permissions.** The action needs `contents: read` and `pull-requests: write`.
It never writes to the repository contents, never pushes, and never approves or
requests changes on a review — reviews are always submitted as `COMMENT`.

## Supply chain

There are no runtime dependencies and no bundled `dist/` — `action.yml` runs
`src/index.js` directly, so the code you audit is the code that runs. Pin to a
release tag, or to a commit SHA if you want the strongest guarantee:

```yaml
- uses: dymoo/commitreview@v1.0.0
```
