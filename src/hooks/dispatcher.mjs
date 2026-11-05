// Run the gates a repo declares for a hook event.
//
// Design commitments, all of them load-bearing:
//
//   Fail closed, never fail open. A gate that cannot run is a failure, not a
//   skip. A repository removed tests from pre-commit because they were slow, and
//   the documented consequence was that authors reached for --no-verify. A
//   dispatcher that skips what it cannot do reproduces exactly that.
//
//   Never weaken a control to make a hook pass. If a gate fails, the gate
//   fails. There is no "warn and continue" mode, and no gate can be downgraded
//   from inside the hook - only from the manifest, where a reviewer sees it.
//
//   Format and lint are staged-only. (ADR-004) Formatting the whole working
//   tree from a pre-commit hook would rewrite files the author did not stage and
//   did not ask to change.
//
//   Report what did not run. The summary names every gate, its disposition and
//   its reason, so "passed" can never be mistaken for "only some of it passed".

import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, join, matchesGlob, resolve, sep } from 'node:path';

import { GATES, getGate } from './gates.mjs';
import { preparePushTree } from './head-worktree.mjs';
import { resolveGate } from './resolve.mjs';
import { resolveNodeRunner } from '../ecosystem/node-runner.mjs';
import { CLI } from '../name.mjs';
import { MANIFEST_FILE } from '../name.mjs';
import { assertVersionPin } from '../package-version.mjs';
import { hasTestEvidence, readLedger, recordRun } from '../ledger/index.mjs';
import { renderFindings, scanStaged } from '../secrets.mjs';
import { git, gitPaths, gitText } from '../sys/git.mjs';

/**
 * The default bound on one gate, in seconds, and the grace a killed gate gets before
 * SIGKILL. A hook that runs on every commit needs a ceiling: a test runner waiting on
 * a socket that never closes blocks the commit with no output and no way to tell a
 * hang from slow work. `gates.timeout` raises or removes it per repository.
 */
const DEFAULT_GATE_TIMEOUT_SECONDS = 600;
const KILL_GRACE_MS = 5000;

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

/**
 * How much of a gate's output a report can carry. This is a bound on what is KEPT, not
 * on what the process may write: a gate whose output exceeded execFile's buffer used to
 * be reported `failed` although it exited 0.
 */
const GATE_OUTPUT_TAIL_BYTES = 64 * 1024;

function tailCollector() {
  let kept = Buffer.alloc(0);
  let dropped = 0;
  return {
    push(chunk) {
      kept = Buffer.concat([kept, chunk]);
      if (kept.length > GATE_OUTPUT_TAIL_BYTES) {
        dropped += kept.length - GATE_OUTPUT_TAIL_BYTES;
        kept = kept.subarray(kept.length - GATE_OUTPUT_TAIL_BYTES);
      }
    },
    text: () => kept.toString('utf8'),
    dropped: () => dropped,
  };
}

/**
 * Signal the gate's whole process group. A test runner spawns workers of its own, and
 * signalling only the leader leaves them holding the pipes this function is waiting on.
 * `detached` in the spawn below is what makes the group exist.
 */
function signalTree(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone: a second signal has nothing to reach.
    }
  }
}

/**
 * Run one gate to completion, keeping its exit code and the tail of what it printed.
 *
 * `timeoutMs` of 0 means no bound, which is what `gates.timeout: 0` asks for and what
 * the manifest does not have to say. Output is collected in full while the process
 * runs and only the tail is retained, so a noisy passing gate passes.
 */
async function runBounded(argv, { cwd, env, timeoutMs }) {
  return await new Promise((settle) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      settle({ code: 1, stdout: '', stderr: String(error.message ?? error), timedOut: false, dropped: 0 });
      return;
    }
    const out = tailCollector();
    const err = tailCollector();
    let timedOut = false;
    let timer = null;
    let killer = null;
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(killer);
      settle({ code, stdout: out.text(), stderr: err.text(), timedOut, dropped: out.dropped() + err.dropped() });
    };
    child.stdout?.on('data', (chunk) => out.push(chunk));
    child.stderr?.on('data', (chunk) => err.push(chunk));
    // A missing binary emits `error` and no `close`; the message is the only evidence.
    child.on('error', (error) => {
      err.push(Buffer.from(String(error.message ?? error)));
      finish(1);
    });
    child.on('close', (code, signal) => finish(typeof code === 'number' ? code : signal === null ? 0 : 1));
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        signalTree(child, 'SIGTERM');
        killer = setTimeout(() => signalTree(child, 'SIGKILL'), KILL_GRACE_MS);
      }, timeoutMs);
    }
  });
}

