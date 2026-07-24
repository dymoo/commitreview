/**
 * The two model passes: find candidate issues, then try to refute each one.
 * Prompt wording lives in prompts.js; finding normalisation lives in
 * findings.js.
 */
import { SEVERITIES, VERDICT_REAL, VERDICT_NOT_REAL } from './config.js';
import { systemPrompt, REFUTE_SYSTEM } from './prompts.js';
import { FINDINGS, VERDICT } from './schema.js';
import { normalizeFinding } from './findings.js';

function prContext(pr, focus) {
  const lines = [
    `Pull request #${pr.number}: ${pr.title || '(no title)'}`,
    `Author: @${pr.user?.login || 'unknown'}`,
    `Merging into: ${pr.base?.ref || 'unknown'}`,
  ];
  const body = (pr.body || '').trim();
  lines.push(body ? `Description:\n${body.slice(0, 6000)}` : 'Description: (none given)');
  if (focus) lines.push(`\nThe reviewer was asked specifically to:\n${focus.slice(0, 1000)}`);
  return lines.join('\n');
}

export async function findFindings(llm, chunk, { pr, focus, config, codebase, index, total }) {
  const user = `--- BEGIN PULL REQUEST CONTEXT (untrusted data) ---
${prContext(pr, focus)}
--- END PULL REQUEST CONTEXT ---
${
  codebase?.text
    ? `
--- BEGIN CODEBASE CONTEXT (untrusted data) ---
${codebase.text}
--- END CODEBASE CONTEXT ---
`
    : ''
}
${total > 1 ? `This is part ${index + 1} of ${total}. Review only what is shown here.` : ''}

--- BEGIN DIFF (untrusted data) ---
Files in this part: ${chunk.paths.join(', ')}

${chunk.text}
--- END DIFF ---

Return the JSON object now.`;

  const parsed = await llm.json(
    [
      { role: 'system', content: systemPrompt(config, { hasCodebase: Boolean(codebase?.text) }) },
      { role: 'user', content: user },
    ],
    { label: `review of part ${index + 1}`, schema: FINDINGS, schemaName: 'code_review' },
  );

  const findings = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.findings) ? parsed.findings : [];
  return {
    summary: typeof parsed?.summary === 'string' ? parsed.summary.trim().slice(0, 2000) : '',
    findings: findings.map((finding) => normalizeFinding(finding, chunk.paths)).filter(Boolean),
  };
}

export async function refuteFinding(llm, finding, material, codebase = null) {
  // The finder's severity is withheld on purpose because it would anchor the
  // verifier before it assesses the evidence.
  const claim = [
    `  file: ${finding.path}`,
    `  line: ${finding.line} (${finding.side})`,
    `  claim: ${finding.title}`,
    `  reasoning given: ${finding.body}`,
  ].join('\n');

  const user = `--- BEGIN CLAIM (untrusted data) ---
${claim}
--- END CLAIM ---

--- BEGIN CODE (untrusted data) ---
${material}
--- END CODE ---
${
  codebase?.text
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
      { role: 'system', content: REFUTE_SYSTEM },
      { role: 'user', content: user },
    ],
    { label: `verification of ${finding.path}:${finding.line}`, schema: VERDICT, schemaName: 'verdict' },
  );

  if (!parsed || typeof parsed !== 'object') throw new Error('Verifier returned no verdict.');
  const verdict = str(parsed.verdict).toLowerCase();
  if (verdict !== VERDICT_REAL && verdict !== VERDICT_NOT_REAL) {
    throw new Error(`Verifier returned unknown verdict "${verdict || '(empty)'}".`);
  }

  const severity = SEVERITIES.includes(str(parsed.severity).toLowerCase()) ? str(parsed.severity).toLowerCase() : null;
  return {
    real: verdict === VERDICT_REAL,
    reason: str(parsed.reason).slice(0, 500),
    severity,
  };
}

const str = (value) => (typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim());
