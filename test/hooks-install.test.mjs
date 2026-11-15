import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { PACKAGE_NAME } from '../src/name.mjs';
import { after, test } from 'node:test';

import { GATE_KINDS, GATES, FORMATTABLE, gateNames } from '../src/hooks/gates.mjs';
import { EVENTS, HOOKS_DIR, HOOKS_DIR_LEGACY, HOOKS_PATH_KEY, SHIM_MARKER, fileFor, renderChainedShim, renderShim } from '../src/hooks/shim.mjs';
import { hasScript, resolveGate, resolveStagedTool } from '../src/hooks/resolve.mjs';
import { classifyPush, DEFAULT_SKIP_EXTENSIONS, parsePushedRefs, renderGateReport, runGates, stagedFiles } from '../src/hooks/dispatcher.mjs';
import { recordRun } from '../src/ledger/index.mjs';
import { packageVersion } from '../src/package-version.mjs';
import { readCapability } from '../src/hooks/capability.mjs';
import * as gateModule from '../src/projection/manifest.mjs';
import { git, cmd, keepTemp } from './fixture.mjs';
import { CLI } from '../src/name.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';
import { simt as simtCli } from './fixture.mjs';

import { run, exec, BIN, fixture, stageBlob, stagedContent, simt, simtAllowingFailure, SKIP_TEST, twoCommitPush, recordGreenSuite, installedRepo, setManifest, hooksPath } from './hooks2-fixture.mjs';
test('hooks install: writes both shims, sets core.hooksPath, and is idempotent', async () => {
  const root = await fixture({ manifest: { gates: { preCommit: ['lint'], prePush: ['test'] } } });
  await simt(['init', '--root', root, '--yes'], root).catch(() => {});
  await simt(['hooks', 'install', '--root', root, '--yes'], root);

  for (const event of EVENTS) {
    const body = await readFile(join(root, fileFor(event)), 'utf8');
    assert.equal(body, renderShim(event));
  }
  const { stdout } = await exec('git', ['config', '--get', HOOKS_PATH_KEY], { cwd: root });
  assert.equal(stdout.trim(), HOOKS_DIR);

  const again = await simt(['hooks', 'install', '--root', root, '--yes'], root);
  assert.match(again.stdout, /UNCHANGED/);
});

test('hooks install then undo: the shims go and core.hooksPath goes back to unset', async () => {
  // The VERIFIED defect of review 0003 Q22: `undo` removed the shims but left
  // `core.hooksPath` pointing at their empty directory, so the repository's
  // own hooks silently stopped running.
  const root = await fixture({ manifest: { gates: { preCommit: ['lint'], prePush: ['test'] } } });
  await simt(['init', '--root', root, '--yes'], root).catch(() => {});
  await simt(['hooks', 'install', '--root', root, '--yes'], root);
  const { stdout } = await exec('git', ['config', '--get', HOOKS_PATH_KEY], { cwd: root });
  assert.equal(stdout.trim(), HOOKS_DIR);

  const preview = await simt(['undo', '--root', root], root);
  assert.match(preview.stdout, /git config core\.hooksPath/);
  const undone = await simt(['undo', '--root', root, '--yes'], root);
  assert.match(undone.stdout, /undone/);

  await assert.rejects(exec('git', ['config', '--get', HOOKS_PATH_KEY], { cwd: root }), (error) => error.code === 1);
  for (const event of EVENTS) {
    await assert.rejects(readFile(join(root, fileFor(event)), 'utf8'), `the ${event} shim survived its own undo`);
  }
});

test('hooks install: refuses to take over an existing hooks path without --yes', async () => {
  const root = await fixture({ manifest: { gates: { preCommit: [], prePush: [] } } });
  await exec('git', ['config', HOOKS_PATH_KEY, 'scripts/git-hooks'], { cwd: root });

  await assert.rejects(
    () => simt(['hooks', 'install', '--root', root], root),
    (error) => error.code === 1 && /BLOCKED/.test(error.stdout + error.stderr),
  );
  const { stdout } = await exec('git', ['config', '--get', HOOKS_PATH_KEY], { cwd: root });
  assert.equal(stdout.trim(), 'scripts/git-hooks', 'must not have taken over');
});

