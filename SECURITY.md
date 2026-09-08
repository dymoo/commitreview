# Security

## Reporting a vulnerability

Open a [private security advisory](https://github.com/dymoo/shipyard/security/advisories/new).
Do not open a public issue for an exploitable report.

## Threat model

Shipyard Cloud Reviewer runs inside GitHub Actions. There is no hosted service
or telemetry. The reviewer can contact GitHub's API and its required `base-url`;
the optional preflight can contact only `https://openrouter.ai/api/v1` and sends
no repository content.

**Runner boundary.** Cloud Coder and Cloud Reviewer default to a `self-hosted`
runner. Treat that runner as dedicated trusted infrastructure: it receives model
and GitHub credentials, must have Docker for the Coder's isolated test
container, and must not execute unrelated untrusted workloads. The Coder test
container is an additional boundary, not a substitute for host isolation.

**Credentials.** Model, GitHub and HMAC hand-off keys are masked immediately.
The reviewer key is sent only to `base-url`; the preflight key only to
OpenRouter. There is no default or fallback model endpoint. Coder/Reviewer
dispatches contain a HMAC proof over repository, direction, Issue, PR, repair
round and head SHA; the shared secret is never retained in an event payload or sent to a
model. Receivers reject a proof unless the live pull-request head still matches.

**OpenRouter routing.** When `base-url` is exactly
`https://openrouter.ai/api/v1`, every request requires an endpoint with data
collection denied, Zero Data Retention and support for all request parameters.
If no route satisfies that policy, review fails rather than relaxing the policy
or falling back. When a reasoning effort is explicitly configured, a 400/404
parameter rejection also fails rather than retrying without that effort. The
source-free preflight verifies the current key's spend
limit/reset interval, effective model allowlist, ZDR route and strict synthetic
tool route immediately before source-bearing review. Each OpenRouter request
also sends fixed public attribution metadata: title `Shipyard` and URL
`https://github.com/dymoo/shipyard`; no user, repository or request data is
included in those headers.

**Prompt caching.** Shipyard sends OpenRouter a run-scoped sticky `session_id`
derived only from GitHub's opaque workflow-run identifier. It keeps provider
prompt caching warm for one Coder or Reviewer job without retaining responses
in OpenRouter. Shipyard never enables OpenRouter response caching: it is not a
fit for stateful agent turns and is unavailable with account-level ZDR.

**Data sent to the model.** A review can send PR metadata, changed hunks and
surrounding source, base-commit instruction documents, and non-ignored files
selected by the read-only investigation. Add sensitive paths explicitly to
`ignore`; generated/vendor defaults are not a secrets policy.

**Untrusted input.** PR authors control code, file names and prose that reach
the model. Prompts fence them as data, but that is not a security boundary.
Treat findings as untrusted advice and never auto-merge from them.

**PR code is never executed.** Shipyard downloads and reads the GitHub snapshot
at the head commit; it does not run, build, install or check out PR code. Reads
reject traversal and escapes; temporary snapshots are removed after collection.
This is why `pull_request_target` is safe only while the workflow also avoids a
head-ref checkout.

**Agent boundary.** Cloud Reviewer has only `list_files`, `read_file` and
exact-text `search`; no write, shell or network tool. Tool calling is required.
Posted model prose has reserved Shipyard markers and user mentions neutralised.

**Who can spend the key.** Pull-request events can run automatically. The
`@shipyard` comment trigger is limited to repository owners, members and
collaborators. A standard review needs `contents: read` and `pull-requests:
write`; the Coder hand-off workflow additionally needs `contents: write` and
`issues: write` for its fixed, token-authenticated repair transition. The
reviewer never pushes, approves or requests changes.

## Supply chain

The reviewer and preflight have no runtime dependencies or bundled build output;
their `action.yml` files run audited Node 20 source directly. Pin an immutable
release in production:

```yaml
- uses: dymoo/shipyard@v3
```
