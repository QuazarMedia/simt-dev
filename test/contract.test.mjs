// The two contracts every command shares, checked by running every command.
//
// Neither of these is a property of one command, so neither belongs in one
// command's test file: a test that runs `doctor` and a test that runs `skills
// install` would each assert their own command and miss the other. What the
// caller actually depends on is the answer to two questions asked of the WHOLE
// surface, and review 0001's S10 is what recorded that the surface answered them
// inconsistently.
//
//   1. Under `--json`, stdout is exactly one JSON document, and its `ok` agrees
//      with the exit code. A caller reads `ok`; the shell reads the exit code;
//      if they disagree then one of the two is a lie and the caller cannot tell
//      which.
//   2. Under `--dry-run`, or without `--yes`, a mutating command changes
//      nothing. `upgrade --yes --dry-run` wrote; `skills install` read neither
//      flag at all. Both are the same defect wearing different commands.
//
// The commands are driven through the real binary, not called as functions. That
// is the only way to catch a flag the dispatcher never routes, which is exactly
// how `--dry-run` reached `skills install` unreached while every direct unit test
// passed.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { git, skillWorkspace, workspaceEnv } from './fixture.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt.mjs');
const exec = promisify(execFile);

// One row installs a skill body, and a body lives in the estate. Without a staged
// workspace `skills install` is REFUSED — which changes nothing, so the row
// asserted "wrote nothing without --yes" and passed, having tested the refusal.
// That row was green in this checkout and green in a `.git`-less copy for two
// different reasons, and only the copy was wrong. ADR-031 is about the suite
// assuming the estate; this is the other side of it, a suite whose assertions are
// satisfied by an absent world.
const { root: WORKSPACE } = await skillWorkspace();
after(() => rm(WORKSPACE, { recursive: true, force: true }));

/** Every row but the install one runs with no estate in sight, and says so. */
const NO_WORKSPACE = { SIMT_DEV_WORKSPACE: 'off' };

