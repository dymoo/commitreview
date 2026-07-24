/**
 * Context assembly: decide what the model sees.
 *
 * Two jobs. Filtering keeps generated noise out of the review. Rendering shows
 * each hunk widened with real surrounding source, pulled from the head commit,
 * with explicit old/new line numbers on every row — that numbering is what makes
 * the model's line references land where `anchorFinding` can accept them.
 * Widened rows are marked `~` and are deliberately *not* commentable.
 */

/** ponytail: chars/4 is close enough for budgeting; swap in a real tokenizer only if truncation starts biting. */
export const estimateTokens = (text) => Math.ceil(text.length / 4);

const globCache = new Map();

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchGlob(path, glob) {
  let re = globCache.get(glob);
  if (!re) {
    re = globToRegExp(glob);
    globCache.set(glob, re);
  }
  if (re.test(path)) return true;
  // gitignore-style convenience: a pattern with no slash also matches basenames.
  return !glob.includes('/') && re.test(path.slice(path.lastIndexOf('/') + 1));
}

export const matchAny = (path, globs) => globs.some((g) => matchGlob(path, g));

/**
 * @param {import('./diff.js').DiffFile[]} files
 * @returns {{selected: import('./diff.js').DiffFile[], skipped: {path: string, reason: string}[]}}
 */
export function selectFiles(files, config) {
  const selected = [];
  const skipped = [];
  for (const file of files) {
    if (file.binary) {
      skipped.push({ path: file.path, reason: 'binary' });
      continue;
    }
    if (file.hunks.length === 0) {
      skipped.push({ path: file.path, reason: 'no textual changes' });
      continue;
    }
    if (matchAny(file.path, config.ignore)) {
      skipped.push({ path: file.path, reason: 'ignored' });
      continue;
    }
    if (selected.length >= config.maxFiles) {
      skipped.push({ path: file.path, reason: `over max-files (${config.maxFiles})` });
      continue;
    }
    selected.push(file);
  }
  return { selected, skipped };
}

const splitLines = (content) => content.split('\n');

function fileHeader(file) {
  const renamed = file.oldPath && file.oldPath !== file.path ? ` (renamed from ${file.oldPath})` : '';
  return `FILE: ${file.path}${renamed} [${file.status}, +${file.additions} -${file.deletions}]`;
}

function buildGroups(file, newLines, contextLines) {
  if (!newLines || contextLines === 0) {
    return file.hunks.map((h) => ({
      start: h.newStart,
      end: h.newStart + h.newLines - 1,
      rows: h.lines.map((l) => ({ old: l.oldLine, new: l.newLine, mark: l.type, text: l.text })),
    }));
  }

  const total = newLines.length;
  const ranges = file.hunks.map((h, i) => ({
    hunks: [i],
    start: Math.max(1, h.newStart - contextLines),
    end: Math.min(total, h.newStart + h.newLines - 1 + contextLines),
  }));

  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 1) {
      last.end = Math.max(last.end, r.end);
      last.hunks.push(...r.hunks);
    } else {
      merged.push({ ...r, hunks: [...r.hunks] });
    }
  }

  return merged.map((range) => ({ ...range, rows: rowsFor(file, newLines, range) }));
}

function rowsFor(file, newLines, range) {
  const rows = [];
  let cursor = range.start;
  let lastOldEnd = null;

  for (const hi of range.hunks) {
    const h = file.hunks[hi];
    for (let n = cursor; n < h.newStart; n++) {
      if (n < 1 || n > newLines.length) continue;
      // Unchanged region: old/new offset is constant, so derive old from the hunk.
      rows.push({ old: h.oldStart - (h.newStart - n), new: n, mark: '~', text: newLines[n - 1] });
    }
    for (const l of h.lines) rows.push({ old: l.oldLine, new: l.newLine, mark: l.type, text: l.text });
    cursor = h.newStart + h.newLines;
    lastOldEnd = h.oldStart + h.oldLines - 1;
  }

  for (let n = cursor; n <= range.end; n++) {
    if (n < 1 || n > newLines.length) continue;
    rows.push({ old: lastOldEnd + (n - cursor + 1), new: n, mark: '~', text: newLines[n - 1] });
  }
  return rows;
}

