import * as core from './core.js';
import { readConfig, readEvent, severityRank } from './config.js';
import { GitHub } from './github.js';
import { parseDiff, anchorFinding, lineText } from './diff.js';
import {
  selectFiles,
  renderFile,
  buildChunks,
  assertCompleteReviewContext,
  sliceAround,
  estimateTokens,
} from './context.js';
import { LLM } from './llm.js';
import { findFindings, refuteFinding } from './review.js';
import { mergeFindings, fingerprint, collectFingerprints } from './findings.js';
import { collectInstructionDocs, renderConventions } from './codebase.js';
import { investigate } from './agent.js';
import { openRepo, openRepoViaApi } from './repo.js';
import { commentBody, renderSummary, postInline, upsertSummary } from './post.js';
import { createHandoffProof } from './handoff.js';

async function main() {
  const config = readConfig();
  const ctx = readEvent(config.handoffToken);

  if (ctx.skip || !ctx.prNumber) {
    core.info(`Nothing to do: ${ctx.skip || 'no pull request number'}`);
    setOutputs(false, 0);
    return;
  }

  const gh = new GitHub(config.githubToken, { apiUrl: config.githubApiUrl });
  const pr = await gh.getPull(ctx.owner, ctx.repo, ctx.prNumber);
  if (ctx.trigger === 'cloud-coder' && pr.head?.sha !== ctx.headSha) {
    throw new Error('Cloud Coder hand-off no longer matches the pull request head.');
  }
  if (pr.state !== 'open') core.warning(`Pull request is ${pr.state}.`);

  const diffText = await gh.getPullDiff(ctx.owner, ctx.repo, ctx.prNumber);
  const files = parseDiff(diffText);
  const { selected, skipped } = selectFiles(files, config);

  core.info(`Reviewing ${ctx.owner}/${ctx.repo}#${ctx.prNumber} with ${config.model}`);
  core.info(`${files.length} changed files, ${selected.length} to review, ${skipped.length} skipped`);
  assertCompleteReviewContext({ skipped });

  if (!selected.length) {
    const currentPr = await refreshCloudCoderPull(gh, ctx, pr);
    const summary = renderSummary(emptyResult(currentPr, skipped), config);
    core.appendSummary(summary);
    await upsertSummary(gh, ctx, summary);
    await handoffCloudCoder(gh, ctx, currentPr, config, 0);
    setOutputs(true, 0);
    return;
  }

  // Excluded files must not leak through the raw diff into investigation.
  const filteredDiff = selected
    .flatMap((file) => renderFile(file, null, { ...config, contextLines: 0 }))
    .map((block) => block.text)
    .join('\n\n');

  if (!pr.head?.sha || !pr.base?.sha) {
    throw new Error('GitHub did not return both head and base commit SHAs for the pull request.');
  }

  const repo = await openRepo(gh, { owner: ctx.owner, repo: ctx.repo, sha: pr.head.sha });
  // A contributor can change instruction files in the pull request. Rules only
  // become trusted review policy after they reach the base branch.
  const rulesRepo = openRepoViaApi(gh, { owner: ctx.owner, repo: ctx.repo, sha: pr.base.sha });
  const llm = new LLM(config);

  let rendered;
  let chunks;
  let dropped;
  let codebase;
  try {
    const contents = await core.pmap(selected, config.concurrency, async (file) => {
      if (file.status === 'deleted') return null;
      const content = await repo.read(file.path);
      if (content === null) return null;
      if (content.length > config.maxFileBytes) {
        core.debug(`${file.path}: too large for context expansion (${content.length} bytes)`);
        return null;
      }
      return content;
    });

    rendered = selected.flatMap((file, index) => renderFile(file, contents[index], config));
    ({ chunks, dropped } = buildChunks(rendered, config));
    assertCompleteReviewContext({ rendered, dropped });
    core.info(
      `Prepared ${chunks.length} request(s), ~${chunks.reduce((total, chunk) => total + chunk.tokens, 0)} tokens${
        dropped.length ? `, ${dropped.length} file(s) dropped for budget` : ''
      }`,
    );
    for (const item of dropped) core.warning(`Not reviewed: ${item.path} — ${item.reason}`);

    const investigationDiff = truncateInvestigationDiff(filteredDiff, config.chunkTokens);
    if (investigationDiff.length < filteredDiff.length) {
      core.warning(`Investigation diff capped at ~${config.chunkTokens} tokens.`);
    }
    codebase = await gatherContext({
      llm,
      repo,
      rulesRepo,
      selected,
      diffText: investigationDiff,
      pr,
      config,
    });
  } finally {
    await Promise.all([repo.close(), rulesRepo.close()]);
  }

  const passes = await core.pmap(chunks, config.concurrency, (chunk, index) =>
    findFindings(llm, chunk, {
      pr,
      focus: ctx.focus,
      config,
      codebase,
      index,
      total: chunks.length,
    }),
  );

  const summaries = [...new Set(passes.map((pass) => pass.summary).filter(Boolean))].slice(0, 2);
  let findings = mergeFindings(passes.flatMap((pass) => pass.findings))
    .filter((finding) => severityRank(finding.severity) <= severityRank(config.minSeverity))
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .slice(0, config.maxFindings);

  const byPath = new Map();
  for (const block of rendered) {
    byPath.set(block.path, `${byPath.get(block.path) || ''}\n\n${block.text}`);
  }

  let refuted = 0;
  const verified = await core.pmap(findings, config.concurrency, async (finding) => {
    const material = sliceAround(byPath.get(finding.path) || '', finding.line);
    const verdict = await refuteFinding(llm, finding, material, codebase).catch((err) => {
      // A broken verifier is an infrastructure failure, not evidence against a
      // finding. Keep the candidate and make the uncertainty visible.
      core.warning(`Verification failed for ${finding.path}:${finding.line} — ${err.message}`);
      return { real: true, reason: 'Verifier failed; candidate retained.', severity: null };
    });
    if (!verdict.real) {
      refuted++;
      core.debug(`Refuted ${finding.path}:${finding.line} — ${verdict.reason}`);
      return null;
    }
    return {
      ...finding,
      severity: verdict.severity || finding.severity,
      refutation: verdict.reason,
    };
  });
  findings = verified.filter(Boolean).sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  core.info(`Verification kept ${findings.length} finding(s); ${refuted} refuted.`);

  const fileByPath = new Map(selected.map((file) => [file.path, file]));
  for (const finding of findings) {
    const file = fileByPath.get(finding.path);
    finding.anchor = anchorFinding(finding, file);
    finding.fp = fingerprint(finding, finding.anchor ? lineText(file, finding.anchor.side, finding.anchor.line) : '');
  }

  const [reviewComments, issueComments] = await Promise.all([
    gh.listReviewComments(ctx.owner, ctx.repo, ctx.prNumber),
    gh.listIssueComments(ctx.owner, ctx.repo, ctx.prNumber),
  ]);
  const seen = collectFingerprints([...reviewComments, ...issueComments].map((comment) => comment.body));
  const fresh = findings.filter((finding) => !seen.has(finding.fp));
  const anchored = findings.filter((finding) => finding.anchor);
  const demoted = findings.filter((finding) => !finding.anchor);
  const freshAnchored = fresh.filter((finding) => finding.anchor);
  if (demoted.length) core.info(`${demoted.length} finding(s) could not be anchored and moved to the summary.`);

  const currentPr = await refreshCloudCoderPull(gh, ctx, pr);
  const result = {
    pr: currentPr,
    anchored,
    demoted,
    duplicates: findings.length - fresh.length,
    skipped,
    dropped,
    summaries,
    refuted,
    usage: llm.usage,
    reviewedFiles: selected.length,
    codebase,
  };
  const summary = renderSummary(result, config);
  core.appendSummary(summary);

  const comments = freshAnchored.map((finding) => ({
    path: finding.anchor.path,
    line: finding.anchor.line,
    side: finding.anchor.side,
    ...(finding.anchor.start_line
      ? { start_line: finding.anchor.start_line, start_side: finding.anchor.start_side }
      : {}),
    body: commentBody(finding, finding.anchor),
  }));
  await postInline(gh, ctx, currentPr, comments);
  // GitHub binds inline comments to currentPr.head.sha. Recheck before the
  // unversioned sticky summary so a newer head receives no old review output.
  await refreshCloudCoderPull(gh, ctx, currentPr);
  await upsertSummary(gh, ctx, summary, issueComments);
  await handoffCloudCoder(gh, ctx, currentPr, config, fresh.length);
  setOutputs(true, findings.length);
}

