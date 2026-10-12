// Read a repo's hook routing and shim state without changing anything.
//
// This is the read half of what `simt-dev hooks status` does inline. It is a separate
// module because two callers need it - `hooks status` and `simt-dev compare` - and a
// second implementation of "is this shim current?" would be exactly the
// duplicated-source-of-truth problem the tool exists to remove. `compare` reads it
// for N repos, so it must not shell out per repo per event.

import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { CHAIN_MARKER, EVENTS, HOOKS_DIR, HOOKS_PATH_KEY, SHIM_MARKER, fileFor, renderShim } from '../hooks/shim.mjs';
import { foreignHooks, resolveHooksDir } from '../hooks/where.mjs';
import { packageVersion, hasNpm } from '../package-version.mjs';

const exec = promisify(execFile);

/**
 * The chained shim at `path`, read back out of the file itself.
 *
 * Content, for the reason given on `CHAIN_MARKER`: the file is named after the
 * repository's hook, so the name is exactly the thing that cannot identify it.
 *
 * The target is parsed out of the file rather than remembered from install time
 * because the only authority on what a shim does is the shim. A re-install has to
 * render the identical bytes, and rendering them from a remembered target would let
 * the two drift the moment a repository moved.
 *
 * @param {string} path
 * @returns {Promise<{event:string, target:string}|null>}
 */
async function readChainedShim(path) {
  let content;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  if (!content.includes(CHAIN_MARKER)) return null;
  const target = /^TARGET='(.+)'$/m.exec(content);
  const event = /^# simt-dev does not gate (\S+),/m.exec(content);
  if (!target || !event) return null;
  return { event: event[1], target: target[1] };
}

/** Whether this file is a chained shim this tool wrote. */
async function isChainedShim(path) {
  return (await readChainedShim(path)) !== null;
}

/**
 * Whether this file is a dispatcher shim this tool wrote, whatever version wrote it.
 *
 * Content, on the same argument as {@link readChainedShim}: the name is what git calls
 * it and the path is where this tool happens to put its own, and neither of those is a
 * statement about authorship. The banner is.
 */
async function isOurShim(path) {
  try {
    return (await readFile(path, 'utf8')).includes(SHIM_MARKER);
  } catch {
    return false;
  }
}

/** Git event -> manifest gate list. Exported because the report prints from it too. */
export const GATE_KEY = { 'pre-commit': 'preCommit', 'pre-push': 'prePush' };

/** Gates this manifest declares for an event. */
export function gateCount(manifest, event) {
  return (manifest?.gates?.[GATE_KEY[event]] ?? []).length;
}

/**
 * Whether a missing shim for this event is a defect.
 *
 * A repo that declares no gate for an event has no reason to want a shim for it, so
 * its absence is the correct end state. A repo with NO manifest is different: we do
 * not know what it wants, so we cannot rule the shim out - absence of knowledge is
 * not a decision.
 *
 * It lives here, not in the command that first needed it, because there are two
 * callers and they were answering differently. `hooks install` asked this question;
 * `compare` did not ask it at all and defaulted to "yes, a shim is wanted for every
 * event", so a repository declaring only `prePush` gates was reported as
 * `hooksComplete: false` for the pre-commit shim it correctly has no reason to write.
 * Four estate repositories were in that state and no amount of running `hooks install`
 * could clear it.
 *
 * @param {object|null} manifest the repository's manifest
 * @param {boolean} exists whether a manifest was found at all
 * @param {string} event
 */
export function wantsShim(manifest, exists, event) {
  if (!exists) return true;
  return gateCount(manifest, event) > 0;
}

/** `core.hooksPath`, or null when unset or the repo is not a git repo. */
export async function readHooksPath(root) {
  try {
    const { stdout } = await exec('git', ['config', '--get', HOOKS_PATH_KEY], { cwd: root });
    const value = stdout.trim();
    return value === '' ? null : value;
  } catch {
    return null;
  }
}

/**
 * One shim's state. A shim that differs from what this simt-dev generates is
 * `stale`: the gates it enforces are from another version, so it cannot be
 * assumed to know about a gate added since.
 *
 * `ours` is reported rather than inferred from `stale`, because the two answer different
 * questions and only one is the one `hooks install` has to ask. A shim this tool wrote can be
 * current (identical bytes), or from an earlier release (stale), or a shell it left behind for
 * an event with no gates - also stale, and the one thing here that is obsolete rather than out
 * of date. A file a person wrote by hand is stale too, and it is the one thing install must
 * never delete. Authorship is only on the file, which is the same argument {@link isOurShim}
 * already records for the same reason.
 *
 * `root` is the repository the shim belongs to: the remedy a shim prints depends on
 * the repo's kind (a devDependency where package.json exists, a pinned global install
 * where there is none), so the comparison must render the shim the way THIS repo got it,
 * or a non-npm repository would read as stale the moment this tool ships.
 */
