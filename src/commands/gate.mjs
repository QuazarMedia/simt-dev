// `simt gate` runs the tests a change reaches (ADR-094).
//
// Paths name the change. `--changed` reads the diff instead. The tests are the
// ones that import a changed file, directly or through other files, and the
// runner is the one the package already uses. Nothing else runs. A report
// this tool knows how to read is compacted; the raw log is kept.

import { existsSync } from 'node:fs';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { EXIT, emit, emitJson, fail, isJson, present } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { commandAvailable, reportPathProblem, runnerSpecProblem } from '../testing/contract.mjs';
import { detectTestRunner } from '../testing/runners.mjs';
import { cleanupReports, readReports } from '../testing/parsers.mjs';
import { spawnBounded } from '../sys/proc.mjs';
import { loadManifest } from '../manifest/schema.mjs';
import { compactOutput } from '../index/compact.mjs';
import { coverage } from '../index/coverage.mjs';
import { readImportEdges } from '../index/gate.mjs';
import { langOf, packageOf } from '../index/store.mjs';
import { localRel } from '../state.mjs';
import { commandRoot } from '../repo-root.mjs';
import { gitPaths } from '../sys/git.mjs';
import { cmp } from '../util/sort.mjs';

/**
 * How long one focused run may take, overridable for a test that must not wait for it.
 *
 * The gate used its own `execFile` with no deadline, so a hung runner held the commit
 * forever and the author's only exit was `--no-verify`. The hook
 * dispatcher and the bench already run through `spawnBounded`; the focused gate now
 * shares it rather than carrying a second, unbounded implementation.
 */
const DEFAULT_GATE_TIMEOUT_MS = 15 * 60 * 1000;

/** The deadline for one run, resolved at run time so a test can shorten it. */
function gateTimeoutMs() {
  return Number(process.env.SIMT_GATE_TIMEOUT_MS ?? 0) || DEFAULT_GATE_TIMEOUT_MS;
}

/** How many raw gate logs the state directory keeps. */
const RAW_LOG_KEEP = 5;

export async function gateCommand(args, flags) {
  const root = commandRoot(flags);
  const listed = await tracked(root);
  if (listed.error) return listed.error;
  let changed = args.filter(Boolean);
  let renames = [];
  let deleted = [];
  if (flags.changed === true) {
    const diff = await changedFiles(root);
    if (diff.error) return diff.error;
    changed = [...new Set([...changed, ...diff.files])].sort();
    renames = diff.renames;
    deleted = diff.deleted;
  }
  if (changed.length === 0) {
    if (flags.changed === true) {
      // No change: nothing is unmatched and no language is implicated, so the
      // graph is vacuously resolved and the verdict is still said out loud.
      if (isJson(flags)) {
        emitJson(
          { ok: true, command: 'gate', root, selected: [], unmatched: [], graph: 'resolved', verdict: 'nothing-selected', code: 0 },
        );
      } else {
        emit('selected  0\nverdict  nothing-selected');
      }
      return EXIT.OK;
    }
    return fail(`nothing changed`, EXIT.USAGE, `pass a path, or ${CLI} gate --changed`);
  }
  // an explicit path that is neither tracked nor on disk names nothing the
  // gate could select from. That is a usage error, not an empty selection: the
  // old answer (`ok: true`, no tests, exit 0) was indistinguishable from "this
  // change is safe" and trained the reader to trust it.
  // A deleted or renamed-away path is named by git and no longer exists, which is the
  // point of it: it still selects the tests that imported it. Existence is only
  // required of a path the caller typed.
  const gone = new Set([...deleted, ...renames.map((rename) => rename.from)]);
  const unknown = changed.filter((p) => !listed.files.includes(p) && !gone.has(p) && !existsSync(join(root, p)));
  if (unknown.length > 0) {
    return fail(
      `no such file: ${unknown.join(', ')}`,
      EXIT.USAGE,
      `pass a path git tracks, or ${CLI} gate --changed`,
    );
  }
  const files = new Set(listed.files);
  for (const file of changed) files.add(file);
  // The repository's own declaration answers before the detection chain does, and an
  // invalid one is refused here rather than in the child: a runner that cannot be built
  // is a configuration finding, not a failing test.
  const loaded = await loadManifest(root);
  const spec = loaded.manifest?.test?.runner ?? null;
  if (spec !== null) {
    const problem = runnerSpecProblem(spec) ?? reportPathProblem(spec, root);
    if (problem !== null) {
      return fail(
        `invalid test.runner (${problem})`,
        EXIT.USAGE,
        `fix "test": {"runner": ...} in ${loaded.path}`,
      );
    }
  }
  const edges = await readImportEdges(root, files);
  const selected = coverage({ imports: edges }, changed, { root });
  // the selection explains itself. `unmatched` names explicit paths the
  // tracked tree does not carry (untracked but present, so the run proceeds);
  // `graph` is `unresolved` when a language has edges but none of them reaches
  // a tracked file (the Kotlin estate: thousands of specs, zero resolutions);
  // `verdict` says the empty set out loud instead of leaving `selected: []` to
  // be read as either safe or blind. `ok` stays as is until a versioned opt-in.
  const unmatched = changed.filter((p) => !listed.files.includes(p));
  const graph = graphState(edges, files, root);
  if (selected.length === 0) {
    // `--strict` is the opt-in versioned verdict (ADR-198): a code change with no reachable
    // test is unproven, not safe. The default stays compatible because every consumer of
    // the old answer reads exit 0 as "nothing to run".
    const strict = flags.strict === true;
    const docOnly = changed.length > 0 && changed.every(isDocPath);
    const unproven = strict && !docOnly;
    const payload = {
      ok: !unproven,
      command: 'gate',
      root,
      selected,
      unmatched,
      graph,
      verdict: unproven ? 'unproven-selection' : 'nothing-selected',
      code: unproven ? EXIT.FAIL : 0,
      renames,
      deleted,
    };
    if (isJson(flags)) {
      emitJson(payload);
      return payload.code === 0 ? EXIT.OK : EXIT.FAIL;
    }
    const lines = ['selected  0', `verdict  ${payload.verdict}`];
    if (unmatched.length > 0) lines.push(`unmatched  ${unmatched.join(', ')}`);
    if (graph === 'unresolved') lines.push('graph  unresolved');
    if (unproven) lines.push('strict  no test is reachable from this change; name one, or drop --strict');
    emit(lines.join('\n'));
    return payload.code === 0 ? EXIT.OK : EXIT.FAIL;
  }
  return runSelected(root, flags, selected, { unmatched, graph, spec, renames, deleted, changed });
}

