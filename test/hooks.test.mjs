import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, test } from 'node:test';

import { GATES, FORMATTABLE, gateNames } from '../src/hooks/gates.mjs';
import { EVENTS, HOOKS_DIR, HOOKS_PATH_KEY, fileFor, renderShim } from '../src/hooks/shim.mjs';
import { hasScript, knownGates, resolveGate, resolveStagedTool } from '../src/hooks/resolve.mjs';
import { runGates } from '../src/hooks/dispatcher.mjs';

const exec = promisify(execFile);
const BIN = new URL('../bin/simt-dev.mjs', import.meta.url).pathname;
const temps = [];

after(async () => {
  for (const t of temps) await exec('rm', ['-rf', t]);
});

async function fixture({ scripts, manifest, files = {}, binaries = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'simt-hooks-'));
  temps.push(root);
  await exec('git', ['init', '-q', '.'], { cwd: root });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fx', scripts: scripts ?? {} }, null, 2));
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, body);
  }
  if (manifest) await writeFile(join(root, 'simt-dev.json'), JSON.stringify(manifest, null, 2));
  for (const b of binaries) {
    const path = join(root, 'node_modules', '.bin', b);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, '#!/bin/sh\nexit 0\n');
    await chmod(path, 0o755);
  }
  return root;
}

async function simt(args, cwd) {
  return exec('node', [BIN, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' } });
}

// ---------------------------------------------------------------- shim

test('shim: bakes the event name in rather than deriving it from $0', () => {
  const body = renderShim('pre-push');
  assert.match(body, /hooks run pre-push --root "\$ROOT"/);
  assert.doesNotMatch(body, /basename/);
});

test('shim: refuses an unknown event', () => {
  assert.throws(() => renderShim('post-merge'), /unknown hook event/);
});

test('shim: generated source is valid POSIX sh', async () => {
  // A shim with a syntax error fails at commit time, in the author's face, at
  // the worst possible moment. `sh -n` catches it before it ships.
  for (const event of EVENTS) {
    const path = join(await mkdtemp(join(tmpdir(), 'simt-shim-')), event);
    temps.push(join(path, '..'));
    await writeFile(path, renderShim(event));
    await exec('sh', ['-n', path]);
  }
});

test('shim: does not escape the shell variables it interpolates', async () => {
  // Regression: a template that emitted "\$ROOT" produced a literal string, so
  // the node_modules check never matched and every commit was blocked with
  // "cannot locate the dispatcher".
  const body = renderShim('pre-commit');
  assert.doesNotMatch(body, /\\\$ROOT/);
  assert.match(body, /"\$ROOT\/node_modules/);
  assert.match(body, /\$\{SIMT_DEV_BIN:-\}/);
});

test('shim: every parameter expansion carries a default', () => {
  // Regression: the "cannot locate the dispatcher" remedy echoed $SIMT_DEV_BIN
  // unguarded. The shim runs under `set -eu`, so that one line aborted the shell
  // with "SIMT_DEV_BIN: unbound variable" and the reader got an error instead of
  // the message explaining it. `sh -n` cannot catch this - the script is valid,
  // it just dies at runtime, in the one branch that only runs when nothing
  // resolved. So the guard is structural.
  for (const event of EVENTS) {
    const body = renderShim(event);
    const names = [...body.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)].map((m) => m[1]);
    for (const name of names) {
      assert.ok(
        body.includes(`\${${name}:-`),
        `${event}: $${name} expands without a default and dies under \`set -u\``,
      );
    }
  }
});

test('shim: SIMT_DEV_BIN naming a .mjs entry point is run through node', async () => {
  // Regression: `exec "$SIMT_DEV_BIN"` treats the whole value as one filename, so
  // the documented override could not be used from a source checkout - the normal
  // case for anyone working on simt-dev itself.
  const root = await mkdtemp(join(tmpdir(), 'simt-shim-'));
  temps.push(root);
  await writeFile(join(root, 'simt-dev.json'), JSON.stringify({ gates: { preCommit: [], prePush: [] } }));
  await mkdir(join(root, '.git'), { recursive: true });
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: root });

  const path = join(root, fileFor('pre-commit'));
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, renderShim('pre-commit'));
  await chmod(path, 0o755);

  const { stdout } = await exec('sh', [path], {
    cwd: root,
    env: { ...process.env, SIMT_DEV_BIN: BIN, PATH: process.env.PATH },
  });
  assert.match(stdout, /^hooks\s+pre-commit/m);
});

