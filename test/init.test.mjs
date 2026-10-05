import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildManifest } from '../src/projection/manifest.mjs';

async function scratch() {
  return mkdtemp(join(tmpdir(), 'simt-manifest-'));
}

test('manifest: id defaults to the directory name', async () => {
  const root = await scratch();
  const { id } = buildManifest({ root, stack: ['python'] });
  assert.equal(id, root.split('/').pop());
});

test('manifest: coverage is null by default, not a guessed number (ADR-006)', () => {
  // The central rule mandates evidence discipline; the numeric bar is declared.
  // Inventing a default here would be worse than declaring none, because a
  // fabricated number reads as a decision the repo never made.
  const { limits } = buildManifest({ root: '/x/y', stack: ['python'] });
  assert.equal(limits.coverage, null);
});

test('manifest: file length defaults to the ADR-005 two tiers', () => {
  const { limits } = buildManifest({ root: '/x/y', stack: ['node'] });
  assert.deepEqual(limits.fileLines, { warn: 400, error: 1000 });
});

test('manifest: an existing manifest is never weakened by a re-init', () => {
  const existing = {
    id: 'custom-id',
    stack: ['python'],
    limits: { coverage: 100, fileLines: { warn: 250, error: 600 } },
    gates: { preCommit: ['ruff'], prePush: ['pytest'] },
    localSkills: ['coverage-hunt'],
    substitutions: { 'test-gate': { plansGlob: '../simt-social/docs/plans/*' } },
  };
  const next = buildManifest({ root: '/x/y', stack: ['gradle'], sha: 'abc1234', existing });
  assert.equal(next.id, 'custom-id');
  assert.equal(next.limits.coverage, 100);
  assert.deepEqual(next.limits.fileLines, { warn: 250, error: 600 });
  assert.deepEqual(next.gates.preCommit, ['ruff']);
  assert.deepEqual(next.localSkills, ['coverage-hunt']);
  // ADR-016: the repo's own substitution values survive a re-init. Losing them would
  // reset every generated `.mdc` rule to its defaults, which is a silent edit of four
  // files nobody asked to change.
  assert.deepEqual(next.substitutions['test-gate'], {
    plansGlob: '../simt-social/docs/plans/*',
  });
  // The declared stack wins over detection, or a re-init would silently reclassify.
  assert.deepEqual(next.stack, ['python']);
  // Only the projection stamp is refreshed.
  assert.equal(next.projection.simtDevSha, 'abc1234');
});

test('manifest: substitutions are seeded, not absent (ADR-016)', () => {
  // An absent key looks like an oversight; an empty object says the shape exists and
  // nothing needs filling in yet.
  const { substitutions } = buildManifest({ root: '/x/y', stack: ['node'] });
  assert.deepEqual(substitutions, {});
});

test('manifest: connectiq gets memory and codegen-drift gates (ADR-006)', () => {
  const { gates } = buildManifest({ root: '/x/y', stack: ['connectiq'] });
  assert.ok(gates.preCommit.includes('memory'));
  assert.ok(gates.preCommit.includes('codegen-drift'));
});

test('manifest: an unrecognised stack still gets a gate list', () => {
  // A gate that runs nothing is indistinguishable from a gate never installed.
  const { gates } = buildManifest({ root: '/x/y', stack: [] });
  assert.ok(gates.preCommit.length > 0);
  assert.ok(gates.prePush.length > 0);
});

test('manifest: typescript repos get typecheck on pre-push', () => {
  const { gates } = buildManifest({ root: '/x/y', stack: ['typescript', 'node'] });
  assert.ok(gates.prePush.includes('typecheck'));
});

test('init: dry-run is the default and writes nothing', async () => {
  const { initCommand } = await import('../src/commands/init.mjs');
  const root = await scratch();
  await writeFile(join(root, 'monkey.jungle'), '');
  const code = await initCommand([], { root, yes: false });
  assert.equal(code, 0);
  // No manifest, because nothing was applied.
  await assert.rejects(readFile(join(root, 'simt-dev.json'), 'utf8'));
});

