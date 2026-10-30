// `simt gate` runs the tests a change reaches (R16, ADR-094).
//
// Paths name the change. `--changed` reads the diff instead. The tests are the
// ones that import a changed file, directly or through other files, and the
// runner is the one the package already uses. Nothing else runs. A report
// this tool knows how to read is compacted; the raw log is kept.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { EXIT, emit, emitJson, fail, isJson } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { detectTestRunner } from '../bench/mine.mjs';
import { compactOutput } from '../index/compact.mjs';
import { readImportEdges, selectTests } from '../index/gate.mjs';
import { langOf, packageOf } from '../index/store.mjs';
import { localRel } from '../state.mjs';

const exec = promisify(execFile);

export async function gateCommand(args, flags) {
  const root = flags.root ?? process.cwd();
  const listed = await tracked(root);
  if (listed.error) return listed.error;
  let changed = args.filter(Boolean);
  if (flags.changed === true) {
    const diff = await changedFiles(root);
    if (diff.error) return diff.error;
    changed = [...new Set([...changed, ...diff.files])].sort();
  }
  if (changed.length === 0) {
    if (flags.changed === true) {
      // No change: nothing is unmatched and no language is implicated, so the
      // graph is vacuously resolved and the verdict is still said out loud.
      if (isJson(flags)) {
        emitJson(
          { ok: true, command: 'gate', root, selected: [], unmatched: [], graph: 'resolved', verdict: 'nothing-selected', code: 0 },
          { pretty: flags.pretty === true, maxBytes: flags.maxBytes ?? 0 },
        );
      } else {
        emit('selected  0\nverdict  nothing-selected', { maxBytes: flags.maxBytes ?? 0 });
      }
      return EXIT.OK;
    }
    return fail(`nothing changed`, EXIT.USAGE, `pass a path, or ${CLI} gate --changed`);
  }
  // Q40: an explicit path that is neither tracked nor on disk names nothing the
  // gate could select from. That is a usage error, not an empty selection: the
  // old answer (`ok: true`, no tests, exit 0) was indistinguishable from "this
  // change is safe" and trained the reader to trust it.
  const unknown = changed.filter((p) => !listed.files.includes(p) && !existsSync(join(root, p)));
  if (unknown.length > 0) {
    return fail(
      `no such file: ${unknown.join(', ')}`,
      EXIT.USAGE,
      `pass a path git tracks, or ${CLI} gate --changed`,
    );
  }
  const files = new Set(listed.files);
  for (const file of changed) files.add(file);
  const edges = await readImportEdges(root, files);
  const selected = selectTests(changed, edges);
  // Q40: the selection explains itself. `unmatched` names explicit paths the
  // tracked tree does not carry (untracked but present, so the run proceeds);
  // `graph` is `unresolved` when a language has edges but none of them reaches
  // a tracked file (the Kotlin estate: thousands of specs, zero resolutions);
  // `verdict` says the empty set out loud instead of leaving `selected: []` to
  // be read as either safe or blind. `ok` stays as is until W27's opt-in.
  const unmatched = changed.filter((p) => !listed.files.includes(p));
  const graph = graphState(edges, files);
  if (selected.length === 0) {
    const payload = { ok: true, command: 'gate', root, selected, unmatched, graph, verdict: 'nothing-selected', code: 0 };
    if (isJson(flags)) {
      emitJson(payload, { pretty: flags.pretty === true, maxBytes: flags.maxBytes ?? 0 });
      return EXIT.OK;
    }
    const lines = ['selected  0', 'verdict  nothing-selected'];
    if (unmatched.length > 0) lines.push(`unmatched  ${unmatched.join(', ')}`);
    if (graph === 'unresolved') lines.push('graph  unresolved');
    emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }
  return runSelected(root, flags, selected, { unmatched, graph });
}

/**
 * `resolved` unless some language present in the edges has total edges but
 * zero reaching a tracked file. A language with no edges at all is not
 * evidence of anything - an unimported file needs no resolution.
 */
function graphState(edges, files) {
  const byLang = new Map();
  for (const edge of edges) {
    const lang = langOf(edge.src);
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

async function runSelected(root, flags, selected, { unmatched = [], graph = 'resolved' } = {}) {
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
    const runner = await detectTestRunner(cwd, relative);
    if (!runner) {
      return fail(
        `no runner for ${files.length} test${files.length === 1 ? '' : 's'} in ${pkg || 'this repository'}`,
        EXIT.UNSUPPORTED,
        'declare a package manifest the test runner can see',
      );
    }
    const built = runner.buildExec(cwd);
    text.push(`selected  ${files.length}`, ...files, '', runner.displayCmd);
    // A parent `node --test` puts NODE_TEST_CONTEXT in the environment. Left
    // there, the child reports to that parent and exits 0 whether or not it failed.
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('NODE_TEST')) delete env[key];
    }
    const result = await exec(built.cmd, built.args, { cwd, env, maxBuffer: 32 << 20 }).then(
      (out) => ({ code: 0, stdout: out.stdout, stderr: out.stderr }),
      (error) => ({
        code: typeof error.code === 'number' ? error.code : 1,
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
      }),
    );
    if (result.code !== 0) code = result.code;
    const stdout = String(result.stdout ?? '');
    const stderr = String(result.stderr ?? '');
    const body = stderr ? `${stdout}\n${stderr}` : stdout;
    rawParts.push(body);
    const compact = compactOutput(body);
    runs.push({ package: pkg, command: runner.displayCmd, code: result.code, stdout, stderr });
    text.push(compact ?? body);
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
  };
  if (isJson(flags)) {
    emitJson(payload, { pretty: flags.pretty === true, maxBytes: flags.maxBytes ?? 0 });
    return code === 0 ? EXIT.OK : EXIT.FAIL;
  }
  emit(text.filter((line) => line !== undefined).join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return code === 0 ? EXIT.OK : EXIT.FAIL;
}

async function writeRaw(root, body) {
  // Raw gate output is machine-local state (review 0003 Q19).
  try {
    const rel = localRel('gate', `gate-${Date.now()}.log`);
    const dir = join(root, dirname(rel));
    await mkdir(dir, { recursive: true });
    await writeFile(join(root, rel), body);
    return rel;
  } catch {
    return '';
  }
}

async function tracked(root) {
  try {
    // `-z`: without it git C-quotes a non-ASCII path (`src/\303\274n...`) and
    // the reader's real filename never matches it (review 0003 Q39).
    const { stdout } = await exec('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 16 << 20 });
    return { files: stdout.split('\0').filter(Boolean) };
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
    const { stdout } = await exec('git', ['diff', '--name-only', '-z', 'HEAD'], { cwd: root, maxBuffer: 8 << 20 });
    const untracked = await exec('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 8 << 20 });
    return { files: [...new Set([...stdout.split('\0'), ...untracked.stdout.split('\0')].filter(Boolean))].sort() };
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

function cmp(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
