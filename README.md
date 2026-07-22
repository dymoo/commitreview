# commitreview

Adversarial AI code review on pull requests, as a GitHub Action. Bring your own key.

Mention it on a PR, or let it run on every push. It reads the diff, finds defects,
tries to disprove each one, and posts what survives as inline review comments.

- **Any OpenAI-compatible endpoint** — OpenAI, OpenRouter, Ollama Cloud, Together, Groq, DeepSeek, vLLM, llama.cpp, Azure. One `base-url` + `model` + `api-key`.
- **No servers, no app to install, no data through anyone else's infrastructure.** Your key, your runner, your repository.
- **No checkout required.** The action never fetches or executes the PR's code, which makes it safe on `pull_request_target` and on forks.
- **Zero dependencies.** No `dist/` bundle — the code that runs is the code in `src/`.

---

## Quick start

Add `.github/workflows/commitreview.yml`:

```yaml
name: commitreview

on:
  pull_request_target:
    types: [opened, synchronize, reopened]
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: commitreview-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: true

jobs:
  review:
    if: >-
      github.event_name == 'pull_request_target' ||
      (github.event.issue.pull_request && contains(github.event.comment.body, '@commitreview'))
    runs-on: ubuntu-latest
    steps:
      - uses: dymoo/commitreview@v1
        with:
          api-key: ${{ secrets.LLM_API_KEY }}
          base-url: https://openrouter.ai/api/v1
          model: z-ai/glm-4.6
```

Then add your provider key as a repository secret named `LLM_API_KEY`
(**Settings → Secrets and variables → Actions → New repository secret**).

That is the whole setup. Open a pull request, or comment `@commitreview` on one.

---

## Providers

Any endpoint that serves `POST {base-url}/chat/completions` works. `base-url`
must include the version path.

| Provider         | `base-url`                                      | example `model`               |
| ---------------- | ----------------------------------------------- | ----------------------------- |
| OpenAI           | `https://api.openai.com/v1`                     | `gpt-5.1`                     |
| OpenRouter       | `https://openrouter.ai/api/v1`                  | `z-ai/glm-4.6`                |
| Ollama Cloud     | `https://ollama.com/v1`                         | `glm-4.6`                     |
| DeepSeek         | `https://api.deepseek.com/v1`                   | `deepseek-reasoner`           |
| Together         | `https://api.together.xyz/v1`                   | `Qwen/Qwen3-235B-A22B`        |
| Groq             | `https://api.groq.com/openai/v1`                | `moonshotai/kimi-k2-instruct` |
| Mistral          | `https://api.mistral.ai/v1`                     | `mistral-large-latest`        |
| Anthropic        | `https://api.anthropic.com/v1`                  | `claude-sonnet-4-5`           |
| Azure OpenAI     | `https://{resource}.openai.azure.com/openai/v1` | your deployment name          |
| vLLM / llama.cpp | `http://your-host:8000/v1`                      | whatever you loaded           |

Providers disagree about `response_format`, `temperature` and `max_tokens`.
commitreview probes: if the endpoint rejects one of those with a 400, it drops or
renames the parameter, retries, and remembers for the rest of the run. JSON is
always recovered from the response text — from fenced blocks, from prose,
from `<think>` output, and from responses cut off by a token limit — so nothing
depends on native structured output.

**Self-hosted models** need a runner that can reach them. Use a self-hosted
runner and point `base-url` at your server; no key is required by most local
servers, but the input is mandatory, so pass any placeholder.

---

## Triggering

