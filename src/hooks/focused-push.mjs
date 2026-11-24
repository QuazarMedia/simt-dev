// How many commits a push carries, and which files they change (plan 0010, ADR-258).
//
// The focused threshold needs both numbers: the count decides whether the push is small
// enough to run only its impacted tests, and the files are the selection input. The shape
// is `classifyPush` in push-skip.mjs extended to the file set. Nothing here runs a gate:
// it answers "what does this push carry", which is a question about commits, not about
// the tree the gates then run in. Every uncertainty - an unparseable ref list, a new
// branch with no remote history, a manual run with no upstream - fails closed to the full
// suite with the reason it runs.

import { gitPaths, gitText } from '../sys/git.mjs';
import { ZERO_SHA, parsePushedRefs } from './push-skip.mjs';

/**
 * What a push carries: the commit count summed across its branch refs, and the union of
 * the files those commits change.
 *
 * A ref list is the raw pre-push stdin git feeds the hook; `undefined` is a manual run
 * (`simt hooks run pre-push`), which counts the branch against its upstream instead.
 * Tags and deletions carry no commits of their own, so they contribute nothing here:
 * a push that is only tags and deletions has no files to focus on, and the caller runs
 * the full suite for it, the same as today.
 *
 * @param {string} root the repository to ask git
 * @param {string|undefined} pushed the raw pre-push stdin, or undefined for a manual run
 * @returns {Promise<{commits: number, files: string[], fullSuite: string|null}>}
 *   `fullSuite` is the reason the threshold cannot apply; null means the push is small
 *   enough and `files` may be handed to the focused selection.
 */
export async function focusedPush(root, pushed) {
  if (pushed === undefined) {
    try {
      const count = await gitText(root, ['rev-list', '--count', '@{u}..HEAD']);
      const files = await gitPaths(root, ['diff', '--name-only', '@{u}..HEAD']);
      if (count === null || Number(count) === 0) {
        return { commits: 0, files: [], fullSuite: 'the branch is already up to date with its upstream; running the full suite' };
      }
      return { commits: Number(count), files, fullSuite: null };
    } catch (error) {
      return { commits: 0, files: [], fullSuite: `no upstream to count against (${String(error.stderr ?? error.message).trim()}); running the full suite` };
    }
  }
  const { refs, error } = parsePushedRefs(pushed);
  if (error !== null) {
    return { commits: 0, files: [], fullSuite: `the push carries no readable ref list (${error}); running the full suite` };
  }
  // Branch refs are judged on their remote->local range, mirroring classifyPush: a force
  // push that drops commits is judged on the range it replaces, and a zero remote sha is
  // a new branch with nothing to diff against.
  const branches = refs.filter((r) => r.localSha !== ZERO_SHA && !r.ref.startsWith('refs/tags/'));
  if (branches.length === 0) {
    return { commits: 0, files: [], fullSuite: 'the push carries no branch ref with new commits; running the full suite' };
  }
  let commits = 0;
  const files = new Set();
  for (const { ref, localSha, remoteSha } of branches) {
    if (remoteSha === ZERO_SHA) {
      return { commits: 0, files: [], fullSuite: `a new branch is being pushed (${ref}); its history cannot be counted or diffed against the remote` };
    }
    let count, names;
    try {
      count = await gitText(root, ['rev-list', '--count', `${remoteSha}..${localSha}`]);
      names = await gitPaths(root, ['diff', '--name-only', `${remoteSha}..${localSha}`]);
    } catch (error) {
      return { commits: 0, files: [], fullSuite: `the push could not be diffed: ${String(error.stderr ?? error.message).trim()}` };
    }
    commits += Number(count);
    for (const name of names) files.add(name);
  }
  if (commits === 0) {
    return { commits: 0, files: [], fullSuite: 'the push carries no new commits; running the full suite' };
  }
  return { commits, files: [...files].sort(), fullSuite: null };
}
