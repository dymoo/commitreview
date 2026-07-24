# ChatGPT subscription authentication

> **Status: deferred.** commitreview v2 accepts API keys only.

The earlier design proposed copying the Codex device-login flow and calling
ChatGPT's internal Codex Responses endpoint directly. We are not shipping that
route.

## Why

OpenAI's current guidance is explicit:

- API keys are the supported default for programmatic Codex and CI/CD work.
- ChatGPT-managed `auth.json` automation is for trusted private infrastructure,
  not public or open-source repositories.
- Codex should refresh and persist its own `auth.json`; a generic OAuth client
  should not implement that refresh lifecycle itself.
- Codex access tokens are for trusted Business and Enterprise workflows through
  Codex CLI or app server, not general Responses API calls.

OpenCode demonstrates that direct subscription authentication can work today,
but its implementation depends on a private ChatGPT endpoint, account-id claims
and rotated refresh tokens. That is implementation evidence, not a stable public
contract for a GitHub Action.

Relevant sources:

- [OpenAI authentication](https://learn.chatgpt.com/docs/auth)
- [Maintaining Codex account auth in CI/CD](https://learn.chatgpt.com/docs/auth/ci-cd-auth)
- [Codex access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens)
- [OpenCode's Codex authentication implementation](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/codex.ts)

## Reconsideration criteria

Subscription authentication can be reconsidered when OpenAI documents a public
transport suitable for third-party GitHub Actions, including credential
rotation on ephemeral runners. A separate self-hosted integration through Codex
CLI or app server is also possible, but it would be a different execution model
from this dependency-free action.
