// The `--line` status cache (plan 0003 R48).
//
// `status --line` is for shell prompts, tmux and agent status lines: it must
// answer in well under 50 ms, which rules out everything `check` does (rule
// loading, projection, gate probing). So `check` — the one command that
// already measures all of it — writes `.simt/check.json` on every run, and
// `--line` reads only that file plus one `git rev-parse HEAD` to notice new
// commits. No fingerprint, no rule reads, no capability probe.
//
// Three honesties, each a failure this module refuses to be:
//
//   - The cache is local state, never content (the same standing as the
//     journal, the ledger and the index). Writers that change files `check`
//     reads (`init`, `sync`, `upgrade`, `hooks install`, `undo`) delete it
//     when they apply, so the line goes back to "no cache" instead of
//     reporting the tree as it was. Hand edits between checks are the
//     documented blind spot: the line is the gate state *as of the last
//     check*, and says `stale` only when HEAD moved.
//   - A blocking finding that fits no slot still fails the line. The version
//     pin, an invalid rule, a bad gate cwd — none of these is rules, hooks
//     or gates-count, and a line that showed all slots green while the gate
//     fails would be the lie prompts are for. So PASS/FAIL is carried
//     explicitly rather than inferred from the symbols.
//   - The write is atomic (tmp + rename) and fixed-size: only counts and
//     booleans are stored, never findings, so a huge gate still leaves a
//     ~200-byte file and a killed `check` never leaves half a document.

import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { readHooksState, wantsShim } from './compare/hooksstate.mjs';
import { STATE_DIR } from './name.mjs';

const exec = promisify(execFile);

const CACHE_FILE = join(STATE_DIR, 'check.json');
const CACHE_VERSION = 1;

/**
 * The commit the cached state was measured at, or null when git cannot say
 * (not a repository, no commits yet, git missing). Null is trust, not failure:
 * without a HEAD there is nothing to compare, and refusing the line would
 * make exported trees — the ones with no `.git` at all — unreportable.
 */
export async function currentHead(root) {
  try {
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function cachePath(root) {
  return join(root, CACHE_FILE);
}

/**
 * Add the when and the where to a check-measured summary. The summary itself
 * is built by `check`, which is the only command that measures all of it;
 * this only stamps it.
 */
export async function buildCacheRecord(root, summary) {
  return {
    version: CACHE_VERSION,
    at: Date.now(),
    head: await currentHead(root),
    rulesOk: summary.rulesOk,
    hooksOk: summary.hooksOk,
    gatesRun: summary.gatesRun,
    gatesTotal: summary.gatesTotal,
    blocking: summary.blocking,
    warnings: summary.warnings,
  };
}

/** Atomically replace the cache. A killed `check` leaves the previous record, not half of one. */
export async function writeCheckCache(root, record) {
  const path = cachePath(root);
  await mkdir(join(root, STATE_DIR), { recursive: true });
  const body = `${JSON.stringify(record)}\n`;
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
}

/** The last record `check` wrote, or null when it never ran (or a writer invalidated it). */
export async function readCheckCache(root) {
  let raw;
  try {
    raw = await readFile(cachePath(root), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const record = JSON.parse(raw);
    if (record.version !== CACHE_VERSION) return null;
    return record;
  } catch {
    // A damaged cache is no cache: the next `check` rewrites it, and a prompt
    // that refused to render over a corrupt byte would stay broken until then.
    return null;
  }
}

/**
 * Forget the cached state. Called by writers that change files `check` reads,
 * after they apply — never on preview or dry-run, where nothing changed and
 * the record is still true.
 */
export async function invalidateCheckCache(root) {
  try {
    await unlink(cachePath(root));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
}

/**
 * The hooks slot of the line: every declared gate routed through a current
 * shim. A repository that declares no gate has nothing to enforce, so the
 * slot is vacuously true rather than forever red (the same answer `init`
 * prints in prose). Gates run/total is counted by `check` from the runnable
 * verdicts, not here: routing and runnability are different slots.
 */
export async function hooksSummary(root, manifest, exists) {
  const declared = [...(manifest?.gates?.preCommit ?? []), ...(manifest?.gates?.prePush ?? [])];
  const evidence = manifest?.gates?.evidence === 'warn' || manifest?.gates?.evidence === 'block';
  if (declared.length === 0 && !evidence) return { ok: true };
  const state = await readHooksState(root, { declaresGate: (event) => wantsShim(manifest, exists, event) });
  return { ok: state.complete };
}

/**
 * One line, always: `simt PASS ✓rules ✓hooks 3/3gates`, longest honest case
 * `simt FAIL ✗rules ✗hooks 0/12gates ⚠9 stale`. Counts stay small because they
 * count gates and warnings, never findings; the ≤ 60-char budget is asserted
 * on a synthetic worst case, not on the hope that gates stay few.
 */
export function renderStatusLine(record, stale) {
  const outcome = record.blocking === 0 ? 'PASS' : 'FAIL';
  const rules = record.rulesOk ? '✓rules' : '✗rules';
  const hooks = record.hooksOk ? '✓hooks' : '✗hooks';
  let line = `simt ${outcome} ${rules} ${hooks} ${record.gatesRun}/${record.gatesTotal}gates`;
  if (record.warnings > 0) line += ` ⚠${record.warnings}`;
  if (stale) line += ' stale';
  return line;
}