/**
 * The bound for one gate, in milliseconds. A number applies to every gate; a map applies
 * per name, the shape `gates.cwd` already has. A value that is neither a positive whole
 * number of seconds nor 0 falls back to the default rather than removing the bound: an
 * unreadable declaration must not be the quiet way to disable the ceiling.
 */
function gateTimeoutMs(declared, name) {
  const value = declared !== null && typeof declared === 'object' ? declared[name] : declared;
  if (value === 0) return 0;
  if (Number.isInteger(value) && value > 0) return value * 1000;
  return DEFAULT_GATE_TIMEOUT_SECONDS * 1000;
}

/** Gates that are known but not required for the event to pass. */
const DEFAULT_EVENTS = { 'pre-commit': 'preCommit', 'pre-push': 'prePush' };

/** The sha git writes for a ref that does not exist on the remote yet. */
const ZERO_SHA = '0'.repeat(40);

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
async function resolveNonCodeSkip(root, manifest, pushed) {
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
 * It matches the COMMITTED tree (`HEAD^{tree}`), not the working tree: the pre-push gate runs
 * at HEAD, so the evidence that matters is a pass on exactly that tree. A file edited after
 * the green pass changes the tree id, so the match fails and the suite runs - the "no changes
 * since" condition is enforced by the digest, not by trusting the author. Every uncertainty -
 * an unborn HEAD, an unreadable ledger, no entry for this tree, a later failure - fails closed
 * to the suite.
 *
 * @param {string} root the real repository root
 * @returns {Promise<{reason: string} | null>} null runs the suite; a reason skips the `test` gate
 */
async function resolveAlreadyPassedSkip(root) {
  let headTree;
  try {
    headTree = await gitText(root, ['rev-parse', 'HEAD^{tree}']);
  } catch {
    return null;
  }
  if (!/^[0-9a-f]{40}$/.test(headTree)) return null;
  const { entries, errors } = await readLedger(root);
  if (errors.length > 0) return null;
  if (!hasTestEvidence(entries, headTree)) return null;
  return {
    reason:
      'already passing on current state: the test gate ran green on this tree and nothing has changed since',
    adr: 'ADR-120',
  };
}

/**
 * @param {string} event 'pre-commit' | 'pre-push'
 * @param {object} ctx
 * @param {string} ctx.root
 * @param {object} ctx.manifest parsed simt-dev.json, or null
 * @param {string} [ctx.pushed] the ref list git feeds pre-push on stdin; undefined when no
 *   push is being classified (every other event, a manual run with no stdin)
 * @returns {Promise<{event: string, gates: object[], failed: boolean}>}
 */
export async function runGates(event, { root, manifest, pushed }) {
  const key = DEFAULT_EVENTS[event];
  if (key === undefined) {
    return { event, gates: [], failed: true, error: `unknown hook event ${event}` };
  }

  const declared = manifest?.gates?.[key];
  if (!Array.isArray(declared) || declared.length === 0) {
    // An array, not a string. This field sat next to `gates` as a bare string while
    // the caller iterated it, so an empty gate list printed one note line per
    // character — 180 lines of noise in a hook whose only job is to be readable.
    // Only reachable on a repo that has no formatter and no linter, so the one path
    // where an author's patience is already spent.
    return {
      event,
      gates: [],
      failed: false,
      notes: [
        `nothing runs on ${event}: ${MANIFEST_FILE} declares no gates.${key}. That is a valid ` +
          `answer when the repo has no tool for any of them - \`${CLI} check\` reports each ` +
          `gate it could not run and why - but it is also what an unfiltered default looks like.`,
      ],
    };
  }

  // The gates below run from the binary that resolved this shim. For a repository
  // without npm that is the release binary in `.simt/bin` (ADR-098), whose version
  // nothing else pins: if it is not the one this repo adopted, the gates that run here
  // are not the ones CI runs.
  // Placed after the empty-list check on purpose - with no gates there is nothing the
  // version could get wrong, and failing that case would block commits in repos that
  // deliberately declare none.
  const mismatch = assertVersionPin(manifest);
  if (mismatch) {
    return {
      event,
      gates: [{ name: 'version', status: 'failed', detail: mismatch, remedy: `run: ${CLI} upgrade --yes`, adr: null }],
      failed: true,
    };
  }

  // A pre-push gate runs against the COMMITTED tree, not the working one. Uncommitted
  // work must not block the push of previous commits: a gate that fails on WIP the
  // author has not committed is blocking a push it does not own. The worktree is
  // disposable and shares the repository's object store, so `git worktree add` is cheap
  // and needs no clone. The ledger and the version pin stay at the real root - the
  // evidence is about this repository, not the throwaway checkout.
  let runRoot = root;
  let cleanupHeadWorktree = async () => {};
  let skipTest = null;
  if (event === 'pre-push') {
    // Decided before the worktree exists: a non-code push (documentation, images, release
    // files) skips the `test` gate (ADR-147), and a push whose tree the author already proved
    // green skips it on that evidence (ADR-120).
    skipTest = (await resolveNonCodeSkip(root, manifest, pushed)) ??
      (await resolveAlreadyPassedSkip(root));
    // The tree is materialised for every pre-push, including one that skips `test`: lint and
    // format must see the commit being pushed, not the author's uncommitted edits. The skip
    // reason is passed through so `runGatesAt` still leaves the test gate alone.
    const prepared = await preparePushTree(root);
    if (prepared.path === null) return { event, gates: [prepared.gate], failed: true };
    runRoot = prepared.path;
    cleanupHeadWorktree = prepared.done;
  }

  try {
    return await runGatesAt(event, { root: runRoot, ledgerRoot: root, manifest, declared, key, skipTest });
  } finally {
    await cleanupHeadWorktree();
  }
}

/**
 * Run the declared gates at `root`, recording evidence at `ledgerRoot`.
 *
 * For a pre-push run the two differ: the gates execute in a throwaway worktree at
 * HEAD so uncommitted work cannot block the push, while the ledger line belongs to
 * the repository the author is standing in. For every other event they are the same
 * path, which is why this is one function with two names for the root rather than
 * two functions.
 *
 * @param {string} event
 * @param {object} ctx
 * @param {string} ctx.root the tree the gates execute in
 * @param {string} ctx.ledgerRoot the repository the evidence is recorded in
 * @param {object} ctx.manifest
 * @param {string[]} ctx.declared the gate names for this event
 * @param {string} ctx.key the manifest key for this event
 * @param {{reason: string, adr: string} | null} [ctx.skipTest] set when a push skips the
 *   `test` gate (ADR-147 for a non-code push, ADR-120 for an already-green tree); the reason is
 *   what the report prints in its place, and the adr is the record that earned it
 * @returns {Promise<{event: string, gates: object[], failed: boolean}>}
 */
async function runGatesAt(event, { root, ledgerRoot, manifest, declared, key, skipTest = null }) {
  const pkg = await readPkg(root);
  // the runner is committed evidence (lockfile, then `packageManager`),
  // resolved once per hook run so every script gate spawns the same manager.
  let runner = null;
  if (pkg) {
    const lockfiles = [];
    for (const file of ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'package-lock.json']) {
      try {
        await stat(join(root, file));
        lockfiles.push(file);
      } catch {
        // Absent is the normal case.
      }
    }
    runner = resolveNodeRunner({
      lockfiles,
      packageManager: typeof pkg.packageManager === 'string' ? pkg.packageManager : null,
    }).id;
  }
  const staged = event === 'pre-commit' ? await stagedFiles(root) : [];
  const unstaged = event === 'pre-commit' ? await unstagedFiles(root) : new Set();
  const commands = manifest?.gates?.commands;
  // `gates.cwd` is a separate map rather than a second shape for `gates.commands`.
  // A monorepo needs the gate to run inside one package, and the reader declaring it
  // already knows the gate by name — putting the directory beside the command would
  // mean re-reading the command string to find out where anything runs, and a manifest
  // written by an older release would have to be rewritten to gain the capability.
  const cwds = manifest?.gates?.cwd ?? {};
  // `gates.timeout` bounds one gate, in seconds: a number for every gate, or a map by
  // name like `gates.cwd`. Absent means the default; 0 means no bound, declared.
  const timeouts = manifest?.gates?.timeout;
  const results = [];
  // What the format gate rewrote, so restage touches those files and nothing else.
  let formatted = [];

  for (const name of declared) {
    const gate = getGate(name, commands);
    if (gate === null) {
      results.push({
        name,
        status: 'failed',
        detail: `unknown gate; the shared dispatcher knows: ${Object.keys(GATES).sort().join(', ')}`,
        remedy: `remove "${name}" from ${MANIFEST_FILE} gates.${key}`,
        adr: null,
      });
      continue;
    }

    // The one gate a push may not run (ADR-147 for a non-code push, ADR-120 for a tree
    // already proven green). It is reported, not dropped: a skip without a printed reason
    // would let "passed" mean "the suite never ran", which is the exact confusion the report
    // exists to prevent.
    if (skipTest !== null && name === 'test') {
      results.push({ name, status: 'skipped', detail: skipTest.reason, adr: skipTest.adr, exitCode: null });
      continue;
    }

    const resolution = await resolveGate(gate, { root, pkg, staged, commands, runner });
    if (!resolution.ok) {
      results.push({
        name,
        status: 'failed',
        detail: resolution.reason,
        remedy: resolution.remedy,
        adr: gate.adr,
      });
      continue;
    }

    // A built-in gate runs here, in this process: no script, no command, no
    // tool on disk (ADR-100). It gets the same ledger line and the same
    // fail-closed reporting as every other gate; only the source of the bytes
    // it runs over differs. Keyed on the RESOLUTION rather than the gate, so a
    // declared command for this name takes the shell path below instead.
    if (resolution.builtin !== undefined) {
      const startedBuiltin = Date.now();
      // The manifest's per-builtin options, where a builtin has any: the secret
      // scan takes its ignore globs from gates.secretScan.
      const outcome = await runBuiltinGate(resolution.builtin, { root, staged, options: manifest?.gates?.secretScan });
      try {
        await recordRun(ledgerRoot, {
          cmd: `builtin:${resolution.builtin}`,
          exit: outcome.ok ? 0 : 1,
          ms: Date.now() - startedBuiltin,
          output: outcome.output,
          gate: name,
          kind: 'builtin',
        });
      } catch {
        // Recorded by absence: the next evidence read for this tree has no line.
      }
      results.push({
        name,
        status: outcome.ok ? 'passed' : 'failed',
        detail: outcome.detail,
        output: outcome.ok ? '' : outcome.output,
        ...(outcome.remedy !== undefined ? { remedy: outcome.remedy } : {}),
        adr: gate.adr,
        exitCode: outcome.ok ? 0 : 1,
      });
      continue;
    }

    if (resolution.argv === null) {
      results.push({ name, status: 'skipped', detail: resolution.detail, adr: gate.adr, exitCode: null });
      continue;
    }

    // A formatter rewrites the WORKING TREE copy of the files it is given, so
    // handing it a file that also has unstaged changes destroys work the author
    // staged around deliberately. `git add -p` exists so a commit can carry part
    // of a file; formatting first and re-adding the whole thing silently throws
    // the rest away, which is ADR-004's exact prohibition on the one path that
    // runs on every commit. Refuse rather than stash: a hook that guesses what the
    // author meant is worse than a hook that says so.
    if (gate.kind === 'staged') {
      // The resolved staged tool is handed an explicit file list, so the targets are
      // known. A `gates.commands` declaration is an arbitrary command line - it may
      // take a directory or a glob rather than paths - so every staged file with
      // unstaged changes is treated as at risk, because nothing here can tell.
      const targets = resolution.declared === true ? staged : resolution.argv.slice(2);
      const conflicts = targets.filter((f) => unstaged.has(f));
      if (conflicts.length > 0) {
        results.push({
          name,
          status: 'failed',
          detail: `${conflicts.length} staged file(s) also have unstaged changes: ${conflicts.join(', ')}`,
          remedy:
            `stage the whole file (git add ${conflicts[0]}) so the formatter sees all of it, ` +
            `or run the formatter yourself and stage the result`,
          adr: gate.adr,
        });
        continue;
      }
      formatted = targets;
    }

    // The gate's directory, if it declares one. Resolved against the repo root and
    // checked for containment: a `cwd` that escaped the repository would run a command
    // against files this commit cannot see, and the gate would be green about them.
    // Containment is checked on the RESOLVED path, not the string, because `..` and a
    // symlink both get past a prefix test on the text.
    let cwd = root;
    const declaredCwd = cwds[name];
    if (declaredCwd !== undefined) {
      const resolved = resolve(root, declaredCwd);
      const inside = resolved === root || resolved.startsWith(`${root}${sep}`);
      const exists = inside && (await stat(resolved).catch(() => null))?.isDirectory();
      if (!exists) {
        results.push({
          name,
          status: 'failed',
          detail: inside
            ? `gates.cwd["${name}"] is ${declaredCwd}, which is not a directory in this repository`
            : `gates.cwd["${name}"] is ${declaredCwd}, which is outside the repository`,
          remedy: `point gates.cwd["${name}"] at a directory in this repository, or remove it to run the gate at the root`,
          adr: gate.adr,
        });
        continue;
      }
      cwd = resolved;
    }

    const timeoutMs = gateTimeoutMs(timeouts, name);
    const started = Date.now();
    const outcome = await runGate(resolution, cwd, timeoutMs);
    // The ledger is not the gate. A tree that cannot be named leaves no line, and the
    // claim check then finds nothing, which is the direction that cannot invent a run.
    try {
      const cmd = typeof resolution.command === 'string' ? resolution.command : resolution.argv.join(' ');
      // The evidence claim needs the gate and its kind: a passing secret-scan is
      // not a passing test run. Coverage proves tests; anything
      // else keeps its own kind or the gate name.
      const kind =
        name === 'test' || name === 'coverage' ? 'test' : name === 'lint' ? 'lint' : name === 'format' ? 'format' : (gate.kind ?? name);
      await recordRun(ledgerRoot, {
        cmd,
        exit: outcome.code,
        ms: Date.now() - started,
        output: `${outcome.stdout ?? ''}\n${outcome.stderr ?? ''}`,
        gate: name,
        kind,
      });
    } catch {
      // Recorded by absence: the next evidence read for this tree has no line.
    }
    // A killed gate has no exit code of its own (`signal` instead), so the reason is
    // stated rather than left to `exit 1`, and the remedy says how to change the bound.
    results.push({
      name,
      status: outcome.code === 0 ? 'passed' : 'failed',
      detail: outcome.timedOut
        ? `${resolution.detail}: timed out after ${Math.round(timeoutMs / 1000)} s`
        : `${resolution.detail}${outcome.code === 0 ? '' : `: exit ${outcome.code}`}`,
      output: outcome.code === 0 ? '' : tail(outcome.stderr || outcome.stdout),
      ...(outcome.timedOut
        ? { remedy: `fix the hang, raise gates.timeout to give it longer, or set gates.timeout to 0 to remove the bound` }
        : {}),
      adr: gate.adr,
      exitCode: outcome.code,
    });
  }

  // A formatter that rewrote staged files must re-stage them, or the commit
  // records the unformatted bytes while the working tree holds the formatted
  // ones. This is the one case where the hook mutates the index on purpose.
  //
  // Only the files the formatter was actually given, and only when their staged
  // bytes really moved. This used to `git add` every staged path from
  // `--name-only` with no `--diff-filter`, so a commit containing a deletion made
  // the add fail, the catch swallowed it, and the hook reported success while the
  // commit recorded unformatted bytes. It also claimed to have re-staged files
  // whenever anything was staged, formatted or not.
  if (results.some((r) => r.name === 'format' && r.status === 'passed')) {
    const outcome = await restage(root, formatted);
    if (outcome.error) {
      results.push({
        name: 'restage',
        status: 'failed',
        detail: `the formatter passed but its output could not be staged: ${outcome.error}`,
        remedy: 'stage the formatted files yourself and commit again',
        adr: null,
        exitCode: null,
      });
    } else if (outcome.restaged.length > 0) {
      results.push({
        name: 'restage',
        status: 'passed',
        detail: `re-staged ${outcome.restaged.length} file(s) the formatter rewrote: ${outcome.restaged.join(', ')}`,
        adr: null,
        exitCode: 0,
      });
    }
  }

  return { event, gates: results, failed: results.some((r) => r.status === 'failed') };
}

