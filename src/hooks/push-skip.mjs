// The two reasons a pre-push run may leave the `test` gate alone, and the classification
// evidence both of them rest on (ADR-147, ADR-120).
//
// Extracted from `dispatcher.mjs` when the per-revision push work pushed that file past
// the 1,000-line ceiling (ADR-005). Nothing here runs a gate: it answers "may `test` be
// skipped for this push, and on what evidence", which is a question about commits, not
// about the tree the gates then run in.

import { extname, matchesGlob } from 'node:path';

import { git, gitPaths, gitText } from '../sys/git.mjs';
import { hasTestEvidence, readLedger } from '../ledger/index.mjs';

/**
 * The extension set a push may carry and still skip the `test` gate when the manifest
 * declares none of its own: images and documents, the file kinds a push can add that no
 * test reads (ADR-147). A manifest `extensions` array REPLACES this set - one declared
 * set is the only set that applies - it never unions with it.
 */
export const DEFAULT_SKIP_EXTENSIONS = [
  'avif', 'bmp', 'gif', 'heic', 'heif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp',
  'doc', 'docx', 'epub', 'md', 'odt', 'pdf', 'rtf', 'txt',
];

/**
 * The extension a path carries, lowercased without its dot: `res/a.PNG` is `png`. A name
 * with no dot is `''`, which no extension set contains.
 */
const fileExtension = (name) => extname(name).replace(/^\./, '').toLowerCase();

/** The sha git writes for a ref that does not exist on the remote yet. */
export const ZERO_SHA = '0'.repeat(40);

/**
 * The lines git feeds a pre-push hook on stdin, one per ref being pushed:
 * `<local ref> <local sha> <remote ref> <remote sha>`.
 *
 * Returns `{ refs, error }`. A line this parser cannot read is an ERROR, not a
 * dropped line: a push that cannot be read is a push that cannot be classified,
 * and the classifier's contract is to fail closed to the full suite.
 *
 * @param {string} text the raw stdin
 * @returns {{refs: {ref: string, localSha: string, remoteSha: string}[] | null, error: string | null}}
 */
export function parsePushedRefs(text) {
  const refs = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const parts = trimmed.split(' ');
    if (parts.length !== 4) return { refs: null, error: `unrecognized pre-push line: ${trimmed}` };
    const [ref, localSha, , remoteSha] = parts;
    if (!/^[0-9a-f]{40}$/.test(localSha) || !/^[0-9a-f]{40}$/.test(remoteSha)) {
      return { refs: null, error: `unrecognized sha in pre-push line: ${trimmed}` };
    }
    refs.push({ ref, localSha, remoteSha });
  }
  return { refs, error: null };
}

/**
 * Confirm a tag's commit is already accounted for, so the tag may ride along in a
 * non-code push (ADR-147). A tag carries no commits of its own in the release flow:
 * it points at commits delivered (and tested) by a branch push. It is acceptable only
 * when the commit it names is reachable from a remote-tracking ref (already pushed) or
 * from a branch tip this same push is delivering. Any uncertainty - the tag does not
 * resolve to a commit, the remote refs cannot be listed, no candidate is known, or the
 * commit is unreachable from all of them - fails closed to the full suite.
 *
 * @param {string} root the repository to ask git
 * @param {string} tagSha the tag's local sha from the pre-push line
 * @param {string[]} pushingTips branch tips this same push is delivering
 * @returns {Promise<{ok: boolean, reason: string | null}>}
 */
async function tagCommitAccountedFor(root, tagSha, pushingTips) {
  let commit;
  try {
    commit = await gitText(root, ['rev-parse', `${tagSha}^{commit}`]);
  } catch (error) {
    return { ok: false, reason: `the tag could not be resolved to a commit: ${String(error.stderr ?? error.message).trim()}` };
  }

  let remoteRefs;
  try {
    remoteRefs = await gitText(root, ['for-each-ref', 'refs/remotes/', '--format=%(refname)']);
  } catch (error) {
    return { ok: false, reason: `the remote refs could not be listed: ${String(error.stderr ?? error.message).trim()}` };
  }
  const candidates = [
    ...remoteRefs.split('\n').map((s) => s.trim()).filter((s) => s !== ''),
    ...pushingTips,
  ];
  if (candidates.length === 0) {
    return { ok: false, reason: 'no remote refs are known and no branch is being pushed, so the tag’s commit cannot be confirmed as already delivered' };
  }
  for (const candidate of candidates) {
    try {
      await git(root, ['merge-base', '--is-ancestor', commit, candidate]);
      return { ok: true, reason: null };
    } catch {
      // not reachable from this ref; try the next candidate
    }
  }
  return { ok: false, reason: `the tag’s commit (${commit.slice(0, 7)}) is not reachable from any pushed ref; it may not have been tested` };
}