/** Run the shipped binary. Never throws: the exit code is the thing under test. */
async function run(args, env = {}) {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args], {
      maxBuffer: 32 << 20,
      env: { ...process.env, NO_COLOR: '1', ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/**
 * A consumer repo: a git work tree, committed, with a python stack so `init`
 * detects a profile, and a stale pin so `upgrade` has something to do.
 *
 * `stack: 'node'` stages a repo with `lint` and `test` scripts instead, because
 * `hooks install` refuses to write a shim for a repo that declares no gate it can
 * run - and a python repo declares none. That refusal is correct (a shim with an
 * empty gate list enforces nothing yet still replaces whatever git was running),
 * so a row pointed at the wrong fixture would have been asserting a BLOCKED
 * refusal while claiming to test the write.
 */
async function consumer({ stack = 'python' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'simt-contract-'));
  await git(['init', '-q', '.'], { cwd: root });
  if (stack === 'node') {
    await writeFile(
      join(root, 'package.json'),
      `${JSON.stringify({ name: 'consumer', private: true, scripts: { lint: 'node -e 0', test: 'node --test' } }, null, 2)}\n`,
    );
  } else {
    await writeFile(join(root, 'requirements.txt'), 'flask\n');
    await writeFile(join(root, 'pkg.py'), 'print("hi")\n');
  }
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-qm', 'init'], { cwd: root });
  const adopted = await run(['init', '--root', root, '--yes']);
  assert.equal(adopted.code, 0, adopted.stderr);
  // `init` writes files it does not stage: `simt-dev.json`, and `.editorconfig` and
  // `.gitattributes` when the repo has none. `skills brief` treats an untracked path
  // as work in progress, so leaving them uncommitted makes the fixture look dirty
  // and sends every "no staged files" row down the normal path instead of the one
  // under test. Commit them, then assert the tree really is clean.
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-qm', 'adopted'], { cwd: root });
  const { stdout } = await git(['status', '--porcelain'], { cwd: root });
  assert.equal(stdout.trim(), '', 'the fixture must be a clean repo for this table to mean anything');
  return root;
}

/** Make the repo's pin stale, so `upgrade` has work it would otherwise skip. */
async function stalePin(root) {
  const file = join(root, MANIFEST_FILE);
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.projection.simtDevSha = 'aaaaaaa';
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Put a stray line inside the region, so `sync` has work it would otherwise skip. */
async function staleRegion(root) {
  const file = join(root, 'AGENTS.md');
  const text = await readFile(file, 'utf8');
  await writeFile(
    file,
    text.replace('<!-- simt:begin -->', '<!-- simt:begin -->\nSTALE\n'),
  );
}

/** A corrupt user config, so a workspace lookup has a real answer to get wrong. */
async function badConfig() {
  const home = await mkdtemp(join(tmpdir(), 'simt-contract-cfg-'));
  await mkdir(join(home, 'simt-dev'), { recursive: true });
  await writeFile(join(home, 'simt-dev', 'config.json'), 'not json at all');
  return { XDG_CONFIG_HOME: home };
}

// --- 1. Under --json, one document, and ok agrees with the exit code ------------

/**
 * Every command that emits JSON at all. Each row is a command that must answer
 * the contract in a state where it has something to report - the rows are not
 * "no arguments" invocations, because a command with nothing to say is a
 * different question than one with something to say.
 */
const JSON_COMMANDS = [
  { name: 'doctor', args: (root) => ['doctor', '--root', root], env: async () => ({}) },
  { name: 'doctor (broken config)', args: (root) => ['doctor', '--root', root], env: badConfig },
  { name: 'hooks status', args: (root) => ['hooks', 'status', '--root', root], env: async () => ({}) },
  { name: 'agent-hooks status', args: (root) => ['agent-hooks', 'status', '--root', root], env: async () => ({}) },
  {
    name: 'skills brief',
    args: (root) => ['skills', 'brief', '--root', root, '--task', 'a test'],
    env: async () => ({}),
  },
  {
    name: 'skills brief (no input)',
    args: (root) => ['skills', 'brief', '--root', root],
    env: async () => ({}),
  },
  {
    name: 'skills index',
    args: (root) => ['skills', 'index', '--root', root],
    env: async () => ({}),
  },
  {
    name: 'skills find',
    args: (root) => ['skills', 'find', 'commit', '--root', root],
    env: async () => ({}),
  },
  { name: 'skills show', args: () => ['skills', 'show', 'slice-commit'], env: async () => ({}) },
  { name: 'skills why', args: () => ['skills', 'why', 'slice-commit'], env: async () => ({}) },
  { name: 'skills compile', args: (root) => ['skills', 'compile', '--root', root], env: async () => ({}) },
  // The corpus and the registry both resolve from the package root in a checkout, so
  // this row needs no workspace and no root; it asserts the contract on a command whose
  // answer is a measurement, not a projection.
  { name: 'skills eval', args: () => ['skills', 'eval'], env: async () => ({}) },
  { name: 'rules list', args: () => ['rules', 'list'], env: async () => ({}) },
  { name: 'rules show', args: () => ['rules', 'show', 'core'], env: async () => ({}) },
  { name: 'rules why', args: () => ['rules', 'why', 'ADR-001'], env: async () => ({}) },
  { name: 'sync', args: (root) => ['sync', '--root', root], env: async () => ({}) },
  { name: 'check', args: (root) => ['check', '--root', root], env: async () => ({}) },
  { name: 'compare', args: (root) => ['compare', '--root', root], env: async () => ({}) },
  { name: 'graph', args: () => ['graph'], env: async () => ({}) },
  { name: 'upgrade', args: (root) => ['upgrade', '--root', root], env: async () => ({}) },
  { name: 'init', args: (root) => ['init', '--root', root, '--yes'], env: async () => ({}) },
  { name: 'ci', args: (root) => ['ci', '--root', root], env: async () => ({}) },
  { name: 'harness loaders', args: (root) => ['harness', 'loaders', '--root', root], env: async () => ({}) },
  { name: 'bench mine', args: (root) => ['bench', 'mine', '--root', root], env: async () => ({}) },
  { name: 'bench run', args: (root) => ['bench', 'run', '--root', root], env: async () => ({}) },
  { name: 'bench report', args: (root) => ['bench', 'report', '--root', root], env: async () => ({}) },
  { name: 'bench ablate', args: (root) => ['bench', 'ablate', '--root', root], env: async () => ({}) },
  { name: 'bench probes', args: (root) => ['bench', 'probes', '--root', root], env: async () => ({}) },
  { name: 'bench variants', args: (root) => ['bench', 'variants', '--root', root], env: async () => ({}) },
  { name: 'lessons list', args: (root) => ['lessons', 'list', '--root', root], env: async () => ({}) },
  { name: 'decide', args: (root) => ['decide', '--root', root], env: async () => ({}) },
  { name: 'undo', args: (root) => ['undo', '--root', root], env: async () => ({}) },
  // No cache on a fresh fixture: the miss is one JSON document, exit 0.
  { name: 'status', args: (root) => ['status', '--line', '--root', root], env: async () => ({}) },
  { name: 'local doctor', args: (root) => ['local', 'doctor', '--root', root], env: async () => ({}) },
];

test('--json is one document, and ok agrees with the exit code, for every command', async (t) => {
  const root = await consumer();
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const row of JSON_COMMANDS) {
    await t.test(row.name, async () => {
      const { code, stdout, stderr } = await run([...row.args(root), '--json'], await row.env());
      assert.equal(stderr.includes('\n{'), false, `${row.name} wrote JSON to stderr as well as stdout`);

      // Exactly one document. `JSON.parse` rejects trailing prose, so a second
      // document or a paragraph on stdout is a failure here rather than a
      // warning, which is the point of checking it rather than eyeballing it.
      let payload;
      try {
        payload = JSON.parse(stdout);
      } catch (error) {
        assert.fail(
          `${row.name} --json did not print one JSON document (${error.message}). ` +
            `stdout began: ${JSON.stringify(stdout.slice(0, 120))}`,
        );
      }

      assert.equal(
        typeof payload.ok,
        'boolean',
        `${row.name} --json has no boolean "ok"; the caller has nothing to branch on`,
      );
      assert.equal(
        payload.ok,
        code === 0,
        `${row.name} --json says ok=${payload.ok} but exited ${code}. ` +
          'One of the two is a lie and the caller cannot tell which.',
      );
    });
  }
});

test('a command that fails says so in the same document it reports in', async (t) => {
  // The half of the contract above that a table cannot reach: when the exit code
  // is non-zero, the reason has to be IN the document. An `ok: false` with no
  // error and no remedy tells a caller it failed without saying what to do, and
  // ADR-010 requires the remedy.
  const root = await consumer();
  t.after(() => rm(root, { recursive: true, force: true }));

  const { code, stdout } = await run(['doctor', '--root', root, '--json'], await badConfig());
  assert.equal(code, 3, 'an unparseable workspace config is a config fault');
  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /unparseable JSON/, payload.error);
  assert.equal(typeof payload.remedy, 'string', 'a failure without a remedy is not actionable');
  // The workspace answer is printed in text mode; if JSON omits it then the two
  // modes answer one question two different ways, which is ADR-014's subject.
  assert.equal(typeof payload.workspace, 'object', 'doctor --json must carry the workspace answer');
  assert.match(payload.workspace.error, /unparseable JSON/, payload.workspace.error);
});

