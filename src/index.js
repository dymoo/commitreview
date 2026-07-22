import fs from 'node:fs';
import path from 'node:path';
import * as core from './core.js';
import { readConfig, readEvent, severityRank, LENSES, TASTE_LENS } from './config.js';
import { GitHub } from './github.js';
import { parseDiff, anchorFinding, lineText } from './diff.js';
import { selectFiles, renderFile, buildChunks, sliceAround } from './context.js';
import { LLM } from './llm.js';
import { findFindings, refuteFinding, synthesise } from './review.js';
import { mergeFindings, fingerprint, collectFingerprints } from './findings.js';
import { buildCodebaseContext } from './codebase.js';
import { investigate } from './agent.js';
import { answer, isReviewRequest, findThread } from './chat.js';
import { openRepo } from './repo.js';
import { commentBody, renderSummary, postInline, upsertSummary } from './post.js';

async function main() {
  const config = readConfig();
  const ctx = readEvent(config);

  if (ctx.skip || !ctx.prNumber) {
    core.info(`Nothing to do: ${ctx.skip || 'no pull request number'}`);
    core.setOutput('reviewed', 'false');
    core.setOutput('findings', '0');
    return;
  }

  const gh = new GitHub(config.githubToken);
  if (ctx.trigger === 'mention' && ctx.commentId && !config.dryRun) {
    await gh.addReaction(ctx.owner, ctx.repo, ctx.commentId, { isReviewComment: ctx.commentIsReview });
  }

  const pr = await gh.getPull(ctx.owner, ctx.repo, ctx.prNumber);
  if (pr.state !== 'open') core.warning(`Pull request is ${pr.state}.`);

  const [diffText, conversation] = await Promise.all([
    gh.getPullDiff(ctx.owner, ctx.repo, ctx.prNumber),
    gh.getConversation(ctx.owner, ctx.repo, ctx.prNumber),
  ]);

  const files = parseDiff(diffText);
  const { selected, skipped } = selectFiles(files, config);

  // Reading the repository is one request and everything downstream benefits.
  const repo = await openRepo(gh, { owner: ctx.owner, repo: ctx.repo, sha: pr.head.sha, config });
  const panel = config.panel.map((member) => new LLM({ ...config, ...member }));
  const llm = panel[0];
  if (config.agentic === 'off') for (const client of panel) client.quirks.tools = false;

  // A mention carrying an actual question is a conversation, not a review.
  if (ctx.trigger === 'mention' && !isReviewRequest(ctx.focus)) {
    return runChat({ config, ctx, gh, llm, pr, conversation, repo, diffText });
  }

  core.info(`Reviewing ${ctx.owner}/${ctx.repo}#${ctx.prNumber} with ${config.model} (depth: ${config.depth})`);
  core.info(`${files.length} changed files, ${selected.length} to review, ${skipped.length} skipped`);

  if (!selected.length) {
    const body = renderSummary(emptyResult(pr), config);
    if (ctx.trigger === 'mention' && !config.dryRun) {
      await upsertSummary(gh, ctx, body, config.summaryMode === 'off' ? 'new' : config.summaryMode);
    }
    core.appendSummary(body);
    core.setOutput('reviewed', 'true');
    core.setOutput('findings', '0');
    return;
  }

  // Surrounding source comes from the head commit, so no checkout is needed and
  // the same path works for pull_request and issue_comment events alike.
  const contents = await core.pmap(selected, config.concurrency, async (file) => {
    if (config.contextLines === 0 || file.status === 'deleted') return null;
    const content = repo
      ? await repo.read(file.path)
      : await gh.getFileContent(ctx.owner, ctx.repo, file.path, pr.head.sha);
    if (content === null || content === undefined) return null;
    if (content.length > config.maxFileBytes) {
      core.debug(`${file.path}: too large for context expansion (${content.length} bytes)`);
      return null;
    }
    return content;
  });

  const rendered = selected.flatMap((file, i) => renderFile(file, contents[i], config));
  const { chunks, dropped } = buildChunks(rendered, config);
  core.info(
    `Prepared ${chunks.length} request(s), ~${chunks.reduce((n, c) => n + c.tokens, 0)} tokens${
      dropped.length ? `, ${dropped.length} file(s) dropped for budget` : ''
    }`,
  );
  for (const d of dropped) core.warning(`Not reviewed: ${d.path} — ${d.reason}`);

  const codebase = await gatherContext({ llm, repo, selected, diffText, pr, config });

  const byPath = new Map();
  for (const block of rendered) byPath.set(block.path, `${byPath.get(block.path) || ''}\n\n${block.text}`);
  const fileByPath = new Map(selected.map((f) => [f.path, f]));

  const lenses = [...LENSES.slice(0, config.lenses), ...(config.taste ? [TASTE_LENS] : [])];
  const jobs = panel.flatMap((client) =>
    lenses.flatMap((lens) => chunks.map((chunk, index) => ({ client, lens, chunk, index }))),
  );
  core.info(
    `Running ${jobs.length} review pass(es): ${lenses.map((l) => l.key).join(', ')}${
      panel.length > 1 ? ` across ${panel.map((c) => c.label).join(', ')}` : ''
    }`,
  );

  const passes = await core.pmap(jobs, config.concurrency, ({ client, lens, chunk, index }) =>
    findFindings(client, chunk, {
      pr,
      focus: ctx.focus,
      config,
      conversation,
      codebase,
      lens,
      index,
      total: chunks.length,
    }).catch((err) => {
      core.warning(`${lens.key} review of part ${index + 1} by ${client.label} failed: ${err.message}`);
      return { summary: '', findings: [] };
    }),
  );

  const summaries = [...new Set(passes.map((p) => p.summary).filter(Boolean))].slice(0, 2);
  let findings = mergeFindings(passes.flatMap((p) => p.findings))
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
      refuteFinding(refuterFor(panel, f, vote), f, sliceAround(byPath.get(f.path) || '', f.line), {
        vote,
        codebase,
      }).catch((err) => {
        core.warning(`Verification failed for ${f.path}:${f.line} — ${err.message}`);
        return { real: true, reason: '' }; // A broken verifier must not silently delete findings.
      }),
    );

    const kept = [];
    for (const f of findings) {
      const votes = verdicts.splice(0, config.refuteVotes);
      const real = votes.filter((v) => v.real);
      if (real.length * 2 <= votes.length) {
        refuted++;
        core.debug(`Refuted ${f.path}:${f.line} — ${votes.find((v) => !v.real)?.reason || ''}`);
        continue;
      }
      const proposed = real.find((v) => v.severity)?.severity;
      kept.push({ ...f, severity: proposed || f.severity, refutation: real[0].reason || '' });
    }
    core.info(`Verification kept ${kept.length} of ${findings.length} findings.`);
    findings = kept.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.confidence - a.confidence);
  }

  // With a panel, the lead model reconciles what the others found. It may
  // reword and re-rank, never relocate — anchors are taken from the original.
  let leadSummary = '';
  if (panel.length > 1 && findings.length > 1) {
    const synthesised = await synthesise(panel[0], findings, { pr }).catch((err) => {
      core.warning(`Synthesis failed (${err.message}); using the merged findings.`);
      return null;
    });
    if (synthesised) {
      core.info(`Lead model reconciled ${findings.length} findings down to ${synthesised.findings.length}.`);
      findings = synthesised.findings;
      leadSummary = synthesised.summary;
    }
  }

  for (const f of findings) {
    const file = fileByPath.get(f.path);
    f.anchor = config.inlineComments ? anchorFinding(f, file) : null;
    f.fp = fingerprint(f, f.anchor ? lineText(file, f.anchor.side, f.anchor.line) : '');
  }

  const seen = config.dryRun
    ? new Set()
    : collectFingerprints([...conversation.reviewComments, ...conversation.issueComments].map((c) => c.body));

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
    summaries: leadSummary ? [leadSummary] : summaries,
    refuted,
    usage: totalUsage(panel),
    panel: panel.map((c) => c.label),
    reviewedFiles: selected.length,
    codebase,
    lenses: lenses.map((l) => l.key),
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
    if (worst.length) core.setFailed(`${worst.length} finding(s) at or above severity "${config.failOn}".`);
  }
}

