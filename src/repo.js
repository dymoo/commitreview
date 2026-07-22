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
import { execFile } from 'node:child_process';
import * as core from './core.js';

const MAX_TARBALL_BYTES = 300 * 1024 * 1024;

/**
 * @typedef {object} Repo
 * @property {string} kind
 * @property {() => Promise<string[]>} list repository-relative paths
 * @property {(p: string) => Promise<string|null>} read
 */

/** @returns {Promise<Repo|null>} */
export async function openRepo(gh, { owner, repo, sha, config }) {
  if (config.repoContext === 'off') return null;
  try {
    return await tarballRepo(gh, owner, repo, sha);
  } catch (err) {
    core.warning(`Could not fetch the repository archive (${err.message}); falling back to the contents API.`);
    return apiRepo(gh, owner, repo, sha);
  }
}

async function tarballRepo(gh, owner, repo, sha) {
  const dir = await fsp.mkdtemp(path.join(process.env.RUNNER_TEMP || process.env.TMPDIR || '/tmp', 'commitreview-'));
  const archive = path.join(dir, 'repo.tar.gz');

  const { data, size } = await gh.downloadTarball(owner, repo, sha, MAX_TARBALL_BYTES);
  await fsp.writeFile(archive, data);
  await extract(archive, dir);
  await fsp.rm(archive, { force: true });

  // GitHub wraps everything in a single `owner-repo-sha` directory.
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const top = entries.find((e) => e.isDirectory());
  if (!top) throw new Error('archive contained no directory');
  const root = path.join(dir, top.name);
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
      // Never let a path escape the extracted root.
      const full = path.resolve(root, rel);
      if (!full.startsWith(root + path.sep)) return null;
      try {
        return await fsp.readFile(full, 'utf8');
      } catch {
        return null;
      }
    },
  };
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
      if (!contents.has(rel)) contents.set(rel, await gh.getFileContent(owner, repo, rel, sha));
      return contents.get(rel);
    },
  };
}