// --- 2. --dry-run writes nothing, and neither does a run without --yes ----------

/**
 * Mutating commands, each with the flags that would authorise it. Without the
 * authorising flag nothing may change; with it, `--dry-run` must still be a
 * rehearsal. `skills install` is given a skill that resolves to exactly one
 * source, because `graphify` declares two byte-identical sources and the
 * ambiguity error would hide the thing being tested.
 */
const WRITERS = [
  {
    name: 'upgrade',
    authorise: ['--yes'],
    needsStalePin: true,
    verify: async (root) => JSON.parse(await readFile(join(root, MANIFEST_FILE), 'utf8')).projection.simtDevSha,
  },
  {
    // `sync` was the one writer that wrote by default, which is why it is here: it
    // is the row that would have caught S24's own defect. It needs stale region
    // bytes rather than a stale pin, because what `sync` writes is the region.
    name: 'sync',
    authorise: ['--yes'],
    needsStaleRegion: true,
    // `sync` without flags is also a check, so a preview that found work exits
    // non-zero (ADR-036). Every other row here is a rehearsal, and a rehearsal is
    // not a failure - which is what makes the distinction worth stating in the
    // table rather than in an `if` below.
    previewFindsWork: true,
    verify: async (root) => readFile(join(root, 'AGENTS.md'), 'utf8'),
  },
  {
    name: 'skills install',
    authorise: ['--yes'],
    source: 'repo-07/.agents/skills/graphify',
    verify: async (root) => {
      try {
        return await readFile(join(root, '.agents/skills/graphify/SKILL.md'), 'utf8');
      } catch {
        return null;
      }
    },
  },
  {
    // `hooks install` is the row that was missing while it wrote by default
    // (ADR-040). It is here for the same reason `sync` is: it is the writer whose
    // absence from this table is why 586 tests did not notice.
    name: 'hooks install',
    authorise: ['--yes'],
    stack: 'node',
    // Two things are written and neither is a file in the usual sense: the shim
    // under `.simt-hooks/`, and `core.hooksPath` inside `.git/config`. Probing
    // only the shim would pass on an install that wrote a hook git does not run -
    // the exact downgrade the command exists to avoid - so both are in the
    // fingerprint, and `git config --get` exits non-zero when unset, which is why
    // the unset answer is caught rather than awaited.
    verify: async (root) => {
      const hooksPath = await git(['config', '--get', 'core.hooksPath'], { cwd: root })
        .then(({ stdout }) => stdout.trim())
        .catch(() => '(unset)');
      const shim = await readFile(join(root, '.simt-hooks/pre-commit'), 'utf8').catch(() => '(absent)');
      return `${hooksPath}\n${shim}`;
    },
  },
  {
    name: 'agent-hooks install',
    authorise: ['--yes'],
    verify: async (root) => readFile(join(root, '.claude/settings.json'), 'utf8').catch(() => null),
  },
  {
    name: 'decide',
    authorise: ['--yes'],
    verify: async (root) => readFile(join(root, 'docs/decisions/ADR-001-untitled-decision.md'), 'utf8').catch(() => null),
  },
  {
    // `undo` with no journaled set previews the empty undo and writes nothing,
    // which is what both modes assert. The journal directory itself is
    // fingerprint enough: a run that recorded a set would leave one here.
    name: 'undo',
    // No `--yes` to authorise with: the empty undo previews under both modes.
    authorise: [],
    // The fixture just ran `init --yes`, so this undo previews restoring that
    // adoption: the journal set exists, and the diff shows the way back.

    // A string, not the array: the table compares with `assert.equal`, and two
    // reads of an unchanged directory are equal contents in different arrays.
    verify: async (root) => (await readdir(join(root, '.simt/journal')).catch(() => null))?.join('\n') ?? null,
  },
  {
    // `check` writes the `--line` cache under `.simt/`, which is local state
    // like the ledger and the index — not a write in this table's sense. This
    // row pins that: the gate may record, but tracked content must be
    // byte-identical before and after, under both modes. The gate carries no
    // file plan, so its diff is empty — pinned, not excused.
    name: 'check',
    authorise: [],
    noDiff: true,
    verify: async (root) =>
      `${await readFile(join(root, 'simt.json'), 'utf8').catch(() => null)}\n${await readFile(join(root, 'AGENTS.md'), 'utf8').catch(() => null)}`,
  },
];

