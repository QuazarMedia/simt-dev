// Where the workspace is, and how to be sure.
//
// The workspace is the directory that CONTAINS repositories. It is not the same thing as a
// repository, and it is not required: a single repo with no workspace is a normal, supported
// case (ADR-014). What the workspace provides is the *sibling* relationship - it is how
// `graph/skills.graph.json`'s `repo/path` sources resolve, and how `compare` finds the rest of
// the estate.
//
// Three real failure modes motivated this module, all measured rather than reasoned about:
//
//   1. `resolve(HERE, '..', '..', '..')` is correct in the checkout and wrong in node_modules,
//      where it lands inside `node_modules/@quazarmedia`. Every `skills` command then fails
//      with ENOENT for all 38 sources.
//   2. A single repo passed to `compare` was reported as "contains no git repositories",
//      because discovery scanned the CHILDREN of the given path.
//   3. The published package shipped no `docs/`, so `rules why` could not resolve a single ADR.
//
// The fix is not a cleverer heuristic. It is: resolve from explicit configuration, fall back to
// the heuristic only when it verifies, and report which one answered. A silent fallback to the
// wrong directory is worse than no answer at all, because every downstream answer is then
// confidently wrong.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * The package root. Here that is ONE level up from `src/`, not two - and getting
 * it wrong silently shifts the workspace heuristic by a whole directory, which is
 * why it is a named constant rather than an inline expression.
 */
export const PACKAGE_ROOT = resolve(HERE, '..');

export const CONFIG_DIR = 'simt-dev';
export const CONFIG_FILE = 'config.json';

/**
 * Candidate config paths, most explicit first.
 *
 * `$XDG_CONFIG_HOME` comes first on every platform because it is the only way to *override* the
 * location on a POSIX system, and honouring an explicit override before guessing is the entire
 * point. macOS is listed after it because `~/Library/Application Support` is Apple's documented
 * location for application data, but a developer who already exports XDG_CONFIG_HOME should not
 * have to also move the file. Both conventions are therefore supported, and which one is in use
 * is reported rather than assumed.
 *
 * Windows is listed although ADR-012 drops Windows support. Keeping the function total makes it
 * testable on any host and correct if that ruling is ever reversed; `package.json` still refuses
 * to install on Windows.
 *
 * @returns {string[]}
 *
 * `env` defaults to `process.env`, NOT to an empty object. An earlier version
 * defaulted to `{}` so that a test could pass a fake environment, and the result was
 * that `XDG_CONFIG_HOME` - the one documented way to OVERRIDE the config location -
 * was silently ignored on every real invocation. Every unit test passed `{env}`
 * explicitly, so nothing caught it; only running the CLI did. The default is part of
 * this function's contract, not a convenience.
 */
export function configPaths({ env = process.env, platform = osPlatform(), home = homedir() } = {}) {
  const candidates = [];
  const push = (p) => {
    if (p && !candidates.includes(p)) candidates.push(p);
  };

  if (env.XDG_CONFIG_HOME) push(join(env.XDG_CONFIG_HOME, CONFIG_DIR, CONFIG_FILE));
  push(join(home, '.config', CONFIG_DIR, CONFIG_FILE));
  if (platform === 'darwin') {
    push(join(home, 'Library', 'Application Support', CONFIG_DIR, CONFIG_FILE));
  }
  if (platform === 'win32') {
    const base = env.APPDATA ?? join(home, 'AppData', 'Roaming');
    push(join(base, CONFIG_DIR, CONFIG_FILE));
  }
  return candidates;
}

/**
 * Read the user config, if there is one.
 *
 * An absent file is not an error: it means "not configured", and resolution continues down the
 * precedence list. Only a file that EXISTS and does not parse is an error, because that is a
 * real mistake the reader can fix - and silently ignoring it would send them looking for a
 * configuration problem in the wrong place.
 */
export async function readUserConfig(options = {}) {
  const searched = configPaths(options);
  for (const path of searched) {
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(text);
      return { path, exists: true, config: parsed ?? {}, error: null, searched };
    } catch (error) {
      return { path, exists: true, config: {}, error: `unparseable JSON (${error.message})`, searched };
    }
  }
  return { path: null, exists: false, config: {}, error: null, searched };
}

/**
 * Does this directory contain at least one git repository? The heuristic is only accepted when
 * it verifies, which is what stops a stray `node_modules` parent from being silently believed.
 */
async function looksLikeWorkspace(dir) {
  const { readdir } = await import('node:fs/promises');
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules') continue;
    if (existsSync(join(dir, entry.name, '.git'))) return true;
  }
  return false;
}

