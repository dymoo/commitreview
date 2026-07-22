/**
 * Unified-diff parsing and comment anchoring.
 *
 * Anchoring is where tools like this break: GitHub rejects the whole review with
 * a 422 if any comment names a (path, line, side) that is not part of the diff.
 * So every model claim goes through `anchorFinding`, which either produces a
 * position GitHub will accept or returns null — and the caller demotes the
 * finding to the summary rather than dropping it.
 *
 * @typedef {{ type: ' '|'+'|'-', oldLine: number|null, newLine: number|null, text: string }} DiffLine
 * @typedef {{ oldStart: number, oldLines: number, newStart: number, newLines: number, section: string, lines: DiffLine[] }} Hunk
 * @typedef {{ path: string, oldPath: string|null, status: string, binary: boolean, hunks: Hunk[],
 *             additions: number, deletions: number,
 *             rightLines: Map<number, {type: string, hunk: number}>,
 *             leftLines: Map<number, {type: string, hunk: number}> }} DiffFile
 */

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.*))?$/;

/** @returns {DiffFile[]} */
export function parseDiff(text) {
  /** @type {DiffFile[]} */
  const files = [];
  const lines = String(text || '').split('\n');

  /** @type {DiffFile|null} */
  let file = null;
  /** @type {Hunk|null} */
  let hunk = null;
  let oldRemaining = 0;
  let newRemaining = 0;
  let oldCursor = 0;
  let newCursor = 0;

  const closeFile = () => {
    if (file) files.push(finalize(file));
    file = null;
    hunk = null;
    oldRemaining = newRemaining = 0;
  };

  for (const line of lines) {
    // Inside a hunk we trust the declared line counts rather than the line
    // prefixes, so diff-of-a-diff content cannot be mistaken for a new header.
    if (hunk && (oldRemaining > 0 || newRemaining > 0)) {
      const c = line[0];
      if (c === '+') {
        hunk.lines.push({ type: '+', oldLine: null, newLine: newCursor++, text: line.slice(1) });
        newRemaining--;
        file.additions++;
        continue;
      }
      if (c === '-') {
        hunk.lines.push({ type: '-', oldLine: oldCursor++, newLine: null, text: line.slice(1) });
        oldRemaining--;
        file.deletions++;
        continue;
      }
      if (c === '\\') continue; // "\ No newline at end of file"
      if (c === ' ' || line === '') {
        hunk.lines.push({ type: ' ', oldLine: oldCursor++, newLine: newCursor++, text: line.slice(1) });
        oldRemaining--;
        newRemaining--;
        continue;
      }
      // Counts disagree with reality — stop trusting them and reparse as header.
      oldRemaining = newRemaining = 0;
    }

    if (line.startsWith('diff --git ')) {
      closeFile();
      file = blankFile();
      const guess = guessPathsFromGitHeader(line);
      file.path = guess.newPath || guess.oldPath || '';
      file.oldPath = guess.oldPath;
      continue;
    }

    if (!file) continue;

    if (line.startsWith('--- ')) {
      const p = stripPrefix(line.slice(4));
      if (p === null) file.status = 'added';
      else file.oldPath = p;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = stripPrefix(line.slice(4));
      if (p === null) file.status = 'deleted';
      else file.path = p;
      continue;
    }
    if (line.startsWith('new file mode')) {
      file.status = 'added';
      file.oldPath = null;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      file.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      file.status = 'renamed';
      file.oldPath = unquotePath(line.slice('rename from '.length));
      continue;
    }
    if (line.startsWith('rename to ')) {
      file.status = 'renamed';
      file.path = unquotePath(line.slice('rename to '.length));
      continue;
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      file.binary = true;
      continue;
    }

    const m = HUNK_RE.exec(line);
    if (m) {
      hunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        section: m[5] || '',
        lines: [],
      };
      oldCursor = hunk.oldStart;
      newCursor = hunk.newStart;
      oldRemaining = hunk.oldLines;
      newRemaining = hunk.newLines;
      file.hunks.push(hunk);
    }
  }

  closeFile();
  return files.filter((f) => f.path);
}

function blankFile() {
  return {
    path: '',
    oldPath: null,
    status: 'modified',
    binary: false,
    hunks: [],
    additions: 0,
    deletions: 0,
    rightLines: new Map(),
    leftLines: new Map(),
  };
}

/** @param {DiffFile} file */
function finalize(file) {
  file.hunks.forEach((h, hi) => {
    for (const l of h.lines) {
      if (l.newLine !== null) file.rightLines.set(l.newLine, { type: l.type, hunk: hi });
      if (l.oldLine !== null) file.leftLines.set(l.oldLine, { type: l.type, hunk: hi });
    }
  });
  return file;
}