/** Complete the one permitted Coder/Reviewer repair cycle; never merge code. */
async function handoffCloudCoder(gh, ctx, pr, config, findings) {
  if (ctx.trigger !== 'cloud-coder' || !ctx.codingIssue || ctx.repairRound === undefined) return;
  pr = await refreshCloudCoderPull(gh, ctx, pr);
  if (!pr.draft || pr.head?.ref !== `shipyard/issue-${ctx.codingIssue}`) {
    core.warning('Cloud Coder hand-off refused for a pull request outside the generated draft branch.');
    return;
  }
  if (!pr.head?.sha) throw new Error('Cloud Coder hand-off requires the pull request head SHA.');

  if (findings && ctx.repairRound === 0) {
    await gh.request('POST', `/repos/${ctx.owner}/${ctx.repo}/dispatches`, {
      body: {
        event_type: 'shipyard-repair',
        client_payload: {
          issue: ctx.codingIssue,
          pull_request: pr.number,
          repair_round: 1,
          head_sha: pr.head.sha,
          handoff_proof: createHandoffProof(config.handoffToken, {
            direction: 'repair',
            owner: ctx.owner,
            repo: ctx.repo,
            issue: ctx.codingIssue,
            pull: pr.number,
            repairRound: 1,
            headSha: pr.head.sha,
          }),
        },
      },
    });
    core.info(`Requested one Cloud Coder repair for Issue #${ctx.codingIssue}.`);
    return;
  }

  await gh.request('PATCH', `/repos/${ctx.owner}/${ctx.repo}/pulls/${pr.number}`, { body: { draft: false } });
  await gh.request('POST', `/repos/${ctx.owner}/${ctx.repo}/issues/${pr.number}/labels`, {
    body: { labels: ['ready-for-human'] },
  });
  core.info(`Draft PR #${pr.number} is ready for human or local-orchestrator review.`);
}

