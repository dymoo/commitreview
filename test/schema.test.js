import test from 'node:test';
import assert from 'node:assert/strict';
import { FINDINGS, VERDICT } from '../src/schema.js';
import { SEVERITIES, VERDICT_REAL, VERDICT_NOT_REAL } from '../src/config.js';
import { systemPrompt, REFUTE_SYSTEM } from '../src/prompts.js';

const CONFIG = { maxFindings: 20, instructions: '' };

test('schemas draw enum tokens from their shared source', () => {
  assert.deepEqual(FINDINGS.properties.findings.items.properties.severity.enum, SEVERITIES);
  assert.deepEqual(VERDICT.properties.verdict.enum, [VERDICT_REAL, VERDICT_NOT_REAL]);
});

test('the fallback prompt names every required finding field', () => {
  const prompt = systemPrompt(CONFIG);
  for (const key of FINDINGS.properties.findings.items.required) {
    assert.ok(prompt.includes(`"${key}"`), `the prompt shape is missing "${key}"`);
  }
});

test('the verifier prompt requests exactly the parser verdict tokens', () => {
  assert.ok(REFUTE_SYSTEM.includes(`"${VERDICT_REAL}"`));
  assert.ok(REFUTE_SYSTEM.includes(`"${VERDICT_NOT_REAL}"`));
});

test('every schema object is legal for strict Structured Outputs', () => {
  const check = (node, path) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false, `${path} must forbid extra properties`);
      const properties = Object.keys(node.properties || {});
      assert.deepEqual([...(node.required || [])].sort(), properties.sort(), `${path} must require every property`);
    }
    for (const [key, value] of Object.entries(node.properties || {})) check(value, `${path}.${key}`);
    if (node.items) check(node.items, `${path}[]`);
  };
  for (const [name, schema] of Object.entries({ FINDINGS, VERDICT })) check(schema, name);
});
