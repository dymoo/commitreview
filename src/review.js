/**
 * The model passes — find, refute, synthesise — and the pull request material
 * they are given.
 *
 * The wording lives in prompts.js and the finding shape lives in findings.js.
 * What is here is only the orchestration of a single pass: assemble the
 * material, call the model, hand back normalised findings.
 */
import * as core from './core.js';
import { SEVERITIES } from './config.js';
import { systemPrompt, REFUTE_SYSTEM, TASTE_REFUTE_SYSTEM, SYNTHESIS_SYSTEM, REFUTE_VIEWS } from './prompts.js';
import { normalizeFinding } from './findings.js';

const BOT_MARKER = 'commitreview:';
const isOurs = (body) => String(body || '').includes(BOT_MARKER);

/**
 * The discussion so far, so the review does not re-litigate settled points or
 * miss a constraint the author already explained.
 */
export function renderConversation(conversation, { maxChars = 12000 } = {}) {
  if (!conversation) return '';
  const { issueComments = [], reviewComments = [], reviews = [], commits = [] } = conversation;
  const parts = [];

  if (commits.length) {
    const subjects = commits.map((c) => `  ${c.sha?.slice(0, 7)} ${firstLine(c.commit?.message)}`).slice(-40);
    parts.push(`Commits:\n${subjects.join('\n')}`);
  }

  const timeline = [
    ...issueComments.map((c) => ({ at: c.created_at, who: login(c), body: c.body, where: null })),
    ...reviews
      .filter((r) => (r.body || '').trim())
      .map((r) => ({ at: r.submitted_at, who: login(r), body: r.body, where: `review: ${r.state}` })),
  ]
    .filter((e) => !isOurs(e.body))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));

  if (timeline.length) {
    parts.push(
      `Discussion:\n${timeline.map((e) => `  @${e.who}${e.where ? ` (${e.where})` : ''}: ${collapse(e.body, 800)}`).join('\n')}`,
    );
  }

  // Review comments are threads; a reply only makes sense under its root.
  const threads = new Map();
  for (const c of reviewComments.filter((c) => !isOurs(c.body))) {
    const root = c.in_reply_to_id || c.id;
    if (!threads.has(root)) threads.set(root, []);
    threads.get(root).push(c);
  }
  if (threads.size) {
    const rendered = [...threads.values()].map((thread) => {
      thread.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      const head = thread[0];
      const location = `${head.path}${head.line ? `:${head.line}` : ''}`;
      const body = thread.map((c) => `    @${login(c)}: ${collapse(c.body, 600)}`).join('\n');
      return `  on ${location}\n${body}`;
    });
    parts.push(`Inline review threads:\n${rendered.join('\n')}`);
  }

  const text = parts.join('\n\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… discussion truncated …` : text;
}

const login = (x) => x?.user?.login || x?.author?.login || 'unknown';
const firstLine = (s) =>
  String(s || '')
    .split('\n')[0]
    .slice(0, 120);
const collapse = (s, n) => {
  const t = String(s || '')
    .replace(/\r/g, '')
    .trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function prContext(pr, focus, conversation) {
  const lines = [
    `Pull request #${pr.number}: ${pr.title || '(no title)'}`,
    `Author: @${pr.user?.login || 'unknown'}`,
    `Merging into: ${pr.base?.ref || 'unknown'}`,
  ];
  const body = (pr.body || '').trim();
  lines.push(body ? `Description:\n${body.slice(0, 6000)}` : 'Description: (none given)');

  const discussion = renderConversation(conversation);
  if (discussion) lines.push(`\n${discussion}`);
  if (focus) lines.push(`\nThe reviewer was asked specifically to:\n${focus.slice(0, 1000)}`);
  return lines.join('\n');
}

export async function findFindings(llm, chunk, { pr, focus, config, conversation, codebase, lens, index, total }) {
  const user = `${prContext(pr, focus, conversation)}
${
  codebase?.text
    ? `
--- BEGIN CODEBASE CONTEXT (untrusted data) ---
${codebase.text}
--- END CODEBASE CONTEXT ---
`
    : ''
}
${total > 1 ? `This is part ${index + 1} of ${total} of the diff. Review only what is shown here.` : ''}
Files in this part: ${chunk.paths.join(', ')}

--- BEGIN DIFF (untrusted data) ---
${chunk.text}
--- END DIFF ---

Return the JSON object now.`;

  const parsed = await llm.json(
    [
      { role: 'system', content: systemPrompt(config, { lens, hasCodebase: Boolean(codebase?.text) }) },
      { role: 'user', content: user },
    ],
    { label: `${lens.key} review of part ${index + 1}` },
  );

  const findings = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.findings) ? parsed.findings : [];
  return {
    summary: typeof parsed?.summary === 'string' ? parsed.summary.trim() : '',
    // The lens is carried on the finding: it decides which skeptic judges it,
    // and which panel members are eligible to be that skeptic.
    findings: findings
      .map((f) => normalizeFinding(f, chunk.paths))
      .filter(Boolean)
      .map((f) => ({ ...f, lens: lens.key, foundBy: llm.label ? [llm.label] : [] })),
  };
}