test('hooks install: dry-run writes nothing', async () => {
  const root = await fixture({ manifest: { gates: { preCommit: ['lint'], prePush: [] } } });
  await simt(['hooks', 'install', '--root', root, '--dry-run'], root);
  await assert.rejects(() => readFile(join(root, fileFor('pre-commit')), 'utf8'));
});

test('hooks install: without --yes it prints the plan and the command that applies it', async () => {
  // ADR-040. `hooks install` used to read `flags.yes` and `flags.dryRun` directly
  // and write when neither said otherwise, so it was the last writer still writing
  // by default after ADR-035 and ADR-036. A preview that does not name the command
  // that applies it is only half the fix: the reader is left holding a plan with no
  // next step, which is how `sync`'s preview had to be written too.
  const root = await fixture({ manifest: { gates: { preCommit: ['lint'], prePush: ['test'] } } });

  const { stdout } = await simt(['hooks', 'install', '--root', root], root);
  assert.match(stdout, /PLAN\s+nothing written/, stdout);
  assert.match(stdout, new RegExp(`${CLI} hooks install --root .*--yes`), stdout);
  assert.doesNotMatch(stdout, /WROTE/, 'a preview that claims to have written is lying about what it did');
  await assert.rejects(() => readFile(join(root, fileFor('pre-commit')), 'utf8'));

  // And the plan it printed is the plan `--yes` carries out, or the preview is a
  // different claim from the write rather than a rehearsal of it.
  const applied = await simt(['hooks', 'install', '--root', root, '--yes'], root);
  assert.equal(applied.stdout.match(/CREATED/g).length, stdout.match(/CREATED/g).length);
  assert.match(await readFile(join(root, fileFor('pre-commit')), 'utf8'), /Generated by simt-dev/);
});

test('hooks install: a bare re-run of an installed repo writes nothing and is not a takeover', async () => {
  // The shape an operator actually hits: run it, then run it again to see. The
  // second run is not a takeover - `core.hooksPath` already points at the shims -
  // so it must reach the preview rather than the BLOCKED refusal ADR-018 requires.
  // Reaching either one by accident would teach the reader that `--yes` is needed
  // for a no-op, and then they would pass it for everything.
  const root = await fixture({ manifest: { gates: { preCommit: ['lint'], prePush: [] } } });
  await simt(['hooks', 'install', '--root', root, '--yes'], root);
  const before = await readFile(join(root, fileFor('pre-commit')), 'utf8');

  const { stdout } = await simt(['hooks', 'install', '--root', root], root);
  assert.doesNotMatch(stdout, /BLOCKED/, 'an idempotent re-run is not a takeover');
  assert.match(stdout, /UNCHANGED/);
  assert.equal(await readFile(join(root, fileFor('pre-commit')), 'utf8'), before);
});

test('hooks install: needs a manifest, because gates must be declared', async () => {
  const root = await fixture({});
  await assert.rejects(
    () => simt(['hooks', 'install', '--root', root, '--yes'], root),
    (error) => error.code === 3,
  );
});

test('hooks status: exits non-zero and names every problem', async () => {
  const root = await fixture({});
  await assert.rejects(
    () => simt(['hooks', 'status', '--root', root], root),
    (error) => {
      assert.equal(error.code, 1);
      const out = error.stdout + error.stderr;
      assert.match(out, cmd('{manifest} MISSING'));
      assert.match(out, /core\.hooksPath is \(unset\)/);
      assert.match(out, /pre-commit not installed/);
      return true;
    },
  );
});

test('hooks status: is clean and exits 0 once installed', async () => {
  const root = await fixture({ manifest: { gates: { preCommit: ['lint'], prePush: ['test'] } } });
  await simt(['hooks', 'install', '--root', root, '--yes'], root);
  const { stdout } = await simt(['hooks', 'status', '--root', root], root);
  assert.match(stdout, /\(simt-dev\)/);
  assert.match(stdout, /run script  \[ADR-004\]/);
  assert.doesNotMatch(stdout, /problems:/);
});