/**
 * The lines that report one event's gate run: the event, what was declared, every
 * gate with its disposition, its reason and its remedy, and the verdict.
 *
 * Shared by `hooks run` and `slice finish` rather than written twice (ADR-002: the
 * second real use is what the extraction exists for). Both run this dispatcher over
 * the same event, and two renderings of one run are two ways for one of them to
 * quietly stop printing a gate that failed.
 *
 * @param {string} event the hook event as git spells it
 * @param {string[]} declared the gate names the manifest declares for it
 * @param {object} result the value `runGates` returned
 * @returns {string[]} the report lines, newline-free, in print order
 */
export function renderGateReport(event, declared, result) {
  const lines = [`hooks    ${event}`, `gates    ${(declared ?? []).join(', ') || '(none declared)'}`];
  for (const g of result.gates) {
    lines.push(`${g.status.toUpperCase().padEnd(8)} ${g.name.padEnd(20)} ${g.detail}${g.adr ? `  [${g.adr}]` : ''}`);
    if (g.remedy) lines.push(`        remedy: ${g.remedy}`);
    if (g.output) lines.push(...g.output.split('\n').map((l) => `        ${l}`));
  }
  lines.push(result.failed ? 'BLOCKED  at least one gate failed' : 'PASSED');
  return lines;
}

