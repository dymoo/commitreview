/**
 * OpenAI-compatible chat client.
 *
 * "OpenAI-compatible" is a spectrum: OpenRouter, Ollama, vLLM, Together, Groq
 * and friends all serve /chat/completions but disagree about response_format.
 * The client probes the structured-output parameters it can live without,
 * drops a rejected one and remembers for the rest of the run. An explicitly
 * configured reasoning effort is part of the caller's contract, so it remains
 * fixed and a parameter rejection fails the request. Completion length is
 * deliberately left to the provider and model.
 *
 * Structured output is used when offered but never assumed. A call that passes a
 * `schema` asks for it three ways, strongest first: `json_schema` (the model is
 * constrained to the schema — OpenAI Structured Outputs), then plain
 * `json_object` mode, then prompt-only. Each rung is a probe: on rejection the
 * client drops to the next and retries. Whichever rung it lands on, the JSON is
 * still pulled out of the text and parsed defensively, so nothing depends on the
 * endpoint honouring the schema.
 */
import * as core from './core.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_REFERER = 'https://github.com/dymoo/shipyard';
const OPENROUTER_TITLE = 'Shipyard';
const OPENROUTER_PROVIDER_POLICY = Object.freeze({
  data_collection: 'deny',
  zdr: true,
  require_parameters: true,
});

export class LLM {
  constructor(config, runtime = {}) {
    this.config = config;
    this.runtime = {
      fetch: runtime.fetch ?? ((input, init) => globalThis.fetch(input, init)),
      now: runtime.now ?? (() => Date.now()),
      sleep: runtime.sleep ?? core.sleep,
      timeoutSignal: runtime.timeoutSignal ?? ((ms) => AbortSignal.timeout(ms)),
      env: runtime.env ?? process.env,
    };
    // Identifies this client in findings and in the summary footer.
    this.label = config.label || config.model;
    this.quirks = {
      jsonMode: true,
      // The strongest JSON rung. Dropped to plain json_object on rejection; only
      // ever attempted when a call actually passes a schema.
      jsonSchema: true,
    };
    this.usage = { prompt: 0, completion: 0, cached: 0, cacheWrite: 0, requests: 0 };
    // Bumped whenever quirks change, so a request built against older quirks
    // knows to retry rather than adapt a second time for the same reason.
    this.quirksVersion = 0;
  }

