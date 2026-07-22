/**
 * Turning findings into pull request comments, idempotently.
 *
 * Re-running on a new push must not repeat what has already been said. Every
 * comment carries a fingerprint derived from the path, the finding title and
 * the *text* of the line it points at — not the line number — so a finding
 * survives a rebase or an unrelated edit above it without being re-posted.
 */
import { createHash } from 'node:crypto';
import * as core from './core.js';
import { severityRank } from './config.js';
import { normalizeTitle } from './review.js';

export const SUMMARY_MARKER = '<!-- commitreview:summary -->';
const FP_MARKER = /<!--\s*commitreview:fp=([0-9a-f]{12})\s*-->/g;

const SEVERITY_ICON = {
  critical: '🛑',
  high: '🔴',
  medium: '🟠',
  low: '🟡',
  nit: '⚪',
};

export function fingerprint(finding, codeLine) {
  const title = normalizeTitle(finding.title);
  const code = String(codeLine || finding.line || '')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(`${finding.path}|${title}|${code}`).digest('hex').slice(0, 12);
}

export function collectFingerprints(bodies) {
  const seen = new Set();
  for (const body of bodies) {
    for (const m of String(body || '').matchAll(FP_MARKER)) seen.add(m[1]);
  }
  return seen;
}

function fence(content) {
  const longest = (content.match(/`{3,}/g) || []).reduce((n, s) => Math.max(n, s.length), 2);
  return '`'.repeat(Math.max(3, longest + 1));
}

export function commentBody(finding, anchor, config) {
  const icon = SEVERITY_ICON[finding.severity] || '•';
  const parts = [`${icon} **${finding.severity}** · ${finding.category}`, '', `**${finding.title}**`, '', finding.body];

  // A snapped anchor points near the finding, not exactly at it — a committable
  // suggestion there would replace the wrong line.
  if (config.suggestions && finding.suggestion && anchor.side === 'RIGHT' && !anchor.snapped) {
    const f = fence(finding.suggestion);
    parts.push('', `${f}suggestion\n${finding.suggestion.replace(/\n$/, '')}\n${f}`);
  }
  if (anchor.snapped) {
    parts.push('', `<sub>Anchored to the nearest changed line; the model referenced line ${finding.line}.</sub>`);
  }
  if (finding.refutation) parts.push('', `<sub>Verifier: ${finding.refutation}</sub>`);
  parts.push('', `<sub>commitreview · confidence ${finding.confidence.toFixed(2)}</sub>`);
  parts.push(`<!-- commitreview:fp=${finding.fp} -->`);
  return parts.join('\n');
}

export function renderSummary(result, config) {
  const { pr, posted, demoted, duplicates, skipped, dropped, summaries, refuted, usage, reviewedFiles } = result;
  const all = [...posted, ...demoted];
  const out = [SUMMARY_MARKER, '', '## commitreview'];

  const blurb = summaries.filter(Boolean).join('\n\n');
  if (blurb) out.push('', blurb);

  const counts = {};
  for (const f of all) counts[f.severity] = (counts[f.severity] || 0) + 1;
  const countText =
    Object.entries(counts)
      .sort((a, b) => severityRank(a[0]) - severityRank(b[0]))
      .map(([s, n]) => `${SEVERITY_ICON[s] || '•'} ${n} ${s}`)
      .join(' · ') || 'no findings';

  out.push(
    '',
    `**${all.length} finding${all.length === 1 ? '' : 's'}** across ${reviewedFiles} file${reviewedFiles === 1 ? '' : 's'} — ${countText}`,
  );

  if (all.length) {
    out.push('', '| | Severity | Finding | Location |', '|---|---|---|---|');
    for (const f of all.sort((a, b) => severityRank(a.severity) - severityRank(b.severity))) {
      const loc = f.anchor ? `\`${f.path}:${f.anchor.line}\`` : `\`${f.path}\``;
      out.push(`| ${SEVERITY_ICON[f.severity] || '•'} | ${f.severity} | ${escapeCell(f.title)} | ${loc} |`);
    }
  } else {
    out.push('', 'No defects found in this diff.');
  }

  if (demoted.length) {
    out.push(
      '',
      '<details><summary>Findings that could not be anchored to a diff line</summary>',
      '',
      ...demoted.map(
        (f) =>
          `- **${f.severity}** \`${f.path}\`${f.line ? `:${f.line}` : ''} — ${f.title}\n  ${oneLine(f.body)}\n  <!-- commitreview:fp=${f.fp} -->`,
      ),
      '',
      '</details>',
    );
  }

  const notReviewed = [...skipped, ...dropped];
  if (notReviewed.length) {
    out.push(
      '',
      `<details><summary>Not reviewed (${notReviewed.length})</summary>`,
      '',
      ...notReviewed.map((s) => `- \`${s.path}\` — ${s.reason}`),
      '',
      '</details>',
    );
  }

  const footer = [
    `model \`${config.model}\``,
    `${usage.requests} request${usage.requests === 1 ? '' : 's'}`,
    usage.prompt || usage.completion ? `${usage.prompt + usage.completion} tokens` : null,
    refuted ? `${refuted} refuted` : null,
    duplicates ? `${duplicates} already reported` : null,
    pr?.head?.sha ? `\`${pr.head.sha.slice(0, 7)}\`` : null,
  ].filter(Boolean);
  out.push('', `<sub>${footer.join(' · ')} · <a href="https://github.com/dymoo/commitreview">commitreview</a></sub>`);

  return out.join('\n');
}

const oneLine = (s) => String(s).replace(/\s+/g, ' ').slice(0, 300);
const escapeCell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** Post inline comments as one review, falling back to individual comments on a 422. */
export async function postInline(gh, ctx, pr, comments) {
  if (!comments.length) return 0;
  try {
    await gh.createReview(ctx.owner, ctx.repo, ctx.prNumber, {
      commit_id: pr.head.sha,
      event: 'COMMENT',
      // The API requires a body for a COMMENT review; the detail is in the summary.
      body: `**commitreview** left ${comments.length} comment${comments.length === 1 ? '' : 's'}.`,
      comments,
    });
    return comments.length;
  } catch (err) {
    core.warning(`Batched review rejected (${err.message}). Retrying comments individually.`);
  }

  let posted = 0;
  for (const c of comments) {
    try {
      await gh.request('POST', `/repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.prNumber}/comments`, {
        body: { ...c, commit_id: pr.head.sha },
      });
      posted++;
    } catch (err) {
      core.warning(`Could not anchor a comment at ${c.path}:${c.line} — ${err.message}`);
    }
  }
  return posted;
}

export async function upsertSummary(gh, ctx, body, mode) {
  if (mode === 'off') return null;
  if (mode === 'sticky') {
    const existing = await gh.listIssueComments(ctx.owner, ctx.repo, ctx.prNumber);
    const mine = existing.find((c) => String(c.body || '').includes(SUMMARY_MARKER));
    if (mine) return gh.updateIssueComment(ctx.owner, ctx.repo, mine.id, body);
  }
  return gh.createIssueComment(ctx.owner, ctx.repo, ctx.prNumber, body);
}