/**
 * Codebase context, agentically when the endpoint can drive tools and
 * deterministically when it cannot. Downstream never learns which ran.
 */
async function gatherContext({ llm, repo, selected, diffText, pr, config }) {
  if (!repo) return null;

  if (config.agentic !== 'off') {
    const investigated = await investigate(llm, { repo, files: selected, diffText, pr, config });
    if (investigated) return investigated;
    if (config.agentic === 'on') {
      core.warning('agentic: on was requested but the investigation produced nothing; falling back.');
    }
  }

  const built = await buildCodebaseContext(repo, selected, config);
  if (built.text) {
    core.info(
      `Codebase context: ${built.stats.definitions} definition(s), ${built.stats.references} symbol(s) with external callers, ` +
        `${built.stats.conventions} instruction doc(s), ~${built.tokens} tokens.`,
    );
  }
  return { ...built, stats: { ...built.stats, mode: 'deterministic' } };
}

/** Conversational reply — the @mention-with-a-question path. */
async function runChat({ config, ctx, gh, llm, pr, conversation, repo, diffText }) {
  core.info(`Answering @${ctx.payload?.comment?.user?.login || 'someone'} on #${ctx.prNumber}`);
  const thread = ctx.commentIsReview ? findThread(conversation, ctx.commentId) : null;

  const reply = await answer(llm, {
    repo,
    diffText: diffText.length > 120000 ? `${diffText.slice(0, 120000)}\n… diff truncated …` : diffText,
    pr,
    conversation,
    question: { who: ctx.payload?.comment?.user?.login || 'someone', text: ctx.focus },
    thread,
    config,
  });

  const body = `${reply}\n\n<sub>commitreview · ${llm.usage.requests} request${llm.usage.requests === 1 ? '' : 's'} · <a href="https://github.com/dymoo/commitreview">what is this?</a></sub>`;

  if (config.dryRun) {
    core.info('dry-run: not posting the reply.');
    core.info(body);
  } else if (thread) {
    await gh.replyToReviewComment(ctx.owner, ctx.repo, ctx.prNumber, thread.rootId, body);
  } else {
    await gh.createIssueComment(ctx.owner, ctx.repo, ctx.prNumber, body);
  }

  core.appendSummary(body);
  core.setOutput('reviewed', 'false');
  core.setOutput('findings', '0');
  core.setOutput('summary', body);
}

/**
 * Pick who judges a finding. With a panel, prefer a model that did NOT find it:
 * a critic from another lab catches the correlated blind spots a same-family
 * critic shares. Falls back to round-robin when every model found it.
 */
function refuterFor(panel, finding, vote) {
  if (panel.length === 1) return panel[0];
  const found = new Set(finding.foundBy || []);
  const others = panel.filter((c) => !found.has(c.label));
  const pool = others.length ? others : panel;
  return pool[vote % pool.length];
}

const totalUsage = (panel) =>
  panel.reduce(
    (sum, c) => ({
      requests: sum.requests + c.usage.requests,
      prompt: sum.prompt + c.usage.prompt,
      completion: sum.completion + c.usage.completion,
    }),
    { requests: 0, prompt: 0, completion: 0 },
  );

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
    codebase: null,
    lenses: [],
    panel: [],
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
        `**commitreview** could not finish.\n\n\`\`\`\n${String(err?.message || err).slice(0, 1000)}\n\`\`\`\n\n<sub>See the [workflow run](${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}) for details.</sub>`,
      );
    }
  } catch {
    /* the original failure is already reported */
  }
});
