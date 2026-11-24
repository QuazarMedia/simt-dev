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
import { join } from 'node:path';

import { GATES, getGate } from './gates.mjs';
import { preparePushTree } from './head-worktree.mjs';
import { resolveGateCwd } from './cwd.mjs';
import { resolveGate } from './resolve.mjs';
import { resolveNodeRunner } from '../ecosystem/node-runner.mjs';
import { readManifest } from '../projection/manifest.mjs';
import { CLI } from '../name.mjs';
import { MANIFEST_FILE } from '../name.mjs';
import { assertVersionPin } from '../package-version.mjs';
import { recordRun } from '../ledger/index.mjs';
import { renderFindings, scanStaged } from '../secrets.mjs';
import { git, gitPaths, gitText } from '../sys/git.mjs';
import { ZERO_SHA, parsePushedRefs, resolveAlreadyPassedSkip, resolveNonCodeSkip } from './push-skip.mjs';
import { focusedGate, focusedThreshold, rerunFailures, rerunGate } from './focused-push.mjs';
import { focusedRunTimeoutMs } from '../testing/focused-run.mjs';
import { parseTestReport } from '../testing/parsers.mjs';
import { gateTimeoutMs, toolchainIdentity } from '../util/gates.mjs';
import { tail } from '../util/text.mjs';

// The classification API stays importable from this module: `hooks` is what a consumer
// already imports, and the extraction is a file split, not a change of surface.
export { DEFAULT_SKIP_EXTENSIONS, classifyPush, parsePushedRefs } from './push-skip.mjs';

/** The grace a killed gate gets before SIGKILL: a test runner waiting on a socket that
 *  never closes blocks the commit with no output, and there is no way to tell a hang
 *  from slow work. */
const KILL_GRACE_MS = 5000;


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

/** Gates that are known but not required for the event to pass. */
const DEFAULT_EVENTS = { 'pre-commit': 'preCommit', 'pre-push': 'prePush' };

/** A declared gate list as the manifest must carry it: names, and nothing else. */
function isNonEmptyStringList(value) {
  return Array.isArray(value) && value.every((name) => typeof name === 'string' && name !== '');
}

/** What a wrong value is, in words a reader can act on without inspecting the JSON. */
function describeShape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list with an entry that is not a gate name';
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value} (${JSON.stringify(value)})`;
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

  // A push is gated per revision, not per checkout: the ref list names revisions the
  // caller's HEAD may not be, and a branch carries its own manifest. This is the one
  // event where the tree a gate runs in and the tree the caller stands in differ.
  if (event === 'pre-push') return runPushGates({ root, manifest, pushed });

  const prepared = prepareDeclaration(manifest, key, event);
  if (prepared.result) return prepared.result;
  return runGatesAt(event, { root, ledgerRoot: root, manifest, declared: prepared.declared, key });
}

/**
 * The declaration checks every event shares: a list this build cannot read, an empty
 * one, and a version pin that does not match the binary about to run the gates.
 * Returns either the report to return early or the list to run.
 */
function prepareDeclaration(manifest, key, event) {
  const declared = manifest?.gates?.[key];
  // A declaration this build cannot read is a failed gate, not an empty one. The first
  // version treated a string or a number exactly like an absent list, so a push with a
  // malformed `gates.prePush` printed "nothing runs" and exited 0 - a configuration
  // error reported as a successful gate, which is the worst answer a gate can give.
  if (declared !== undefined && !isNonEmptyStringList(declared)) {
    return { result: { event, gates: [configGate(key, declared)], failed: true } };
  }
  if (!Array.isArray(declared) || declared.length === 0) {
    // An array, not a string. This field sat next to `gates` as a bare string while
    // the caller iterated it, so an empty gate list printed one note line per
    // character — 180 lines of noise in a hook whose only job is to be readable.
    // Only reachable on a repo that has no formatter and no linter, so the one path
    // where an author's patience is already spent.
    return {
      result: {
        event,
        gates: [],
        failed: false,
        notes: [
          `nothing runs on ${event}: ${MANIFEST_FILE} declares no gates.${key}. That is a valid ` +
            `answer when the repo has no tool for any of them - \`${CLI} check\` reports each ` +
            `gate it could not run and why - but it is also what an unfiltered default looks like.`,
        ],
      },
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
      result: {
        event,
        gates: [{ name: 'version', status: 'failed', detail: mismatch, remedy: `run: ${CLI} upgrade --yes`, adr: null }],
        failed: true,
      },
    };
  }
  return { declared };
}