/** `--- a/foo` → `foo`; `/dev/null` → null. */
function stripPrefix(raw) {
  const path = unquotePath(raw.replace(/\t.*$/, '').trim());
  if (path === '/dev/null') return null;
  return path.replace(/^[ab]\//, '');
}

function guessPathsFromGitHeader(line) {
  const rest = line.slice('diff --git '.length);
  // Quoted form is unambiguous; the unquoted form is only ambiguous for paths
  // containing " b/", which git quotes anyway when it matters.
  const quoted = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(rest);
  if (quoted) {
    return {
      oldPath: unquotePath(quoted[1]).replace(/^a\//, ''),
      newPath: unquotePath(quoted[2]).replace(/^b\//, ''),
    };
  }
  const idx = rest.indexOf(' b/');
  if (idx === -1) return { oldPath: null, newPath: null };
  return {
    oldPath: rest.slice(0, idx).replace(/^a\//, ''),
    newPath: rest.slice(idx + 3),
  };
}

/** Undo git's C-style quoting of paths with special or non-ASCII characters. */
export function unquotePath(p) {
  if (!(p.startsWith('"') && p.endsWith('"') && p.length >= 2)) return p;
  const body = p.slice(1, -1);
  const bytes = [];
  const simple = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '\\': 92, '"': 34 };
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      bytes.push(...Buffer.from(body[i], 'utf8'));
      continue;
    }
    const c = body[++i];
    if (c >= '0' && c <= '7') {
      bytes.push(parseInt(body.slice(i, i + 3), 8) & 0xff);
      i += 2;
    } else {
      bytes.push(simple[c] ?? c.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Text of a specific line as it appears in the diff, used for fingerprinting. */
export function lineText(file, side, line) {
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (side === 'LEFT' ? l.oldLine === line : l.newLine === line) return l.text;
    }
  }
  return '';
}

/**
 * Turn a model finding into a position GitHub will accept, or null.
 *
 * @param {{path: string, line: number, side?: string, start_line?: number|null}} finding
 * @param {DiffFile} file
 * @param {{snap?: number}} [opts] snap: how far to search for a nearby valid line
 * @returns {{path: string, line: number, side: 'LEFT'|'RIGHT', start_line?: number, start_side?: string, snapped?: boolean}|null}
 */
export function anchorFinding(finding, file, { snap = 3 } = {}) {
  if (!file || file.binary || file.hunks.length === 0) return null;

  const requested = Number(finding.line);
  if (!Number.isInteger(requested) || requested < 1) return null;

  /** @type {'LEFT'|'RIGHT'} */
  let side = String(finding.side || 'RIGHT').toUpperCase() === 'LEFT' ? 'LEFT' : 'RIGHT';
  // A pure deletion has no right-hand side at all; take the model's intent.
  if (side === 'RIGHT' && file.rightLines.size === 0 && file.leftLines.size > 0) side = 'LEFT';

  let resolved = resolveLine(file, side, requested, snap);
  if (!resolved && file.status === 'modified') {
    const other = side === 'RIGHT' ? 'LEFT' : 'RIGHT';
    const alt = resolveLine(file, other, requested, 0);
    if (alt) {
      resolved = alt;
      side = other;
    }
  }
  if (!resolved) return null;

  /** @type {{path: string, line: number, side: 'LEFT'|'RIGHT', start_line?: number, start_side?: string, snapped?: boolean}} */
  const out = {
    path: file.path,
    line: resolved.line,
    side,
    ...(resolved.line !== requested ? { snapped: true } : {}),
  };

  const start = Number(finding.start_line);
  if (Number.isInteger(start) && start > 0 && start < resolved.line) {
    const map = side === 'LEFT' ? file.leftLines : file.rightLines;
    const entry = map.get(start);
    if (entry && entry.hunk === resolved.hunk) {
      out.start_line = start;
      out.start_side = side;
    }
  }
  return out;
}

function resolveLine(file, side, requested, snap) {
  const map = side === 'LEFT' ? file.leftLines : file.rightLines;
  const hit = map.get(requested);
  if (hit) return { line: requested, hunk: hit.hunk };
  if (snap <= 0) return null;

  // Only snap when the line plausibly belongs to a hunk we actually have —
  // a hallucinated line 900 in a file whose hunks cover 1..50 must be dropped,
  // not silently relocated to line 50.
  const near = file.hunks.some((h) => {
    const start = side === 'LEFT' ? h.oldStart : h.newStart;
    const count = side === 'LEFT' ? h.oldLines : h.newLines;
    return requested >= start - snap && requested <= start + count - 1 + snap;
  });
  if (!near) return null;

  const changed = side === 'LEFT' ? '-' : '+';
  for (const wantChanged of [true, false]) {
    for (let d = 1; d <= snap; d++) {
      for (const candidate of [requested - d, requested + d]) {
        const entry = map.get(candidate);
        if (!entry) continue;
        if (wantChanged && entry.type !== changed) continue;
        return { line: candidate, hunk: entry.hunk };
      }
    }
  }
  return null;
}