async function describeShim(path, root) {
  let content;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    return { present: false, executable: false, stale: false, ours: false };
  }
  let info;
  try {
    info = await stat(path);
  } catch {
    return { present: false, executable: false, stale: false, ours: false };
  }
  let stale = true;
  try {
    stale = content !== renderShim(basename(path), { npm: await hasNpm(root), version: packageVersion() });
  } catch {
    stale = true;
  }
  return { present: true, executable: (info.mode & 0o111) !== 0, stale, ours: content.includes(SHIM_MARKER) };
}

/**
 * @param {string} root
 * @param {{declaresGate?: (event:string)=>boolean}} [options] a missing shim is
 *   only a problem when the repo has a gate that shim would enforce.
 * @returns {Promise<{current:string|null, routed:boolean, complete:boolean,
 *                    installed:object[], foreign:object[], liveDir:string|null,
 *                    problems:string[]}>}
 */
export async function readHooksState(root, options = {}) {
  const declaresGate = options.declaresGate ?? (() => true);
  const current = await readHooksPath(root);
  const installed = [];
  for (const event of EVENTS) {
    installed.push({ event, ...(await describeShim(join(root, fileFor(event)), root)) });
  }

  // What git runs right now, which is not the same question as "is a simt-dev
  // shim installed". Before this existed the tool read an unset core.hooksPath
  // as "no hooks" and reported a live hand-written hook as not installed.
  const where = await resolveHooksDir(root);
  const live = where.how === 'not-a-repo' ? [] : await foreignHooks(root);
  // A shim is also called `pre-commit`, so the name cannot tell ours from a
  // hand-written one. Only the bytes can.
  const foreign = [];
  const chained = [];
  const staleOurs = [];
  for (const hook of live) {
    const shim = EVENTS.includes(hook.event) ? await describeShim(hook.path, root) : { stale: true };
    if (!shim.stale) continue;
    // A chained shim is ours too, and its name says nothing: `post-commit` is what the
    // repository called its own hook, and the shim exists under that name precisely so
    // git finds it. Reading it as foreign would make every re-install refuse with "this
    // repo already runs hooks simt did not write" - a shim this tool wrote, refusing
    // itself. Identity is content, the same rule as the dispatcher shim above.
    const chain = await readChainedShim(hook.path);
    if (chain) {
      chained.push({ ...chain, path: hook.path });
      continue;
    }
    // And so is a dispatcher shim from an EARLIER version of this tool, which is the
    // ordinary state of every repository adopted before the last release.
    //
    // Reading it as foreign was wrong twice over. `compare` reported "not a simt-dev
    // shim" about a file simt-dev wrote, and `hooks install --yes` then printed "stopped
    // running <event> ... declare it in simt.json gates.commands to have the dispatcher
    // run it" — advice that, followed, makes the dispatcher run the dispatcher. The file
    // was also described as "still on disk, untouched" in the same breath as the install
    // overwrote it. Both statements were false and both pointed a reader at a worse
    // configuration; nine estate repositories were in exactly this state.
    //
    // What it actually needs is refreshing, which `installed` already reports as `stale`
    // and `compare` already reports as "differs from this simt-dev; reinstall". Keeping
    // it out of `foreign` also stops the takeover guard asking for consent the
    // repository has already given: it routed through this tool once.
    if (await isOurShim(hook.path)) {
      staleOurs.push(hook);
      continue;
    }
    foreign.push(hook);
  }

  const problems = [];
  for (const i of installed) {
    if (!declaresGate(i.event)) continue;
    if (!i.present) problems.push(`${i.event} not installed`);
    else if (!i.executable) problems.push(`${i.event} is not executable`);
    else if (i.stale) problems.push(`${i.event} differs from this simt-dev; reinstall`);
  }
  for (const f of foreign) {
    problems.push(`git runs ${f.event} at ${f.path} (${f.bytes} bytes), which is not a simt-dev shim`);
  }

  return {
    current,
    routed: current === HOOKS_DIR,
    // Complete means routed AND every shim present, executable and current. A repo
    // can route correctly while a shim is missing, which looks installed and is not.
    complete: current === HOOKS_DIR && problems.length === 0,
    installed,
    foreign,
    // Dispatcher shims this tool wrote in an earlier version. Reported so a reader can
    // tell an out-of-date shim - which `hooks install` refreshes - from one this tool
    // has never heard of, which only a human may decide to replace.
    staleOurs,
    // The chained shims this repo is already running, read back off disk. `install`
    // re-renders them from here so a second run keeps maintaining them rather than
    // quietly forgetting them; without this field the set of things install maintains
    // would depend on whether the operator happened to run it twice.
    chained,
    liveDir: where.dir,
    problems,
  };
}

export { HOOKS_DIR, HOOKS_PATH_KEY };