/**
 * Decide whether a push is non-code, so the `test` gate may be skipped for it (ADR-147).
 * Every uncertainty fails closed to `{ nonCode: false }` with the reason the full suite
 * runs: an empty ref list, a new branch (no remote sha to diff against), a tag whose
 * commit is not confirmed already delivered, a commit count above the ceiling, a file
 * outside the declared paths and extensions, or a git error.
 *
 * Branch refs are judged on a TREE diff (`remote..local`), so a force push that
 * drops commits is judged on the trees it replaces, not on the commit count alone.
 * Tag refs carry no commits of their own; each is accepted only when its commit is
 * already accounted for (see `tagCommitAccountedFor`). Deletions push nothing.
 *
 * @param {string} root the repository to ask git
 * @param {{ref: string, localSha: string, remoteSha: string}[]} refs
 * @param {{maxCommits: number, paths: string[], extensions?: string[] | Set<string>}} config
 *   the manifest's `gates.prePushSkipTest`; `extensions` defaults to the built-in
 *   image-and-document set
 * @returns {Promise<{nonCode: boolean, reason: string}>}
 */
export async function classifyPush(root, refs, { maxCommits, paths, extensions = DEFAULT_SKIP_EXTENSIONS }) {
  const exts = new Set(extensions);
  if (refs.length === 0) {
    return { nonCode: false, reason: 'the push carries no readable ref list; running the full suite' };
  }
  const deletions = refs.filter((r) => r.localSha === ZERO_SHA).length;
  const branches = refs.filter((r) => r.localSha !== ZERO_SHA && !r.ref.startsWith('refs/tags/'));
  const tags = refs.filter((r) => r.localSha !== ZERO_SHA && r.ref.startsWith('refs/tags/'));

  let commits = 0;
  const files = new Set();
  for (const { ref, localSha, remoteSha } of branches) {
    if (remoteSha === ZERO_SHA) {
      return { nonCode: false, reason: `a new branch is being pushed (${ref}); its history cannot be diffed against the remote` };
    }
    let count, names;
    try {
      count = await gitText(root, ['rev-list', '--count', `${remoteSha}..${localSha}`]);
      names = await gitPaths(root, ['diff', '--name-only', `${remoteSha}..${localSha}`]);
    } catch (error) {
      return { nonCode: false, reason: `the push could not be diffed: ${String(error.stderr ?? error.message).trim()}` };
    }
    commits += Number(count);
    // NUL-separated paths because a path can contain a newline, and git quotes such a
    // name in the line-terminated form, so splitting on newlines compares a quoted path
    // against an unquoted glob and never matches.
    for (const name of names) {
      files.add(name);
    }
  }

  const pushingTips = branches.map((b) => b.localSha);
  for (const { localSha } of tags) {
    const verdict = await tagCommitAccountedFor(root, localSha, pushingTips);
    if (!verdict.ok) return { nonCode: false, reason: verdict.reason };
  }

  if (commits > maxCommits) {
    return { nonCode: false, reason: `${commits} commits exceed the ${maxCommits}-commit ceiling for a non-code push` };
  }
  // A file is inside when a declared path matches it OR its extension is declared:
  // the two are orthogonal, and a file that satisfies neither is the suite's to judge.
  const inside = (f) => paths.some((p) => matchesGlob(f, p)) || exts.has(fileExtension(f));
  const outside = [...files].filter((f) => !inside(f));
  if (outside.length > 0) {
    return { nonCode: false, reason: `${outside.length} file(s) are outside the declared paths and extensions: ${outside.slice(0, 5).join(', ')}` };
  }

  const parts = [];
  if (commits > 0) parts.push(`${commits} commit(s) touching ${files.size} file(s), all inside the declared paths and extensions`);
  if (tags.length > 0) parts.push(`${tags.length} tag(s) already delivered`);
  if (deletions > 0) parts.push(`${deletions} ref deletion(s)`);
  if (parts.length === 0) return { nonCode: true, reason: 'no commits carried' };
  // The report prints this as-is (ADR-147). The label names what is being pushed:
  // a push that carries only tags is a tag push, not a non-code push.
  const kind = commits > 0 ? 'non-code push' : tags.length > 0 ? 'tag push' : 'deletion push';
  return { nonCode: true, reason: `${kind}: ${parts.join('; ')}` };
}