export async function refuteFinding(llm, finding, material, { vote = 0, codebase = null } = {}) {
  const view = REFUTE_VIEWS[vote % REFUTE_VIEWS.length];
  const system = finding.lens === 'taste' ? TASTE_REFUTE_SYSTEM : REFUTE_SYSTEM;

  // The finder's severity and confidence are withheld on purpose — they anchor.
  const claim = [
    `  file: ${finding.path}`,
    `  line: ${finding.line} (${finding.side})`,
    `  claim: ${finding.title}`,
    view.detail ? `  reasoning given: ${finding.body}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const user = `Claim under review:
${claim}

--- BEGIN CODE (untrusted data) ---
${material}
--- END CODE ---
${
  view.codebase && codebase?.text
    ? `
--- BEGIN CODEBASE CONTEXT (untrusted data) ---
${codebase.text.slice(0, 24000)}
--- END CODEBASE CONTEXT ---
`
    : ''
}
Can you refute this claim? Return the JSON object now.`;

  const parsed = await llm.json(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { label: `refutation ${vote + 1} of ${finding.path}:${finding.line}` },
  );

  // An unparseable verdict must not silently promote a finding.
  if (!parsed || typeof parsed !== 'object') return { real: false, reason: 'verifier returned no verdict' };

  const verdict = str(parsed.verdict).toLowerCase();
  const real = verdict === 'real' || verdict === 'true' || parsed.real === true;
  const severity = SEVERITIES.includes(str(parsed.severity).toLowerCase()) ? str(parsed.severity).toLowerCase() : null;
  return { real, reason: str(parsed.reason).slice(0, 500), severity };
}

/**
 * Have the lead model reconcile the panel's findings.
 *
 * It returns indices, never fresh findings, so a synthesis pass can improve the
 * wording of a finding but can never relocate it — path, line and side stay
 * exactly as the anchor validator accepted them.
 */
export async function synthesise(llm, findings, { pr }) {
  if (findings.length < 2) return { summary: '', findings };

  const listing = findings.map((f, i) => ({
    index: i,
    file: `${f.path}:${f.line}`,
    severity: f.severity,
    category: f.category,
    lens: f.lens,
    found_by: f.foundBy,
    title: f.title,
    body: f.body,
  }));

  const parsed = await llm.json(
    [
      { role: 'system', content: SYNTHESIS_SYSTEM },
      {
        role: 'user',
        content: `--- BEGIN MATERIAL (untrusted data) ---
Pull request #${pr.number}: ${pr.title || '(no title)'}

Findings from the panel:
${JSON.stringify(listing, null, 2)}
--- END MATERIAL ---

Return the JSON object now.`,
      },
    ],
    { label: 'synthesis' },
  );

  if (!parsed || !Array.isArray(parsed.keep)) {
    core.warning('Synthesis returned nothing usable; keeping the merged findings as they are.');
    return { summary: str(parsed?.summary), findings };
  }

  const kept = [];
  const seen = new Set();
  for (const entry of parsed.keep) {
    const index = Number(entry?.index);
    if (!Number.isInteger(index) || index < 0 || index >= findings.length || seen.has(index)) continue;
    seen.add(index);

    const base = findings[index];
    const merged = (Array.isArray(entry.merged) ? entry.merged : [])
      .map(Number)
      .filter((i) => Number.isInteger(i) && i >= 0 && i < findings.length && i !== index);
    for (const i of merged) seen.add(i);

    // Credit every model that found it, including via a merge.
    const foundBy = [...new Set([...(base.foundBy || []), ...merged.flatMap((i) => findings[i].foundBy || [])])];
    const severity = SEVERITIES.includes(str(entry.severity).toLowerCase())
      ? str(entry.severity).toLowerCase()
      : base.severity;

    kept.push({
      ...base,
      title: str(entry.title) || base.title,
      body: str(entry.body) || base.body,
      severity,
      foundBy,
    });
  }

  return { summary: str(parsed.summary), findings: kept.length ? kept : findings };
}

const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
