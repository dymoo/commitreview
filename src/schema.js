/**
 * Authoritative machine-readable contracts for model replies. Optional values
 * are nullable because strict Structured Outputs requires every property to
 * appear in `required`.
 */
import { SEVERITIES, VERDICT_REAL, VERDICT_NOT_REAL } from './config.js';

const FINDING = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', description: 'exact path from a FILE header' },
    line: { type: 'integer', description: 'line number to anchor on' },
    side: { type: 'string', enum: ['LEFT', 'RIGHT'] },
    start_line: { type: ['integer', 'null'], description: 'first line when the finding spans a range' },
    severity: { type: 'string', enum: SEVERITIES },
    category: { type: 'string' },
    title: { type: 'string', description: 'one line, under 90 characters' },
    body: { type: 'string', description: 'specific evidence, trigger and consequence' },
  },
  required: ['path', 'line', 'side', 'start_line', 'severity', 'category', 'title', 'body'],
};

export const FINDINGS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    findings: { type: 'array', items: FINDING },
  },
  required: ['summary', 'findings'],
};

export const VERDICT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: [VERDICT_REAL, VERDICT_NOT_REAL] },
    reason: { type: 'string' },
    severity: { type: ['string', 'null'], enum: [...SEVERITIES, null] },
  },
  required: ['verdict', 'reason', 'severity'],
};
