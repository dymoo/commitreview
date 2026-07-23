import test from 'node:test';
import assert from 'node:assert/strict';
import { FINDINGS, VERDICT, SYNTHESIS } from '../src/schema.js';
import { SEVERITIES, VERDICT_REAL, VERDICT_NOT_REAL } from '../src/config.js';
import { systemPrompt, REFUTE_SYSTEM, TASTE_REFUTE_SYSTEM } from '../src/prompts.js';

const CONFIG = { maxFindings: 20, instructions: '' };

test('the finding schema draws its severity words from the shared source', () => {
  assert.deepEqual(FINDINGS.properties.findings.items.properties.severity.enum, SEVERITIES);
});

test('the verdict schema uses the shared verdict tokens', () => {
  assert.deepEqual(VERDICT.properties.verdict.enum, [VERDICT_REAL, VERDICT_NOT_REAL]);
});

// A JSON Schema and a prose description of the same shape are two encodings of
// one contract; if they drift, a schema-ignoring endpoint emits fields the
// pipeline does not read. These guard the drift the seed example was about.
test('the review prompt names every field the finding schema requires', () => {
  const prompt = systemPrompt(CONFIG);
  for (const key of FINDINGS.properties.findings.items.required) {
    assert.ok(prompt.includes(`"${key}"`), `the prompt shape is missing "${key}"`);
  }
});

test('the refutation prompts ask for exactly the verdict tokens the parser accepts', () => {
  for (const prompt of [REFUTE_SYSTEM, TASTE_REFUTE_SYSTEM]) {
    assert.ok(prompt.includes(`"${VERDICT_REAL}"`), 'prompt must request the real token');
    assert.ok(prompt.includes(`"${VERDICT_NOT_REAL}"`), 'prompt must request the not-real token');
  }
});

// OpenAI strict mode requires every property to appear in `required` and objects
// to forbid extra properties. A field added to `properties` but forgotten in
// `required` is rejected at request time by strict endpoints.
test('every object in every schema is strict-mode legal', () => {
  const check = (node, path) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false, `${path} must forbid extra properties`);
      const props = Object.keys(node.properties || {});
      assert.deepEqual([...(node.required || [])].sort(), props.sort(), `${path}: every property must be required`);
    }
    for (const [key, value] of Object.entries(node.properties || {})) check(value, `${path}.${key}`);
    if (node.items) check(node.items, `${path}[]`);
  };
  for (const [name, schema] of Object.entries({ FINDINGS, VERDICT, SYNTHESIS })) check(schema, name);
});
