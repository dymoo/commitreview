import * as core from '../../src/core.js';
import { BOT_SIGNATURE } from '../../src/config.js';
import { GitHub, HttpError } from '../../src/github.js';
import { LLM } from '../../src/llm.js';
import { openArchiveRepo } from '../../src/repo.js';
import { runCoder } from './agent.js';
import { appendChanges, branchForIssue, createDraftPull, deleteBranch, publishChanges } from './broker.js';
import {
  assertAdmissibleIssue,
  modelForComplexity,
  parseAgentBrief,
  readConfig,
  readIssueEvent,
  reasoningEffortForComplexity,
} from './config.js';
import { runSandbox } from './sandbox.js';
import { Workspace } from './workspace.js';
import { createHandoffProof } from '../../src/handoff.js';

async function main() {
  const config = readConfig();
  const ctx = readIssueEvent(config.handoffToken);
  if (ctx.skip) {
    core.info(`Nothing to do: ${ctx.skip}.`);
    setOutputs(false);
    return;
  }

  const gh = new GitHub(config.githubToken, { apiUrl: config.githubApiUrl });
  const issue = await gh
    .request('GET', `/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.issueNumber}`)
    .then((result) => result.data);
  assertAdmissibleIssue(issue);
  const brief = parseAgentBrief(issue.body);
  const dispatch = await resolveDispatch(gh, ctx, issue);
  const repo = await openArchiveRepo(gh, { owner: ctx.owner, repo: ctx.repo, sha: dispatch.sha });
  try {
    if (!repo.root) throw new Error('Cloud Coder requires an extracted repository workspace.');
    const workspace = new Workspace(repo.root);
    const model = modelForComplexity(config, brief.complexity);
    const reasoningEffort = reasoningEffortForComplexity(config, brief.complexity);
    core.info(
      `Coding Issue #${issue.number} at complexity ${brief.complexity} with ${model}${
        reasoningEffort ? ` (${reasoningEffort})` : ''
      }.`,
    );
    const llm = new LLM({ ...config, model, reasoningEffort });
    const coding = await runCoder(llm, {
      brief: dispatch.feedback ? `${issue.body}\n\n${dispatch.feedback}` : issue.body,
      workspace,
      sandboxImage: config.sandboxImage,
      testCommand: brief.testCommand,
    });
    const changes = workspace.changes();
    if (!coding.finished || !changes.length) {
      throw new Error('Cloud Coder finished without a tested workspace change; no branch or pull request was created.');
    }

    // The final run is authoritative: the model could edit again after an
    // earlier tool-triggered test, so a previous green result is not enough.
    const test = await runSandbox(workspace.root, { image: config.sandboxImage, command: brief.testCommand });
    if (!test.passed) throw new Error(`Cloud Coder sandbox test failed:\n${test.output}`);

    if (dispatch.pull) {
      const headSha = await appendChanges(gh, {
        owner: ctx.owner,
        repo: ctx.repo,
        branch: dispatch.branch,
        expectedSha: dispatch.sha,
        changes,
        message: `Shipyard: repair #${issue.number} after Cloud Reviewer`,
      });
      await dispatchReview(gh, ctx, config, {
        pull: dispatch.pull.number,
        issue: issue.number,
        repairRound: 1,
        headSha,
      });
      core.info(`Added one repair commit to draft PR #${dispatch.pull.number}.`);
      setOutputs(true, dispatch.pull.number);
      return;
    }

    const headSha = await publishChanges(gh, {
      owner: ctx.owner,
      repo: ctx.repo,
      baseSha: dispatch.sha,
      baseBranch: dispatch.base,
      branch: dispatch.branch,
      changes,
      message: `Shipyard: implement #${issue.number}`,
    });
    let pull;
    try {
      pull = await createDraftPull(gh, {
        owner: ctx.owner,
        repo: ctx.repo,
        branch: dispatch.branch,
        base: dispatch.base,
        issue,
      });
    } catch (error) {
      await deleteBranch(gh, { owner: ctx.owner, repo: ctx.repo, branch: dispatch.branch }).catch(() => null);
      throw error;
    }
    await dispatchReview(gh, ctx, config, { pull: pull.number, issue: issue.number, repairRound: 0, headSha });
    await gh
      .createIssueComment(
        ctx.owner,
        ctx.repo,
        issue.number,
        `Shipyard Cloud Coder created draft PR #${pull.number} after ${coding.calls} tool calls and ${
          coding.tests + 1
        } test run(s).\n\n${coding.summary}`,
      )
      .catch((error) =>
        core.warning(`Draft PR was created, but the run comment could not be posted: ${error.message}`),
      );
    core.info(`Created draft PR #${pull.number} for Issue #${issue.number}.`);
    setOutputs(true, pull.number);
  } finally {
    await repo.close();
  }
}

