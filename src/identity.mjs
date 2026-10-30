// The per-developer git identity, as a file the repository does not track.
//
// A repository has more than one person in it, and each of them may already have an
// identity this tool has no business choosing. So the rules here are conservative in
// that order:
//
//   1. If `git.config` already exists, it is left exactly as it is. Not updated, not
//      merged, not reformatted. It may have been written by a person, by an older
//      version of this tool, or by hand years ago, and none of those are this tool's
//      to second-guess.
//   2. Otherwise the identity comes from the repository's own last commit author.
//      That is the person who has been working here, which is the best available
//      answer to "who commits here" and requires no guessing: it is a fact, not a
//      default.
//   3. Otherwise from the git identity configured for this machine or this user,
//      which is what would have been used anyway had this file never existed.
//   4. Otherwise nothing is written. An identity nobody configured is not one to
//      invent, and a file with a placeholder in it is worse than no file: git would
//      use the placeholder.
//
// The file is deliberately NOT written into the repository's tracked files. It holds
// whoever is committing, and committing it publishes one developer's name and email
// to everybody else in the repository. `init` adds it to .gitignore when it creates
// one; a repository that already tracks it is left that way, because removing a
// tracked file is not something an adopting command should do silently.

import { execFile } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { journaledGitConfig, journaledWriteFile } from './journal.mjs';

const exec = promisify(execFile);

/** The file, at the repository root. Named for what it is: a git config fragment. */
export const IDENTITY_FILE = 'git.config';

/** The git config key that pulls the file in. */
export const INCLUDE_KEY = 'include.path';

/**
 * Run a git command and return trimmed stdout, or null if it fails.
 *
 * Null rather than an exception for every case: a repository that is not a git
 * repository, a version of git that does not know a flag, a machine with no
 * configured identity. None of those is an error worth refusing an adoption over.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string|null>}
 */
