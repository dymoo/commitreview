import fs from 'node:fs';
import path from 'node:path';
import * as core from './core.js';
import { readConfig, readEvent, severityRank } from './config.js';
import { GitHub } from './github.js';
import { parseDiff, anchorFinding, lineText } from './diff.js';
import { selectFiles, renderFile, buildChunks, sliceAround } from './context.js';
import { LLM } from './llm.js';
import { findFindings, refuteFinding, dedupeFindings } from './review.js';
import { fingerprint, collectFingerprints, commentBody, renderSummary, postInline, upsertSummary } from './post.js';

async function main() {
  const config = readConfig();
  const ctx = readEvent(config);

  if (ctx.skip || !ctx.prNumber) {
    core.info(`Nothing to review: ${ctx.skip || 'no pull request number'}`);
    core.setOutput('reviewed', 'false');
    core.setOutput('findings', '0');
    return;
  }

  const gh = new GitHub(config.githubToken);
  if (ctx.trigger === 'mention' && ctx.commentId && !config.dryRun) {
    await gh.addReaction(ctx.owner, ctx.repo, ctx.commentId, { isReviewComment: ctx.commentIsReview });
  }

  core.info(`Reviewing ${ctx.owner}/${ctx.repo}#${ctx.prNumber} with ${config.model}`);
  const pr = await gh.getPull(ctx.owner, ctx.repo, ctx.prNumber);
  if (pr.state !== 'open') core.warning(`Pull request is ${pr.state}.`);

  const diffText = await gh.getPullDiff(ctx.owner, ctx.repo, ctx.prNumber);
  const files = parseDiff(diffText);
  const { selected, skipped } = selectFiles(files, config);
  core.info(`${files.length} changed files, ${selected.length} to review, ${skipped.length} skipped`);

  if (!selected.length) {
    const body = `${renderSummary(emptyResult(pr), config)}`;
    if (ctx.trigger === 'mention' && !config.dryRun) {
      await upsertSummary(gh, ctx, body, config.summaryMode === 'off' ? 'new' : config.summaryMode);
    }
    core.appendSummary(body);
    core.setOutput('reviewed', 'true');
    core.setOutput('findings', '0');
    return;
  }

  // Surrounding source comes from the head commit, so no repository checkout is
  // needed — the same code path works for pull_request and issue_comment events.
  const contents = await core.pmap(selected, config.concurrency, async (file) => {
    if (config.contextLines === 0 || file.status === 'deleted') return null;
    const content = await gh.getFileContent(ctx.owner, ctx.repo, file.path, pr.head.sha);
    if (content === null) return null;
    if (content.length > config.maxFileBytes) {
      core.debug(`${file.path}: too large for context expansion (${content.length} bytes)`);
      return null;
    }
    return content;
  });

  const rendered = selected.flatMap((file, i) => renderFile(file, contents[i], config));
  const { chunks, dropped } = buildChunks(rendered, config);
  core.info(
    `Prepared ${chunks.length} request(s), ~${chunks.reduce((n, c) => n + c.tokens, 0)} tokens` +
      (dropped.length ? `, ${dropped.length} file(s) dropped for budget` : ''),
  );
  for (const d of dropped) core.warning(`Not reviewed: ${d.path} — ${d.reason}`);

  const byPath = new Map();
  for (const block of rendered) byPath.set(block.path, (byPath.get(block.path) || '') + `\n\n${block.text}`);
  const fileByPath = new Map(selected.map((f) => [f.path, f]));

  const llm = new LLM(config);
  const passes = await core.pmap(chunks, config.concurrency, (chunk, i) =>
    findFindings(llm, chunk, { pr, focus: ctx.focus, config, index: i, total: chunks.length }).catch((err) => {
      core.warning(`Review of part ${i + 1} failed: ${err.message}`);
      return { summary: '', findings: [] };
    }),
  );

  const summaries = passes.map((p) => p.summary).filter(Boolean);
  let findings = dedupeFindings(passes.flatMap((p) => p.findings))
    .filter((f) => severityRank(f.severity) <= severityRank(config.minSeverity))
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.confidence - a.confidence);

  if (findings.length > config.maxFindings) {
    core.info(`Keeping the top ${config.maxFindings} of ${findings.length} findings.`);
    findings = findings.slice(0, config.maxFindings);
  }

  let refuted = 0;
  if (config.refute && findings.length) {
    const tasks = findings.flatMap((f) => Array.from({ length: config.refuteVotes }, (_, vote) => ({ f, vote })));
    const verdicts = await core.pmap(tasks, config.concurrency, ({ f, vote }) =>
      refuteFinding(llm, f, sliceAround(byPath.get(f.path) || '', f.line), { config, vote }).catch((err) => {
        core.warning(`Verification failed for ${f.path}:${f.line} — ${err.message}`);
        return { real: true, reason: '' }; // A broken verifier must not silently delete findings.
      }),
    );

    const kept = [];
    for (const f of findings) {
      const votes = verdicts.splice(0, config.refuteVotes);
      const real = votes.filter((v) => v.real);
      if (real.length * 2 <= votes.length && votes.length > 1) {
        refuted++;
        continue;
      }
      if (!real.length) {
        refuted++;
        core.debug(`Refuted ${f.path}:${f.line} — ${votes[0]?.reason || ''}`);
        continue;
      }
      const proposed = real.find((v) => v.severity)?.severity;
      kept.push({ ...f, severity: proposed || f.severity, refutation: real[0].reason || '' });
    }
    core.info(`Verification kept ${kept.length} of ${findings.length} findings.`);
    findings = kept.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.confidence - a.confidence);
  }

  for (const f of findings) {
    const file = fileByPath.get(f.path);
    f.anchor = config.inlineComments ? anchorFinding(f, file) : null;
    f.fp = fingerprint(f, f.anchor ? lineText(file, f.anchor.side, f.anchor.line) : '');
  }

  const [reviewComments, issueComments] = config.dryRun
    ? [[], []]
    : await Promise.all([
        gh.listReviewComments(ctx.owner, ctx.repo, ctx.prNumber),
        gh.listIssueComments(ctx.owner, ctx.repo, ctx.prNumber),
      ]);
  const seen = collectFingerprints([...reviewComments, ...issueComments].map((c) => c.body));

  const fresh = findings.filter((f) => !seen.has(f.fp));
  const duplicates = findings.length - fresh.length;
  const posted = fresh.filter((f) => f.anchor);
  const demoted = fresh.filter((f) => !f.anchor);
  if (demoted.length) core.info(`${demoted.length} finding(s) could not be anchored and moved to the summary.`);

  const result = {
    pr,
    posted,
    demoted,
    duplicates,
    skipped,
    dropped,
    summaries,
    refuted,
    usage: llm.usage,
    reviewedFiles: selected.length,
  };
  const summaryMarkdown = renderSummary(result, config);
  core.appendSummary(summaryMarkdown);

  if (config.dryRun) {
    core.info('dry-run: not posting to the pull request.');
    core.info(summaryMarkdown);
  } else {
    const comments = posted.map((f) => ({
      path: f.anchor.path,
      line: f.anchor.line,
      side: f.anchor.side,
      ...(f.anchor.start_line ? { start_line: f.anchor.start_line, start_side: f.anchor.start_side } : {}),
      body: commentBody(f, f.anchor, config),
    }));
    await postInline(gh, ctx, pr, comments);
    await upsertSummary(gh, ctx, summaryMarkdown, config.summaryMode);
  }

  const jsonPath = path.join(process.env.RUNNER_TEMP || process.cwd(), 'commitreview-findings.json');
  fs.writeFileSync(jsonPath, JSON.stringify({ findings: [...posted, ...demoted], skipped, dropped }, null, 2));
  core.setOutput('reviewed', 'true');
  core.setOutput('findings', String(posted.length + demoted.length));
  core.setOutput('findings-json', jsonPath);
  core.setOutput('summary', summaryMarkdown);

  if (config.failOn !== 'none') {
    const worst = [...posted, ...demoted].filter((f) => severityRank(f.severity) <= severityRank(config.failOn));
    if (worst.length) {
      core.setFailed(`${worst.length} finding(s) at or above severity "${config.failOn}".`);
    }
  }
}

function emptyResult(pr) {
  return {
    pr,
    posted: [],
    demoted: [],
    duplicates: 0,
    skipped: [],
    dropped: [],
    summaries: ['No reviewable changes in this pull request.'],
    refuted: 0,
    usage: { requests: 0, prompt: 0, completion: 0 },
    reviewedFiles: 0,
  };
}

main().catch(async (err) => {
  core.setFailed(err?.stack || String(err));
  // A mention-triggered run that dies in silence looks like the bot ignored you.
  try {
    const config = readConfig();
    const ctx = readEvent(config);
    if (ctx.trigger === 'mention' && ctx.prNumber && !config.dryRun) {
      const gh = new GitHub(config.githubToken);
      await gh.createIssueComment(
        ctx.owner,
        ctx.repo,
        ctx.prNumber,
        `**commitreview** could not complete this review.\n\n\`\`\`\n${String(err?.message || err).slice(0, 1000)}\n\`\`\`\n\n<sub>See the [workflow run](${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}) for details.</sub>`,
      );
    }
  } catch {
    /* the original failure is already reported */
  }
});
