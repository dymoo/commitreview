/**
 * OpenAI-compatible chat client.
 *
 * "OpenAI-compatible" is a spectrum: OpenRouter, Ollama, vLLM, Together, Groq
 * and friends all serve /chat/completions but disagree about response_format,
 * temperature and max_tokens. So the client probes: on a 400 naming a parameter
 * it can live without, it drops or renames that parameter and retries, then
 * remembers for the rest of the run. Structured output is never assumed — the
 * JSON comes out of the text and is parsed defensively.
 */
import * as core from './core.js';

export class LLM {
  constructor(config) {
    this.config = config;
    // Identifies this client in findings and in the summary footer.
    this.label = config.label || config.model;
    this.quirks = {
      jsonMode: config.jsonMode !== 'off',
      jsonModeForced: config.jsonMode === 'on',
      temperature: true,
      maxTokensKey: 'max_tokens',
      tools: true,
    };
    this.usage = { prompt: 0, completion: 0, requests: 0 };
    // Bumped whenever quirks change, so a request built against older quirks
    // knows to retry rather than adapt a second time for the same reason.
    this.quirksVersion = 0;
  }

  buildBody(messages, { tools = null, jsonMode = undefined } = {}) {
    /** @type {Record<string, unknown>} */
    const body = { model: this.config.model, messages };
    if (this.quirks.temperature) body.temperature = this.config.temperature;
    if (this.quirks.maxTokensKey) body[this.quirks.maxTokensKey] = this.config.maxOutputTokens;
    // response_format and tools do not mix on several gateways; tools win.
    const wantJson = jsonMode === undefined ? this.quirks.jsonMode : jsonMode && this.quirks.jsonMode;
    if (wantJson && !tools) body.response_format = { type: 'json_object' };
    if (tools && this.quirks.tools) {
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
   * tool_calls. Adapts and retries around parameters the endpoint rejects.
   * @returns {Promise<{message: any, finishReason: string}>}
   */
  async send(messages, options = {}) {
    const url = `${this.config.baseUrl}/chat/completions`;
    let attempt = 0;
    let networkRetries = 0;

    for (;;) {
      const builtAt = this.quirksVersion;
      const body = this.buildBody(messages, options);
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.config.apiKey}`,
            'content-type': 'application/json',
            'user-agent': 'commitreview',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        });
      } catch (err) {
        if (networkRetries++ >= 3) throw new Error(`Model request failed: ${err.message}`, { cause: err });
        await core.sleep(backoff(networkRetries));
        continue;
      }

      if (res.ok) {
        const data = /** @type {any} */ (await res.json());
        this.usage.requests++;
        this.usage.prompt += data?.usage?.prompt_tokens || 0;
        this.usage.completion += data?.usage?.completion_tokens || 0;
        const choice = data?.choices?.[0] || {};
        const message = choice.message || {};
        if (!message.content && !message.reasoning_content && !message.tool_calls?.length) {
          core.warning('Model returned an empty message.');
        }
        return { message, finishReason: choice.finish_reason || '' };
      }

      const text = await res.text().catch(() => '');

      if (res.status === 429 || res.status >= 500) {
        if (networkRetries++ >= 3) throw new Error(`Model request failed: ${res.status} ${truncate(text)}`);
        const after = Number(res.headers.get('retry-after'));
        await core.sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : backoff(networkRetries));
        continue;
      }

      if ((res.status === 400 || res.status === 422 || res.status === 404) && attempt++ < 4) {
        // Another in-flight request may already have adapted for this same
        // rejection. If so, simply retry with the new quirks rather than
        // adapting again and stripping an unrelated parameter.
        if (this.quirksVersion !== builtAt) continue;
        if (this.adapt(text)) continue;
      }

      if (res.status === 401 || res.status === 403) {
        throw new Error(`Model request rejected (${res.status}). Check api-key and base-url. ${truncate(text, 200)}`);
      }
      throw new Error(`Model request failed: ${res.status} ${truncate(text)}`);
    }
  }

  /** Drop or rename whatever the endpoint just complained about. @returns {boolean} changed */
  adapt(errorText) {
    const changed = this.#adapt(errorText || '');
    if (changed) this.quirksVersion++;
    return changed;
  }

  #adapt(t) {
    if (this.quirks.tools && /\btools?\b|tool_choice|function[_ ]call|function calling/i.test(t)) {
      core.warning('Endpoint rejected tool calling — the reviewer will fall back to deterministic retrieval.');
      this.quirks.tools = false;
      return true;
    }
    if (this.quirks.jsonMode && !this.quirks.jsonModeForced && /response_format|json_object|json_schema/i.test(t)) {
      core.warning('Endpoint rejected response_format — falling back to prompt-only JSON.');
      this.quirks.jsonMode = false;
      return true;
    }
    if (this.quirks.maxTokensKey === 'max_tokens' && /max_completion_tokens|max_tokens/i.test(t)) {
      core.warning('Endpoint rejected max_tokens — retrying with max_completion_tokens.');
      this.quirks.maxTokensKey = 'max_completion_tokens';
      return true;
    }
    if (this.quirks.maxTokensKey === 'max_completion_tokens' && /max_completion_tokens/i.test(t)) {
      this.quirks.maxTokensKey = null;
      return true;
    }
    if (this.quirks.temperature && /temperature/i.test(t)) {
      core.warning('Endpoint rejected temperature — retrying without it.');
      this.quirks.temperature = false;
      return true;
    }
    // Some gateways reject json mode without naming it. Try once without.
    if (this.quirks.jsonMode && !this.quirks.jsonModeForced) {
      this.quirks.jsonMode = false;
      return true;
    }
    return false;
  }

  /**
   * Ask for JSON and get an object back, or null.
   * One repair round-trip when the first response will not parse.
   */
  async json(messages, { label = 'response' } = {}) {
    const raw = await this.complete(messages);
    const parsed = extractJson(raw);
    if (parsed !== null) return parsed;

    core.warning(`Could not parse JSON from the model's ${label}; asking it to repair.`);
    const repaired = await this.complete([
      ...messages,
      { role: 'assistant', content: truncate(raw, 4000) },
      {
        role: 'user',
        content:
          'That was not valid JSON. Reply with the JSON object only — no prose, no markdown fences, no commentary.',
      },
    ]);
    const second = extractJson(repaired);
    if (second === null) core.warning(`Model ${label} still unparseable; treating as empty.`);
    return second;
  }
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
  const candidates = [cleaned];

  // A response cut off by a token limit is checked before complete regions:
  // the truncated outer object holds every finding, while the only complete
  // region inside it is the first finding on its own.
  for (const candidate of candidates) {
    const repaired = repairTruncated(candidate);
    if (repaired !== undefined) return repaired;
  }

  let best;
  let bestLength = 0;
  for (const candidate of candidates) {
    for (const region of balancedRegions(candidate)) {
      if (region.source.length > bestLength) {
        best = region.value;
        bestLength = region.source.length;
      }
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

function backoff(attempt) {
  return Math.min(30000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
}

function truncate(s, n = 400) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
