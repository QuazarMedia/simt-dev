// The read-only half of `init`: the conflict scan and the pre-write escape hatch.
//
// Split out of init.mjs when it reached the repository ceiling. Neither function writes
// the manifest; both answer a question the command asks before it does.

import { mkdir, readFile, symlink } from 'node:fs/promises';
import { git as sysGit } from '../sys/git.mjs';
import { rulePaths, scanDocument, summarise } from '../projection/conflicts.mjs';
import { parse as parseRegion } from '../projection/markers.mjs';

const BACKUP_TAG = 'backup-before-simt-dev';
const ADOPT_BRANCH = 'simt-dev/adopt';

async function scanRepo(root) {
  const findings = [];
  for (const path of await rulePaths(root)) {
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    const region = parseRegion(text);
    const handWritten = region.status === 'ok' ? `${region.before}\n${region.after}` : text;
    findings.push(...scanDocument(handWritten, path));
  }
  return findings;
}

/**
 * The opt-in escape hatch before the first write, taken when --backup is passed
 * (ADR-063 amended plan 0002 §8.2 item 3 from "always" to on request). Both operations
 * are best-effort: a repo that is not a git repo, or has no commits yet, must still be
 * adoptable. Failure is reported as a note rather than blocking, because refusing
 * to initialise an unborn repo would be worse than proceeding without a backup.
 */
async function establishEscapeHatch(root) {
  const result = { branch: null, tag: null, from: null, notes: [] };
  const isRepo = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (!isRepo.ok) {
    result.notes.push('not a git work tree; no backup branch or tag created');
    return result;
  }

  const dirty = await git(root, ['status', '--porcelain']);
  if (dirty.ok && dirty.stdout.trim() !== '') {
    result.notes.push('worktree already dirty; left untouched, existing changes are not staged');
  }

  const head = await git(root, ['rev-parse', '--verify', 'HEAD']);
  if (!head.ok) {
    result.notes.push('no commits yet; nothing to tag');
  } else {
    const hasTag = await git(root, ['rev-parse', '--verify', `refs/tags/${BACKUP_TAG}`]);
    if (hasTag.ok) {
      result.tag = BACKUP_TAG;
    } else {
      const tag = await git(root, ['tag', BACKUP_TAG]);
      if (tag.ok) result.tag = BACKUP_TAG;
      else result.notes.push(`could not create tag ${BACKUP_TAG}: ${tag.stderr.trim()}`);
    }
  }

  const current = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current.ok && current.stdout.trim() !== ADOPT_BRANCH) {
    // Recorded rather than re-read by the caller: only this function knows what the
    // branch was before it moved it, and a second `rev-parse` would answer with the new
    // value and make every "you were on X" line read as "you were on Y".
    result.from = current.stdout.trim();
    const branch = await git(root, ['checkout', '-b', ADOPT_BRANCH]);
    if (branch.ok) result.branch = ADOPT_BRANCH;
    else result.notes.push(`could not create branch ${ADOPT_BRANCH}: ${branch.stderr.trim()}`);
  } else if (current.ok) {
    result.branch = ADOPT_BRANCH;
  }

  return result;
}

async function git(cwd, args) {
  try {
    const stdout = await sysGit(cwd, args);
    return { ok: true, stdout, stderr: '' };
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}


export { ADOPT_BRANCH, BACKUP_TAG, establishEscapeHatch, git, scanRepo };