for (const writer of WRITERS) {
  test(`${writer.name} writes nothing without --yes, and nothing under --dry-run`, async (t) => {
    const install = writer.source ? ['skills', 'install', 'graphify', '--from', writer.source] : [writer.name];

    for (const mode of ['unauthorised', 'dry-run']) {
      const root = await consumer({ stack: writer.stack });
      t.after(() => rm(root, { recursive: true, force: true }));
      if (writer.needsStalePin) await stalePin(root);
      if (writer.needsStaleRegion) await staleRegion(root);

      const before = await writer.verify(root);
      // `--root` is not optional here. `skills install` writes to `process.cwd()`
      // when it is absent, so a version of this table that forgot it would install
      // into the checkout running the suite and watch a fixture path that never
      // changes - a test that passes because it inspected nothing. The assertion
      // below is what makes that impossible rather than merely unlikely.
      assert.ok(
        root.startsWith(tmpdir()),
        `the fixture root must be a temp directory, not the checkout: ${root}`,
      );
      const args = [...install, '--root', root, ...(mode === 'dry-run' ? [...writer.authorise, '--dry-run'] : [])];

      // Which world this row runs in is stated per row rather than inherited. Left to
      // the environment it was the estate for a developer at a checkout and absent
      // for everyone else, and one of those two answers satisfied the row by
      // refusing.
      const { code, stderr } = await run(args, writer.source ? workspaceEnv(WORKSPACE) : NO_WORKSPACE);
      const after = await writer.verify(root);

      assert.equal(
        after,
        before,
        `${writer.name} changed the filesystem in ${mode} mode (exit ${code}). ` +
          `A rehearsal and an unauthorised run are both no-write. ${stderr.slice(0, 200)}`,
      );
      // The bytes alone are not enough, and the direction that costs a whole table is
      // the one where the command refuses instead of previewing: a refusal changes
      // nothing, so the equality above still holds. `hooks install` on a repo with
      // no runnable gate is refused exactly that way (correctly - a shim with an
      // empty gate list enforces nothing yet still replaces whatever git was
      // running), so a row pointed at the wrong fixture would have gone green
      // while testing the refusal. The exit code separates the two, and it is the
      // same question ADR-035 rules out having two answers.
      //
      // Only the unauthorised form is asserted. A rehearsal is not the same
      // question: `sync --yes --dry-run` reports the work it found exactly as the
      // unauthorised form does (ADR-036), so requiring 0 here would fail on the
      // behaviour that record deliberately settled.
      if (mode === 'unauthorised') {
        if (writer.previewFindsWork) {
          assert.notEqual(
            code,
            0,
            `${writer.name} previewed a real change and exited 0, so a caller would read it as current`,
          );
        } else {
          assert.equal(
            code,
            0,
            `${writer.name} exited ${code} instead of previewing. A refusal leaves the ` +
              'filesystem untouched, so this row would pass while testing the refusal.',
          );
        }
      }
    }
  });
}