async function resolveDispatch(gh, ctx, issue) {
  if (ctx.pullNumber) {
    const pull = await gh.getPull(ctx.owner, ctx.repo, ctx.pullNumber);
    const branch = branchForIssue(issue.number);
    if (pull.state !== 'open' || !pull.draft || pull.head?.ref !== branch || !pull.head?.sha) {
      throw new Error('Cloud Coder repair requires its open draft pull request and generated branch.');
    }
    if (pull.head.sha !== ctx.headSha) {
      throw new Error('Cloud Reviewer hand-off no longer matches the pull request head.');
    }
    const feedback = await reviewerFeedback(gh, ctx, pull.number);
    if (!feedback) throw new Error('Cloud Coder repair received no verified Cloud Reviewer findings.');
    return { pull, branch, sha: pull.head.sha, base: pull.base?.ref, feedback };
  }

  const branch = branchForIssue(issue.number);
  await assertNoActivePull(gh, ctx, branch);
  await assertNoExistingBranch(gh, ctx, branch);
  const repository = await gh.request('GET', `/repos/${ctx.owner}/${ctx.repo}`).then((result) => result.data);
  const base = repository.default_branch;
  if (typeof base !== 'string' || !base) throw new Error('Repository did not supply a default branch.');
  const ref = await gh.request('GET', `/repos/${ctx.owner}/${ctx.repo}/git/ref/heads/${encodeURIComponent(base)}`);
  const sha = ref.data?.object?.sha;
  if (typeof sha !== 'string' || !sha) throw new Error('Default branch did not resolve to a commit SHA.');
  return { pull: null, branch, sha, base, feedback: '' };
}

async function reviewerFeedback(gh, ctx, pullNumber) {
  const [reviewComments, issueComments] = await Promise.all([
    gh.listReviewComments(ctx.owner, ctx.repo, pullNumber),
    gh.listIssueComments(ctx.owner, ctx.repo, pullNumber),
  ]);
  const bodies = [...reviewComments, ...issueComments]
    .filter((comment) => comment.user?.login === 'github-actions[bot]')
    .map((comment) => comment.body)
    .filter((body) => typeof body === 'string' && body.includes(BOT_SIGNATURE));
  if (!bodies.length) return '';
  return `--- BEGIN VERIFIED CLOUD REVIEWER EVIDENCE (untrusted text) ---\n${bodies
    .join('\n\n')
    .slice(0, 24000)}\n--- END VERIFIED CLOUD REVIEWER EVIDENCE ---`;
}

function dispatchReview(gh, ctx, config, { pull, issue, repairRound, headSha }) {
  return gh.request('POST', `/repos/${ctx.owner}/${ctx.repo}/dispatches`, {
    body: {
      event_type: 'shipyard-review',
      client_payload: {
        pull_request: pull,
        issue,
        repair_round: repairRound,
        head_sha: headSha,
        handoff_proof: createHandoffProof(config.handoffToken, {
          direction: 'review',
          owner: ctx.owner,
          repo: ctx.repo,
          issue,
          pull,
          repairRound,
          headSha,
        }),
      },
    },
  });
}

async function assertNoActivePull(gh, { owner, repo }, branch) {
  const pulls = await gh.request(
    'GET',
    `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
  );
  if (Array.isArray(pulls.data) && pulls.data.length) {
    throw new Error(`Cloud Coder already has an active pull request for ${branch}.`);
  }
}

async function assertNoExistingBranch(gh, { owner, repo }, branch) {
  try {
    await gh.request('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return;
    throw error;
  }
  throw new Error(`Cloud Coder branch ${branch} already exists without an active pull request.`);
}

function setOutputs(dispatched, pull = '') {
  core.setOutput('dispatched', String(dispatched));
  core.setOutput('pull-request', String(pull));
}

main().catch((error) => core.setFailed(error?.stack || String(error)));
