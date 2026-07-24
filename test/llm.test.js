import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, LLM } from '../src/llm.js';

const base = {
  model: 'test-model',
  baseUrl: 'https://example.invalid/v1',
  apiKey: 'k',
  temperature: 0.1,
  maxOutputTokens: 100,
  requestTimeoutMs: 1000,
};

test('parses plain JSON', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('[1,2]'), [1, 2]);
});

test('parses JSON out of a fenced block', () => {
  assert.deepEqual(extractJson('Sure:\n```json\n{"findings":[]}\n```\nHope that helps.'), { findings: [] });
  assert.deepEqual(extractJson('```\n{"a":2}\n```'), { a: 2 });
});

test('parses JSON surrounded by prose', () => {
  assert.deepEqual(extractJson('Here is the result: {"a":1} — let me know.'), { a: 1 });
});

test('ignores reasoning-model think blocks', () => {
  assert.deepEqual(extractJson('<think>hmm {"trap": true} maybe</think>\n{"a":3}'), { a: 3 });
});

test('a fence ending inside a JSON string does not truncate the answer', () => {
  // The fence regex is lazy, so a ``` inside a finding body ends the capture
  // early. Recovering from that capture would produce a plausible, wrong object.
  const reply = '```json\n{"summary":"ok","findings":[{"title":"A","body":"use ```js x ```"},{"title":"B"}]}\n```';
  const parsed = extractJson(reply);
  assert.equal(parsed.findings.length, 2, 'the second finding must not be silently dropped');
  assert.equal(parsed.findings[0].body, 'use ```js x ```');
});

test('a bracket in the preamble is not mistaken for the answer', () => {
  // Anchoring on the first bracket returned `{}` or `[0]` as the whole review.
  assert.deepEqual(extractJson('The empty object {} case is odd. Review:\n{"findings":[{"title":"real"}]}'), {
    findings: [{ title: 'real' }],
  });
  assert.deepEqual(extractJson('See config[0] handling.\n{"findings":[{"title":"real"}]}'), {
    findings: [{ title: 'real' }],
  });
});

test('a truncated answer is recovered even behind a decoy bracket', () => {
  const parsed = extractJson('The {} case.\n{"findings":[{"title":"leak"},{"title":"race"');
  assert.equal(parsed.findings.length, 2);
  assert.equal(parsed.findings[1].title, 'race');
});

test('recovers output truncated by a token limit', () => {
  const truncated = '{"findings":[{"title":"leak","severity":"high"},{"title":"race"';
  const parsed = extractJson(truncated);
  assert.equal(parsed.findings.length, 2);
  assert.equal(parsed.findings[0].title, 'leak');
});

test('tolerates trailing commas', () => {
  assert.deepEqual(extractJson('{"a":[1,2,],}'), { a: [1, 2] });
});

test('returns null when there is no JSON at all', () => {
  assert.equal(extractJson('I could not review this.'), null);
  assert.equal(extractJson(''), null);
});

test('request body carries the tunables the endpoint is expected to support', () => {
  const llm = new LLM(base);
  const body = llm.buildBody([{ role: 'user', content: 'hi' }]);
  assert.equal(body.model, 'test-model');
  assert.equal(body.temperature, 0.1);
  assert.equal(body.max_tokens, 100);
  assert.deepEqual(body.response_format, { type: 'json_object' });
});

test('sends a json schema as response_format when a schema is passed', () => {
  const llm = new LLM(base);
  const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
  const body = llm.buildBody([], { schema, schemaName: 'thing' });
  assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'thing', strict: true, schema } });
});

test('a call without a schema still uses plain json_object mode', () => {
  const llm = new LLM(base);
  assert.deepEqual(llm.buildBody([]).response_format, { type: 'json_object' });
});

test('json_schema degrades to plain json_object before prompt-only', () => {
  const llm = new LLM(base);
  const schema = { type: 'object', properties: {}, required: [] };
  assert.equal(llm.adapt('This model does not support json_schema response_format'), true);
  // Still asks for JSON, just not the schema-constrained kind.
  assert.deepEqual(llm.buildBody([], { schema }).response_format, { type: 'json_object' });
  // A subsequent json_object rejection is what finally drops to prompt-only.
  assert.equal(llm.adapt('Unsupported parameter: response_format'), true);
  assert.equal(llm.buildBody([], { schema }).response_format, undefined);
});

test('drops response_format when the endpoint rejects it', () => {
  const llm = new LLM(base);
  assert.equal(llm.adapt('Unsupported parameter: response_format'), true);
  assert.equal(llm.buildBody([]).response_format, undefined);
});

test('an endpoint that rejects tool calling is a hard error, not a degrade', async () => {
  const llm = new LLM(base);
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'this model does not support tools' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  try {
    await assert.rejects(
      () =>
        llm.send([{ role: 'user', content: 'hi' }], {
          tools: [{ type: 'function', function: { name: 'x', parameters: { type: 'object', properties: {} } } }],
        }),
      (/** @type {any} */ err) => err.toolsUnsupported === true && /tool calling/i.test(err.message),
    );
  } finally {
    // Single-threaded test: the save/restore is not a real race.
    // eslint-disable-next-line require-atomic-updates
    globalThis.fetch = original;
  }
});

test('renames max_tokens when the endpoint demands max_completion_tokens', () => {
  const llm = new LLM(base);
  llm.quirks.jsonMode = false;
  assert.equal(llm.adapt("Use 'max_completion_tokens' instead of 'max_tokens'"), true);
  assert.equal(llm.buildBody([]).max_completion_tokens, 100);
  assert.equal(llm.buildBody([]).max_tokens, undefined);
});

test('drops temperature when the model only supports the default', () => {
  const llm = new LLM(base);
  llm.quirks.jsonMode = false;
  assert.equal(llm.adapt("'temperature' does not support 0.1 with this model"), true);
  assert.equal(llm.buildBody([]).temperature, undefined);
});

test('a concurrent adaptation is retried rather than adapted twice', () => {
  // Several requests are in flight on one client. If two hit the same
  // rejection, the second must not strip an unrelated parameter as collateral.
  const llm = new LLM(base);
  const before = llm.quirksVersion;
  llm.adapt('Unsupported parameter: response_format');
  assert.notEqual(llm.quirksVersion, before, 'a real adaptation bumps the version');
  assert.equal(llm.quirks.jsonMode, false);
  assert.equal(llm.quirks.temperature, true, 'an unrelated quirk is untouched');
});

test('adaptation eventually gives up instead of looping', () => {
  const llm = new LLM(base);
  llm.quirks.jsonMode = false;
  llm.quirks.temperature = false;
  llm.quirks.maxTokensKey = null;
  assert.equal(llm.adapt('some unrelated failure'), false);
});
