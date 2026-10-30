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

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { GATES } from './gates.mjs';
import { resolveGate } from './resolve.mjs';
import { resolveNodeRunner } from '../ecosystem/node-runner.mjs';
import { CLI } from '../name.mjs';
import { MANIFEST_FILE } from '../name.mjs';
import { assertVersionPin } from '../package-version.mjs';
import { recordRun } from '../ledger/index.mjs';
import { renderFindings, scanStaged } from '../secrets.mjs';

const exec = promisify(execFile);

/** Gates that are known but not required for the event to pass. */
const DEFAULT_EVENTS = { 'pre-commit': 'preCommit', 'pre-push': 'prePush' };

/**
 * @param {string} event 'pre-commit' | 'pre-push'
 * @param {object} ctx
 * @param {string} ctx.root
 * @param {object} ctx.manifest parsed simt-dev.json, or null
 * @returns {Promise<{event: string, gates: object[], failed: boolean}>}
 */
export async function runGates(event, { root, manifest }) {
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
  let headWorktree = null;
  if (event === 'pre-push') {
    const materialized = await materializeHeadWorktree(root);
    if (materialized.path === null) {
      return {
        event,
        gates: [
          {
            name: 'head',
            status: 'failed',
            detail: materialized.error,
            remedy: 'commit the work, or resolve the git state so HEAD is a valid reference, then push again',
            adr: null,
          },
        ],
        failed: true,
      };
    }
    runRoot = materialized.path;
    headWorktree = materialized.path;
  }

  try {
    return await runGatesAt(event, { root: runRoot, ledgerRoot: root, manifest, declared, key });
  } finally {
    if (headWorktree !== null) await removeHeadWorktree(root, headWorktree);
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
 * @returns {Promise<{event: string, gates: object[], failed: boolean}>}
 */
async function runGatesAt(event, { root, ledgerRoot, manifest, declared, key }) {
  const pkg = await readPkg(root);
  // Q31: the runner is committed evidence (lockfile, then `packageManager`),
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
  const results = [];
  // What the format gate rewrote, so restage touches those files and nothing else.
  let formatted = [];

  for (const name of declared) {
    const gate = GATES[name];
    if (gate === undefined) {
      results.push({
        name,
        status: 'failed',
        detail: `unknown gate; the shared dispatcher knows: ${Object.keys(GATES).sort().join(', ')}`,
        remedy: `remove "${name}" from ${MANIFEST_FILE} gates.${key}`,
        adr: null,
      });
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
      // scan takes its ignore globs from gates.secretScan (review 0003 Q24).
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

    const started = Date.now();
    const outcome = await runGate(resolution, cwd);
    // The ledger is not the gate. A tree that cannot be named leaves no line, and the
    // claim check then finds nothing, which is the direction that cannot invent a run.
    try {
      const cmd = typeof resolution.command === 'string' ? resolution.command : resolution.argv.join(' ');
      // The evidence claim needs the gate and its kind: a passing secret-scan is
      // not a passing test run (review 0003 Q18). Coverage proves tests; anything
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
    results.push({
      name,
      status: outcome.code === 0 ? 'passed' : 'failed',
      detail: `${resolution.detail}${outcome.code === 0 ? '' : `: exit ${outcome.code}`}`,
      output: outcome.code === 0 ? '' : tail(outcome.stderr || outcome.stdout),
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
 * Materialize a detached worktree at HEAD so the pre-push gates run against the
 * committed tree, not the working one. The worktree shares the repository's object
 * store, so `git worktree add` is cheap and needs no clone. `node_modules` is
 * symlinked in when the real root has one, because a script gate resolves its runner
 * and binaries from there and a fresh worktree does not carry it.
 *
 * Fails closed: an unborn HEAD (no commits) or a git error returns `{ path: null }`
 * with the reason, and the caller turns that into a gate failure rather than running
 * against a tree it cannot name.
 *
 * @param {string} root the real repository root
 * @returns {Promise<{path: string, error?: never}|{path: null, error: string}>}
 */
async function materializeHeadWorktree(root) {
  const path = await mkdtemp(join(tmpdir(), 'head-gate-'));
  try {
    await exec('git', ['worktree', 'add', '--detach', path, 'HEAD'], { cwd: root });
  } catch (error) {
    await rm(path, { recursive: true, force: true }).catch(() => {});
    return { path: null, error: `git worktree add failed: ${String(error.stderr ?? error.message).trim()}` };
  }
  const nodeModules = join(root, 'node_modules');
  try {
    await symlink(nodeModules, join(path, 'node_modules'));
  } catch {
    // Absent node_modules is the normal case for a repo with no install step; a
    // dangling link is harmless, and `npm run` does not need it to exist.
  }
  return { path };
}

/**
 * Remove a pre-push worktree. `--force` because a gate may have left it dirty (a
 * formatter, a test that writes fixtures); the worktree is disposable, the real tree
 * is not. Falls back to `rm -rf` plus a prune when git cannot remove it (a lock, a
 * path in a state git does not expect), so a cleanup failure never leaks the tree.
 *
 * @param {string} root the real repository root
 * @param {string} path the worktree to remove
 */
async function removeHeadWorktree(root, path) {
  await exec('git', ['worktree', 'remove', '--force', path], { cwd: root }).catch(async () => {
    await rm(path, { recursive: true, force: true }).catch(() => {});
    await exec('git', ['worktree', 'prune'], { cwd: root }).catch(() => {});
  });
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

async function run(argv, cwd, env) {
  try {
    const { stdout, stderr } = await exec(argv[0], argv.slice(1), { cwd, env, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error.message ?? error) };
  }
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
async function runGate(resolution, cwd) {
  // The push override is for the push itself, not for the gates the hook runs.
  // A test that asserts a push is denied sees the override and fails.
  const env = { ...process.env };
  delete env.SIMT_ALLOW;
  if (resolution.shell === true && typeof resolution.command === 'string') {
    try {
      const { stdout, stderr } = await exec('sh', ['-c', resolution.command], { cwd, env, maxBuffer: 8 * 1024 * 1024 });
      return { code: 0, stdout, stderr };
    } catch (error) {
      return {
        code: typeof error.code === 'number' ? error.code : 1,
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? String(error.message ?? error),
      };
    }
  }
  return run(resolution.argv, cwd, env);
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
    const { stdout } = await exec('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { cwd: root });
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
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
    const { stdout } = await exec('git', ['diff', '--name-only'], { cwd: root });
    return new Set(stdout.split('\n').map((s) => s.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** The staged blob hash for each path, or an empty map if git cannot answer. */
async function stagedBlobs(root, files) {
  if (files.length === 0) return new Map();
  try {
    const { stdout } = await exec('git', ['ls-files', '-s', '--', ...files], { cwd: root });
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
    await exec('git', ['add', '--', ...files], { cwd: root });
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
