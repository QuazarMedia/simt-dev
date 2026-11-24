// The selection-plus-execution path `simt gate` and the pre-push focused threshold share.
//
// Given a file set, it selects the tests that import those files (ADR-094) and runs
// exactly them through the same bounded spawn `simt gate` always used. The hook
// dispatcher is the second real caller, so the loop lives here rather than in both
// (ADR-002). Nothing re-implements selection or runner detection; a caller that
// already selected (the `--precise` path) hands in the list and skips the graph read.

import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { coverage } from '../index/coverage.mjs';
import { readGateGraph } from '../index/gate.mjs';
import { packageOf } from '../index/store.mjs';
import { cmp } from '../util/sort.mjs';
import { compactReport } from '../index/compact.mjs';
import { commandAvailable } from './contract.mjs';
import { readReports } from './parsers.mjs';
import { detectTestRunner } from './runners.mjs';
import { spawnBounded } from '../sys/proc.mjs';

/**
 * How long one focused run may take, overridable for a test that must not wait for it.
 *
 * The gate used its own `execFile` with no deadline, so a hung runner held the commit
 * forever and the author's only exit was `--no-verify`. The hook dispatcher and the bench
 * already run through `spawnBounded`; the focused gate shares that bound here.
 */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/** The deadline for one run, resolved at run time so a test can shorten it. */
export function focusedRunTimeoutMs() {
  return Number(process.env.SIMT_GATE_TIMEOUT_MS ?? 0) || DEFAULT_TIMEOUT_MS;
}

/**
 * Run the already-selected test files, grouped by package.
 *
 * The per-package contract is the gate command's: detect the runner from the package's
 * own manifest, refuse a declared runner that is not installed (unsupported, not a
 * failing test), build its argv with the selected files, and spawn it bounded. `output`
 * is the raw runner text of every group: the ledger parses it for failure identities,
 * and a report the runner wrote to a file is read in here, not by the caller.
 *
 * @param {string} root the repository the files are relative to
 * @param {string[]} selected test files, repository-relative
 * @param {{spec?: object|null, timeoutMs?: number}} [options] the manifest's `test.runner`
 *   declaration, if any; the deadline defaults to {@link focusedRunTimeoutMs}
 * @returns {Promise<{code: number, runs: object[], output: string, text: string[], unproven: string[]}>}
 *   `runs` is one record per package group; `unproven` names selected files the runner
 *   output never mentioned, so a selector-ignoring runner cannot read as a pass.
 */