test('init: a conflicting repo is blocked before any write', async () => {
  const { initCommand } = await import('../src/commands/init.mjs');
  const root = await scratch();
  await writeFile(join(root, 'monkey.jungle'), '');
  await writeFile(join(root, 'AGENTS.md'), '# Rules\n\n8. Committed and pushed with a conventional message\n');
  const code = await initCommand([], { root, yes: true });
  assert.equal(code, 1, 'a conflict must block even with --yes');
  await assert.rejects(readFile(join(root, 'simt-dev.json'), 'utf8'));
});

test('init: --accept-conflicts proceeds and writes both files', async () => {
  const { initCommand } = await import('../src/commands/init.mjs');
  const root = await scratch();
  await writeFile(join(root, 'monkey.jungle'), '');
  const agents = '# Rules\n\n1. Committed and pushed with a conventional message\n';
  await writeFile(join(root, 'AGENTS.md'), agents);
  const code = await initCommand([], { root, yes: true, acceptConflicts: true });
  assert.equal(code, 0);
  const manifest = JSON.parse(await readFile(join(root, 'simt-dev.json'), 'utf8'));
  assert.ok(manifest.projection.simtDevSha);
  const after = await readFile(join(root, 'AGENTS.md'), 'utf8');
  // The hand-written line survives verbatim: init never overwrites prose.
  assert.ok(after.startsWith(agents.trimEnd()));
  assert.ok(after.includes('simt-dev:begin'));
});

test('init: a malformed region blocks rather than duplicating the rules', async () => {
  const { initCommand } = await import('../src/commands/init.mjs');
  const root = await scratch();
  await writeFile(join(root, 'monkey.jungle'), '');
  await writeFile(join(root, 'AGENTS.md'), '# R\n\n<!-- simt-dev:begin -->\nstuff\n');
  const code = await initCommand([], { root, yes: true });
  assert.equal(code, 1);
  const after = await readFile(join(root, 'AGENTS.md'), 'utf8');
  assert.equal(after.match(/simt-dev:begin/g).length, 1, 'must not append a second region');
});

test('init: scaffolding a repo with no rules creates AGENTS.md', async () => {
  const { initCommand } = await import('../src/commands/init.mjs');
  const root = await scratch();
  await writeFile(join(root, 'monkey.jungle'), '');
  const code = await initCommand([], { root, yes: true });
  assert.equal(code, 0);
  const after = await readFile(join(root, 'AGENTS.md'), 'utf8');
  assert.ok(after.includes('simt-dev:begin'));
  assert.ok(after.includes('simt-dev:end'));
});

test('init: never commits', async () => {
  // ADR-001. init writes files; a human decides whether that becomes a commit.
  const { initCommand } = await import('../src/commands/init.mjs');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  const root = await scratch();
  await run('git', ['init', '-q'], { cwd: root });
  await writeFile(join(root, 'monkey.jungle'), '');
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', ['-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', 'base'], {
    cwd: root,
  });

  await initCommand([], { root, yes: true });

  const { stdout: log } = await run('git', ['log', '--oneline'], { cwd: root });
  assert.equal(log.trim().split('\n').length, 1, 'init must not create a commit');
  const { stdout } = await run('git', ['status', '--porcelain'], { cwd: root });
  assert.match(stdout, /simt-dev\.json/, 'files are left uncommitted for review');
});

test('init: a repo with no commits is still adoptable', async () => {
  // An unborn repo cannot be tagged, so the escape hatch degrades to a note
  // rather than blocking. Refusing to initialise would be worse.
  const { initCommand } = await import('../src/commands/init.mjs');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  const root = await scratch();
  await run('git', ['init', '-q'], { cwd: root });
  await writeFile(join(root, 'monkey.jungle'), '');

  assert.equal(await initCommand([], { root, yes: true }), 0);
  const manifest = await readFile(join(root, 'simt-dev.json'), 'utf8');
  assert.match(manifest, /simtDevSha/);
});
test('manifest: the default id is the repo name, not unnamed-repo (ADR-016 follow-up)', () => {
  // `basename('.')` is `''`, so the most natural invocation — `simt init .` — wrote an
  // `unnamed-repo` id into the one field of the manifest a human reads.
  assert.equal(buildManifest({ root: '.', stack: [] }).id, process.cwd().split('/').pop());
  assert.equal(buildManifest({ root: process.cwd(), stack: [] }).id, process.cwd().split('/').pop());
});