/** The one gate a malformed declaration reports, in the words a reader can act on. */
function configGate(key, declared) {
  return {
    name: 'config',
    status: 'failed',
    detail: `${MANIFEST_FILE} gates.${key} must be a list of gate names; it is ${describeShape(declared)}`,
    remedy: `fix gates.${key} in ${MANIFEST_FILE} by hand; an empty list is a valid declaration`,
    adr: null,
  };
}

/**
 * The distinct commits a push delivers, each with every ref that carries it.
 *
 * An annotated tag's pre-push sha is the tag OBJECT, so every ref is dereferenced to its
 * commit before it is used as a worktree revision; a branch and a tag that deliver the
 * same commit are one target, because running the gates twice on one tree proves nothing
 * the first run did not. A ref that does not resolve to a commit is carried with
 * `revision: null` and reported as its own failure.
 */
async function pushedRevisions(root, refs) {
  const byRevision = new Map();
  for (const ref of refs) {
    if (ref.localSha === ZERO_SHA) continue;
    let revision = null;
    try {
      revision = await gitText(root, ['rev-parse', `${ref.localSha}^{commit}`]);
    } catch {
      // Reported by the target, not swallowed: a pushed object this repository cannot
      // read is exactly the case that must fail closed.
    }
    const key = revision ?? ref.localSha;
    const at = byRevision.get(key) ?? { revision, object: ref.localSha, refs: [] };
    if (!at.refs.includes(ref.ref)) at.refs.push(ref.ref);
    byRevision.set(key, at);
  }
  return [...byRevision.values()];
}

/**
 * Gate every revision a push delivers, once per distinct commit.
 *
 * A manual run (no ref list on stdin) is a push of HEAD, and says so: the gates run
 * against the committed HEAD tree exactly as they would for a push, which is the only
 * basis a hook can name when git told it nothing.
 */
async function runPushGates({ root, manifest, pushed }) {
  const notes = [];
  const parsed = pushed === undefined || String(pushed).trim() === '' ? null : parsePushedRefs(pushed);
  let targets;
  if (parsed === null || parsed.error !== null) {
    let head = null;
    try {
      head = await gitText(root, ['rev-parse', 'HEAD^{commit}']);
    } catch {
      // Unborn HEAD: reported as the target's failure below.
    }
    // A manual run's basis is the caller's manifest, so its declaration is answered
    // before any worktree exists - the order every other event uses, and the one that
    // lets "this repository declares no pre-push gate" be the whole answer.
    const early = manifest === null || manifest === undefined ? { declared: [] } : prepareDeclaration(manifest, 'prePush', 'pre-push');
    if (early.result) return { ...early.result, targets: [], notes: [...(early.result.notes ?? []), ...notes] };
    // `HEAD` rather than the literal sha when the branch is unborn, so the failure names
    // the reference the reader typed rather than a null.
    targets = [{ revision: head ?? 'HEAD', object: head ?? 'HEAD', refs: ['HEAD'], manual: true }];
    notes.push(
      head === null
        ? 'manual run: there is no ref list on stdin and no commit at HEAD, so there is no tree to run a gate against'
        : `manual run: no ref list on stdin, so the gates run against HEAD (${head.slice(0, 12)})`,
    );
    if (parsed?.error !== null && parsed?.error !== undefined) {
      notes.push(`the push ref list could not be read (${parsed.error}); the gates run against HEAD instead`);
    }
  } else {
    const refs = parsed.refs ?? [];
    const deletions = refs.filter((r) => r.localSha === ZERO_SHA);
    if (deletions.length > 0) {
      notes.push(`deletion(s) push no tree, so nothing runs for: ${deletions.map((d) => d.ref).join(', ')}`);
    }
    targets = await pushedRevisions(root, refs);
    if (targets.length === 0) {
      // A deletion-only push delivers no tree, but it is still a push: the classifier
      // earns the non-code skip on the deletions themselves, and the other gates run
      // against HEAD, which is the only tree the caller can name.
      let head = null;
      try {
        head = await gitText(root, ['rev-parse', 'HEAD^{commit}']);
      } catch {
        // Unborn HEAD: reported by the target's own gate below.
      }
      targets = [{ revision: head ?? 'HEAD', object: head ?? 'HEAD', refs: deletions.map((d) => d.ref), manual: true }];
      notes.push(
        'the push carries deletions only, so there is no pushed tree; the gates run against HEAD and the non-code classification reports the deletions',
      );
    }
  }

  const results = [];
  for (const target of targets) {
    results.push({ manual: target.manual === true, ...(await runPushTarget(root, manifest, target, pushed, notes)) });
  }
  // A target's own notes ("nothing runs", "this revision's manifest cannot be read")
  // are part of the run's answer, and `hooks run` prints the top-level list. A multi-
  // target run prefixes each with its revision so the note says which tree it is about.
  const targetNotes = results.flatMap((r) =>
    (r.notes ?? []).map((n) => (results.length > 1 ? `${r.revision === null ? r.ref : r.revision.slice(0, 12)}: ${n}` : n)),
  );
  return {
    event: 'pre-push',
    // Flat as well as grouped: a caller that only wants the verdict keeps the shape it
    // had, and each gate names the ref and revision it belongs to.
    gates: results.flatMap((r) => r.gates.map((g) => ({ ...g, ref: r.ref, revision: r.revision }))),
    targets: results,
    failed: results.some((r) => r.failed),
    notes: [...targetNotes, ...notes],
  };
}

