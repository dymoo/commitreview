/**
 * Finding normalisation, deduplication and stable fingerprints.
 */
import { createHash } from 'node:crypto';
import { SEVERITIES, severityRank } from './config.js';

const CATEGORIES = new Set([
  'correctness',
  'security',
  'performance',
  'concurrency',
  'error-handling',
  'api-contract',
  'maintainability',
  'convention',
]);

export function normalizeFinding(raw, allowedPaths) {
  if (!raw || typeof raw !== 'object') return null;

  const title = oneLine(raw.title) || oneLine(raw.message) || oneLine(str(raw.body).split('\n')[0]);
  const body = str(raw.body) || str(raw.description) || title;
  if (!title) return null;

  let path = str(raw.path) || str(raw.file);
  if (path && !allowedPaths.includes(path)) {
    const cleaned = path.replace(/^\.\//, '');
    const match =
      allowedPaths.find((candidate) => candidate === cleaned) ||
      uniqueMatch(allowedPaths, (candidate) => candidate.endsWith(`/${cleaned}`)) ||
      uniqueMatch(allowedPaths, (candidate) => candidate.split('/').pop() === cleaned.split('/').pop());
    path = match || '';
  }
  if (!path) return null;

  const severity = SEVERITIES.includes(str(raw.severity).toLowerCase()) ? str(raw.severity).toLowerCase() : 'medium';
  const category = str(raw.category).toLowerCase();
  const line = positiveInteger(raw.line ?? raw.end_line ?? raw.lineNumber);
  const startLine = positiveInteger(raw.start_line ?? raw.startLine);

  return {
    path,
    line,
    start_line: startLine,
    side: str(raw.side).toUpperCase() === 'LEFT' ? 'LEFT' : 'RIGHT',
    severity,
    category: CATEGORIES.has(category) ? category : 'correctness',
    title: title.slice(0, 120),
    body: body.slice(0, 4000),
  };
}

/** Collapse the same defect reported by overlapping chunks. */
export function mergeFindings(findings) {
  /** @type {Map<string, any>} */
  const byKey = new Map();
  for (const finding of findings) {
    const key = `${finding.path}|${finding.line}|${normalizeTitle(finding.title)}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...finding });
      continue;
    }
    if (severityRank(finding.severity) < severityRank(existing.severity)) {
      existing.severity = finding.severity;
    }
  }
  return [...byKey.values()];
}

export const normalizeTitle = (title) =>
  String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Hash anchored source rather than the line number so a rebase does not repeat
 * the same finding.
 */
export function fingerprint(finding, codeLine) {
  const title = normalizeTitle(finding.title);
  const code = String(codeLine || finding.line || '')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(`${finding.path}|${title}|${code}`).digest('hex').slice(0, 12);
}

const FP_MARKER = /<!--\s*commitreview:fp=([0-9a-f]{12})\s*-->/g;

export function collectFingerprints(bodies) {
  const seen = new Set();
  for (const body of bodies) {
    for (const match of String(body || '').matchAll(FP_MARKER)) seen.add(match[1]);
  }
  return seen;
}

const str = (value) => (typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim());
const oneLine = (value) => str(value).replace(/\s+/g, ' ');
const positiveInteger = (value) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
};

function uniqueMatch(values, predicate) {
  const matches = values.filter(predicate);
  return matches.length === 1 ? matches[0] : null;
}
