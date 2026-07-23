# commitreview

**An open source, fully self-hostable equivalent of OpenAI's `@codex` cloud review — one you own end to end.**

Mention it on a pull request and it reviews the change in the context of your
whole codebase, argues with itself about what it found, and posts what survives
as inline comments. Ask it a question and it answers in the thread. It runs in
your own GitHub Actions runner, on your own API key, and nothing goes anywhere
you did not send it.

- **Catches vibe slop.** A dedicated taste pass looks for what linters and defect reviewers both miss: code that reinvents what you already have, patterns applied unevenly, an auth check present in one path and absent in its sibling, abstractions nobody asked for. [What that means →](#the-taste-pass-vibe-slop-and-restraint)
- **Reviews the codebase, not just the diff.** It reads the repository at the head commit — the definitions of what your change calls, the callers of what your change modified, and the project's own `AGENTS.md` / `CLAUDE.md` rules.
- **Ask several labs at once.** Run the same review across models from different labs; each finding is cross-checked by a model that did not find it, and the lead model reconciles the result. [Panel review →](#panel-review-several-labs-one-review)
- **Talk to it.** `@commitreview why would that deadlock?` gets an answer. Reply to one of its comments and it replies in that thread.
- **Any OpenAI-compatible endpoint.** OpenAI, OpenRouter, Ollama, Together, Groq, DeepSeek, vLLM, llama.cpp, Anthropic, Azure. One `base-url` + `model` + `api-key`.
- **No service, no app to install, no third party.** Your key, your runner, your source code.
- **No checkout required**, which makes `pull_request_target` safe here, and forks work.
- **Zero dependencies, no `dist/` bundle.** The code that runs is the code in `src/`.

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
          model: moonshotai/kimi-k3
```

Add your provider key as a repository secret named `LLM_API_KEY`
(**Settings → Secrets and variables → Actions → New repository secret**).

That is the whole setup. Open a pull request, or comment `@commitreview` on one.

> **Which model?** As of late July 2026, `moonshotai/kimi-k3` is the best
> cheap reviewer we have found. Any capable model works — this is your key and
> your choice, and the action deliberately ships no opinion beyond that.

---

## Using it

**Review on every push.** The `pull_request_target` trigger above reviews each
push to a pull request.

**Review on demand.** Comment `@commitreview` on a pull request. Add a focus and
it takes the hint:

```
@commitreview review the migration for data loss
```

**Ask it things.** Any mention that is not a review request is a question, and
it answers in a comment rather than reviewing:

```
@commitreview why would this deadlock under concurrent writes?
@commitreview is the retry backoff actually reset between attempts?
@commitreview is there already a helper for this in the codebase?
```

It answers with the same read-only tools it reviews with, so it reads the code
before answering rather than guessing from the diff.

**Reply to its comments.** Replying to one of its inline comments continues that
thread, in that thread, with the thread's history in context. Disagree with it
and it will tell you if you are right.

The bot reacts 👀 when it picks a request up. Because it posts with
`GITHUB_TOKEN`, its own comments cannot re-trigger the workflow — there is no
self-review loop.

---

## The taste pass: vibe slop, and restraint

Most review tools ask "is this correct?". That question misses the thing that
actually degrades a codebase, because slop is never locally wrong. Every piece
is individually plausible — a button that works, an endpoint that responds. The
damage only shows in aggregate: in the seams, in the sixth month, in the
incident review.

**Vibe slop is what accumulates when the cost of generating software collapses
to near zero while the cost of deciding — what to build, why, and how it coheres
— does not.** A model emits a couple of thousand lines from one prompt; a person
makes a handful of genuinely good architectural decisions in a day. When
generation outruns judgement by three orders of magnitude, the gap fills with
un-made decisions wearing the costume of code.

It shows up in layers, and only the third is what people usually mean by "code
quality":

| Layer            | What it looks like                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| **Product**      | Features added because they were promptable, not needed. No kill criteria, no prioritisation.                |
| **UX**           | Every session invents its own conventions. Four button styles, three date formats.                           |
| **Code**         | Duplicated logic instead of reuse, dead code never removed, a thousand lines where a hundred would do.       |
| **Architecture** | No coherent data model. Security checks present in some paths and absent in structurally identical siblings. |
| **Epistemic**    | Nobody alive understands the system. Every future change is archaeology.                                     |

The diagnostic question is never _"did an AI write this?"_ — a reviewed,
well-specified 5,000-line generated patch can be sound, and fifty unjustified
hand-written lines can be slop. It is:

> **Was this complexity deliberately chosen, independently verified, integrated
> with the surrounding system, and accepted by someone able to own its
> consequences?**

The taste pass asks exactly that, and it is the reason the action reads your
whole repository rather than just the diff — you cannot detect reinvention,
inconsistency or a missing sibling check from a diff alone.

**What it reports:** reinvention of code that already exists (cited by
`path:line`), inconsistency with the conventions around it, structural
asymmetry where a sibling path has a check this one lacks, unrequested
abstractions, a dependency reached for before the standard library, tests that
would still pass with the feature deleted, and negative space — the error state
or the rate limit that a change like this normally carries and this one does not.

**What it will never report**, because getting this wrong is worse than saying
nothing: input validation at a trust boundary, error handling that prevents data
loss, security controls, and accessibility basics. Simplicity is never a reason
to remove those. Nor will it flag a shortcut that already records its own
ceiling — a comment like `// ponytail: global lock, per-account if throughput
matters` is a decision, and the opposite of slop.

Every taste finding is judged by its own skeptic, because the defect skeptic
("can you name the input that triggers a crash?") would destroy all of them by
construction. The taste skeptic asks a different question: does the thing you
cite actually exist, and is the convention you claim really the convention here?

The restraint half of this pass condenses the
[ponytail rules by Dietrich Gebert](https://github.com/dietrichgebert/ponytail) —
a lazy-senior-developer ladder that stops at the first rung that holds: does this
need to exist, is it already in the codebase, does the standard library do it,
does the platform do it natively, can it be one line. Used with credit and worth
reading in full.

It is on by default. Turn it off with `taste: false`.

---

## Panel review: several labs, one review

Models from different labs fail differently. Asking one model twice mostly gets
you the same blind spot twice; asking two labs gets you two different ones.

```yaml
with:
  api-key: ${{ secrets.OPENROUTER_KEY }}
  base-url: https://openrouter.ai/api/v1
  model: moonshotai/kimi-k3 # the lead: it reconciles everything at the end

  panel: |
    model: gpt-5.6
    base-url: https://api.openai.com/v1
    api-key: ${{ secrets.OPENAI_KEY }}

    model: claude-sonnet-4-5
    base-url: https://api.anthropic.com/v1
    api-key: ${{ secrets.ANTHROPIC_KEY }}
```

Blank-line-separated blocks of `key: value`, accepting `model`, `base-url`,
`api-key` and `label`. A block that leaves out `base-url` inherits the lead's —
and its key with it — so a second model on the same provider is one line:

```yaml
panel: |
  model: moonshotai/kimi-k3-thinking
```

A block that names its **own** `base-url` must bring its own `api-key`. Keys are
never inherited across providers, and an entry that tries fails the run rather
than quietly sending one lab's credential to another.

What happens:

1. **Every model reviews independently**, running the full set of passes.
2. **Findings are merged.** When two labs land on the same finding, that is
   recorded rather than deduplicated away — you will see _found independently by
   kimi-k3 and gpt-5.6_ on the comment, which is the strongest signal a panel
   produces.
3. **Each finding is cross-checked by a model that did not find it.** A critic
   from the same family shares the author's blind spots; one from another lab
   does not.
4. **The lead model reconciles.** It merges near-duplicates the key-based merge
   missed, drops what contradicts better evidence, and ranks the result. It can
   reword and re-rank but **never relocate** — `path`, `line` and `side` come
   from the diff and no model is allowed to touch them.

Cost scales linearly with panel size: three models is roughly three reviews plus
one synthesis call.

---

## Depth

`depth` is the single dial. Everything else has a sensible default derived from
it, and any input you set explicitly still wins.

| `depth`    | What it does                                                                                 | Cost                      |
| ---------- | -------------------------------------------------------------------------------------------- | ------------------------- |
| `quick`    | Diff only, no repository access, one pass, medium severity and above.                        | Lowest, a few requests.   |
| `standard` | Repository context, one pass, everything above nits. **Default.**                            | A handful of requests.    |
| `thorough` | Four review perspectives, deep investigation, three independent verifiers per finding, nits. | Several times `standard`. |

```yaml
with:
  depth: thorough
```

`thorough` runs four passes — general, security, concurrency and resources, and
integration — because a pass told to care about exactly one thing finds what a
generic pass skims past. Each surviving finding is then attacked by three
independent verifiers, and needs a majority to be posted.

---

## Codebase context

A diff cannot tell you what the function you are calling actually returns, or
who else depends on the thing you just changed. So the action fetches the
repository at the head commit (one request, never executed) and works both out.

**When the endpoint supports tool calling**, the model investigates for itself
with four read-only tools — `search`, `read_file`, `list_files`,
`find_definition` — for up to `agent-turns` turns. It follows what it becomes
suspicious of, which is the part deterministic retrieval cannot do.

**When it does not**, the action falls back to deterministic retrieval that
extracts the symbols your change defines and calls, then scans the repository
for their definitions and their callers. Less thorough, but it works on every
endpoint, at predictable cost.

`agentic: auto` (the default) picks whichever the endpoint supports. Neither
path can write, run a shell, or reach the network.

**Project rules are read and treated as binding.** `AGENTS.md`, `CLAUDE.md`,
`CONVENTIONS.md`, `CONTRIBUTING.md`, `.cursorrules`, `.windsurfrules`,
`.cursor/rules/*`, and `.github/copilot-instructions.md` — at the repository
root and in every directory on the path to a changed file, so
`src/api/AGENTS.md` applies to changes under `src/api/`. `@imports` inside those
files are followed, so an `AGENTS.md` that pulls in six standards documents
works. Code that violates a documented rule is reported as a finding.

Set `repo-context: off` to review the diff alone.

---

## Inputs

### Required

| Input     | Description                                             |
| --------- | ------------------------------------------------------- |
| `api-key` | Key for the endpoint. Always a secret, never a literal. |
| `model`   | Model id, as your provider names it.                    |

### Connection

| Input               | Default                     | Description                                                             |
| ------------------- | --------------------------- | ----------------------------------------------------------------------- |
| `base-url`          | `https://api.openai.com/v1` | Endpoint base, including the version path.                              |
| `github-token`      | `${{ github.token }}`       | Needs `pull-requests: write`.                                           |
| `temperature`       | `0.1`                       | Dropped automatically if the model rejects it.                          |
| `max-output-tokens` | `16000`                     | Per response. Reasoning models spend this on thinking before answering. |
| `json-mode`         | `auto`                      | `on`, `off`, or `auto` to try and fall back.                            |
| `request-timeout`   | `180`                       | Seconds per model request.                                              |

### Depth and context

| Input                | Default      | Description                                                          |
| -------------------- | ------------ | -------------------------------------------------------------------- |
| `depth`              | `standard`   | `quick`, `standard` or `thorough`. Sets the defaults below.          |
| `repo-context`       | from `depth` | `auto` reads the repository; `off` reviews the diff alone.           |
| `agentic`            | `auto`       | `on`, `off`, or `auto` to use tools when the endpoint supports them. |
| `agent-turns`        | from `depth` | Investigation turns before the agent must report back.               |
| `review-passes`      | from `depth` | 1–4 perspectives: general, security, concurrency, integration.       |
| `max-related-tokens` | from `depth` | Ceiling on codebase context sent alongside the diff.                 |
| `context-lines`      | from `depth` | Real surrounding source shown around each hunk. `0` disables.        |
| `instructions`       | —            | Extra guidance appended to the system prompt.                        |

### What gets reviewed

| Input                 | Default      | Description                                                       |
| --------------------- | ------------ | ----------------------------------------------------------------- |
| `include`             | —            | Newline-separated globs. When set, only these files are reviewed. |
| `ignore`              | —            | Newline-separated globs, added to the built-in list.              |
| `use-default-ignores` | `true`       | Skip lockfiles, build output, vendored and generated code.        |
| `max-files`           | `60`         | Cap on changed files.                                             |
| `max-file-bytes`      | `400000`     | Above this the diff is reviewed but not widened with context.     |
| `max-input-tokens`    | from `depth` | Approximate ceiling for the whole review.                         |
| `chunk-tokens`        | from `depth` | Approximate ceiling per request.                                  |
| `concurrency`         | `4`          | In-flight model requests.                                         |

Anything skipped or dropped is listed in the summary comment. The action never
silently truncates a review.

### What gets posted

| Input                  | Default                     | Description                                                   |
| ---------------------- | --------------------------- | ------------------------------------------------------------- |
| `max-findings`         | from `depth`                | Kept before verification, most severe first.                  |
| `min-severity`         | from `depth`                | `critical`, `high`, `medium`, `low` or `nit`.                 |
| `refute`               | `true`                      | Adversarial pass that tries to disprove each finding.         |
| `refute-votes`         | from `depth`                | Independent verifiers per finding; survives on a majority.    |
| `inline-comments`      | `true`                      | Off puts everything in the summary instead.                   |
| `summary-mode`         | `sticky`                    | `sticky` updates one comment, `new` each run, `off` skips it. |
| `suggestions`          | `true`                      | Render fixes as committable GitHub suggestion blocks.         |
| `fail-on`              | `none`                      | Fail the step at or above this severity.                      |
| `dry-run`              | `false`                     | Do everything except write to the pull request.               |
| `trigger-phrase`       | `@commitreview`             | Mention phrase.                                               |
| `allowed-associations` | `OWNER,MEMBER,COLLABORATOR` | Who may trigger by comment. `ANY` disables the gate.          |
| `pr-number`            | —                           | Review a specific PR regardless of the event.                 |

### Outputs

| Output          | Description                                |
| --------------- | ------------------------------------------ |
| `findings`      | Number of findings posted.                 |
| `findings-json` | Path to a JSON file with the full payload. |
| `summary`       | The markdown summary that was posted.      |
| `reviewed`      | `true` when a review ran.                  |

---

## Providers

Any endpoint serving `POST {base-url}/chat/completions` works. `base-url` must
include the version path.

| Provider         | `base-url`                                      |
| ---------------- | ----------------------------------------------- |
| OpenAI           | `https://api.openai.com/v1`                     |
| OpenRouter       | `https://openrouter.ai/api/v1`                  |
| Ollama Cloud     | `https://ollama.com/v1`                         |
| DeepSeek         | `https://api.deepseek.com/v1`                   |
| Together         | `https://api.together.xyz/v1`                   |
| Groq             | `https://api.groq.com/openai/v1`                |
| Mistral          | `https://api.mistral.ai/v1`                     |
| Anthropic        | `https://api.anthropic.com/v1`                  |
| Azure OpenAI     | `https://{resource}.openai.azure.com/openai/v1` |
| vLLM / llama.cpp | `http://your-host:8000/v1`                      |

Providers disagree about `response_format`, `temperature`, `max_tokens` and tool
calling. commitreview probes: when an endpoint rejects one of those with a 400,
it drops or renames the parameter, retries, and remembers for the rest of the
run. JSON is always recovered from the response text — from fenced blocks, from
prose, from `<think>` output, and from responses cut off by a token limit — so
nothing depends on native structured output.

[Anthropic serves an OpenAI-compatible layer](https://docs.claude.com/en/api/openai-sdk)
at `https://api.anthropic.com/v1`, with the caveat that prompt caching and
extended thinking need their native API.

**Self-hosted models** need a runner that can reach them. Use a self-hosted
runner and point `base-url` at your server. Most local servers ignore the key,
but the input is required, so pass any placeholder.

**Your ChatGPT (Codex) subscription — planned.** A design to pay for reviews
with a ChatGPT Pro/Plus subscription (`model: codex`) instead of a metered key,
via the same OAuth device flow the Codex CLI uses, is written up in
[docs/codex-chatgpt-auth.md](docs/codex-chatgpt-auth.md). It is **not built
yet** — the doc exists so the flow and its constraints (the ChatGPT endpoint is
the Responses API, not `chat/completions`; a GitHub Action cannot store its own
secret on the default token) can be reviewed first.

---

## Recipes

**Give it your conventions.** It already reads `AGENTS.md` and friends; this is
for guidance that does not belong in the repository.

```yaml
with:
  instructions: |
    This is a Rails monolith. Flag anything that queries inside a loop.
    All money is in integer pence — flag float arithmetic on money.
```

**Block the merge on serious findings.**

```yaml
with:
  depth: thorough
  fail-on: high
```

**Keep it cheap on a big repository.**

```yaml
with:
  depth: quick
  max-files: 20
  min-severity: medium
```

**Use the results in a later step.**

```yaml
- uses: dymoo/commitreview@v1
  id: review
  with: { api-key: ${{ secrets.LLM_API_KEY }}, model: moonshotai/kimi-k3 }
- run: jq '.findings[] | .severity' "${{ steps.review.outputs.findings-json }}"
```

More complete workflows are in [`examples/workflows`](examples/workflows).

---

## How it works

**Context assembly.** GitHub's diff gives three lines of context around each
hunk, which is rarely enough to judge whether something is a bug. commitreview
widens every hunk with real source from the head commit and renders each line
with its old and new line numbers in explicit columns. Widened lines are marked
`~` and the model is told they are not commentable. Files are packed into
requests up to a token budget; oversized files split at hunk boundaries.

**Anchoring.** GitHub rejects an entire review with a 422 if any comment names a
line that is not part of the diff — the most common failure in tools like this.
Every model claim is validated against the exact set of `(line, side)` pairs
parsed from the diff. A near miss snaps to the closest changed line within three
lines of the same hunk and is labelled as such. Anything unanchorable is demoted
into the summary rather than dropped, and a snapped anchor never gets a
committable suggestion, since it would replace the wrong line. If a batched
review is still rejected, comments are retried individually so one bad anchor
cannot lose the rest.

**Refutation.** A reviewer's failure mode is not missing bugs, it is inventing
them. Each finding goes to independent skeptics holding a kill mandate — they
are asked to destroy the claim, not to rate it, and to default to "not real"
when unsure. They are denied the finder's severity and confidence, because those
anchor, and across multiple votes each is given a deliberately different slice of
context so they fail independently rather than agreeing on the same paragraph.

**Prompting.** The review prompt states the criteria a finding must _pass_
rather than a list of things not to report, because models systematically
underweight negation and a "do not report style issues" line is the weakest
sentence in a prompt.

**The discussion so far** — the pull request description, commit subjects, review
comments and inline threads — goes to the model, so it does not re-raise a point
the thread settled three days ago.

**Idempotency.** Every comment carries a fingerprint of the path, the finding,
and the _text_ of the line it points at — not the line number. A rebase or an
edit above the finding does not make it look new, so re-running on a new push
adds only what is genuinely new. The summary is one comment updated in place.

---

## Security

**Your key never leaves your runner.** There is no hosted service. The action
talks to GitHub and to the endpoint you configure, and nothing else.

**No code from the pull request is executed.** The repository is read, never
run. This is why `pull_request_target` is safe with commitreview — but only as
long as your workflow does not also check out the head ref. Do not add
`actions/checkout` of the head ref to a `pull_request_target` workflow.

**The agent is read-only by construction.** Four tools that read; no shell, no
network, no writes, and a turn cap. Paths excluded by `ignore` are invisible to
it, and it cannot escape the extracted repository root.

**Comment triggers are gated by author association.** By default only owners,
members and collaborators can spend your key, and `pr-number` cannot be used to
step around that gate.

**The automatic trigger is not gated, by design.** On a public repository,
`pull_request_target` means anyone who opens a pull request causes a review, and
that spends your key. Gate the job if that is not what you want:

```yaml
jobs:
  review:
    if: contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.pull_request.author_association)
```

**Prompt injection.** Diffs, discussion and file contents are untrusted input
and are labelled as such to the model, which is told to treat them as data and
to report injection attempts as a high-severity finding. No instruction is a
guarantee — treat findings as advice, not as a gate you never look at.

Full threat model in [SECURITY.md](SECURITY.md).

---

## Cost

`standard` on a typical 300-line pull request is a handful of requests. `depth:
thorough` multiplies that by the number of passes and verifiers, and an agentic
investigation adds a turn per lookup. It is your key, so the dial is yours.

Reviews trigger on `synchronize`, so a branch pushed ten times is reviewed ten
times. The `concurrency` block in the quick start cancels superseded runs. To
review only on demand, drop the `pull_request_target` trigger and use mentions.

---

## Development

```bash
npm install
npm test          # node:test, no network
npm run check-all # format, lint, typecheck, tests
```

`src/` is plain ESM with JSDoc types. With no build step there is no compiler to
lean on, so the checks are assembled explicitly: Prettier for formatting, ESLint
for correctness and JSDoc validity, and `tsc --checkJs` reading those JSDoc
annotations as real types. No runtime dependencies — `action.yml` runs
`src/index.js` directly.

| File              | Responsibility                                        |
| ----------------- | ----------------------------------------------------- |
| `src/index.js`    | Orchestration and mode dispatch                       |
| `src/config.js`   | Inputs, depth presets, lenses, event resolution       |
| `src/github.js`   | REST client                                           |
| `src/repo.js`     | Repository access at the head commit                  |
| `src/diff.js`     | Diff parsing and comment anchoring                    |
| `src/context.js`  | File selection, context widening, chunking            |
| `src/codebase.js` | Symbol extraction, repository scan, project rules     |
| `src/agent.js`    | Read-only tools and the bounded investigation loop    |
| `src/chat.js`     | Conversational replies                                |
| `src/llm.js`      | OpenAI-compatible client, defensive JSON              |
| `src/review.js`   | Prompts, find pass, refute pass                       |
| `src/post.js`     | Fingerprinting, dedupe, comment and summary rendering |

Conventions, invariants and the rules this repository enforces on itself are in
[AGENTS.md](AGENTS.md) — which commitreview reads when reviewing its own pull
requests, so it is worth keeping honest.

Issues and pull requests welcome. If you are changing anchoring, chunking or
JSON extraction, add a case to the tests — those three are where this class of
tool breaks.

## Credits

The restraint half of the taste pass condenses the
[ponytail rules by Dietrich Gebert](https://github.com/dietrichgebert/ponytail).

The adversarial structure — kill mandates, context asymmetry between verifiers,
and cross-model critics — follows the refute-or-promote literature on
high-precision LLM defect discovery.

## License

MIT
