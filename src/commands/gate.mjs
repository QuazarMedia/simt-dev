// `simt gate` runs the tests a change reaches (ADR-094).
//
// Paths name the change. `--changed` reads the diff instead. The tests are the
// ones that import a changed file, directly or through other files, and the
// runner is the one the package already uses. Nothing else runs. A report
// this tool knows how to read is compacted; an unrecognised log is marked
// `unavailable` and kept raw.

import { existsSync } from 'node:fs';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { EXIT, emit, emitJson, fail, isJson, present } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { runnerSpecProblem, reportPathProblem } from '../testing/contract.mjs';
import { executeFocused, FocusedRunError, focusedRunTimeoutMs } from '../testing/focused-run.mjs';
import { loadManifest } from '../manifest/schema.mjs';
import { coverage, preciseCoverage } from '../index/coverage.mjs';
import { readGateGraph } from '../index/gate.mjs';
import { langOf } from '../index/store.mjs';
import { localRel } from '../state.mjs';
import { commandRoot } from '../repo-root.mjs';
import { gitPaths } from '../sys/git.mjs';
import { readChangeHunks, readChanges } from '../sys/changes.mjs';

/** How many raw gate logs the state directory keeps. */
const RAW_LOG_KEEP = 5;

export async function gateCommand(args, flags) {
  const root = commandRoot(flags);
  const reportSelection = flags.precise === true || flags.conservative === true;
  const fallbackReason = flags.conservative === true ? 'full file reach was requested'
    : flags.strict === true ? 'strict mode requires full file reach' : null;
  const listed = await tracked(root);
  if (listed.error) return listed.error;
  let changed = args.filter(Boolean);
  let renames = [];
  let deleted = [];
  if (flags.changed === true) {
    let diff;
    try {
      diff = await readChanges(root);
    } catch (error) {
      return fail(`could not read the diff (${error.message})`, EXIT.UNSUPPORTED, 'run this inside a git repository that has a commit');
    }
    changed = [...new Set([...changed, ...diff.files])].sort();
    renames = diff.renames;
    deleted = diff.deleted;
  }
  if (changed.length === 0) {
    if (flags.changed === true) {
      // No change: nothing is unmatched and no language is implicated, so the
      // graph is vacuously resolved and the verdict is still said out loud.
      const selection = reportSelection ? { mode: 'conservative', reason: 'there are no changed files',
        hubMediatedSkipped: [], otherSkipped: 0 } : null;
      if (isJson(flags)) {
        emitJson(
          { ok: true, command: 'gate', root, selected: [], unmatched: [], graph: 'resolved', verdict: 'nothing-selected', code: 0,
            ...(selection ? { selection } : {}) },
        );
      } else {
        emit(['selected  0', 'verdict  nothing-selected', ...selectionText(selection)].join('\n'));
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
  const hunks = flags.precise === true && fallbackReason === null && flags.changed === true
    ? await readChangeHunks(root).catch(() => null) : null;
  let live;
  try {
    live = await readGateGraph(root, { gone, hunks });
  } catch (error) {
    return fail(`could not read the import graph (${error.message})`, EXIT.FAIL, `run: ${CLI} index`);
  }
  const edges = live.edges;
  const { selected, selection } = reportSelection ? preciseCoverage(live, changed, hunks, { root, fallbackReason })
    : { selected: coverage({ imports: edges }, changed, { root }), selection: null };
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
      ...(selection ? { selection } : {}),
    };
    if (isJson(flags)) {
      emitJson(payload);
      return payload.code === 0 ? EXIT.OK : EXIT.FAIL;
    }
    const lines = ['selected  0', `verdict  ${payload.verdict}`, ...selectionText(selection)];
    if (unmatched.length > 0) lines.push(`unmatched  ${unmatched.join(', ')}`);
    if (graph === 'unresolved') lines.push('graph  unresolved');
    if (unproven) lines.push('strict  no test is reachable from this change; name one, or drop --strict');
    emit(lines.join('\n'));
    return payload.code === 0 ? EXIT.OK : EXIT.FAIL;
  }
  return runSelected(root, flags, selected, { unmatched, graph, spec, renames, deleted, changed, selection });
}

function selectionText(selection) {
  if (!selection) return [];
  const reason = selection.reason ? `  ${selection.reason}` : '';
  const skipped = selection.hubMediatedSkipped.map((path) => `hub test omitted  ${path}`);
  if (selection.otherSkipped) skipped.push(`other file-level tests omitted  ${selection.otherSkipped}`);
  return [`selection  ${selection.mode}${reason}`, ...skipped];
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

async function runSelected(root, flags, selected, { unmatched = [], graph = 'resolved', spec = null, renames = [], deleted = [], changed = [], selection = null } = {}) {
  // The execution half lives in the shared focused-run core: the pre-push focused
  // threshold runs the same loop over its own selection (ADR-002), so neither
  // caller re-implements runner detection, the bounded spawn, or report handling.
  let result;
  try {
    result = await executeFocused(root, { selected, spec, timeoutMs: focusedRunTimeoutMs() });
  } catch (error) {
    if (error instanceof FocusedRunError) {
      return fail(error.message, EXIT.UNSUPPORTED, error.remedy);
    }
    throw error;
  }
  let { code, runs, output, unproven } = result;
  const text = [...selectionText(selection), ...result.text];
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
  const raw = await writeRaw(root, output);
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
    ...(selection ? { selection } : {}),
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
