/**
 * Render and post verified findings idempotently.
 */
import * as core from './core.js';
import { severityRank, BOT_SIGNATURE } from './config.js';

export const SUMMARY_MARKER = '<!-- commitreview:summary -->';
const MAX_NOT_REVIEWED = 10;
const RESERVED_MARKER = /<!--\s*commitreview:[\s\S]*?-->/gi;

const SEVERITY_ICON = {
  critical: '🛑',
  high: '🔴',
  medium: '🟠',
  low: '🟡',
};

export function commentBody(finding, anchor) {
  const parts = [
    `${SEVERITY_ICON[finding.severity] || '•'} **${finding.severity}** · ${finding.category}`,
    '',
    `**${escapeInline(finding.title)}**`,
    '',
    safeModelMarkdown(finding.body, 4000),
  ];

  if (anchor.snapped) {
    parts.push('', `<sub>Anchored to the nearest changed line; the model referenced line ${finding.line}.</sub>`);
  }
  if (finding.refutation) parts.push('', `<sub>Verifier: ${escapeHtml(finding.refutation)}</sub>`);
  parts.push('', '<sub>commitreview</sub>', `<!-- commitreview:fp=${finding.fp} -->`);
  return parts.join('\n');
}

export function renderSummary(result, config) {
  const { pr, anchored, demoted, duplicates, skipped, dropped, summaries, refuted, usage, reviewedFiles } = result;
  const all = [...anchored, ...demoted];
  const out = [SUMMARY_MARKER, '', '## commitreview'];

  const blurb = safeModelMarkdown(summaries.filter(Boolean).join('\n\n'), 5000);
  if (blurb) out.push('', blurb);

  const counts = {};
  for (const finding of all) counts[finding.severity] = (counts[finding.severity] || 0) + 1;
  const countText =
    Object.entries(counts)
      .sort((a, b) => severityRank(a[0]) - severityRank(b[0]))
      .map(([severity, count]) => `${SEVERITY_ICON[severity] || '•'} ${count} ${severity}`)
      .join(' · ') || 'no findings';

  out.push(
    '',
    `**${all.length} finding${all.length === 1 ? '' : 's'}** across ${reviewedFiles} file${reviewedFiles === 1 ? '' : 's'} — ${countText}`,
  );

  if (all.length) {
    out.push('', '| | Severity | Finding | Location |', '|---|---|---|---|');
    for (const finding of all.sort((a, b) => severityRank(a.severity) - severityRank(b.severity))) {
      const location = finding.anchor
        ? `\`${displayPath(finding.path)}:${finding.anchor.line}\``
        : `\`${displayPath(finding.path)}\``;
      out.push(
        `| ${SEVERITY_ICON[finding.severity] || '•'} | ${finding.severity} | ${escapeCell(escapeInline(finding.title))} | ${location} |`,
      );
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
        (finding) =>
          `- **${finding.severity}** \`${displayPath(finding.path)}\`${finding.line ? `:${finding.line}` : ''} — ${escapeInline(finding.title)}\n  ${oneLine(safeModelMarkdown(finding.body, 4000))}\n  <!-- commitreview:fp=${finding.fp} -->`,
      ),
      '',
      '</details>',
    );
  }

  const notReviewed = [...skipped, ...dropped];
  if (notReviewed.length) {
    const visible = notReviewed.slice(0, MAX_NOT_REVIEWED);
    const remainder = notReviewed.length - visible.length;
    out.push(
      '',
      `<details><summary>Not reviewed (${notReviewed.length})</summary>`,
      '',
      ...visible.map((item) => `- \`${displayPath(item.path)}\` — ${escapeInline(item.reason)}`),
      ...(remainder ? [`- … and ${remainder} more`] : []),
      '',
      '</details>',
    );
  }

  const context = result.codebase?.stats;
  const footer = [
    `model \`${displayPath(config.model)}\``,
    context?.toolCalls ? `${context.toolCalls} codebase lookup${context.toolCalls === 1 ? '' : 's'}` : null,
    context?.conventions ? `${context.conventions} rule doc${context.conventions === 1 ? '' : 's'}` : null,
    `${usage.requests} request${usage.requests === 1 ? '' : 's'}`,
    usage.prompt || usage.completion ? `${usage.prompt + usage.completion} tokens` : null,
    refuted ? `${refuted} refuted` : null,
    duplicates ? `${duplicates} already reported` : null,
    pr?.head?.sha ? `\`${pr.head.sha.slice(0, 7)}\`` : null,
  ].filter(Boolean);
  out.push('', `<sub>${footer.join(' · ')} · <a href="https://github.com/dymoo/commitreview">commitreview</a></sub>`);

  return out.join('\n');
}

const oneLine = (value) => String(value).replace(/\s+/g, ' ').slice(0, 300);
const escapeCell = (value) => String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const escapeHtml = (value) => neutralize(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeInline = (value) => escapeHtml(value).replace(/([\\`*_[\]])/g, '\\$1');
const displayPath = (value) =>
  neutralize(value)
    .replace(/[\r\n]/g, ' ')
    .replace(/`/g, "'")
    .slice(0, 240);
const neutralize = (value) => String(value ?? '').replace(/@/g, '@\u200b');
const safeModelMarkdown = (value, maxLength) =>
  neutralize(value).replace(RESERVED_MARKER, '').slice(0, maxLength).trim();

/** Post inline comments as one review, falling back to individual comments on a 422. */
export async function postInline(gh, ctx, pr, comments) {
  if (!comments.length) return 0;
  try {
    await gh.createReview(ctx.owner, ctx.repo, ctx.prNumber, {
      commit_id: pr.head.sha,
      event: 'COMMENT',
      body: `**commitreview** left ${comments.length} comment${comments.length === 1 ? '' : 's'}.\n${BOT_SIGNATURE}`,
      comments,
    });
    return comments.length;
  } catch (err) {
    if (err?.status !== 422) throw err;
    core.warning(`Batched review rejected (${err.message}). Retrying comments individually.`);
  }

  let posted = 0;
  for (const comment of comments) {
    try {
      await gh.request('POST', `/repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.prNumber}/comments`, {
        body: { ...comment, commit_id: pr.head.sha },
      });
      posted++;
    } catch (err) {
      core.warning(`Could not anchor a comment at ${comment.path}:${comment.line} — ${err.message}`);
    }
  }
  return posted;
}

export async function upsertSummary(gh, ctx, body, issueComments = null) {
  const comments = issueComments ?? (await gh.listIssueComments(ctx.owner, ctx.repo, ctx.prNumber));
  const existing = comments.find((comment) => String(comment.body || '').includes(SUMMARY_MARKER));
  if (existing) return gh.updateIssueComment(ctx.owner, ctx.repo, existing.id, body);
  return gh.createIssueComment(ctx.owner, ctx.repo, ctx.prNumber, body);
}
