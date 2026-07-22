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
    this.quirks = {
      jsonMode: config.jsonMode !== 'off',
      jsonModeForced: config.jsonMode === 'on',
      temperature: true,
      maxTokensKey: 'max_tokens',
      tools: true,
    };
    this.usage = { prompt: 0, completion: 0, requests: 0 };
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
        if (networkRetries++ >= 3) throw new Error(`Model request failed: ${err.message}`);
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

      if ((res.status === 400 || res.status === 422 || res.status === 404) && attempt++ < 4 && this.adapt(text)) {
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        throw new Error(`Model request rejected (${res.status}). Check api-key and base-url. ${truncate(text, 200)}`);
      }
      throw new Error(`Model request failed: ${res.status} ${truncate(text)}`);
    }
  }

  /** Drop or rename whatever the endpoint just complained about. @returns {boolean} changed */
  adapt(errorText) {
    const t = errorText || '';
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

/** Pull a JSON value out of arbitrary model text. Returns null when there is none. */
export function extractJson(text) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?thinking>/gi, '')
    .replace(/^﻿/, '');

  const candidates = [];
  const fence = /```(?:json5?|jsonc)?\s*\n?([\s\S]*?)```/i.exec(cleaned);
  if (fence) candidates.push(fence[1]);
  candidates.push(cleaned);

  for (const candidate of candidates) {
    const direct = tryParse(candidate.trim());
    if (direct !== undefined) return direct;
    const scanned = scanBalanced(candidate);
    if (scanned !== undefined) return scanned;
  }
  return null;
}

function tryParse(s) {
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    /* fall through */
  }
  try {
    return JSON.parse(stripTrailingCommas(s));
  } catch {
    return undefined;
  }
}

const stripTrailingCommas = (s) => s.replace(/,(\s*[}\]])/g, '$1');

/**
 * Walk from the first bracket tracking string state, and parse the balanced
 * region. If the text was cut off mid-object (a hit max_tokens), close the open
 * brackets and try again — that usually recovers every complete finding.
 */
function scanBalanced(text) {
  const start = firstBracket(text);
  if (start === -1) return undefined;

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
        const parsed = tryParse(text.slice(start, i + 1));
        if (parsed !== undefined) return parsed;
      }
    }
  }

  if (stack.length) {
    let tail = text.slice(start);
    if (inString) tail += '"';
    tail = tail.replace(/,\s*$/, '');
    while (stack.length) tail += stack.pop();
    const repaired = tryParse(tail);
    if (repaired !== undefined) return repaired;
  }
  return undefined;
}

function firstBracket(text) {
  const a = text.indexOf('{');
  const b = text.indexOf('[');
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function backoff(attempt) {
  return Math.min(30000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
}

function truncate(s, n = 400) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