const col = (n) => String(n ?? '').padStart(6, ' ');

export function renderRows(rows) {
  return rows.map((r) => `${col(r.old)} ${col(r.new)} ${r.mark} ${r.text}`).join('\n');
}

/**
 * Render one file into one or more text blocks, each within `chunkTokens`.
 * @returns {{path: string, text: string, tokens: number}[]}
 */
export function renderFile(file, content, config) {
  const newLines = content === null || content === undefined ? null : splitLines(content);
  const groups = buildGroups(file, newLines, config.contextLines);
  const header = fileHeader(file);

  const sections = groups.map((g) => `@@ new lines ${g.start}-${g.end} @@\n${renderRows(g.rows)}`);
  const blocks = [];
  let current = [];
  let currentTokens = 0;
  const budget = Math.max(1, config.chunkTokens - estimateTokens(header) - 32);

  const flush = () => {
    if (!current.length) return;
    const text = `${header}${blocks.length ? ` (continued)` : ''}\n${current.join('\n\n')}`;
    blocks.push({ path: file.path, text, tokens: estimateTokens(text) });
    current = [];
    currentTokens = 0;
  };

  for (const section of sections) {
    const t = estimateTokens(section);
    if (t > budget) {
      // One hunk larger than a whole request: keep the head of it and say so.
      flush();
      const suffix = `… hunk truncated (${t - budget} tokens dropped) …`;
      const prefix = `${header} (continued)\n`;
      const keep = Math.max(
        0,
        Math.floor((config.chunkTokens - estimateTokens(prefix) - estimateTokens(suffix) - 2) * 4),
      );
      const text = `${prefix}${section.slice(0, keep)}\n${suffix}`;
      blocks.push({ path: file.path, text, tokens: estimateTokens(text) });
      continue;
    }
    if (currentTokens + t > budget) flush();
    current.push(section);
    currentTokens += t;
  }
  flush();
  return blocks;
}

/**
 * Pack rendered blocks into requests.
 * @returns {{chunks: {text: string, tokens: number, paths: string[]}[], dropped: {path: string, reason: string}[]}}
 */
export function buildChunks(rendered, config) {
  const chunks = [];
  const dropped = [];
  const droppedPaths = new Set();
  let spent = 0;
  let current = { text: '', tokens: 0, paths: [] };

  const flush = () => {
    if (current.paths.length) chunks.push(current);
    current = { text: '', tokens: 0, paths: [] };
  };

  for (const block of rendered) {
    if (spent + block.tokens > config.maxInputTokens) {
      if (!droppedPaths.has(block.path)) {
        droppedPaths.add(block.path);
        dropped.push({ path: block.path, reason: `over max-input-tokens (${config.maxInputTokens})` });
      }
      continue;
    }
    if (current.tokens + block.tokens > config.chunkTokens) flush();
    current.text += (current.text ? '\n\n' : '') + block.text;
    current.tokens += block.tokens;
    if (!current.paths.includes(block.path)) current.paths.push(block.path);
    spent += block.tokens;
  }
  flush();
  return { chunks, dropped };
}

/**
 * Keep a verifier's context small but centred on the line under review.
 * Falls back to the head of the text when the line cannot be located.
 */
export function sliceAround(text, line, maxChars = 32000) {
  if (text.length <= maxChars) return text;
  // renderRows writes "<old> <new> <marker> <source>". A RIGHT finding's line is
  // in the new column, a LEFT finding's in the old — match either, or the slice
  // silently centres on the head of the file and weakens the refutation.
  const hit = new RegExp(`^\\s*(?:\\d*\\s+${line}|${line}\\s+\\d*)\\s+[-+~ ]`, 'm').exec(text);
  const centre = hit ? hit.index : 0;
  const start = Math.max(0, centre - Math.floor(maxChars / 2));
  return `${start > 0 ? '… earlier hunks omitted …\n' : ''}${text.slice(start, start + maxChars)}`;
}
