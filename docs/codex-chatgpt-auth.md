# Using a ChatGPT (Codex) subscription

> **Status: design, not shipped.** This documents how commitreview _will_ let you
> pay for reviews with a ChatGPT Pro/Plus subscription instead of a metered API
> key, and the constraints that shape it. Nothing here is wired up yet — it is
> published so the design (and its sharp edges) can be reviewed before code is
> written. The flow and every endpoint below are taken from OpenAI's own Codex
> CLI client, as re-implemented in [opencode](https://github.com/sst/opencode)'s
> `plugin/codex.ts`.

## What this is

OpenAI's Codex CLI lets a ChatGPT Pro/Plus subscriber use their subscription
instead of a pay-per-token API key. It does this with an OAuth login against
`auth.openai.com`, then calls a ChatGPT-internal endpoint —
`https://chatgpt.com/backend-api/codex/responses` — with the resulting token.
The subscription, not a key, pays for the tokens.

The goal here: set `model: codex`, do a one-time login, and have commitreview
review your pull requests on your ChatGPT subscription.

## The login flow (device authorization)

CI has no browser and no localhost callback, so the browser/PKCE flow is out.
The **device authorization** flow is the one that fits — the same one `codex
login --headless` uses. It is a poll loop, not a callback:

Constants (public; these are OpenAI's Codex CLI client, not secrets):

|              |                                                   |
| ------------ | ------------------------------------------------- |
| Issuer       | `https://auth.openai.com`                         |
| Client ID    | `app_EMoamEEZ73f0CkXaXp7hrann`                    |
| API endpoint | `https://chatgpt.com/backend-api/codex/responses` |

1. **Request a user code.**
   `POST https://auth.openai.com/api/accounts/deviceauth/usercode`
   with JSON `{ "client_id": "app_EMoamEEZ73f0CkXaXp7hrann" }`.
   Response: `{ device_auth_id, user_code, interval }`.

2. **Show the user the code and URL.** Print `user_code` and tell them to open
   `https://auth.openai.com/codex/device` and enter it. They have a few minutes.

3. **Poll for the grant.**
   `POST https://auth.openai.com/api/accounts/deviceauth/token`
   with JSON `{ device_auth_id, user_code }`, every `interval` seconds
   (plus a small margin).
   - `403` / `404` → not authorized yet, keep polling.
   - `200` → `{ authorization_code, code_verifier }`.
   - anything else → failed, stop.

4. **Exchange the code for tokens.**
   `POST https://auth.openai.com/oauth/token`, form-encoded:
   `grant_type=authorization_code`, `code=<authorization_code>`,
   `redirect_uri=https://auth.openai.com/deviceauth/callback`,
   `client_id=<client id>`, `code_verifier=<code_verifier>`.
   Response: `{ id_token, access_token, refresh_token, expires_in }`.

5. **Extract the account id.** Base64url-decode the JWT `id_token` (or
   `access_token`) payload and read `chatgpt_account_id`
   (or `https://api.openai.com/auth.chatgpt_account_id`, or
   `organizations[0].id`). It becomes the `ChatGPT-Account-Id` request header.

## Calling the model at review time

Each run:

1. **Refresh.** The `access_token` lasts ~1 hour, so a stored one is always
   stale by the next PR. Exchange the stored `refresh_token`:
   `POST https://auth.openai.com/oauth/token`, form-encoded
   `grant_type=refresh_token`, `refresh_token=<stored>`, `client_id=<client id>`.
   → a fresh `{ access_token, refresh_token, expires_in }`.

2. **Call.** `POST https://chatgpt.com/backend-api/codex/responses` with
   `Authorization: Bearer <access_token>` and `ChatGPT-Account-Id: <account id>`.

Register both tokens with the runner's secret masker first — same as any key.

### The transport gap (biggest build item)

commitreview today speaks exactly one dialect: `POST {base-url}/chat/completions`,
OpenAI Chat Completions shape. The Codex endpoint is **not** that — it is the
**Responses API** (`/codex/responses`), a different request body and a different
streaming/response envelope. So `codex` is not just a new `base-url`; it needs a
second transport in `llm.js` (build the Responses request, parse the Responses
reply) sitting behind the same internal interface the rest of the pipeline uses.
Everything downstream — anchoring, refutation, panel, taste — is transport-blind
and unaffected. This is the real cost of the feature, and it is why `codex`
is a named model rather than "point `base-url` at ChatGPT."

## The secret problem (verified against GitHub docs)

The obvious design — "the action logs in once and stores the token as a repo
secret for next time" — runs straight into GitHub's security model. Two facts,
both confirmed from the GitHub REST docs:

- **An action cannot read its own secrets through the API.** "Get a repository
  secret" returns metadata only and _never_ the encrypted value. A secret only
  reaches a run when the workflow injects it explicitly as `${{ secrets.NAME }}`.
- **An action cannot write a secret with the default token.** "Create or update
  a repository secret" needs a classic PAT with `repo` scope, or a fine-grained
  token with **Secrets: write**. The automatic `GITHUB_TOKEN` has no secrets
  permission at all — there is no `permissions:` scope that grants it. Writing a
  secret means handing the run an admin-grade PAT.

So the token cannot silently round-trip through repo secrets on the automatic
token. There are two honest ways to persist it.

### Strategy A — local login, paste the token (recommended)

The user runs the device flow **on their own machine** (a small
`scripts/codex-login.mjs` we ship), gets the `refresh_token`, and pastes it into
repo secrets as `CODEX_REFRESH_TOKEN` — exactly the one-time step they already
do for `LLM_API_KEY`. The token never touches CI logs.

```yaml
with:
  model: codex
  codex-refresh-token: ${{ secrets.CODEX_REFRESH_TOKEN }}
```

No admin PAT, no self-writing secrets, nothing to leak in a log. The only cost
is that if the refresh token ever becomes invalid, the user re-runs the login
script and re-pastes.

### Strategy B — bootstrap job self-writes the secret (needs an admin PAT)

A manual `workflow_dispatch` "login" job runs the device flow, prints the code
for the user, then encrypts the refresh token with the repo's Actions public key
and `PUT`s it as `CODEX_REFRESH_TOKEN`. This matches the "action stores its own
secret" idea — but it requires a `SETUP_PAT` secret with Secrets: write already
present. That is chicken-and-egg (you store an admin PAT to store a token) and
the PAT is far more dangerous than the thing it bootstraps. **Not recommended**,
and only worth building if Strategy A proves untenable because of rotation ↓.

## Open risk: does the refresh token rotate?

OpenAI's refresh response _returns a new `refresh_token` every time_, and the
Codex CLI / opencode both write it back to local storage on every refresh. If
OpenAI **invalidates the old refresh token on use** (single-use rotation, common
with `offline_access`), then a stateless CI run is a problem: it refreshes, gets
a new token, and has nowhere to persist it — so the _next_ run's stored token is
already dead. That would force one of:

- Strategy B (write the rotated token back into the secret — admin PAT), or
- periodic manual re-login (Strategy A, fragile), or
- confirmation that the old refresh token stays valid (rotation is not
  enforced), which makes Strategy A clean.

**This must be settled by testing against a real ChatGPT subscription before
building** — it decides whether Strategy A alone is viable. It needs an account
we do not have; it is the first thing to check when someone with a sub can.

## Open questions to resolve before building

1. Refresh-token rotation policy (above) — the load-bearing unknown.
2. Responses-API request/response shape for a non-streaming JSON review call,
   and whether `response_format` / structured output is honored there.
3. Terms: whether programmatic PR review on a ChatGPT subscription is within
   OpenAI's usage terms for that subscription tier. Worth stating plainly in the
   README so users decide with eyes open.
4. Model naming: `codex` → which concrete model, and whether to expose the
   `gpt-5.x-codex` variants.