async function run(argv, cwd, env, timeoutMs) {
  return await runBounded(argv, { cwd, env, timeoutMs });
}

/** The built-in gates this dispatcher can run, by name. */
const BUILTIN_GATES = new Map([['secret-scan', scanStaged]]);

/** How many findings the report prints; the detail carries the true count. */
const BUILTIN_REPORT_MAX = 12;

/**
 * Run a `builtin` gate in this process (ADR-100).
 * Every outcome is a verdict with a reason: a built-in that does not exist, a
 * diff git cannot read, or a secret found each fail with their own detail —
 * none of them can degrade into a pass, which is the same fail-closed contract
 * an unresolvable script gate has.
 */
async function runBuiltinGate(name, { root, staged, options }) {
  const scan = BUILTIN_GATES.get(name);
  if (scan === undefined) {
    return {
      ok: false,
      detail: `no built-in implementation for gate "${name}"; this is a bug in ${CLI}`,
      remedy: `remove "${name}" from ${MANIFEST_FILE} gates`,
      output: '',
    };
  }
  if (staged.length === 0) {
    return { ok: true, detail: 'nothing staged; no added line to scan', output: '' };
  }
  const result = await scan(root, options ?? {});
  if (result.error !== null) {
    return {
      ok: false,
      detail: `the staged diff could not be read: ${result.error}`,
      remedy: 'the gate fails closed; inspect the repository state and commit again',
      output: '',
    };
  }
  if (result.findings.length === 0) {
    return { ok: true, detail: `${result.lines} added line(s) scanned, no secret found`, output: '' };
  }
  const files = new Set(result.findings.map((f) => f.file));
  const shown = result.findings.slice(0, BUILTIN_REPORT_MAX);
  const more = result.findings.length - shown.length;
  return {
    ok: false,
    detail: `${result.findings.length} probable secret(s) in ${files.size} staged file(s)`,
    remedy:
      'remove the value from the staged file (or unstage it with git restore --staged <path>) ' +
      'and commit again; the report never prints the matched bytes',
    output:
      renderFindings(shown) +
      (more > 0 ? `\n  … ${more} more finding(s) not shown` : ''),
  };
}