  buildBody(messages, { tools = null, jsonMode = undefined, schema = null, schemaName = 'response' } = {}) {
    /** @type {Record<string, unknown>} */
    const body = { model: this.config.model, messages };
    if (this.config.baseUrl === OPENROUTER_BASE_URL) {
      body.provider = OPENROUTER_PROVIDER_POLICY;
      const sessionId = openRouterSessionId(this.runtime.env);
      if (sessionId) body.session_id = sessionId;
    }
    if (this.config.reasoningEffort) body.reasoning_effort = this.config.reasoningEffort;
    // response_format and tools do not mix on several gateways; tools win.
    const wantJson = jsonMode === undefined ? this.quirks.jsonMode : jsonMode && this.quirks.jsonMode;
    if (wantJson && !tools) {
      body.response_format =
        schema && this.quirks.jsonSchema
          ? { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } }
          : { type: 'json_object' };
    }
    if (tools) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    return body;
  }

  /** @returns {Promise<string>} raw assistant text */
  async complete(messages, options = {}) {
    const { message } = await this.send(messages, options);
    const content = message.content || message.reasoning_content || '';
    return typeof content === 'string' ? content : JSON.stringify(content);
  }

  /**
   * One request, returning the whole assistant message so a tool loop can see
   * tool_calls. Adapts and retries around optional compatibility parameters the
   * endpoint rejects.
   * @returns {Promise<{message: any}>}
   */
  async send(messages, options = {}) {
    const url = `${this.config.baseUrl}/chat/completions`;
    const deadline = this.runtime.now() + this.config.requestTimeoutMs;
    let attempt = 0;
    let networkRetries = 0;

    for (;;) {
      const remainingMs = deadline - this.runtime.now();
      if (remainingMs <= 0) throw requestDeadlineError(this.config.requestTimeoutMs);
      const builtAt = this.quirksVersion;
      const body = this.buildBody(messages, options);
      let res;
      try {
        res = await this.runtime.fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.config.apiKey}`,
            'content-type': 'application/json',
            'user-agent': 'shipyard',
            ...(this.config.baseUrl === OPENROUTER_BASE_URL
              ? { 'HTTP-Referer': OPENROUTER_REFERER, 'X-OpenRouter-Title': OPENROUTER_TITLE }
              : {}),
          },
          body: JSON.stringify(body),
          signal: this.runtime.timeoutSignal(remainingMs),
        });
      } catch (err) {
        if (isRequestAbort(err) || this.runtime.now() >= deadline) {
          throw requestDeadlineError(this.config.requestTimeoutMs, err);
        }
        if (networkRetries++ >= 3) throw new Error(`Model request failed: ${errorMessage(err)}`, { cause: err });
        await this.waitForRetry(core.backoff(networkRetries), deadline, err);
        continue;
      }

      if (this.runtime.now() >= deadline) throw requestDeadlineError(this.config.requestTimeoutMs);
      if (res.ok) {
        const data = /** @type {any} */ (await res.json());
        if (this.runtime.now() >= deadline) throw requestDeadlineError(this.config.requestTimeoutMs);
        this.usage.requests++;
        this.usage.prompt += data?.usage?.prompt_tokens || 0;
        this.usage.completion += data?.usage?.completion_tokens || 0;
        this.usage.cached += data?.usage?.prompt_tokens_details?.cached_tokens || 0;
        this.usage.cacheWrite += data?.usage?.prompt_tokens_details?.cache_write_tokens || 0;
        const choice = data?.choices?.[0] || {};
        const message = choice.message || {};
        if (!message.content && !message.reasoning_content && !message.tool_calls?.length) {
          core.warning('Model returned an empty message.');
        }
        return { message };
      }

      const text = await res.text().catch(() => '');

      if (res.status === 429 || res.status >= 500) {
        if (networkRetries++ >= 3) throw new Error(`Model request failed: ${res.status} ${truncate(text)}`);
        const after = Number(res.headers.get('retry-after'));
        await this.waitForRetry(
          Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : core.backoff(networkRetries),
          deadline,
        );
        continue;
      }

      // Tool calling is required, not optional: an endpoint that rejects the
      // tools it was sent is unsupported, and degrading it to a diff-only review
      // would be a silently worse review. Fail loudly instead.
      if (body.tools && /\btools?\b|tool_choice|function[_ ]call|function calling/i.test(text)) {
        const e = /** @type {Error & {toolsUnsupported?: boolean}} */ (
          new Error(
            `This endpoint rejected tool calling, which Shipyard requires (${res.status}). ` +
              `Use a model and endpoint that support OpenAI-style function calling. ${truncate(text, 200)}`,
          )
        );
        e.toolsUnsupported = true;
        throw e;
      }

      if ((res.status === 400 || res.status === 422 || res.status === 404) && attempt++ < 4) {
        // Another in-flight request may already have adapted for this same
        // rejection. If so, simply retry with the new quirks rather than
        // adapting again and stripping an unrelated parameter.
        if (this.quirksVersion !== builtAt) continue;
        if (this.adapt(text)) continue;
      }

      // Once optional compatibility retries are exhausted, a rejected explicit-
      // effort request is fatal even if the provider omits the parameter name.
      // Otherwise the investigation loop could swallow it and publish a review
      // with its required context-gathering pass missing.
      if (this.config.reasoningEffort && (res.status === 400 || res.status === 422 || res.status === 404)) {
        const error = /** @type {Error & {explicitEffortRequestRejected?: boolean}} */ (
          new Error(
            `Endpoint rejected a request with explicitly configured reasoning_effort (${res.status}); ` +
              `Shipyard will not retry without it. ${truncate(text, 200)}`,
          )
        );
        error.explicitEffortRequestRejected = true;
        throw error;
      }

      if (res.status === 401 || res.status === 403) {
        throw new Error(`Model request rejected (${res.status}). Check api-key and base-url. ${truncate(text, 200)}`);
      }
      throw new Error(`Model request failed: ${res.status} ${truncate(text)}`);
    }
  }

  async waitForRetry(delayMs, deadline, cause) {
    const remainingMs = deadline - this.runtime.now();
    if (remainingMs <= delayMs) throw requestDeadlineError(this.config.requestTimeoutMs, cause);
    await this.runtime.sleep(delayMs);
    if (this.runtime.now() >= deadline) throw requestDeadlineError(this.config.requestTimeoutMs, cause);
  }

  /** Drop or rename an optional compatibility parameter the endpoint just complained about. @returns {boolean} changed */
  adapt(errorText) {
    const changed = this.#adapt(errorText || '');
    if (changed) this.quirksVersion++;
    return changed;
  }

  #adapt(t) {
    // Explicit effort is a caller contract, not an optional compatibility
    // parameter. Keep it in every retry and let send() report its rejection.
    if (this.config.reasoningEffort && /reasoning[-_ ]?effort/i.test(t)) return false;

    // Drop json_schema to plain json_object first — many endpoints serve one and
    // not the other. Matched on schema-specific wording so a bare
    // "response_format not supported" falls straight through to the rung below.
    if (this.quirks.jsonSchema && /json[_ ]?schema|structured output|response_format\.json_schema/i.test(t)) {
      core.warning('Endpoint rejected json_schema — falling back to plain JSON mode.');
      this.quirks.jsonSchema = false;
      return true;
    }
    if (this.quirks.jsonMode && /response_format|json_object|json_schema/i.test(t)) {
      core.warning('Endpoint rejected response_format — falling back to prompt-only JSON.');
      this.quirks.jsonMode = false;
      return true;
    }
    // Some gateways reject json mode without naming it. Try once without.
    if (this.quirks.jsonMode) {
      this.quirks.jsonMode = false;
      return true;
    }
    return false;
  }

  /**
   * Ask for JSON and get an object back, or null.
   *
   * Pass `schema` (a JSON Schema from schema.js) to have supporting endpoints
   * constrain the model to it; it degrades to plain JSON mode and then to
   * prompt-only on its own. One repair round-trip when the first response will
   * not parse either way.
   *
   * @param {Array<{role:string,content:string}>} messages
   * @param {{label?: string, schema?: object|null, schemaName?: string}} [opts]
   */
  async json(messages, { label = 'response', schema = null, schemaName = 'response' } = {}) {
    const opts = { schema, schemaName };
    const raw = await this.complete(messages, opts);
    const parsed = extractJson(raw);
    if (parsed !== null) return parsed;

    core.warning(`Could not parse JSON from the model's ${label}; asking it to repair.`);
    const repaired = await this.complete(
      [
        ...messages,
        { role: 'assistant', content: truncate(raw, 4000) },
        {
          role: 'user',
          content:
            'That was not valid JSON. Reply with the JSON object only — no prose, no markdown fences, no commentary.',
        },
      ],
      opts,
    );
    const second = extractJson(repaired);
    if (second === null) core.warning(`Model ${label} still unparseable; treating as empty.`);
    return second;
  }
}