/**
 * `resolved` unless some language present in the edges has total edges but
 * zero reaching a tracked file. A language with no edges at all is not
 * evidence of anything - an unimported file needs no resolution.
 */
/**
 * Whether a changed path is prose rather than code.
 *
 * A docs-only change legitimately selects no test, and strict mode must not fail the one
 * case where an empty selection is the whole truth. The list is deliberately about
 * documentation, not about "not a language this tool parses": a config or data file a test
 * reads is still a change strict mode should demand proof for.
 */
function isDocPath(file) {
  return /(^|\/)(docs?|decisions)\/|\.(md|mdx|txt|rst|adoc)$/i.test(file);
}

function graphState(edges, files, root = null) {
  const byLang = new Map();
  for (const edge of edges) {
    const lang = langOf(edge.src, root);
    if (!lang) continue;
    const stat = byLang.get(lang) ?? { total: 0, resolved: 0 };
    stat.total += 1;
    if (files.has(edge.dst)) stat.resolved += 1;
    byLang.set(lang, stat);
  }
  for (const stat of byLang.values()) {
    if (stat.total > 0 && stat.resolved === 0) return 'unresolved';
  }
  return 'resolved';
}

async function runSelected(root, flags, selected, { unmatched = [], graph = 'resolved', spec = null, renames = [], deleted = [], changed = [] } = {}) {
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
      return fail(
        `no runner for ${files.length} test${files.length === 1 ? '' : 's'} in ${pkg || 'this repository'}`,
        EXIT.UNSUPPORTED,
        'declare "test": {"runner": {"command": [argv]}} in simt.json, or a package manifest a built-in detector reads',
      );
    }
    // A declared tool that is not installed is unsupported, not a failing test: the child
    // would otherwise exit 1 with ENOENT and the reader would go looking for a bug in the
    // code the test covers.
    const missing = (runner.requires ?? []).filter((command) => !commandAvailable(command, { cwd }));
    if (missing.length > 0) {
      return fail(
        `the ${runner.runner} runner needs ${missing.join(', ')}, which is not installed`,
        EXIT.UNSUPPORTED,
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
      timeoutMs: gateTimeoutMs(),
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
    if (result.timedOut) text.push(`timeout  ${runner.displayCmd} exceeded ${gateTimeoutMs() / 1000}s`);
    const body = stderr ? `${stdout}\n${stderr}` : stdout;
    rawParts.push(body);
    const compact = compactOutput(body);
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
      ...(parsed ? { passed: parsed.passed, failed: parsed.failed } : {}),
    });
    text.push(compact ?? body);
  }
  const unproven = runs.flatMap((run) => run.unproven ?? []);
  // `--strict` is the opt-in versioned verdict (ADR-198). The default stays compatible:
  // an empty selection is still exit 0, because every consumer of the old answer expects
  // it. Strict refuses to call a run proven when the graph could not resolve, when a
  // changed path has no reachable test, or when the runner never mentioned a file it was
  // given - the three ways a green exit used to mean nothing.
  const strict = flags.strict === true;
  const docOnly = changed.length > 0 && changed.every(isDocPath);
  if (strict) {
    if (graph === 'unresolved') {
      text.push('', 'strict  the import graph did not resolve this change');
      code = code === 0 ? EXIT.FAIL : code;
    }
    if (unproven.length > 0) {
      text.push('', `strict  the runner never ran: ${unproven.join(', ')}`);
      code = code === 0 ? EXIT.FAIL : code;
    }
    if (selected.length === 0 || unproven.length > 0) {
      if (!docOnly) text.push('', 'strict  this change has no proven test selection');
    }
  }
  const raw = await writeRaw(root, rawParts.join('\n'));
  if (raw) text.push('', `raw  ${raw}`);
  const payload = {
    ok: code === 0,
    command: 'gate',
    root,
    selected,
    unmatched,
    graph,
    verdict: 'selected',
    code,
    raw,
    runs,
    renames,
    deleted,
    // The versioned strict verdict adds what the default answer never had to say: whether
    // every selected file was actually mentioned by the runner.
    ...(flags.strict === true ? { strict: { unproven } } : {}),
  };
  present(payload, () => text.filter((line) => line !== undefined).join('\n'), flags);
  return code === 0 ? EXIT.OK : EXIT.FAIL;
}