test('shim: SIMT_DEV_BIN naming a command line is refused, not half-executed', async () => {
  // There is no safe way to split a command line in sh without eval. Guessing
  // would run the wrong program; refusing says exactly what to set instead.
  const root = await mkdtemp(join(tmpdir(), 'simt-shim-'));
  temps.push(root);
  await mkdir(join(root, '.git'), { recursive: true });
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: root });

  const path = join(root, fileFor('pre-commit'));
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, renderShim('pre-commit'));
  await chmod(path, 0o755);

  const result = await exec('sh', [path], {
    cwd: root,
    // PATH stays intact: emptying it makes `sh` itself unresolvable, so execFile
    // never runs the script at all. The refusal happens before any PATH lookup.
    env: { ...process.env, SIMT_DEV_BIN: `node ${BIN}` },
  }).catch((error) => ({ stderr: error.stderr, code: error.code }));

  assert.match(result.stderr, /names a command line, not a program/);
  assert.equal(result.code, 1);
});

test('shim: does not forward git arguments into argv', () => {
  // pre-push passes a remote name and URL; forwarding them would make argv
  // read them as command arguments.
  assert.doesNotMatch(renderShim('pre-push'), /run "\$@"/);
});

test('shim: every resolution path has a remedy and exits non-zero', () => {
  const body = renderShim('pre-commit');
  assert.match(body, /REMEDY/);
  assert.match(body, /exit 1/);
  assert.match(body, /cannot locate the dispatcher/);
});

test('shim: fileFor places both events in one directory', () => {
  assert.equal(fileFor('pre-commit'), `${HOOKS_DIR}/pre-commit`);
  assert.equal(fileFor('pre-push'), `${HOOKS_DIR}/pre-push`);
});

// ---------------------------------------------------------------- gates

test('gates: every gate declares a kind, an ADR and a reason', () => {
  for (const gate of Object.values(GATES)) {
    assert.ok(['staged', 'script', 'command'].includes(gate.kind), `${gate.name} kind`);
    assert.match(gate.adr, /^ADR-\d{3}$/, `${gate.name} adr`);
    assert.ok(gate.why.length > 20, `${gate.name} why`);
  }
});

test('gates: format is staged and the rest are script or command', () => {
  assert.equal(GATES.format.kind, 'staged');
  assert.equal(GATES.lint.kind, 'script');
  assert.equal(GATES.memory.kind, 'command');
});

test('gates: known gate names are sorted and include the manifest defaults', () => {
  const names = knownGates();
  assert.deepEqual(names, [...names].sort());
  for (const n of ['format', 'lint', 'test', 'coverage', 'typecheck', 'memory', 'codegen-drift', 'i18n-completeness']) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
});

// ---------------------------------------------------------------- resolve

test('resolve: hasScript only accepts a non-empty string', () => {
  const pkg = { scripts: { a: 'x', b: '' } };
  assert.equal(hasScript(pkg, 'a'), true);
  assert.equal(hasScript(pkg, 'b'), false);
  assert.equal(hasScript(pkg, 'missing'), false);
  assert.equal(hasScript(null, 'a'), false);
});

test('resolve: staged gate finds the binary in the project node_modules', async () => {
  const root = await fixture({ binaries: ['prettier'] });
  const tool = await resolveStagedTool(root, GATES.format);
  assert.equal(tool.tool, 'prettier');
  assert.match(tool.path, /node_modules\/\.bin\/prettier$/);
});

test('resolve: staged gate reports exactly what it looked for when absent', async () => {
  const root = await fixture({});
  const tool = await resolveStagedTool(root, GATES.format);
  assert.equal(tool.path, null);
  assert.equal(tool.tried.length, 1);
});