test('hooks status: flags a gate the dispatcher cannot run', async () => {
  const root = await fixture({
    manifest: { gates: { preCommit: ['memory'], prePush: [], commands: {} } },
  });
  await simt(['hooks', 'install', '--root', root, '--yes'], root);
  await assert.rejects(
    () => simt(['hooks', 'status', '--root', root], root),
    (error) => /command gate with no declared command/.test(error.stdout + error.stderr),
  );
});

test('hooks status: flags a declared command that no gate uses', async () => {
  const root = await fixture({
    manifest: { gates: { preCommit: ['lint'], prePush: [], commands: { memory: './x.sh' } } },
  });
  await simt(['hooks', 'install', '--root', root, '--yes'], root);
  const { stdout } = await simt(['hooks', 'status', '--root', root], root);
  assert.match(stdout, /declared but never run: memory/);
});

test('hooks run: refuses without a manifest instead of reporting success', async () => {
  const root = await fixture({});
  await assert.rejects(
    () => simt(['hooks', 'run', 'pre-commit', '--root', root], root),
    (error) => error.code === 3 && /cannot know its gate list/.test(error.stderr),
  );
});

test('hooks run: blocks on an unresolvable gate, so --no-verify is not the next step', async () => {
  const root = await fixture({ manifest: { gates: { preCommit: ['format'], prePush: [] } } });
  await assert.rejects(
    () => simt(['hooks', 'run', 'pre-commit', '--root', root], root),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /BLOCKED/);
      assert.match(error.stdout, /remedy:/);
      return true;
    },
  );
});

test('hooks run: --json reports the same verdict machine-readably', async () => {
  const root = await fixture({ scripts: { lint: 'exit 0' }, manifest: { gates: { preCommit: ['lint'], prePush: [] } } });
  const { stdout } = await simt(['hooks', 'run', 'pre-commit', '--root', root, '--json'], root);
  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.gates[0].status, 'passed');
});

