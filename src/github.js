import * as core from './core.js';

const USER_AGENT = 'commitreview';

export class HttpError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class GitHub {
  constructor(token, { apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com', retries = 3 } = {}) {
    this.token = token;
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.retries = retries;
  }

  /**
   * @param {string} method
   * @param {string} path absolute URL or a path relative to the API root
   * @param {{body?: any, accept?: string, raw?: boolean}} [options]
   */
  async request(method, path, { body, accept = 'application/vnd.github+json', raw = false } = {}) {
    const url = path.startsWith('http') ? path : `${this.apiUrl}${path}`;
    let lastError;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            accept,
            'x-github-api-version': '2022-11-28',
            'user-agent': USER_AGENT,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(60000),
        });
      } catch (err) {
        lastError = err;
        if (attempt === this.retries) break;
        await core.sleep(backoff(attempt));
        continue;
      }

      if (res.ok) {
        const text = await res.text();
        const payload = raw || !text ? text : safeJson(text);
        return { data: payload, headers: res.headers, status: res.status };
      }

      const text = await res.text().catch(() => '');
      const retryable = res.status === 429 || res.status >= 500 || isSecondaryRateLimit(res, text);
      if (!retryable || attempt === this.retries) {
        throw new HttpError(res.status, `${method} ${path} failed: ${res.status} ${truncate(text, 400)}`, text);
      }
      const after = Number(res.headers.get('retry-after'));
      await core.sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : backoff(attempt));
    }

    throw new HttpError(0, `${method} ${path} failed: ${lastError?.message || 'network error'}`);
  }

  async paginate(path, { max = 1000 } = {}) {
    const out = [];
    let next = `${path}${path.includes('?') ? '&' : '?'}per_page=100`;
    while (next && out.length < max) {
      const { data, headers } = await this.request('GET', next);
      if (!Array.isArray(data)) break;
      out.push(...data);
      next = parseNextLink(headers.get('link'));
    }
    return out;
  }

  getPull(owner, repo, number) {
    return this.request('GET', `/repos/${owner}/${repo}/pulls/${number}`).then((r) => r.data);
  }

  /**
   * The diff media type refuses to generate very large diffs (406). Those are
   * exactly the pull requests where a review is worth most, so fall back to the
   * files endpoint and rebuild a unified diff from the per-file patches.
   */
  async getPullDiff(owner, repo, number) {
    try {
      const { data } = await this.request('GET', `/repos/${owner}/${repo}/pulls/${number}`, {
        accept: 'application/vnd.github.v3.diff',
        raw: true,
      });
      if (data) return data;
      core.warning('The diff endpoint returned nothing; rebuilding from the files endpoint.');
    } catch (err) {
      if (!(err instanceof HttpError) || ![406, 422, 500, 502, 503].includes(err.status)) throw err;
      core.warning(`Diff endpoint returned ${err.status}; rebuilding from the files endpoint.`);
    }
    const files = await this.paginate(`/repos/${owner}/${repo}/pulls/${number}/files`, { max: 3000 });
    return files.map(fileToDiff).join('');
  }

  /** Raw file content at a ref, or null when it does not exist there. */
  async getFileContent(owner, repo, path, ref) {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    try {
      const { data } = await this.request(
        'GET',
        `/repos/${owner}/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
        { accept: 'application/vnd.github.raw', raw: true },
      );
      return typeof data === 'string' ? data : null;
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 403)) return null;
      throw err;
    }
  }

  listReviewComments(owner, repo, number) {
    return this.paginate(`/repos/${owner}/${repo}/pulls/${number}/comments`);
  }

  listIssueComments(owner, repo, number) {
    return this.paginate(`/repos/${owner}/${repo}/issues/${number}/comments`);
  }

  createReview(owner, repo, number, review) {
    return this.request('POST', `/repos/${owner}/${repo}/pulls/${number}/reviews`, { body: review }).then(
      (r) => r.data,
    );
  }

  createIssueComment(owner, repo, number, body) {
    return this.request('POST', `/repos/${owner}/${repo}/issues/${number}/comments`, { body: { body } }).then(
      (r) => r.data,
    );
  }

  updateIssueComment(owner, repo, commentId, body) {
    return this.request('PATCH', `/repos/${owner}/${repo}/issues/comments/${commentId}`, { body: { body } }).then(
      (r) => r.data,
    );
  }

  /** Review comments and issue comments live under different reaction paths. */
  async addReaction(owner, repo, commentId, { isReviewComment = false, content = 'eyes' } = {}) {
    const scope = isReviewComment ? 'pulls' : 'issues';
    try {
      await this.request('POST', `/repos/${owner}/${repo}/${scope}/comments/${commentId}/reactions`, {
        body: { content },
      });
    } catch {
      // Purely cosmetic acknowledgement — never fail a review over it.
    }
  }
}

/**
 * Rebuild one file's section of a unified diff from a pulls/files entry, so the
 * normal parser can consume it. Files with no patch (binary, or too large for
 * GitHub to render) still get a header, which keeps them visible as skipped.
 */
export function fileToDiff(file) {
  const newPath = file.filename;
  const oldPath = file.previous_filename || file.filename;
  // git quotes the whole prefixed path, not the path inside the prefix.
  const quote = (p) => (/[\s"\\]/.test(p) ? JSON.stringify(p) : p);
  const a = quote(`a/${oldPath}`);
  const b = quote(`b/${newPath}`);
  const lines = [`diff --git ${a} ${b}`];

  if (file.status === 'added') lines.push('new file mode 100644');
  else if (file.status === 'removed') lines.push('deleted file mode 100644');
  else if (file.status === 'renamed') lines.push(`rename from ${quote(oldPath)}`, `rename to ${quote(newPath)}`);

  if (!file.patch) {
    lines.push(`Binary files ${a} and ${b} differ`);
    return `${lines.join('\n')}\n`;
  }

  lines.push(
    file.status === 'added' ? '--- /dev/null' : `--- ${a}`,
    file.status === 'removed' ? '+++ /dev/null' : `+++ ${b}`,
    file.patch.replace(/\n$/, ''),
  );
  return `${lines.join('\n')}\n`;
}

function parseNextLink(link) {
  if (!link) return null;
  const m = /<([^>]+)>;\s*rel="next"/.exec(link);
  return m ? m[1] : null;
}

function isSecondaryRateLimit(res, text) {
  return res.status === 403 && /secondary rate limit|abuse detection/i.test(text);
}

function backoff(attempt) {
  return Math.min(30000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
