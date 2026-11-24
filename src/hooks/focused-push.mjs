// How many commits a push carries, and which files they change (plan 0010, ADR-258).
//
// The focused threshold needs both numbers: the count decides whether the push is small
// enough to run only its impacted tests, and the files are the selection input. The shape
// is `classifyPush` in push-skip.mjs extended to the file set. Nothing here runs a gate:
// it answers "what does this push carry", which is a question about commits, not about
// the tree the gates then run in. Every uncertainty - an unparseable ref list, a new
// branch with no remote history, a manual run with no upstream - fails closed to the full
// suite with the reason it runs.

import { recordRun } from '../ledger/index.mjs';
import { runFocused } from '../testing/focused-run.mjs';
import { tail } from '../util/text.mjs';
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

/**
 * The threshold half of ADR-258: is this push small enough to run only the tests
 * that import its files, and which files are those?
 *
 * Every "no" answers the same way — `null`, and the full suite runs exactly as
 * today. The threshold is the commit count at or below which the focused path
 * applies; absent means 1, so a single-commit push is focused by default. A `test`
 * gate the repository declared as a command cannot take file arguments, so it
 * never focuses.
 *
 * @param {string} root the repository to ask git
 * @param {string|undefined} pushed the raw pre-push stdin, or undefined for a manual run
 * @param {{threshold?: number, commandTest?: boolean}} [options]
 * @returns {Promise<string[]|null>} the pushed files to focus on, or null for the full suite
 */
export async function focusedThreshold(root, pushed, { threshold = 1, commandTest = false } = {}) {
  if (commandTest) return null;
  const { commits, files, fullSuite } = await focusedPush(root, pushed);
  if (fullSuite !== null) return null;
  if (commits > threshold) return null;
  if (files.length === 0) return null;
  return files;
}

/**
 * Run the `test` gate over the tests that import `files`, and record the run in the
 * ledger (ADR-258). Returns the report row, or `null` when the full suite must run
 * instead: every way the focused path cannot be sure — a graph that will not read, a
 * runner that will not build, a selection that comes back empty — falls through. More
 * runs, never fewer.
 *
 * @param {object} ctx
 * @param {string} ctx.root the tree the run executes in
 * @param {string} ctx.ledgerRoot the repository the evidence is recorded in
 * @param {string[]} ctx.files the pushed files the selection starts from
 * @param {object|null} [ctx.spec] the manifest's `test.runner` declaration, if any
 * @param {number} ctx.timeoutMs the bound in milliseconds (the dispatcher maps a declared
 *   0 to the focused default before calling)
 * @param {string} ctx.name the gate name, for the ledger line and the row
 * @param {string|null} [ctx.adr] the gate definition's decision record
 * @param {string|null} [ctx.subjectRevision] the revision the line is about
 * @param {object} [ctx.toolchain] the toolchain identity recorded beside the result
 * @returns {Promise<object|null>} the report row, or null for the full suite
 */
export async function focusedGate({ root, ledgerRoot, files, spec = null, timeoutMs, name, adr = null, subjectRevision = null, toolchain = {} }) {
  const started = Date.now();
  let focused = null;
  try {
    focused = await runFocused(root, { files, spec, timeoutMs });
  } catch {
    // The full suite runs in its place; the run below says what the gate did.
  }
  if (focused === null || focused.selected.length === 0) return null;
  const passed = focused.code === 0 && focused.unproven.length === 0;
  const exitCode = passed ? 0 : focused.code === 0 ? 1 : focused.code;
  try {
    await recordRun(ledgerRoot, {
      cmd: focused.runs.map((run) => run.command).join(' | '),
      exit: exitCode,
      ms: Date.now() - started,
      output: focused.output,
      gate: name,
      kind: 'test-focused',
      subject: root,
      revision: subjectRevision,
      toolchain,
      outcome: passed ? 'passed' : 'failed',
    });
  } catch {
    // Recorded by absence: the next evidence read for this tree has no line.
  }
  return {
    name,
    status: passed ? 'passed' : 'failed',
    detail: `focused: ${focused.selected.length} test file(s) for ${files.length} pushed file(s); the push is at or below gates.prePushFocusedCommits${focused.unproven.length > 0 ? `; the runner never ran: ${focused.unproven.join(', ')}` : ''}`,
    output: passed ? '' : tail(focused.output),
    adr,
    exitCode,
  };
}