export async function executeFocused(root, { selected, spec = null, timeoutMs = focusedRunTimeoutMs() }) {
  const cache = new Map();
  const groups = new Map();
  for (const file of selected) {
    const pkg = await packageOf(root, file, cache);
    const list = groups.get(pkg);
    if (list) list.push(file);
    else groups.set(pkg, [file]);
  }
  const runs = [];
  let code = 0;
  const text = [];
  const rawParts = [];
  for (const [pkg, files] of [...groups.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    const relative = files.map((file) => (pkg && file.startsWith(`${pkg}/`) ? file.slice(pkg.length + 1) : file));
    const cwd = join(root, pkg);
    const runner = await detectTestRunner(cwd, relative, { spec, pkg });
    if (!runner) {
      throw new FocusedRunError(
        `no runner for ${files.length} test${files.length === 1 ? '' : 's'} in ${pkg || 'this repository'}`,
        'declare "test": {"runner": {"command": [argv]}} in simt.json, or a package manifest a built-in detector reads',
      );
    }
    // A declared tool that is not installed is unsupported, not a failing test: the child
    // would otherwise exit 1 with ENOENT and the reader would go looking for a bug in the
    // code the test covers.
    const missing = (runner.requires ?? []).filter((command) => !commandAvailable(command, { cwd }));
    if (missing.length > 0) {
      throw new FocusedRunError(
        `the ${runner.runner} runner needs ${missing.join(', ')}, which is not installed`,
        `install ${missing.join(', ')} or declare a different "test": {"runner": ...} in simt.json`,
      );
    }
    const built = runner.buildExec(cwd);
    const preexistingReports = new Set((built.reportPaths ?? []).filter((path) => existsSync(path)));
    text.push(`selected  ${files.length}`, ...files, '', runner.displayCmd);
    // A parent `node --test` puts NODE_TEST_CONTEXT in the environment. Left
    // there, the child reports to that parent and exits 0 whether or not it failed.
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('NODE_TEST')) delete env[key];
    }
    const result = await spawnBounded(built.cmd, built.args, {
      cwd: built.cwd ?? cwd,
      env,
      timeoutMs,
      maxOutputBytes: 32 << 20,
    });
    if (result.code !== 0) code = result.code;
    const stdout = result.stdout.toString('utf8');
    const stderr = result.stderr.toString('utf8');
    // A report the runner was told to write is read and then removed by the run that owns
    // it. Before this the path was built and never read, so a report-shaped runner was
    // parsed from stdout or not at all, and the file it wrote stayed in the tree.
    let reportText = '';
    if (Array.isArray(built.reportPaths) && built.reportPaths.length > 0) {
      reportText = await readReports(built.reportPaths).catch(() => '');
      // Only the files this run caused: a report the repository already had is its own
      // file, and deleting it would be this command removing something it did not write.
      const created = built.reportPaths.filter((path) => !preexistingReports.has(path));
      // Ownership was settled by looking before the run, which is stronger than matching a
      // filename: a path this run created is one it may remove, whatever it is called.
      for (const path of created) await unlink(path).catch(() => {});
    }
    const parsed = reportText ? runner.parse(stdout, reportText) : undefined;
    if (result.timedOut) text.push(`timeout  ${runner.displayCmd} exceeded ${timeoutMs / 1000}s`);
    const body = stderr ? `${stdout}\n${stderr}` : stdout;
    rawParts.push(body);
    // A report-only runner writes the result to the file and little or nothing to
    // stdout. Read the report this run already collected before falling back to the
    // raw stream; otherwise a readable JUnit report was counted but never compacted.
    const compaction = compactReport(reportText || body);
    // Whether the runner was actually asked to run the files: a runner that ignores its
    // selector exits 0 having run nothing, and the old report called that a pass. The
    // check is only a claim about the output mentioning each file, which is what a
    // selector-aware reporter prints; it is deliberately not a parse of pass counts.
    const unproven = files.filter((file) => !body.includes(file) && !body.includes(basename(file)));
    runs.push({
      package: pkg,
      command: runner.displayCmd,
      code: result.code,
      stdout,
      stderr,
      unproven,
      timedOut: result.timedOut,
      truncated: result.truncated,
      compact: compaction.status,
      ...(compaction.format ? { reportFormat: compaction.format } : {}),
      ...(parsed ? { passed: parsed.passed, failed: parsed.failed } : {}),
    });
    // The raw body is still the fallback. `unavailable` says the text was not a
    // report this tool reads, so the reader is not invited to mistake it for one.
    text.push(compaction.text ?? body);
  }
  const unprovenAll = runs.flatMap((run) => run.unproven ?? []);
  return { code, runs, output: rawParts.join('\n'), text, unproven: unprovenAll };
}

/**
 * The selection half plus the execution: select the tests that import `files` and run
 * them. An empty selection is returned as-is, not an error: "no test imports this" is
 * an answer the caller reports (the gate calls it `nothing-selected`; pre-push falls
 * back to the full suite, because a selection it cannot name is not a proof).
 *
 * @param {string} root the repository
 * @param {{files: Iterable<string>, spec?: object|null, timeoutMs?: number, gone?: Set<string>, hunks?: object[]|null}} options
 *   `gone` is the set of deleted or renamed-away paths, kept in the graph so a test that
 *   imported one is still selected; `hunks` bounds the walk when precise evidence was read.
 * @returns {Promise<{selected: string[], edges: object[], code: number, runs: object[], output: string, text: string[], unproven: string[]}>}
 *   throws when the import graph cannot be read; the caller names the remedy.
 */
export async function runFocused(root, { files, spec = null, timeoutMs = focusedRunTimeoutMs(), gone = new Set(), hunks = null } = {}) {
  const live = await readGateGraph(root, { gone, hunks });
  const edges = live.edges;
  const selected = coverage({ imports: edges }, files, { root });
  if (selected.length === 0) {
    return { selected, edges, code: 0, runs: [], output: '', text: [], unproven: [] };
  }
  const result = await executeFocused(root, { selected, spec, timeoutMs });
  return { selected, edges, ...result };
}

/** A focused run that cannot be BUILT (no runner, a missing tool): configuration, not a failing test. */
export class FocusedRunError extends Error {
  constructor(message, remedy) {
    super(message);
    this.name = 'FocusedRunError';
    this.remedy = remedy;
  }
}