**On every push to a PR** — `pull_request_target` with types `[opened, synchronize, reopened]`.
Use `pull_request` instead if the repository is private or you do not want fork
PRs reviewed. See [security](#security) for why `pull_request_target` is safe here.

**On mention** — `issue_comment`, `types: [created]`. Anyone whose author
association is in `allowed-associations` (owner, member or collaborator by
default) can comment `@commitreview` on a PR to trigger a run. Text after the
phrase becomes a focus instruction:

```
@commitreview look closely at the retry logic and the transaction boundaries
```

The bot reacts 👀 when it picks the request up. Because it posts with
`GITHUB_TOKEN`, its own comments cannot re-trigger the workflow — there is no
self-review loop.

**Manually** — pass `pr-number` explicitly from a `workflow_dispatch` job.

---

## Inputs

### Required

| Input     | Description                                                         |
| --------- | ------------------------------------------------------------------- |
| `api-key` | Key for the endpoint. Always a secret, never a literal.             |
| `model`   | Model id, e.g. `glm-4.6`, `gpt-5.1`, `anthropic/claude-sonnet-4.5`. |

### Connection

| Input               | Default                     | Description                                    |
| ------------------- | --------------------------- | ---------------------------------------------- |
| `base-url`          | `https://api.openai.com/v1` | Endpoint base, including the version path.     |
| `github-token`      | `${{ github.token }}`       | Needs `pull-requests: write`.                  |
| `temperature`       | `0.1`                       | Dropped automatically if the model rejects it. |
| `max-output-tokens` | `8000`                      | Per response.                                  |
| `json-mode`         | `auto`                      | `on`, `off`, or `auto` to try and fall back.   |
| `request-timeout`   | `180`                       | Seconds per model request.                     |

### What gets reviewed

| Input                 | Default  | Description                                                             |
| --------------------- | -------- | ----------------------------------------------------------------------- |
| `include`             | —        | Newline-separated globs. When set, only these files are reviewed.       |
| `ignore`              | —        | Newline-separated globs, added to the built-in list.                    |
| `use-default-ignores` | `true`   | Skip lockfiles, build output, vendored code, snapshots, generated code. |
| `max-files`           | `60`     | Cap on changed files.                                                   |
| `max-file-bytes`      | `400000` | Above this, the diff is still reviewed but not widened with context.    |
| `context-lines`       | `20`     | Lines of real surrounding source shown around each hunk. `0` disables.  |
| `max-input-tokens`    | `120000` | Approximate ceiling for the whole review.                               |
| `chunk-tokens`        | `30000`  | Approximate ceiling per request.                                        |
| `concurrency`         | `4`      | In-flight model requests.                                               |

Anything skipped or dropped is listed in the summary comment. The action never
silently truncates a review.

### What gets posted

| Input                  | Default                     | Description                                                         |
| ---------------------- | --------------------------- | ------------------------------------------------------------------- |
| `max-findings`         | `25`                        | Kept before verification, most severe first.                        |
| `min-severity`         | `low`                       | One of `critical`, `high`, `medium`, `low`, `nit`.                  |
| `refute`               | `true`                      | Adversarial pass that tries to disprove each finding.               |
| `refute-votes`         | `1`                         | Independent attempts per finding; a finding survives on a majority. |
| `inline-comments`      | `true`                      | Off puts everything in the summary instead.                         |
| `summary-mode`         | `sticky`                    | `sticky` updates one comment, `new` posts each run, `off` skips.    |
| `suggestions`          | `true`                      | Render fixes as committable GitHub suggestion blocks.               |
| `fail-on`              | `none`                      | Fail the step at or above this severity.                            |
| `instructions`         | —                           | Extra guidance appended to the system prompt.                       |
| `dry-run`              | `false`                     | Do everything except write to the PR.                               |
| `trigger-phrase`       | `@commitreview`             | Mention phrase.                                                     |
| `allowed-associations` | `OWNER,MEMBER,COLLABORATOR` | Who may trigger by comment. `ANY` disables the gate.                |
| `pr-number`            | —                           | Review a specific PR regardless of the event.                       |

### Outputs

| Output          | Description                                |
| --------------- | ------------------------------------------ |
| `findings`      | Number of findings posted.                 |
| `findings-json` | Path to a JSON file with the full payload. |
| `summary`       | The markdown summary that was posted.      |
| `reviewed`      | `true` when a review ran.                  |

---

## Recipes

**Give it your conventions.**

```yaml
with:
  instructions: |
    This is a Rails monolith. Flag anything that queries inside a loop.
    All money is in integer pence — flag float arithmetic on money.
    Background jobs must be idempotent; flag any that are not.
```

**Only review the code you care about.**

```yaml
with:
  include: |
    src/**
    api/**
  ignore: |
    **/*.test.ts
    docs/**
```

**Block the merge on serious findings.**

```yaml
with:
  fail-on: high
  refute-votes: 3 # three independent skeptics; majority wins
```

**Keep it cheap on a big repository.**

```yaml
with:
  max-files: 20
  context-lines: 8
  max-input-tokens: 40000
  min-severity: medium
```

**Try it without posting anything.**

```yaml
with:
  dry-run: true # findings go to the job summary only
```

**Use the results in a later step.**

```yaml
- uses: dymoo/commitreview@v1
  id: review
  with: { api-key: ${{ secrets.LLM_API_KEY }}, model: glm-4.6 }
- run: jq '.findings[] | .severity' "${{ steps.review.outputs.findings-json }}"
```

More complete workflows are in [`examples/workflows`](examples/workflows).

---

## How it works

**Context assembly.** GitHub's diff gives three lines of context around each
hunk, which is rarely enough to judge whether something is a bug. commitreview
fetches the file at the head commit and widens every hunk with real surrounding
source, then renders each line with its old and new line numbers in explicit
columns. Widened lines are marked `~` and the model is told they are not
commentable. Files are packed into requests up to a token budget; oversized
files are split at hunk boundaries.

**Anchoring.** GitHub rejects an entire review with a 422 if any comment names a
line that is not part of the diff — the single most common failure in tools like
this. Every model claim is validated against the exact set of `(line, side)`
pairs parsed from the diff. A near miss snaps to the closest changed line within
three lines of the same hunk and is labelled as such. Anything that cannot be
anchored is demoted into the summary rather than dropped, and a snapped anchor
never gets a committable suggestion, since it would replace the wrong line. If a
batched review is still rejected, the comments are retried individually so one
bad anchor cannot lose the rest.

**Refutation.** A one-shot reviewer's failure mode is not missing bugs, it is
inventing them. Each finding goes to an independent skeptic prompted to refute
it and to default to "not real" when unsure. Only survivors are posted.

**Idempotency.** Every comment carries a fingerprint of the path, the finding,
and the _text_ of the line it points at — not the line number. A rebase or an
edit above the finding does not make it look new, so re-running on a new push
adds only what is genuinely new. The summary is one comment updated in place.

**Portability.** No native tool calling, no `json_schema`, no agentic loop —
those are exactly the features that vary between OpenAI-compatible servers. One
prompt in, JSON out, parsed defensively.

---

## Security

**Your key never leaves your runner.** There is no hosted service. The action
talks to GitHub and to the endpoint you configure, and nothing else.

**`pull_request_target` is safe here** — commitreview never checks out or
executes the pull request's code. It reads the diff and file contents through
the API. Do not add an `actions/checkout` of the head ref to the same workflow;
that is what makes `pull_request_target` dangerous, and it is not needed.

**Comment triggers are gated by author association.** By default only the owner,
organisation members and collaborators can spend your key, and `pr-number`
cannot be used to step around that gate. Setting `allowed-associations: ANY` on
a public repository lets any stranger run reviews on your budget.

**The automatic trigger is not gated, by design.** On a public repository,
`pull_request_target` means anyone who opens a pull request causes a review, and
that spends your key. That is usually what you want, but if it is not, gate the
job or drop the automatic trigger and review on mention only:

```yaml
jobs:
  review:
    if: contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.pull_request.author_association)
```

**Prompt injection.** Diffs are untrusted input and are labelled as such to the
model, which is instructed to treat them as data and to report injection
attempts as a high-severity finding. Treat findings as advice, not as a gate you
never look at.

**What the model sees.** The changed hunks, surrounding source from the changed
files, the PR title and description. Nothing else in the repository. If that is
still too much for a given path, add it to `ignore`.

---

## Cost

One review is roughly one request per 30k tokens of diff, plus one small request
per finding for refutation. A typical 300-line PR is two to four requests. Keep
it down with `max-files`, `context-lines`, `max-input-tokens`, `min-severity`, or
`refute: false`.

Reviews trigger on `synchronize`, so a branch pushed ten times is reviewed ten
times. The `concurrency` block in the quick start cancels superseded runs. To
review only on demand, drop the `pull_request_target` trigger and use mentions.

---

## Development

```bash
npm install
npm test          # node:test, no network
npm run check-all # format check, typecheck, tests
```

`src/` is plain ESM with JSDoc types, checked by `tsc --checkJs`. There are no
runtime dependencies and no build step: `action.yml` runs `src/index.js`
directly, so what you read is what runs on the runner.

Where things live:

| File             | Responsibility                                        |
| ---------------- | ----------------------------------------------------- |
| `src/index.js`   | Orchestration                                         |
| `src/config.js`  | Inputs and event resolution                           |
| `src/github.js`  | REST client                                           |
| `src/diff.js`    | Diff parsing and comment anchoring                    |
| `src/context.js` | File selection, context widening, chunking            |
| `src/llm.js`     | OpenAI-compatible client, defensive JSON              |
| `src/review.js`  | Prompts, find pass, refute pass                       |
| `src/post.js`    | Fingerprinting, dedupe, comment and summary rendering |

Issues and pull requests welcome. If you are changing anchoring, chunking or
JSON extraction, add a case to the tests — those three are where this class of
tool breaks.

## License

MIT
