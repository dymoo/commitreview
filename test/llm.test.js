import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, LLM } from '../src/llm.js';

const base = {
  model: 'test-model',
  baseUrl: 'https://example.invalid/v1',
  apiKey: 'k',
  temperature: 0.1,
  maxOutputTokens: 100,
  jsonMode: 'auto',
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

test('drops response_format when the endpoint rejects it', () => {
  const llm = new LLM(base);
  assert.equal(llm.adapt('Unsupported parameter: response_format'), true);
  assert.equal(llm.buildBody([]).response_format, undefined);
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

test('json-mode on is never dropped behind the user’s back', () => {
  const llm = new LLM({ ...base, jsonMode: 'on' });
  llm.adapt('Unsupported parameter: response_format');
  assert.deepEqual(llm.buildBody([]).response_format, { type: 'json_object' });
});

test('json-mode off never sends response_format', () => {
  const llm = new LLM({ ...base, jsonMode: 'off' });
  assert.equal(llm.buildBody([]).response_format, undefined);
});

test('adaptation eventually gives up instead of looping', () => {
  const llm = new LLM({ ...base, jsonMode: 'off' });
  llm.quirks.temperature = false;
  llm.quirks.maxTokensKey = null;
  assert.equal(llm.adapt('some unrelated failure'), false);
});