// --- 3. --diff prints the plan without writing, in preview and under --dry-run ---
//
// R50: every writer accepts `--diff`, which prints what it would change — or,
// with `--yes`, what it changed — as unified diffs. A display flag: the
// filesystem must be byte-identical with and without it, and the exit code must
// agree with the same run without `--diff`. `undo` (empty) and `check` (a gate)
// carry no file plan, so their diff is empty — which this pins rather than
// excuses, so a writer that silently drops its diff goes red here.
for (const writer of WRITERS) {
  test(`${writer.name} --diff shows the plan and writes nothing`, async (t) => {
    const install = writer.source ? ['skills', 'install', 'graphify', '--from', writer.source] : [writer.name];
    const root = await consumer({ stack: writer.stack });
    t.after(() => rm(root, { recursive: true, force: true }));
    if (writer.needsStalePin) await stalePin(root);
    if (writer.needsStaleRegion) await staleRegion(root);
    const env = writer.source ? workspaceEnv(WORKSPACE) : NO_WORKSPACE;
    const before = await writer.verify(root);

    for (const mode of ['unauthorised', 'dry-run']) {
      const base = [
        ...install,
        '--root',
        root,
        ...(mode === 'dry-run' ? [...writer.authorise, '--dry-run'] : []),
      ];
      const text = await run([...base, '--diff'], env);
      const plain = await run(base, env);
      // A display flag: the same exit code, the same filesystem.
      assert.equal(
        text.code,
        plain.code,
        `${writer.name} --diff exited ${text.code} where the same run without it exited ${plain.code} in ${mode} mode`,
      );
      assert.equal(
        await writer.verify(root),
        before,
        `${writer.name} --diff changed the filesystem in ${mode} mode (exit ${text.code})`,
      );
      if (writer.noDiff === true) {
        assert.equal(
          text.stdout.includes('diff --git'),
          false,
          `${writer.name} printed a diff for a plan it does not have`,
        );
      } else {
        assert.match(
          text.stdout,
          /diff --git/,
          `${writer.name} --diff printed no unified diff in ${mode} mode (exit ${text.code})`,
        );
      }
      // The same diff, in the document: a caller that cannot read it from JSON
      // has one question with two answers (ADR-014).
      const js = await run([...base, '--diff', '--json'], env);
      let payload = null;
      try {
        payload = JSON.parse(js.stdout);
      } catch {
        assert.fail(`${writer.name} --json --diff is not one JSON document: ${js.stdout.slice(0, 200)}`);
      }
      assert.equal(
        typeof payload.diff,
        'string',
        `${writer.name} --json --diff carries no diff field`,
      );
      assert.equal(
        await writer.verify(root),
        before,
        `${writer.name} --json --diff changed the filesystem in ${mode} mode`,
      );
      if (writer.noDiff === true) {
        assert.equal(payload.diff, '', `${writer.name} diffed a plan it does not have`);
      } else {
        assert.match(
          payload.diff,
          /diff --git/,
          `${writer.name} --json --diff carries an empty diff in ${mode} mode`,
        );
      }
    }
  });
}