/** One revision a push delivers: its tree, its declaration, its gates and its cleanup. */
async function runPushTarget(root, callerManifest, target, pushed, notes) {
  const label = target.refs.join(', ');
  const revision = target.revision;
  if (revision === null) {
    return {
      ref: label,
      revision: null,
      basis: null,
      gates: [
        {
          name: 'head',
          status: 'failed',
          detail: `the pushed object ${String(target.object).slice(0, 12)} is not a commit this repository can check out`,
          remedy: 'push a revision this repository has, or fetch the missing objects and push again',
          adr: null,
        },
      ],
      failed: true,
    };
  }
  const prepared = await preparePushTree(root, revision);
  if (prepared.path === null) return { ref: label, revision, basis: null, gates: [prepared.gate], failed: true };
  try {
    // The declaration and the toolchain come from the tree the gates run in: a branch
    // that changes simt.json changes what its own push is gated by, and the caller's
    // checkout is not the authority on either.
    const loaded = await readManifest(prepared.path);
    if (loaded.exists && loaded.manifest === null) {
      return {
        ref: label,
        revision,
        basis: 'revision',
        gates: [
          {
            name: 'config',
            status: 'failed',
            detail: `${MANIFEST_FILE} in ${revision.slice(0, 12)} cannot be read: ${loaded.error}`,
            remedy: 'fix the manifest in that revision and push it again',
            adr: null,
          },
        ],
        failed: true,
      };
    }
    let basis = 'revision';
    let basisManifest = loaded.manifest;
    if (!loaded.exists) {
      // A revision adopted before its manifest landed still has to be gated by
      // something. The caller's declaration is the only one on offer, and the target
      // row says so rather than claiming the revision declared it.
      basis = 'caller';
      basisManifest = callerManifest ?? null;
      if (basisManifest === null) {
        return {
          ref: label,
          revision,
          basis: null,
          gates: [
            {
              name: 'config',
              status: 'failed',
              detail: `neither ${revision.slice(0, 12)} nor the caller checkout carries ${MANIFEST_FILE}, so the gate list is unknown`,
              remedy: `commit ${MANIFEST_FILE} into the pushed revision, then push again`,
              adr: null,
            },
          ],
          failed: true,
        };
      }
      notes.push(`${revision.slice(0, 12)} carries no ${MANIFEST_FILE}; its gates are the caller checkout's declaration`);
    }
    const declaration = prepareDeclaration(basisManifest, 'prePush', 'pre-push');
    if (declaration.result) {
      return {
        ref: label,
        revision,
        basis,
        gates: declaration.result.gates,
        failed: declaration.result.failed,
        notes: declaration.result.notes ?? [],
      };
    }
    // A non-code push skips `test` for every revision it carries (ADR-147); a tree the
    // author already proved green skips it on that evidence (ADR-120), matched against
    // the revision's own tree rather than HEAD's.
    const skipTest =
      (await resolveNonCodeSkip(root, basisManifest, pushed)) ?? (await resolveAlreadyPassedSkip(root, revision));
    // A push at or below `gates.prePushFocusedCommits` runs only the tests that import
    // its files; anything larger keeps the full suite (ADR-258). The declaration is the
    // pushed revision's, like the skips above. A `test` gate the repository declared as
    // a command cannot take file arguments, so it never focuses.
    let focusTest = null;
    if (skipTest === null && declaration.declared.includes('test')) {
      const declared = basisManifest?.gates;
      const thresholdValue = declared?.prePushFocusedCommits;
      focusTest = await focusedThreshold(root, pushed, {
        threshold: Number.isInteger(thresholdValue) && thresholdValue > 0 ? thresholdValue : 1,
        commandTest: typeof declared?.commands?.test === 'string',
      });
    }
    // A failed `test` run recorded at exactly one commit below the pushed HEAD, with a
    // test-only commit in between, re-runs exactly the failing ids it recorded (ADR-258):
    // a subset of whatever the threshold path would run, so it never widens the gate.
    let rerun = null;
    if (skipTest === null && declaration.declared.includes('test')) {
      rerun = await rerunFailures(root, revision);
    }
    // The tree is materialised for every pre-push, including one that skips `test`: lint and
    // format must see the commit being pushed, not the author's uncommitted edits.
    const run = await runGatesAt('pre-push', {
      root: prepared.path,
      ledgerRoot: root,
      manifest: basisManifest,
      declared: declaration.declared,
      key: 'prePush',
      skipTest,
      focusTest,
      rerun,
      // Named on every ledger line: the revision whose tree this line is about.
      subjectRevision: revision,
    });
    return { ref: label, revision, basis, gates: run.gates, failed: run.failed };
  } finally {
    await prepared.done();
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
 * @param {string[]|null} [ctx.focusTest] set when a push is small enough for the focused
 *   threshold (ADR-258): the `test` gate runs the tests that import these files, recorded as
 *   `kind: 'test-focused'`, in place of the full suite
 * @param {{files: string[], ids: string[], at: string}|null} [ctx.rerun] set when the
 *   re-run lever fires (ADR-258): the `test` gate re-runs exactly the recorded failing ids
 *   before the threshold path would run
 * @returns {Promise<{event: string, gates: object[], failed: boolean}>}
 */
async function runGatesAt(event, { root, ledgerRoot, manifest, declared, key, skipTest = null, focusTest = null, rerun = null, subjectRevision = null }) {
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

    // The `test` gate's two focused paths share one execution context; only the selection
    // and the reason line differ. The re-run lever comes first - it is a subset of what
    // the threshold path runs - and a `null` row from either falls through to the next
    // path, ending at the full suite: more runs, never fewer.
    const focusedCtx = { root, ledgerRoot, spec: manifest?.test?.runner ?? null, name, adr: gate.adr, subjectRevision, toolchain: toolchainIdentity(runner) };
    if (rerun !== null && name === 'test') {
      const ms = gateTimeoutMs(timeouts, name);
      const row = await rerunGate({ ...focusedCtx, timeoutMs: ms === 0 ? focusedRunTimeoutMs() : ms, rerun });
      if (row !== null) { results.push(row); continue; }
    }

    // The focused threshold runs the `test` gate over the tests that import the pushed
    // files instead of the full suite (ADR-258).
    if (focusTest !== null && name === 'test') {
      const ms = gateTimeoutMs(timeouts, name);
      const row = await focusedGate({ ...focusedCtx, files: focusTest, timeoutMs: ms === 0 ? focusedRunTimeoutMs() : ms });
      if (row !== null) { results.push(row); continue; }
    }

    // Where the gate runs is part of resolving it: a `gates.cwd` entry selects a nested
    // package's own script and its own binaries, so resolution happens in that scope
    // rather than at the root and is moved afterwards. `check` answers the same question
    // through the same resolver, so a finding and a run cannot disagree.
    const placement = await resolveGateCwd(root, cwds[name], name);
    if (!placement.ok) {
      results.push({ name, status: 'failed', detail: placement.detail, remedy: placement.remedy, adr: gate.adr });
      continue;
    }
    // A staged gate is handed repository-relative paths, so it runs at the root whatever
    // `gates.cwd` says: resolving its binary from the package directory while passing
    // root-relative paths is the pairing that made a nested formatter fail on files it
    // was never given. The declaration is still validated above, so a broken one is loud.
    const cwd = gate.kind === 'staged' ? root : placement.path;
    const scopedPkg = cwd === root ? pkg : await readPkg(cwd);
    const resolution = await resolveGate(gate, { root: cwd, pkg: scopedPkg, staged, commands, runner, fallbackRoot: root });
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
          subject: root,
          revision: subjectRevision,
          toolchain: toolchainIdentity(null),
          outcome: outcome.ok ? 'passed' : 'failed',
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

    const timeoutMs = gateTimeoutMs(timeouts, name);
    const started = Date.now();
    const outcome = await runGate(resolution, cwd, timeoutMs);
    // A gate that ran out of time is not a pass, whatever code its process managed to
    // exit with: a child that traps SIGTERM and exits 0 used to reach the pass path and
    // leave a green ledger line for a run the bound had already failed.
    const passed = outcome.code === 0 && !outcome.timedOut;
    const recordedExit = outcome.timedOut && outcome.code === 0 ? 1 : outcome.code;
    const outputText = `${outcome.stdout ?? ''}\n${outcome.stderr ?? ''}`;
    // A failed `test` run leaves the failing test ids in its ledger line, so the next
    // push can re-run exactly them (ADR-258). Ids, not logs: the output digest keeps
    // the detail. Output the parser cannot read carries none.
    let failedTests = null;
    if (name === 'test' && !passed) {
      const report = parseTestReport(outputText);
      if (report !== null && report.failed.length > 0) failedTests = report.failed;
    }
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
        exit: recordedExit,
        ms: Date.now() - started,
        output: outputText,
        gate: name,
        kind,
        ...(failedTests !== null ? { failedTests } : {}),
        // The tree the gate actually ran in, not the tree the ledger lives in: for a
        // pre-push run those differ, and the skip query reads this line.
        subject: root,
        revision: subjectRevision,
        toolchain: toolchainIdentity(runner),
        ...(cwd !== root ? { cwd } : {}),
        outcome: outcome.timedOut ? 'timeout' : passed ? 'passed' : 'failed',
      });
    } catch {
      // Recorded by absence: the next evidence read for this tree has no line.
    }
    // A killed gate has no exit code of its own (`signal` instead), so the reason is
    // stated rather than left to `exit 1`, and the remedy says how to change the bound.
    results.push({
      name,
      status: passed ? 'passed' : 'failed',
      detail: outcome.timedOut
        ? `${resolution.detail}: timed out after ${Math.round(timeoutMs / 1000)} s`
        : `${resolution.detail}${outcome.code === 0 ? '' : `: exit ${outcome.code}`}`,
      output: passed ? '' : tail(outcome.stderr || outcome.stdout),
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
  const lines = [`hooks    ${event}`];
  const gateLines = (gates) => {
    const out = [];
    for (const g of gates) {
      out.push(`${g.status.toUpperCase().padEnd(8)} ${g.name.padEnd(20)} ${g.detail}${g.adr ? `  [${g.adr}]` : ''}`);
      if (g.remedy) out.push(`        remedy: ${g.remedy}`);
      if (g.output) out.push(...g.output.split('\n').map((l) => `        ${l}`));
    }
    return out;
  };
  const targets = result.targets ?? [];
  // A push that delivers a revision other than the caller's HEAD is reported per
  // target: the ref, the revision and the verdict, because "the gates passed" about a
  // tree the push did not carry is the answer this report exists not to give.
  const grouped = targets.length > 1 || targets.some((t) => t.manual !== true);
  if (grouped) {
    for (const target of targets) {
      lines.push(
        `target   ${target.ref}  ${target.revision === null ? '(no commit)' : target.revision.slice(0, 12)}  basis: ${target.basis ?? 'unknown'}`,
      );
      lines.push(...gateLines(target.gates));
    }
  } else {
    lines.push(`gates    ${(declared ?? []).join(', ') || '(none declared)'}`);
    lines.push(...gateLines(result.gates));
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