/**
 * Run a gate's resolution, as a shell line or as an argv.
 *
 * A declared command is a line the repository wrote in its own manifest and would type
 * into its own shell (ADR-019 ruling 8), so it goes through `sh -c` and everything it
 * wrote survives — quotes, pipes, `&&`, a flag with a space in its value. Everything
 * this tool resolved itself stays an argv, because that is a path this tool chose out of
 * `node_modules/.bin` and handing it to a shell would be a change of trust for no gain.
 *
 * `sh -c` is not a sandbox and is not meant to be. The trust boundary is the repository:
 * the line came from its own manifest, which it can read and change, and it runs on the
 * author's own machine at the author's own request. The only property worth defending is
 * that the two sources stay distinguishable, which is why this is a separate branch
 * rather than a flag on `run`.
 */
async function runGate(resolution, cwd, timeoutMs) {
  // The push override is for the push itself, not for the gates the hook runs.
  // A test that asserts a push is denied sees the override and fails.
  const env = { ...process.env };
  delete env.SIMT_ALLOW;
  if (resolution.shell === true && typeof resolution.command === 'string') {
    return await run(['sh', '-c', resolution.command], cwd, env, timeoutMs);
  }
  return await run(resolution.argv, cwd, env, timeoutMs);
}

async function readPkg(root) {
  try {
    return JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Staged paths, or [] when git cannot answer (an unborn branch, for instance). */
export async function stagedFiles(root) {
  try {
    // NUL-separated: git quotes a path containing a newline or a quote in the line form,
    // and a quoted name is not the path the index holds, so it never matches a staged blob.
    return await gitPaths(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
  } catch {
    return [];
  }
}

/**
 * Paths whose working-tree copy differs from the index - the ones a partial stage
 * leaves behind. Read as a Set because every stage check is a membership test over
 * the same staged list, and this is asked once per run.
 *
 * A path staged as DELETED is not here: the index and the working tree agree that
 * it is gone, so there is no unstaged work to protect and no reason to refuse.
 */
async function unstagedFiles(root) {
  try {
    return new Set(await gitPaths(root, ['diff', '--name-only']));
  } catch {
    return new Set();
  }
}

/** The staged blob hash for each path, or an empty map if git cannot answer. */
async function stagedBlobs(root, files) {
  if (files.length === 0) return new Map();
  try {
    const stdout = await git(root, ['ls-files', '-s', '--', ...files]);
    const blobs = new Map();
    for (const line of stdout.split('\n')) {
      const [meta, ...rest] = line.split('\t');
      if (rest.length === 0) continue;
      const [, sha] = meta.trim().split(/\s+/);
      blobs.set(rest.join('\t'), sha ?? null);
    }
    return blobs;
  } catch {
    return new Map();
  }
}

/**
 * Stage the formatter's output, and report which paths actually moved.
 *
 * The before/after blob comparison is the whole point: a formatter that rewrote
 * nothing is a pass with nothing to report, and a hook that claims otherwise has
 * trained its readers to distrust the lines that matter.
 */
async function restage(root, files) {
  if (files.length === 0) return { restaged: [], error: null };
  const before = await stagedBlobs(root, files);
  try {
    await git(root, ['add', '--', ...files]);
  } catch (error) {
    return { restaged: [], error: String(error.stderr ?? error.message ?? error).trim() };
  }
  const after = await stagedBlobs(root, files);
  const restaged = files.filter((f) => before.get(f) !== after.get(f));
  return { restaged, error: null };
}

/** Last few lines of output, for a failure a human or agent has to act on. */
function tail(text, lines = 12) {
  const parts = String(text).trimEnd().split('\n');
  return parts.slice(-lines).join('\n');
}