/** Refuse to publish review output against any commit other than the signed hand-off. */
async function refreshCloudCoderPull(gh, ctx, pr) {
  if (ctx.trigger !== 'cloud-coder') return pr;
  const current = await gh.getPull(ctx.owner, ctx.repo, pr.number);
  if (current.head?.sha !== ctx.headSha)
    throw new Error('Cloud Coder hand-off no longer matches the pull request head.');
  return current;
}

async function gatherContext({ llm, repo, rulesRepo, selected, diffText, pr, config }) {
  const docs = await collectInstructionDocs(
    rulesRepo,
    selected.map((file) => file.path),
    config.ignore,
  );
  const conventions = renderConventions(docs);
  const investigated = await investigate(llm, { repo, files: selected, diffText, pr, config });
  const text = [conventions, investigated?.text].filter(Boolean).join('\n\n');

  const stats = {
    ...(investigated?.stats || { mode: 'no investigation', toolCalls: 0 }),
    conventions: docs.length,
  };
  core.info(
    `Codebase context: ${docs.length} instruction doc(s), ${stats.toolCalls} lookup(s), ~${estimateTokens(
      text,
    )} tokens.`,
  );
  return text ? { text, tokens: estimateTokens(text), stats } : null;
}

function truncateInvestigationDiff(text, maxTokens) {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… investigation diff truncated …`;
}

function setOutputs(reviewed, findings) {
  core.setOutput('reviewed', String(reviewed));
  core.setOutput('findings', String(findings));
}

function emptyResult(pr, skipped) {
  return {
    pr,
    anchored: [],
    demoted: [],
    duplicates: 0,
    skipped,
    dropped: [],
    summaries: ['No reviewable changes in this pull request.'],
    refuted: 0,
    usage: { requests: 0, prompt: 0, completion: 0, cached: 0, cacheWrite: 0 },
    reviewedFiles: 0,
    codebase: null,
  };
}

main().catch((err) => {
  core.setFailed(err?.stack || String(err));
});