async function writeRaw(root, body) {
  // Raw gate output is machine-local state.
  try {
    const rel = localRel('gate', `gate-${Date.now()}.log`);
    const dir = join(root, dirname(rel));
    await mkdir(dir, { recursive: true });
    await writeFile(join(root, rel), body);
    // Keep the newest few: raw gate output is machine-local state , and a file per
    // run with no bound is a directory that grows on every command .
    const kept = await readdir(dir).catch(() => []);
    const logs = kept.filter((name) => /^gate-\d+\.log$/.test(name)).sort().reverse();
    for (const name of logs.slice(RAW_LOG_KEEP)) await unlink(join(dir, name)).catch(() => {});
    return rel;
  } catch {
    return '';
  }
}

async function tracked(root) {
  try {
    // `-z`: without it git C-quotes a non-ASCII path (`src/\303\274n...`) and
    // the reader's real filename never matches it.
    return { files: await gitPaths(root, ['ls-files']) };
  } catch (error) {
    return {
      error: fail(
        `could not read the change (${error.message})`,
        EXIT.UNSUPPORTED,
        'run this inside a git repository',
      ),
    };
  }
}

async function changedFiles(root) {
  try {
    // `--name-status` names what happened as well as what changed. A rename used to
    // arrive as two unrelated paths and a deletion as a path that no longer exists, so a
    // renamed module and a deleted one both selected nothing while exiting 0.
    const status = await gitPaths(root, ['diff', '--name-status', '-z', 'HEAD'], { maxBuffer: 8 << 20 });
    const files = [];
    const renames = [];
    const deleted = [];
    for (let index = 0; index < status.length; index += 1) {
      const code = status[index];
      if (!/^[A-Z]/.test(code)) continue;
      if (code.startsWith('R') || code.startsWith('C')) {
        const from = status[index + 1];
        const to = status[index + 2];
        index += 2;
        if (from && to) {
          renames.push({ from, to });
          files.push(from, to);
        }
        continue;
      }
      const path = status[index + 1];
      index += 1;
      if (!path) continue;
      files.push(path);
      if (code.startsWith('D')) deleted.push(path);
    }
    const untracked = await gitPaths(root, ['ls-files', '--others', '--exclude-standard'], { maxBuffer: 8 << 20 });
    return { files: [...new Set([...files, ...untracked])].sort(), renames, deleted };
  } catch (error) {
    return {
      error: fail(
        `could not read the diff (${error.message})`,
        EXIT.UNSUPPORTED,
        'run this inside a git repository that has a commit',
      ),
    };
  }
}

