/**
 * Read-only access to the whole repository at the head commit.
 *
 * A diff alone cannot answer the questions that matter most — what does this
 * function it calls actually return, and who else calls the thing it just
 * changed. So we fetch the repository.
 *
 * The tarball endpoint gives us every file in one request, which we extract to
 * a temp directory and read from. Nothing is ever executed, so this keeps the
 * property that makes `pull_request_target` safe here.
 *
 * We deliberately do not reuse an `actions/checkout` in the workspace: on a
 * `pull_request` event that checkout is the *merge* commit, whose file contents
 * do not match the base...head diff we are reviewing.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import * as core from './core.js';

const MAX_TARBALL_BYTES = 300 * 1024 * 1024;

/**
 * Reject anything that is not a plain repository-relative path.
 *
 * Both backends need this and for different reasons: the archive reader would
 * otherwise resolve out of its root, and the API reader builds a URL, where the
 * WHATWG parser silently collapses `..` into a different API endpoint.
 */
export function isSafeRepoPath(p) {
  if (typeof p !== 'string' || p === '') return false;
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  return !p.split('/').some((segment) => segment === '..' || segment === '.' || segment === '');
}

/**
 * @typedef {object} Repo
 * @property {string} kind
 * @property {() => Promise<string[]>} list repository-relative paths
 * @property {(p: string) => Promise<string|null>} read
 * @property {() => Promise<void>} close
 */

/** @returns {Promise<Repo>} */
export async function openRepo(gh, { owner, repo, sha }) {
  try {
    return await tarballRepo(gh, owner, repo, sha);
  } catch (err) {
    core.warning(`Could not fetch the repository archive (${err.message}); falling back to the contents API.`);
    return apiRepo(gh, owner, repo, sha);
  }
}

/** Use the API backend when only a small set of files is expected to be read. */
export function openRepoViaApi(gh, { owner, repo, sha }) {
  return apiRepo(gh, owner, repo, sha);
}

async function tarballRepo(gh, owner, repo, sha) {
  const dir = await fsp.mkdtemp(path.join(tmpdir(), 'commitreview-'));
  const archive = path.join(dir, 'repo.tar.gz');

  try {
    const { data, size } = await gh.downloadTarball(owner, repo, sha, MAX_TARBALL_BYTES);
    await fsp.writeFile(archive, data);
    await extract(archive, dir);
    await fsp.rm(archive, { force: true });

    // GitHub wraps everything in a single `owner-repo-sha` directory.
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const top = entries.find((entry) => entry.isDirectory());
    if (!top) throw new Error('archive contained no directory');
    // Resolve the root itself once: the temp directory is commonly reached
    // through a symlink (/tmp and /var on macOS), so comparing a resolved file
    // path against an unresolved root would reject every read.
    const root = await fsp.realpath(path.join(dir, top.name));
    core.info(`Repository archive extracted (${Math.round(size / 1024)} KiB).`);

    // Cache the promise, not the result: two concurrent callers must share one
    // walk rather than both starting their own.
    let listing = null;
    return {
      kind: 'archive',
      list() {
        if (!listing) listing = walk(root, root);
        return listing;
      },
      async read(rel) {
        if (!isSafeRepoPath(rel)) return null;
        const full = path.resolve(root, rel);
        if (!full.startsWith(root + path.sep)) return null;
        try {
          // A lexical check is not enough: readFile follows symlinks, and a pull
          // request can add one pointing at /proc/self/environ, which holds this
          // job's API keys. Resolve the link and re-check before reading.
          const real = await fsp.realpath(full);
          if (real !== root && !real.startsWith(root + path.sep)) {
            core.warning(`Refusing to read ${rel}: it resolves outside the repository.`);
            return null;
          }
          return await fsp.readFile(real, 'utf8');
        } catch {
          return null;
        }
      },
      close: () => removeTemp(dir),
    };
  } catch (err) {
    await removeTemp(dir);
    throw err;
  }
}

function extract(archive, into) {
  return new Promise((resolve, reject) => {
    execFile('tar', ['-xzf', archive, '-C', into], { timeout: 120000 }, (err) =>
      err ? reject(new Error(`tar failed: ${err.message}`)) : resolve(null),
    );
  });
}

async function walk(root, dir, out = []) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(root, full, out);
    else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return out;
}

/** Fallback when the archive is unavailable: one tree call, then a fetch per file. */
function apiRepo(gh, owner, repo, sha) {
  let listing = null;
  /** @type {Map<string, Promise<string|null>>} */
  const contents = new Map();
  return {
    kind: 'api',
    list() {
      if (!listing) {
        listing = gh.getTree(owner, repo, sha).then((tree) => {
          if (tree.truncated) core.warning('Repository tree was truncated by the API; context may be incomplete.');
          return (tree.tree || []).filter((n) => n.type === 'blob').map((n) => n.path);
        });
      }
      return listing;
    },
    async read(rel) {
      if (!isSafeRepoPath(rel)) return null;
      let content = contents.get(rel);
      if (!content) {
        content = gh.getFileContent(owner, repo, rel, sha);
        contents.set(rel, content);
      }
      return content;
    },
    close: () => Promise.resolve(),
  };
}

async function removeTemp(dir) {
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch (err) {
    // Cleanup failure should be visible without replacing the review result.
    core.warning(`Could not remove temporary repository ${dir}: ${err.message}`);
  }
}