test('resolve: staged gate only receives files it can format', async () => {
  const root = await fixture({ binaries: ['prettier'] });
  const result = await resolveGate(GATES.format, {
    root,
    pkg: null,
    staged: ['src/a.ts', 'docs/b.md', 'logo.png', 'Makefile'],
    commands: {},
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.argv.slice(2), ['src/a.ts', 'docs/b.md']);
});

test('resolve: staged gate is a pass with nothing to do, not a failure', async () => {
  const root = await fixture({ binaries: ['prettier'] });
  const result = await resolveGate(GATES.format, {
    root, pkg: null, staged: ['logo.png'], commands: {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.argv, null);
});

test('resolve: a gate that cannot run fails with a remedy, never silently passes', async () => {
  const cases = [
    [GATES.format, {}, 'no formatter binary in node_modules/.bin', 'remove "format"'],
    [GATES.lint, {}, 'package.json declares no "lint" script', 'add "lint" to scripts'],
    [GATES.memory, {}, 'no command declared', 'gates.commands["memory"]'],
  ];
  for (const [gate, ctx, reasonFragment, remedyFragment] of cases) {
    const root = await fixture({});
    const result = await resolveGate(gate, { root, pkg: ctx.pkg ?? null, staged: [], commands: ctx.commands });
    assert.equal(result.ok, false, `${gate.name} should fail`);
    assert.ok(result.reason.includes(reasonFragment), `${gate.name} reason: ${result.reason}`);
    assert.ok(result.remedy.includes(remedyFragment), `${gate.name} remedy: ${result.remedy}`);
  }
});

test('resolve: script gates go through npm run, never npx (ADR-010)', async () => {
  const root = await fixture({ scripts: { lint: 'true' } });
  const result = await resolveGate(GATES.lint, { root, pkg: { scripts: { lint: 'true' } }, staged: [], commands: {} });
  assert.deepEqual(result.argv, ['npm', 'run', '--silent', 'lint']);
  assert.doesNotMatch(result.argv.join(' '), /npx|npm exec/);
});

test('resolve: a command gate uses the manifest command verbatim', async () => {
  const root = await fixture({});
  const result = await resolveGate(GATES.memory, {
    root, pkg: null, staged: [], commands: { memory: './bin/memcheck.sh' },
  });
  assert.deepEqual(result.argv, ['./bin/memcheck.sh']);
});

test('resolve: formattable extensions include what the estate actually uses', () => {
  for (const ext of ['.ts', '.tsx', '.json', '.md', '.less', '.yml']) {
    assert.ok(FORMATTABLE.has(ext), `missing ${ext}`);
  }
  assert.equal(FORMATTABLE.has('.png'), false);
  assert.equal(FORMATTABLE.has('.tif'), false);
});

// ---------------------------------------------------------------- dispatcher

test('dispatcher: an unresolvable gate blocks the event', async () => {
  const root = await fixture({ scripts: {}, manifest: { gates: { preCommit: ['format'], prePush: [] } } });
  const result = await runGates('pre-commit', { root, manifest: { gates: { preCommit: ['format'], prePush: [] } } });
  assert.equal(result.failed, true);
  assert.equal(result.gates[0].status, 'failed');
  assert.ok(result.gates[0].remedy);
});

test('dispatcher: an unknown gate blocks rather than being skipped', async () => {
  const manifest = { gates: { preCommit: ['format', 'made-up-gate'], prePush: [] } };
  const root = await fixture({ manifest });
  const result = await runGates('pre-commit', { root, manifest });
  const bad = result.gates.find((g) => g.name === 'made-up-gate');
  assert.equal(bad.status, 'failed');
  assert.match(bad.detail, /unknown gate/);
  assert.equal(result.failed, true);
});

test('dispatcher: a failing script gate fails the event and reports the output', async () => {
  const manifest = { gates: { preCommit: ['lint'], prePush: [] } };
  const root = await fixture({ scripts: { lint: 'echo BOOM; exit 3' }, manifest });
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const result = await runGates('pre-commit', {
    root,
    manifest: { ...manifest, gates: { ...manifest.gates, preCommit: ['lint'] } },
  });
  const gate = result.gates.find((g) => g.name === 'lint');
  assert.equal(gate.status, 'failed');
  assert.match(gate.detail, /exit 3/);
  assert.ok(pkg.scripts.lint);
});

test('dispatcher: an empty gate list passes but says why', async () => {
  const root = await fixture({ manifest: { gates: { preCommit: [], prePush: [] } } });
  const result = await runGates('pre-commit', { root, manifest: { gates: { preCommit: [], prePush: [] } } });
  assert.equal(result.failed, false);
  assert.match(result.note, /declares no gates\.preCommit/);
});

test('dispatcher: pre-push reads gates.prePush, not preCommit', async () => {
  const manifest = { gates: { preCommit: ['lint'], prePush: ['test'] } };
  const root = await fixture({ scripts: { test: 'exit 0' }, manifest });
  const result = await runGates('pre-push', { root, manifest });
  assert.deepEqual(result.gates.map((g) => g.name), ['test']);
});

test('dispatcher: an unknown event fails rather than passing silently', async () => {
  const root = await fixture({});
  const result = await runGates('post-merge', { root, manifest: { gates: {} } });
  assert.equal(result.failed, true);
  assert.match(result.error, /unknown hook event/);
});

// ---------------------------------------------------------------- install / status

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
      assert.match(out, /simt-dev\.json MISSING/);
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
  await exec('git', ['commit', '-q', '-m', 'seed', '--no-verify'], { cwd: root });
  await simt(['init', '--root', root, '--yes'], root).catch(() => {});
  await simt(['hooks', 'install', '--root', root, '--yes'], root);
  await mkdir(join(root, 'node_modules', '@quazarmedia'), { recursive: true });
  await exec('ln', ['-sfn', new URL('..', import.meta.url).pathname, join(root, 'node_modules', '@quazarmedia', 'simt-dev')]);
  await writeFile(join(root, '.gitignore'), 'node_modules\n');
  await writeFile(join(root, 'a.ts'), 'x\n');
  await exec('git', ['add', '-A'], { cwd: root });

  await assert.rejects(
    () => exec('git', ['commit', '-m', 'should be blocked'], { cwd: root }),
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

test('gateNames matches knownGates', () => {
  assert.deepEqual(gateNames(), knownGates());
});