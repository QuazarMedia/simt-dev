// The one git runner (Q72).
//
// Thirty modules imported `child_process` and grew their own `git()`: some threw, some
// returned null, some trimmed, some split on NUL, and each of them decided for itself
// whether `core.quotePath` was the caller's problem. The copies disagreed in ways that
// only showed up on a path with a non-ASCII byte in it.
//
// Three verbs, and the difference between them is the return type, not the flags:
// `git` answers the raw stdout, `gitText` answers it trimmed or null, and `gitPaths`
// answers NUL-separated paths. `allowFailure` is explicit because "this repository is not
// a git repository" is sometimes an answer and sometimes an error, and only the caller
// knows which.

import { execFile } from 'node:child_process';

/** How much stdout one git call may buffer before the call is refused. */
const GIT_MAX_BUFFER = 32 << 20;

/** A failed git call, carrying the arguments and git's own stderr.
 *  `stdout` is kept too: a call that fails part-way (a `diff` in a tree with no HEAD)
 *  can still have printed, and a caller that salvages the partial output must not lose
 *  it to the wrap. */
class GitError extends Error {
  constructor(args, cause) {
    const stderr = String(cause?.stderr ?? '').trim();
    super(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
    this.name = 'GitError';
    this.args = args;
    this.stderr = stderr;
    this.stdout = cause?.stdout;
    this.code = cause?.code;
  }
}

/**
 * Run git in `root` and answer stdout.
 *
 * `core.quotePath=false` is set on every call so a path with a non-ASCII byte comes back
 * as itself; the copies that relied on a caller remembering `-z` did not.
 *
 * @param {string} root
 * @param {string[]} args
 * @param {{allowFailure?: boolean, maxBuffer?: number, input?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<string|null>} stdout, or null when `allowFailure` and the call failed
 */
export function git(
  root,
  args,
  { allowFailure = false, maxBuffer = GIT_MAX_BUFFER, input, env = process.env } = {},
) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotePath=false', ...args],
      { cwd: root, encoding: 'utf8', maxBuffer, env },
      (error, stdout, stderr) => {
        if (error) {
          if (allowFailure) resolve(null);
          else reject(new GitError(args, Object.assign(error, { stderr })));
          return;
        }
        resolve(stdout);
      },
    );
    // `execFile` has no `input` option and leaves stdin a pipe: a child like `hash-object
    // --stdin` waits for an EOF that never comes, so the call hangs rather than fails.
    if (input !== undefined) child.stdin.end(input);
  });
}

/** stdout trimmed, or null when `allowFailure` and the call failed. */
export async function gitText(root, args, options = {}) {
  const stdout = await git(root, args, options);
  return stdout === null ? null : stdout.trim();
}

/** NUL-separated stdout split into paths. `-z` is added here, so a caller cannot forget it. */
export async function gitPaths(root, args, options = {}) {
  const stdout = await git(root, [...args, '-z'], options);
  if (stdout === null) return null;
  return stdout.split('\0').filter(Boolean);
}