test('a run that is authorised and not a rehearsal does write', async (t) => {
  // Without this the test above would pass on a command that never writes at all,
  // which is the shape of a vacuous fix: refuse everything, be correct about
  // refusing, and never have been broken.
  const root = await consumer();
  t.after(() => rm(root, { recursive: true, force: true }));
  await stalePin(root);
  const before = JSON.parse(await readFile(join(root, MANIFEST_FILE), 'utf8')).projection.simtDevSha;
  const { code } = await run(['upgrade', '--root', root, '--yes']);
  assert.equal(code, 0);
  const after = JSON.parse(await readFile(join(root, MANIFEST_FILE), 'utf8')).projection.simtDevSha;
  assert.notEqual(after, before, 'upgrade --yes no longer moves a pin, so the refusal proves nothing');
  assert.match(after, /^[0-9a-f]{40}$/, 'and the pin it wrote is not a stamp the grammar can read back');
});

test('writeMode is the only place that decides whether a run may write', async () => {
  // The reason the previous tests can be table-driven: the decision is one
  // function, so a new command cannot answer "may I write" a third way. This
  // asserts the arithmetic, which is where the two original defects lived
  // (`upgrade` read `yes` alone, `skills install` read neither flag).
  const { writeMode } = await import('../src/output/index.mjs');
  assert.deepEqual(writeMode({}), { dryRun: false, apply: false });
  assert.deepEqual(writeMode({ yes: true }), { dryRun: false, apply: true });
  assert.deepEqual(writeMode({ dryRun: true }), { dryRun: true, apply: false });
  assert.deepEqual(writeMode({ yes: true, dryRun: true }), { dryRun: true, apply: false });
});