function openRouterSessionId(env) {
  const runId = env.GITHUB_RUN_ID?.trim();
  return runId ? `shipyard-${runId}`.slice(0, 256) : '';
}

function isRequestAbort(error) {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function requestDeadlineError(timeoutMs, cause) {
  return new Error(`Model request exceeded its ${timeoutMs}ms logical deadline.`, { cause });
}

/**
 * Pull a JSON value out of arbitrary model text. Returns null when there is none.
 *
 * Two failure modes make this harder than it looks, and both produced silently
 * WRONG objects rather than no object:
 *
 *   1. A lazy fence regex ends at the first fence marker inside a JSON string,
 *      so a finding whose body quotes a code block truncated the whole
 *      response — and the bracket repair then closed it into something that
 *      parsed cleanly and was wrong.
 *   2. Anchoring on the first bracket meant a preamble like "the {} case" or
 *      "config[0]" parsed to an empty object, and that became the answer.
 *
 * So: try every candidate, collect every region that parses, and prefer the
 * largest — the real payload is never the shortest thing in the response.
 */
export function extractJson(text) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?thinking>/gi, '')
    .replace(/^\uFEFF/, '');

  // Fenced blocks first, longest last so an explicit ```json wins over a stray
  // fence, then the whole text as a fallback.
  const fences = [...cleaned.matchAll(/```(?:json5?|jsonc)?\s*\n?([\s\S]*?)```/gi)].map((m) => m[1]);

  // A candidate that parses outright is always right, so fenced blocks get
  // their chance here. They get no further: the fence regex ends at the first
  // ``` inside a JSON string, so a capture that did not parse is likely
  // truncated, and must not be handed to the recovery paths below — they would
  // happily close it into something plausible and wrong.
  for (const candidate of [...fences, cleaned]) {
    const direct = tryParse(candidate.trim());
    if (direct !== undefined) return direct;
  }

  // Recovery runs on the whole cleaned text only — never on a fenced capture,
  // which may be truncated at a ``` inside a string and would close into
  // something plausible and wrong. A response cut off by a token limit is
  // checked before complete regions: the truncated outer object holds every
  // finding, while the only complete region inside it is the first alone.
  const repaired = repairTruncated(cleaned);
  if (repaired !== undefined) return repaired;

  let best;
  let bestLength = 0;
  for (const region of balancedRegions(cleaned)) {
    if (region.source.length > bestLength) {
      best = region.value;
      bestLength = region.source.length;
    }
  }
  return best === undefined ? null : best;
}

