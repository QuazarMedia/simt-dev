// Where a repository's hidden test patches live.
//
// The vault is outside every checkout on purpose: a container of test patches a
// bench run is graded against must not be readable from the workspace it is measuring.
// It is keyed on the repository's root commit, which is identical in every clone and
// survives remote renames, so the corpus a bench was mined from is found on another
// machine (review 0003 Q48: an absolute-path key made the committed corpus unrunnable
// from any other checkout).
//
// This lives under `src/testing/` because the map measures recall against the same
// patches and the index asks whether a path is a test — neither of them runs a benchmark
// (review 0003 Q79).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir, platform as osPlatform } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { CONFIG_DIR } from '../name.mjs';

/**
 * The stable identity a repository's vault is keyed on: the basename for a
 * human-readable prefix, and the root commit for the digest. Outside git it degrades to
 * the absolute-path digest: a root with no history has no better identity, and the vault
 * path must never fail because git is absent.
 */
function repoIdentifier(root) {
  const full = resolve(root);
  const name = basename(full).replace(/[^A-Za-z0-9._-]/g, '-') || 'repo';
  try {
    const sha = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .split(/\s/)[0];
    if (/^[0-9a-f]{40}$/.test(sha)) return `${name}-root-${sha.slice(0, 8)}`;
  } catch {
    // Not a git root (or no commits): fall through to the path digest.
  }
  const digest = createHash('sha256').update(full).digest('hex').slice(0, 8);
  return `${name}-${digest}`;
}

/**
 * Resolve the hidden verifier vault root outside every worktree.
 *
 * Precedence:
 *   1. `SIMT_DEV_VAULT_DIR` (explicit override for hermetic tests)
 *   2. `$XDG_CACHE_HOME/simt-dev/vault/<repo-id>`
 *   3. `~/Library/Caches/simt-dev/vault/<repo-id>` on macOS, or `~/.cache/simt-dev/vault/<repo-id>`
 *
 * @param {string} root
 * @param {{env?: NodeJS.ProcessEnv, home?: string, platform?: string}} [options]
 * @returns {string}
 */
export function resolveVaultDir(root, { env = process.env, home = homedir(), platform = osPlatform() } = {}) {
  const repoId = repoIdentifier(root);
  if (env.SIMT_DEV_VAULT_DIR) {
    return join(resolve(env.SIMT_DEV_VAULT_DIR), repoId);
  }
  const cacheBase = env.XDG_CACHE_HOME
    ? resolve(env.XDG_CACHE_HOME)
    : platform === 'darwin'
      ? join(home, 'Library', 'Caches')
      : join(home, '.cache');
  return join(cacheBase, CONFIG_DIR, 'vault', repoId);
}