async function git(cwd, args) {
  try {
    const { stdout } = await exec('git', args, { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Who last committed here.
 *
 * `%an` and `%ae` rather than the configured identity on purpose: this is what
 * actually happened, which is the answer to the question being asked. Reading
 * `git config user.email` here would return the value this file is about to be
 * derived from, and the step would be circular.
 *
 * @param {string} root
 * @returns {Promise<{name: string|null, email: string|null}>}
 */
export async function lastCommitAuthor(root) {
  const line = await git(root, ['log', '-1', '--format=%an <%ae>']);
  if (!line) return { name: null, email: null };
  // The name may itself contain angle brackets, so the address is split off the
  // LAST one rather than the first.
  const at = line.lastIndexOf('<');
  const close = line.lastIndexOf('>');
  if (at === -1 || close < at) return { name: line || null, email: null };
  return {
    name: line.slice(0, at).trim() || null,
    email: line.slice(at + 1, close).trim() || null,
  };
}

/**
 * The identity this machine would use anyway.
 *
 * `--get` rather than `--global`: it resolves through system, global and local in
 * git's own order, so what it returns is what a commit would have used had this file
 * never been created. That is the fallback's whole point - it must not be a second
 * opinion about what identity means.
 *
 * @param {string} root
 * @returns {Promise<{name: string|null, email: string|null}>}
 */
export async function configuredIdentity(root) {
  const read = async (key) => {
    const value = await git(root, ['config', '--get', key]);
    return value && value !== '' ? value : null;
  };
  return { name: await read('user.name'), email: await read('user.email') };
}

/**
 * The identity to write, and where it came from.
 *
 * @param {string} root
 * @returns {Promise<{name: string|null, email: string|null, from: 'last-commit'|'configured'|null,
 *                    exists: boolean, bytes: number}>}
 */
export async function resolveIdentity(root) {
  const path = join(root, IDENTITY_FILE);
  try {
    const info = await stat(path);
    if (info.isFile()) {
      return { name: null, email: null, from: null, exists: true, bytes: info.size };
    }
  } catch {
    // Absent is the case this whole module exists for.
  }

  const committed = await lastCommitAuthor(root);
  if (committed.name && committed.email) {
    return { ...committed, from: 'last-commit', exists: false, bytes: 0 };
  }
  const configured = await configuredIdentity(root);
  if (configured.name || configured.email) {
    return { ...configured, from: 'configured', exists: false, bytes: 0 };
  }
  return { name: null, email: null, from: null, exists: false, bytes: 0 };
}

/**
 * The file's bytes.
 *
 * Only the keys that were found are written. A partial identity is written as a
 * partial identity rather than padded with a placeholder, because a placeholder is
 * an identity git would use.
 *
 * @param {{name: string|null, email: string|null}} identity
 * @returns {string} LF-terminated
 */
export function renderIdentityFile({ name, email }) {
  const lines = ['[user]'];
  if (name) lines.push(`\tname = ${name}`);
  if (email) lines.push(`\temail = ${email}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Whether `include.path` already names this repository's own file.
 *
 * @param {string} root
 * @returns {Promise<boolean>}
 */
export async function includesOwnIdentity(root) {
  const values = (await git(root, ['config', '--local', '--get-all', INCLUDE_KEY])) ?? '';
  return values.split('\n').map((v) => v.trim()).filter(Boolean).includes(`../${IDENTITY_FILE}`);
}

/**
 * Point `core.hooksPath`-style local config at this repository's own identity file.
 *
 * `--replace-all` rather than `--add`, and that is the whole point: a value naming
 * ANOTHER repository's identity file is not an addition to keep, it is a link to
 * break. Two of the repositories here had exactly that, and both worked only because
 * the sibling checkout happened to exist at the expected relative path.
 *
 * A caller-supplied journal records the key so `undo` restores the routing (R49);
 * without one the write stays unrecorded, as `commitJournal` needs it (review 0003
 * Q30). The journaled path sets through `journaledGitConfig`, which records one
 * key's before and after - the single-value case, and the only shape this tool
 * writes.
 *
 * @param {string} root
 * @param {Array} [journal]
 * @returns {Promise<void>}
 */
export async function includeOwnIdentity(root, journal = null) {
  // A directory that is not a git work tree has no config to route. The lenient
  // `git()` used to swallow the failure here, and an adoption of a plain directory
  // must keep working: there is simply nothing to point at.
  if ((await git(root, ['rev-parse', '--is-inside-work-tree'])) !== 'true') return;
  if (journal) {
    await journaledGitConfig(root, journal, INCLUDE_KEY, `../${IDENTITY_FILE}`);
    return;
  }
  await git(root, ['config', '--local', '--replace-all', INCLUDE_KEY, `../${IDENTITY_FILE}`]);
}

/**
 * Whether .gitignore already names the identity file. The plan needs the answer
 * before anything is written: a line the run does not print is a write the reader
 * approves from the diff afterwards (review 0003 Q30).
 *
 * @param {string} root
 * @returns {Promise<boolean>}
 */
export async function identityIgnored(root) {
  let text;
  try {
    text = await readFile(join(root, '.gitignore'), 'utf8');
  } catch {
    return false;
  }
  return text.split('\n').map((l) => l.trim()).includes(IDENTITY_FILE);
}

/**
 * The .gitignore bytes with the identity entry appended, or null when it is
 * already there. One owner for the edit's shape: `ignoreIdentity` writes it and
 * `init --diff` previews it, so the two cannot disagree about the bytes (review
 * 0003 Q30).
 *
 * @param {string} text the current bytes, '' when the file is absent
 * @returns {string|null}
 */
export function gitignoreWithIdentity(text) {
  if (text.split('\n').map((l) => l.trim()).includes(IDENTITY_FILE)) return null;
  const prefix = text === '' || text.endsWith('\n') ? '' : '\n';
  return (
    `${text}${prefix}\n` +
    '# Per-developer git identity, written by `simt init`. Not a file to share:\n' +
    '# it carries whoever is committing into the tree, and a repository has more than\n' +
    '# one of those.\n' +
    `${IDENTITY_FILE}\n`
  );
}

/**
 * Add the identity file to .gitignore, if it is not already there.
 *
 * Matching on the exact line rather than a substring, because a `.gitignore`
 * entry of `/git.config` or `git.config` both mean it while a comment mentioning
 * it means nothing, and appending a duplicate of an entry that is already present
 * is how a file ends up listed twice.
 *
 * A caller-supplied journal records the edit so `undo` restores it (R49); without
 * one the write stays unrecorded, as `commitJournal` needs it (review 0003 Q30).
 *
 * @param {string} root
 * @param {Array} [journal]
 * @returns {Promise<boolean>} whether the file was changed
 */
export async function ignoreIdentity(root, journal = null) {
  const path = join(root, '.gitignore');
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    text = '';
  }
  const next = gitignoreWithIdentity(text);
  if (next === null) return false;
  if (journal) await journaledWriteFile(root, journal, path, next);
  else await writeFile(path, next);
  return true;
}