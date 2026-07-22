/**
 * The finding: what a review pass produces, and everything that happens to one
 * before it becomes a comment.
 *
 * This lives apart from both the prompts that create findings and the rendering
 * that posts them, because both sides need it and neither should own it.
 */
import { createHash } from 'node:crypto';
import { SEVERITIES, severityRank } from './config.js';

export function normalizeFinding(raw, allowedPaths) {
  if (!raw || typeof raw !== 'object') return null;

  const title = str(raw.title) || str(raw.message) || str(raw.body).split('\n')[0];
  const body = str(raw.body) || str(raw.description) || title;
  if (!title) return null;

  let path = str(raw.path) || str(raw.file);
  if (path && !allowedPaths.includes(path)) {
    // Models sometimes echo a basename or add a leading ./ — recover that,
    // but never invent a path that is not in this chunk.
    const cleaned = path.replace(/^\.\//, '');
    const match =
      allowedPaths.find((p) => p === cleaned) ||
      allowedPaths.find((p) => p.endsWith(`/${cleaned}`)) ||
      allowedPaths.find((p) => p.split('/').pop() === cleaned.split('/').pop());
    path = match || '';
  }
  if (!path) return null;

  const severity = SEVERITIES.includes(str(raw.severity).toLowerCase()) ? str(raw.severity).toLowerCase() : 'medium';
  const line = Number.parseInt(raw.line ?? raw.end_line ?? raw.lineNumber, 10);
  const startLine = Number.parseInt(raw.start_line ?? raw.startLine, 10);
  const confidence = Number(raw.confidence);

  return {
    path,
    line: Number.isInteger(line) ? line : null,
    start_line: Number.isInteger(startLine) ? startLine : null,
    side: str(raw.side).toUpperCase() === 'LEFT' ? 'LEFT' : 'RIGHT',
    severity,
    category: str(raw.category).slice(0, 40) || 'correctness',
    title: title.slice(0, 200),
    body: body.slice(0, 4000),
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.6,
    suggestion: str(raw.suggestion) || null,
  };
}

/**
 * Collapse the same defect reported by two chunks, two lenses, or two panel
 * members. Agreement is signal, not noise: when two models independently land
 * on the same finding, that is recorded in foundBy rather than thrown away.
 */
export function mergeFindings(findings) {
  /** @type {Map<string, any>} */
  const byKey = new Map();
  for (const f of findings) {
    const key = `${f.path}|${f.line}|${normalizeTitle(f.title)}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...f, foundBy: [...(f.foundBy || [])] });
      continue;
    }
    for (const who of f.foundBy || []) if (!existing.foundBy.includes(who)) existing.foundBy.push(who);
    existing.confidence = Math.max(existing.confidence, f.confidence);
    if (severityRank(f.severity) < severityRank(existing.severity)) existing.severity = f.severity;
    if (f.suggestion && !existing.suggestion) existing.suggestion = f.suggestion;
  }
  return [...byKey.values()];
}

export const normalizeTitle = (t) =>
  String(t)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Identify a finding by what it points at, not by where it points.
 *
 * Hashing the *text* of the anchored line rather than its number is what makes
 * a re-run idempotent: a rebase, or an edit above the finding, moves the line
 * number but not the code, so the finding is recognised as already reported.
 */
export function fingerprint(finding, codeLine) {
  const title = normalizeTitle(finding.title);
  const code = String(codeLine || finding.line || '')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(`${finding.path}|${title}|${code}`).digest('hex').slice(0, 12);
}

const FP_MARKER = /<!--\s*commitreview:fp=([0-9a-f]{12})\s*-->/g;

/** Recover the fingerprints of everything already said on this pull request. */
export function collectFingerprints(bodies) {
  const seen = new Set();
  for (const body of bodies) {
    for (const m of String(body || '').matchAll(FP_MARKER)) seen.add(m[1]);
  }
  return seen;
}

const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