/**
 * Resolve the workspace.
 *
 * Precedence, highest first: `--workspace`, `SIMT_DEV_WORKSPACE`, the user config file, then the
 * sibling heuristic of this package - and that last one only if it actually contains a git
 * repository.
 *
 * @returns {Promise<{root: string|null, source: string, detail: string, searched: string[], error: string|null}>}
 */
export async function resolveWorkspace(flags = {}, options = {}) {
  const env = options.env ?? process.env;
  const searched = configPaths(options);

  // The config file is read FIRST, before precedence is applied, and a parse failure
  // is reported immediately. That is deliberate: precedence decides which *answer*
  // wins, but a config file that exists and does not parse is a defect in the
  // reader's setup, and hiding it because some other source outranked it would send
  // them looking for a configuration problem in the wrong place.
  const user = await readUserConfig(options);
  if (user.error) {
    return { root: null, source: 'config', detail: user.path, searched, error: user.error };
  }

  // Only `--workspace` counts here. `--root` names a REPOSITORY, and a repository
  // is not its own parent, so treating one as the other would resolve every
  // `repo/path` source one directory too low - a wrong answer that reads as right.
  const flag = flags.workspace;
  if (flag) {
    return (
      disabled(flag, 'flag', '--workspace', searched) ?? {
        root: absolute(flag),
        source: 'flag',
        detail: '--workspace',
        searched,
        error: null,
      }
    );
  }

  if (env.SIMT_DEV_WORKSPACE) {
    return (
      disabled(env.SIMT_DEV_WORKSPACE, 'env', 'SIMT_DEV_WORKSPACE', searched) ?? {
        root: absolute(env.SIMT_DEV_WORKSPACE),
        source: 'env',
        detail: 'SIMT_DEV_WORKSPACE',
        searched,
        error: null,
      }
    );
  }

  if (user.exists && typeof user.config.workspace === 'string' && user.config.workspace.length > 0) {
    return (
      disabled(user.config.workspace, 'config', user.path, searched) ?? {
        root: absolute(user.config.workspace),
        source: 'config',
        detail: user.path,
        searched,
        error: null,
      }
    );
  }

  const parent = resolve(PACKAGE_ROOT, '..');
  if (await looksLikeWorkspace(parent)) {
    return { root: parent, source: 'heuristic', detail: 'sibling of this package', searched, error: null };
  }

  return {
    root: null,
    source: 'none',
    detail: 'no workspace configured',
    searched,
    error: null,
  };
}

/** Values that mean "there is deliberately no workspace", from any source. */
const OFF = new Set(['off', 'none', 'no', '0', '-']);

/**
 * The sentinel. Without it there is no way to *decline* the sibling heuristic, so a
 * reader who does not want a directory guessed for them cannot say so - and no test
 * running from this checkout can reach the unconfigured path at all. `off` is
 * returned from any source and takes the same shape as any other answer, so callers
 * need no special case for it.
 */
function disabled(value, source, detail, searched) {
  return OFF.has(String(value).trim().toLowerCase())
    ? {
        root: null,
        source: 'disabled',
        detail: `${detail}=off (workspace declined)`,
        searched: searched ?? [],
        error: null,
      }
    : null;
}

/**
 * The one-line remedy every workspace-dependent failure prints.
 *
 * Built from this machine's OWN candidate list rather than a hardcoded example, because a
 * remedy that names a path the reader does not have is a second problem stacked on the first.
 * Index 0 is the right one to name: on POSIX that is `$XDG_CONFIG_HOME/...` when set and
 * `$HOME/.config/...` when not, which is the path the reader most likely already expects.
 */
// The remedy is a phrase, not a sentence: several callers embed it after their own
// lead-in ("workspace none configured - <here>"), so it must not start with one.
export const WORKSPACE_REMEDY = (() => {
  const first = configPaths()[0];
  const where = first ?? join('$HOME', '.config', CONFIG_DIR, CONFIG_FILE);
  return `--workspace <path>, the SIMT_DEV_WORKSPACE environment variable, or ${where}`;
})();

function absolute(p) {
  const expanded = p.startsWith('~/')
    ? join(homedir(), p.slice(2))
    : p;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/**
 * The workspace, or null. Callers that can degrade use this and report `source: 'none'`;
 * callers that genuinely cannot proceed should use `resolveWorkspace` and fail with its detail.
 */
export async function workspaceOrNull(flags = {}, options = {}) {
  const { root, error } = await resolveWorkspace(flags, options);
  return error ? null : root;
}