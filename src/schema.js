/**
 * The machine-readable shape of every structured model reply, in one place.
 *
 * These are the authoritative contract. When an endpoint supports OpenAI
 * Structured Outputs, `llm.json` sends the matching schema as
 * `response_format: { type: 'json_schema', strict: true, ... }` and the model is
 * constrained to it — far more reliable than hoping it matches a shape described
 * in prose. When an endpoint does not support it, the client falls back to plain
 * JSON mode and then to prompt-only, and `extractJson` recovers the object from
 * text; the prose shapes in prompts.js are the human-readable mirror for that
 * path. A test asserts the two never drift.
 *
 * Written in strict form: every property appears in `required`, optional fields
 * are nullable via a type union, and `additionalProperties` is false — that is
 * what OpenAI's strict mode demands, and endpoints that ignore strictness do not
 * mind the extra rigor.
 */
import { SEVERITIES, VERDICT_REAL, VERDICT_NOT_REAL } from './config.js';

const SEVERITY = SEVERITIES;

/** One reviewer finding. */
const FINDING = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', description: 'exact path from a FILE: header' },
    line: { type: 'integer', description: 'the line number to anchor on' },
    side: { type: 'string', enum: ['LEFT', 'RIGHT'] },
    start_line: { type: ['integer', 'null'], description: 'first line when the finding spans a range' },
    severity: { type: 'string', enum: SEVERITY },
    category: { type: 'string' },
    title: { type: 'string', description: 'one line, under 90 characters' },
    body: { type: 'string', description: 'the trigger, then the consequence' },
    confidence: { type: 'number', description: 'honest probability 0.0 to 1.0 that this is real' },
    suggestion: { type: ['string', 'null'], description: 'exact replacement source, or null' },
  },
  required: ['path', 'line', 'side', 'start_line', 'severity', 'category', 'title', 'body', 'confidence', 'suggestion'],
};

/** The find pass: a summary and a list of findings. */
export const FINDINGS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    findings: { type: 'array', items: FINDING },
  },
  required: ['summary', 'findings'],
};

/** A skeptic's verdict on one finding. `severity` is null unless the verdict is "real". */
export const VERDICT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: [VERDICT_REAL, VERDICT_NOT_REAL] },
    reason: { type: 'string' },
    severity: { type: ['string', 'null'], enum: [...SEVERITY, null] },
  },
  required: ['verdict', 'reason', 'severity'],
};

/** The lead model's reconciliation: which findings to keep (by index) and which to drop. */
export const SYNTHESIS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    keep: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'integer' },
          title: { type: ['string', 'null'] },
          body: { type: ['string', 'null'] },
          severity: { type: ['string', 'null'], enum: [...SEVERITY, null] },
          merged: { type: 'array', items: { type: 'integer' } },
        },
        required: ['index', 'title', 'body', 'severity', 'merged'],
      },
    },
    drop: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'integer' },
          reason: { type: 'string' },
        },
        required: ['index', 'reason'],
      },
    },
  },
  required: ['summary', 'keep', 'drop'],
};
