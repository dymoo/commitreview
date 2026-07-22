// Minimal stand-in for @actions/core. Keeping the action dependency-free means
// no bundled dist/, so the code that runs is the code you can read in the repo.
import fs from 'node:fs';

const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

function issue(cmd, message = '') {
  process.stdout.write(`::${cmd}::${esc(message)}\n`);
}

export const info = (msg) => process.stdout.write(`${msg}\n`);
export const debug = (msg) => issue('debug', msg);
export const notice = (msg) => issue('notice', msg);
export const warning = (msg) => issue('warning', msg);
export const error = (msg) => issue('error', msg);
export const mask = (value) => {
  if (value) issue('add-mask', value);
};
export const startGroup = (name) => issue('group', name);
export const endGroup = () => issue('endgroup');

export function setFailed(msg) {
  error(msg);
  process.exitCode = 1;
}

function appendFile(envVar, text) {
  const file = process.env[envVar];
  if (!file) return false;
  fs.appendFileSync(file, text, 'utf8');
  return true;
}

export function setOutput(name, value) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  // Heredoc form, so multi-line values survive.
  const delim = `ghadelimiter_${name}_${v.length}`;
  if (!appendFile('GITHUB_OUTPUT', `${name}<<${delim}\n${v}\n${delim}\n`)) {
    issue(`set-output name=${name}`, v);
  }
}

export function appendSummary(markdown) {
  appendFile('GITHUB_STEP_SUMMARY', `${markdown}\n`);
}

const envName = (name) => `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;

export function getInput(name, fallback = '') {
  const raw = process.env[envName(name)];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  return trimmed === '' ? fallback : trimmed;
}

export function getBool(name, fallback = false) {
  const v = getInput(name, '');
  if (v === '') return fallback;
  if (/^(true|1|yes|on)$/i.test(v)) return true;
  if (/^(false|0|no|off)$/i.test(v)) return false;
  throw new Error(`Input "${name}" must be a boolean, got "${v}"`);
}

export function getNumber(name, fallback) {
  const v = getInput(name, '');
  if (v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Input "${name}" must be a number, got "${v}"`);
  return n;
}

/** Newline-separated values — for globs, which may legitimately contain commas. */
export const getLines = (name) =>
  getInput(name, '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));

/** Comma or newline separated values. */
export const getCsv = (name, fallback = '') =>
  getInput(name, fallback)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Bounded-concurrency map that preserves input order. */
export async function pmap(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