test('a real git commit is blocked by a gate that cannot run', async () => {
  // The end-to-end claim: the shim is reachable from git, not only from the CLI.
  const root = await fixture({ manifest: { gates: { preCommit: ['format'], prePush: [] } } });
  // An initial commit first: an unborn branch would make `git log` itself fail,
  // so the assertion below could not distinguish "blocked" from "never ran".
  await writeFile(join(root, 'seed.txt'), 'seed\n');
  await exec('git', ['add', '-A'], { cwd: root });
  await git(['commit', '-q', '-m', 'seed', '--no-verify'], { cwd: root });
  await simt(['init', '--root', root, '--yes'], root).catch(() => {});
  await simt(['hooks', 'install', '--root', root, '--yes'], root);
  // Create the PARENT of the installed package, not the package itself: ln -sfn onto
  // an existing directory nests the link inside it, and the shim then finds nothing.
  const installed = join(root, 'node_modules', ...PACKAGE_NAME.split('/'));
  await mkdir(dirname(installed), { recursive: true });
  await exec('ln', ['-sfn', new URL('..', import.meta.url).pathname, installed]);
  await writeFile(join(root, '.gitignore'), 'node_modules\n');
  await writeFile(join(root, 'a.ts'), 'x\n');
  await exec('git', ['add', '-A'], { cwd: root });

  await assert.rejects(
    () => git(['commit', '-m', 'should be blocked'], { cwd: root }),
    (error) => {
      const out = `${error.stdout}${error.stderr}`;
      assert.match(out, /no formatter binary in node_modules\/\.bin/);
      assert.doesNotMatch(out, /created commit|\[simt-dev\/adopt /);
      return true;
    },
  );
  const { stdout } = await exec('git', ['log', '--oneline'], { cwd: root });
  assert.equal(stdout.trim().split('\n').length, 1, 'only the seed commit may exist');
});

test('hooks run: an empty gate list prints one note, not one line per character', async () => {
  // The note sat next to `gates` as a bare string while the caller iterated it, so a
  // string iterated character by character: 180 lines of noise from a hook whose only
  // job is to be readable. Found by running `hooks run` on the first repo that
  // legitimately has no pre-commit gate.
  const { runGates } = await import('../src/hooks/dispatcher.mjs');
  const result = await runGates('pre-commit', { root: '/nonexistent', manifest: { gates: { preCommit: [] } } });
  assert.equal(result.failed, false);
  assert.ok(Array.isArray(result.notes), 'notes must be an array, not a string');
  assert.equal(result.notes.length, 1);
  assert.equal(result.gates.length, 0);
});

test('hooks run: the empty-gate note explains the two readings, not just one', async () => {
  const { runGates } = await import('../src/hooks/dispatcher.mjs');
  const { notes } = await runGates('pre-push', { root: '/nonexistent', manifest: { gates: { prePush: [] } } });
  // The note must not read as "you forgot something": a repo with no formatter and no
  // linter has no pre-commit gate, and that is a correct manifest.
  assert.match(notes[0], /valid answer/);
  assert.match(notes[0], /no tool/);
  assert.ok(!/accident/i.test(notes[0]), 'the old wording implied the empty list was a mistake');
});

// ------------------------------------------------- foreign hooks (where.mjs)
// simt-space keeps 4 KB of real logic in .git/hooks/pre-commit with
// core.hooksPath UNSET. Unset means "git uses its default", not "git runs
// nothing", and reading it the other way made `hooks status` report a live hook
// as not installed and let `install` replace it without a word.

test('where: an unset core.hooksPath resolves to the git default, not to nothing', async () => {
  const { resolveHooksDir } = await import('../src/hooks/where.mjs');
  const root = await fixture({});
  const where = await resolveHooksDir(root);
  assert.equal(where.how, 'default');
  // git reports the top level through /private/var, mkdtemp hands back /var.
  assert.equal(where.dir, join(await realpath(root), '.git', 'hooks'));
});

test('where: a relative core.hooksPath resolves against the top of the working tree', async () => {
  // simt-app sets exactly this, and it works because git resolves a relative
  // hooks path against the worktree top, not against the git dir.
  const { resolveHooksDir } = await import('../src/hooks/where.mjs');
  const root = await fixture({ files: { 'hooks/pre-commit': '#!/bin/sh\nexit 0\n' } });
  await chmod(join(root, 'hooks', 'pre-commit'), 0o755);
  await exec('git', ['config', HOOKS_PATH_KEY, 'hooks'], { cwd: root });
  const where = await resolveHooksDir(root);
  assert.equal(where.how, 'configured');
  assert.equal(where.dir, join(await realpath(root), 'hooks'));
});

test('where: a linked worktree shares its parent hooks directory', async () => {
  // The worktree's git dir is not the parent repo's .git, and its own .git is a
  // FILE. `--git-path hooks` returns "./" here, which would enumerate the whole
  // repository as if every file in it were a hook.
  const { resolveHooksDir, foreignHooks } = await import('../src/hooks/where.mjs');
  const main = await fixture({});
  await writeFile(join(main, 'a.txt'), 'a\n');
  await exec('git', ['add', '.'], { cwd: main });
  await git(['commit', '-qm', 'seed'], { cwd: main });

  const links = await mkdtemp(join(tmpdir(), 'simt-wt-'));
  keepTemp(links);
  const wt = join(links, 'wt');
  await exec('git', ['worktree', 'add', '-q', wt], { cwd: main });

  const where = await resolveHooksDir(wt);
  assert.equal(where.how, 'default');
  assert.equal(where.dir, join(await realpath(main), '.git', 'hooks'));

  // A hook installed in the parent is a hook the worktree runs, and simt-dev
  // has to be able to see it.
  await writeFile(join(main, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
  await chmod(join(main, '.git', 'hooks', 'pre-commit'), 0o755);
  const live = await foreignHooks(wt);
  assert.equal(live.length, 1);
  assert.equal(live[0].event, 'pre-commit');
  assert.equal(live[0].path, join(await realpath(main), '.git', 'hooks', 'pre-commit'));
});

test('where: git sample templates are not hooks', async () => {
  const { foreignHooks } = await import('../src/hooks/where.mjs');
  const root = await fixture({});
  const gitHooks = join(root, '.git', 'hooks');
  for (const name of ['pre-commit.sample', 'pre-push.sample', 'update.sample']) {
    await writeFile(join(gitHooks, name), '#!/bin/sh\nexit 0\n');
    await chmod(join(gitHooks, name), 0o755);
  }
  assert.deepEqual(await foreignHooks(root), []);
});

test('hooks status: reports a hand-written hook git is running as foreign', async () => {
  const root = await fixture({
    manifest: { gates: { preCommit: ['lint'], prePush: [] }, commands: {} },
    scripts: { lint: 'true' },
    files: { '.git/hooks/pre-commit': '#!/bin/sh\n# 4088 bytes of real logic in the real world\necho hand-written\n' },
  });
  await chmod(join(root, '.git', 'hooks', 'pre-commit'), 0o755);
  // A foreign hook is a problem, so status exits non-zero and exec rejects.
  const { stdout } = await simt(['hooks', 'status', '--root', root], root).catch((e) => e);
  assert.match(stdout, /git runs these, and simt-dev did not write them/);
  assert.match(stdout, /pre-commit\s+.*\.git\/hooks\/pre-commit/);
  assert.match(stdout, /which is not a simt-dev shim/);
  // The header must not claim there are no hooks while listing one.
  assert.doesNotMatch(stdout, /\(none\)/);
  assert.match(stdout, /git default: .*\.git\/hooks/);
});

test('hooks install: refuses to replace a hand-written hook and writes nothing', async () => {
  const root = await fixture({
    manifest: { gates: { preCommit: ['lint'], prePush: [] }, commands: {} },
    scripts: { lint: 'true' },
    files: { '.git/hooks/pre-commit': '#!/bin/sh\necho hand-written\n' },
  });
  await chmod(join(root, '.git', 'hooks', 'pre-commit'), 0o755);
  await assert.rejects(
    () => simt(['hooks', 'install', '--root', root], root),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, new RegExp(`BLOCKED .* already runs git hooks that ${CLI} did not write`));
      assert.match(error.stdout, /git runs pre-commit at/);
      return true;
    },
  );
  const { stdout } = await exec('git', ['config', '--get', HOOKS_PATH_KEY], { cwd: root }).catch(() => ({ stdout: '' }));
  assert.equal(stdout.trim(), '', 'core.hooksPath must still be unset');
  // And the hook git runs is untouched.
  assert.match(await readFile(join(root, '.git', 'hooks', 'pre-commit'), 'utf8'), /hand-written/);
});

test('hooks install --yes: replaces it and says which hook stopped running', async () => {
  const root = await fixture({
    manifest: { gates: { preCommit: ['lint'], prePush: [] }, commands: {} },
    scripts: { lint: 'true' },
    files: { '.git/hooks/pre-commit': '#!/bin/sh\necho hand-written\n' },
  });
  await chmod(join(root, '.git', 'hooks', 'pre-commit'), 0o755);
  const { stderr } = await simt(['hooks', 'install', '--root', root, '--yes'], root);
  assert.match(stderr, /stopped running pre-commit at .*\.git\/hooks\/pre-commit \(\d+ bytes\)/);
  assert.match(stderr, /still on disk, untouched/);
});

test('hooks install --yes: chains a foreign hook on an event this tool does not gate', async () => {
  // The defect this closes, end to end. `core.hooksPath` does not scope routing to
  // the events this tool gates: git reads every hook from the named directory. So
  // without chaining, adopting this repository silently stops its `post-commit` -
  // no error, no log, hook still on disk looking intact.
  const root = await fixture({
    manifest: { gates: { preCommit: ['lint'], prePush: [] }, commands: {} },
    scripts: { lint: 'true' },
    files: { '.git/hooks/post-commit': '#!/bin/sh\nexit 0\n' },
  });
  await chmod(join(root, '.git', 'hooks', 'post-commit'), 0o755);

  const { stderr } = await simt(['hooks', 'install', '--root', root, '--yes'], root);

  // The note has to say it was CHAINED. The old note said "stopped running" about
  // every foreign hook, which is false here and would send an operator to restore a
  // hook that install is already running for them.
  assert.match(stderr, /chained post-commit/);
  assert.doesNotMatch(stderr, /stopped running post-commit/);

  // And the shim has to exist, run the original hook, and say so in the plan.
  const shim = await readFile(join(root, HOOKS_DIR, 'post-commit'), 'utf8');
  assert.match(shim, /post-commit/, 'the chained shim names its event');
  const { stdout } = await simt(['hooks', 'install', '--root', root], root);
  assert.match(stdout, /chained: runs \.git\/hooks\/post-commit/);
});

test('hooks install: a gate-type foreign hook is not chained, it is named as stopped', async () => {
  // The other half of ruling 7. `pre-commit` is an event this tool gates, so the
  // hook belongs in `gates.commands` where its verdict appears in the gate report;
  // chaining it would run it after the gates passed, where an author cannot see it.
  const root = await fixture({
    manifest: { gates: { preCommit: ['lint'], prePush: [] }, commands: {} },
    scripts: { lint: 'true' },
    files: { '.git/hooks/pre-commit': '#!/bin/sh\nexit 0\n' },
  });
  await chmod(join(root, '.git', 'hooks', 'pre-commit'), 0o755);
  const { stderr } = await simt(['hooks', 'install', '--root', root, '--yes'], root);
  assert.match(stderr, /stopped running pre-commit/);
  assert.match(stderr, /gates\.commands/);
});

test('hooks install: a second run leaves the chained shim unchanged', async () => {
  // Idempotency, which is where this actually broke. The chain was written on the
  // first run but read back from disk on the second, and macOS spells the same
  // directory `/var/...` and `/private/var/...` depending on who asked - so compared
  // naively the shim looked rewritten on every run and `install` rewrote an identical
  // file forever. A plan that never settles is indistinguishable from one that is
  // wrong, and this is the test that says the bytes are stable.
  const root = await fixture({
    manifest: { gates: { preCommit: ['lint'], prePush: [] }, commands: {} },
    scripts: { lint: 'true' },
    files: { '.git/hooks/post-commit': '#!/bin/sh\nexit 0\n' },
  });
  await chmod(join(root, '.git', 'hooks', 'post-commit'), 0o755);
  await simt(['hooks', 'install', '--root', root, '--yes'], root);
  const first = await readFile(join(root, HOOKS_DIR, 'post-commit'), 'utf8');

  const { stdout } = await simt(['hooks', 'install', '--root', root, '--yes'], root);
  assert.match(stdout, /UNCHANGED .simt\/hooks\/post-commit/);
  assert.equal(await readFile(join(root, HOOKS_DIR, 'post-commit'), 'utf8'), first);
});

test('hooks status: does not report this tool\'s own chained shim as a foreign hook', async () => {
  // A shim this tool wrote, refusing itself: the name is the repository's hook name,
  // so only the bytes can say whose it is. Without the marker check, every re-install
  // on a chained repo fails with "this repo already runs hooks simt did not write".
  const root = await fixture({
    manifest: { gates: { preCommit: ['lint'], prePush: [] }, commands: {} },
    scripts: { lint: 'true' },
    files: { '.git/hooks/post-commit': '#!/bin/sh\nexit 0\n' },
  });
  await chmod(join(root, '.git', 'hooks', 'post-commit'), 0o755);
  await simt(['hooks', 'install', '--root', root, '--yes'], root);

  const { stdout, stderr } = await simt(['hooks', 'status', '--root', root], root);
  assert.doesNotMatch(stdout + stderr, /git runs post-commit/);
});