/**
 * The pre-push skip decision, from the manifest and the ref list git fed on stdin.
 *
 * The skip is OPT-IN: a repository without `gates.prePushSkipTest` runs the full
 * suite on every push, because a control a repo did not declare is one it did not
 * review. A misdeclaration (missing fields) also runs the suite - a skip the
 * manifest cannot state precisely is a skip a reviewer cannot see.
 *
 * @returns {Promise<{reason: string, adr: string} | null>} null runs the suite; a reason skips the `test` gate
 */
export async function resolveNonCodeSkip(root, manifest, pushed) {
  if (pushed === undefined) return null;
  const config = manifest?.gates?.prePushSkipTest;
  if (typeof config?.maxCommits !== 'number' || !Array.isArray(config.paths)) return null;
  // `extensions` is optional: absent, the built-in image-and-document set applies.
  // Present, it must be an array of non-empty strings - a misshape runs the suite,
  // the same fail-closed as any other field - and it REPLACES the built-in set:
  // the declared set is the only set that applies (ADR-147).
  let extensions = DEFAULT_SKIP_EXTENSIONS;
  if (config.extensions !== undefined) {
    if (!Array.isArray(config.extensions) || !config.extensions.every((e) => typeof e === 'string' && e.trim() !== '')) {
      return null;
    }
    extensions = config.extensions.map((e) => e.trim().replace(/^\./, '').toLowerCase());
  }
  const { refs, error } = parsePushedRefs(pushed);
  if (error !== null) {
    return null; // the caller cannot be sure what is being pushed; the suite runs
  }
  const verdict = await classifyPush(root, refs, {
    maxCommits: config.maxCommits,
    paths: config.paths,
    extensions: new Set(extensions),
  });
  return verdict.nonCode ? { reason: verdict.reason, adr: 'ADR-147' } : null;
}

/**
 * The pre-push skip for a suite the author already ran on this exact tree (ADR-120).
 *
 * The dispatcher records every gate run against the tree it ran on (ADR-087). If a passing
 * `test` run is recorded for the committed tree about to be pushed, and nothing has changed
 * since, re-running the full suite at push time buys nothing: it is the same tree, already
 * proven. This reads that evidence and earns the same reported skip the non-code path does.
 *
 * It matches the COMMITTED tree of the revision being pushed, not the caller's working
 * tree: a pre-push gate executes in a worktree at that revision, so the evidence that
 * matters is a pass on exactly that tree. A file edited after the green pass changes the
 * tree id, so the match fails and the suite runs - the "no changes since" condition is
 * enforced by the digest, not by trusting the author. Every uncertainty - an unborn HEAD,
 * an unreadable ledger, no entry for this tree, a later failure - fails closed to the suite.
 *
 * @param {string} root the real repository root
 * @param {string} [revision] the revision being pushed; HEAD for a manual run
 * @returns {Promise<{reason: string} | null>} null runs the suite; a reason skips the `test` gate
 */
export async function resolveAlreadyPassedSkip(root, revision = 'HEAD') {
  let headTree;
  try {
    headTree = await gitText(root, ['rev-parse', `${revision}^{tree}`]);
  } catch {
    return null;
  }
  if (!/^[0-9a-f]{40}$/.test(headTree)) return null;
  const { entries, errors } = await readLedger(root);
  if (errors.length > 0) return null;
  if (!hasTestEvidence(entries, headTree)) return null;
  return {
    reason:
      `already passing on current state: the test gate ran green on the tree of ${revision === 'HEAD' ? 'HEAD' : revision.slice(0, 12)} and nothing has changed since`,
    adr: 'ADR-120',
  };
}