/**
 * Every self-contained bracketed region that parses, anchoring at each bracket
 * in turn rather than only the first.
 *
 * @returns {{value: any, source: string}[]}
 */
function balancedRegions(text) {
  const out = [];
  let searchFrom = 0;
  // Bounded so a pathological response cannot make this quadratic.
  for (let attempt = 0; attempt < 40; attempt++) {
    const start = firstBracket(text, searchFrom);
    if (start === -1) break;
    searchFrom = start + 1;

    const stack = [];
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
      else if (c === '}' || c === ']') {
        stack.pop();
        if (stack.length === 0) {
          const source = text.slice(start, i + 1);
          const value = tryParse(source);
          if (value !== undefined) out.push({ value, source });
          break;
        }
      }
    }
  }
  return out;
}

/**
 * Close the brackets a truncated response left open.
 *
 * Anchors are tried in turn, because a preamble containing its own bracket pair
 * would otherwise make the repair start in the wrong place.
 */
function repairTruncated(text) {
  let searchFrom = 0;
  for (let attempt = 0; attempt < 40; attempt++) {
    const start = firstBracket(text, searchFrom);
    if (start === -1) return undefined;
    searchFrom = start + 1;
    const repaired = repairFrom(text, start);
    if (repaired !== undefined) return repaired;
  }
  return undefined;
}

function repairFrom(text, start) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') stack.pop();
  }
  // Nothing left open means this region was complete, not truncated.
  if (!stack.length) return undefined;

  let tail = text.slice(start);
  if (inString) tail += '"';
  tail = tail.replace(/,\s*$/, '');
  while (stack.length) tail += stack.pop();
  return tryParse(tail);
}

function firstBracket(text, from) {
  const a = text.indexOf('{', from);
  const b = text.indexOf('[', from);
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function tryParse(s) {
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    /* fall through to the trailing-comma repair */
  }
  try {
    return JSON.parse(stripTrailingCommas(s));
  } catch {
    return undefined;
  }
}

const stripTrailingCommas = (s) => s.replace(/,(\s*[}\]])/g, '$1');

function truncate(s, n = 400) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
