// A profile that declares a scope loads only when a matching file is in play (S50).
//
// The whole point of this feature is that the profile LEAVES the region, so the tests
// below mostly assert where it went rather than what it says: a rule that moved out of
// AGENTS.md and was not named anywhere is a rule the reader cannot find.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { plan, checkTargets, loadRules } from '../src/projection/project.mjs';
import { desiredRegion } from '../src/projection/rules.mjs';
import { canScope, SURFACES, undocumentedKeys } from '../src/projection/surfaces.mjs';

/** Write what a plan decided, the way `sync` does, so a test can gate or read it. */
async function writePlanned(root, p) {
  for (const t of p.targets) {
    if (t.text === undefined) continue;
    await mkdir(join(root, dirname(t.file)), { recursive: true });
    await writeFile(t.path, t.text);
  }
}

/** A python repository with a local profile that scopes itself. */
async function scopedRepo(scope = '["pyproject.toml", "*.py"]', id = 'local-python') {
  const root = await mkdtemp(join(tmpdir(), 'simt-scoped-'));
  await mkdir(join(root, '.simt-dev', 'profiles'), { recursive: true });
  await writeFile(join(root, 'pyproject.toml'), '[project]\nname = "x"\n');
  await writeFile(join(root, 'main.py'), 'print(1)\n');
  await writeFile(
    join(root, '.simt-dev', 'profiles', `${id}.md`),
    `---\nsimt-id: ${id}\nsimt-title: Scoped python\nsimt-applies: [python]\n${scope ? `simt-scope: ${scope}\n` : ''}---\n\n# Scoped python\n\nDo the scoped thing.\n`,
  );
  return root;
}

// --------------------------------------------------------------- what leaves, and what stays

test('a scoped profile leaves the region for the surfaces that can narrow it', async () => {
  const root = await scopedRepo();
  const desired = await desiredRegion(root, { surfaces: 'cursor,copilot,antigravity' });
  assert.equal(desired.narrowing, true, 'three surfaces with a documented scoping key can narrow');
  // The shipped `python` profile scopes too, so both move; what is asserted is that the
  // local one is among them.
  assert.ok(desired.scoped.some((r) => r.id === 'local-python'), desired.scoped.map((r) => r.id).join(' '));
  assert.ok(!desired.body.includes('Do the scoped thing'), 'the profile text left the region');
  // The pointer is not decoration: without it the source list is quietly one short.
  assert.match(desired.body, /## Disclosure/);
  assert.ok(desired.body.includes('local-python'), 'the pointer names the profile by id');
  assert.match(desired.body, /pyproject\.toml/);
  assert.ok(desired.meta.sources.some((s) => s.includes('local-python')), 'the source list still names it');
  await rm(root, { recursive: true, force: true });
});

test('a surface that cannot narrow keeps the profile in the region, and says why', async () => {
  // Claude Code's `paths:` key has a documented parser defect in which quoted values
  // and YAML sequences silently fail to lazy-load (surfaces.mjs decision 3). A profile
  // written only as a scoped file for it would be a rule that reader never loads.
  const root = await scopedRepo();
  const desired = await desiredRegion(root, { surfaces: 'cursor,claude' });
  assert.equal(desired.narrowing, false);
  assert.ok(desired.body.includes('Do the scoped thing'), 'it stayed where a reader will find it');
  assert.ok(
    desired.notes.some((n) => /cannot narrow|simt-scope/.test(n)),
    `a narrowed profile that stayed must say so: ${JSON.stringify(desired.notes)}`,
  );
  await rm(root, { recursive: true, force: true });
});

test('every surface either keeps the profile at session start or writes the file it loads on a match', async () => {
  // The accept is per surface, and the three that can narrow were previously checked
  // together. A surface that cannot narrow must keep the body: writing only the scoped
  // file would be a rule that reader never loads.
  const root = await scopedRepo();
  for (const surface of SURFACES) {
    const desired = await desiredRegion(root, { surfaces: surface.id });
    if (canScope(surface)) {
      assert.equal(desired.narrowing, true, surface.id);
      assert.equal(desired.body.includes('Do the scoped thing'), false, `${surface.id} still carries the profile`);
      assert.match(desired.body, /## Disclosure/);
      const planned = await plan(root, { surfaces: surface.id });
      const file = planned.targets.find((t) => t.text?.includes('Do the scoped thing') && t.file?.includes('local-python'));
      assert.ok(file, `${surface.id} wrote no file a matching path can load`);
    } else {
      assert.equal(desired.body.includes('Do the scoped thing'), true, `${surface.id} dropped a profile it cannot load any other way`);
    }
  }
  await rm(root, { recursive: true, force: true });
});

test('an unscoped profile behaves exactly as it did before', async () => {
  const root = await scopedRepo(null);
  const desired = await desiredRegion(root, { surfaces: 'cursor' });
  // The shipped `python` profile still scopes, so this is about the LOCAL profile only.
  assert.ok(!desired.scoped.some((r) => r.id === 'local-python'), 'an unscoped profile narrows nothing');
  assert.equal(desired.narrowing, true);
  assert.ok(desired.body.includes('Do the scoped thing'));
  await rm(root, { recursive: true, force: true });
});

// --------------------------------------------------------------- what lands on disk

test('the scoped file carries the patterns the surface was documented to take', async () => {
  const root = await scopedRepo();
  const p = await plan(root, { surfaces: 'cursor,copilot,antigravity' });
  const files = p.targets.map((t) => t.file);
  await writePlanned(root, p);
  assert.ok(files.includes('.cursor/rules/local-python.mdc'), files.join(' '));
  assert.ok(files.includes('.agents/rules/local-python.md'), files.join(' '));
  assert.ok(files.includes('.github/instructions/local-python.instructions.md'), files.join(' '));

  const cursor = await readFile(join(root, '.cursor/rules/local-python.mdc'), 'utf8');
  assert.match(cursor, /^alwaysApply: false$/m, 'a rule that attaches on patterns says so');
  assert.match(cursor, /^globs: "pyproject\.toml", "\*\.py"$/m);
  // The description is not optional: Cursor documents no-description plus no-globs as a
  // manual @-mention, so a scoped rule without one would never attach to anything.
  assert.match(cursor, /^description: /m);

  const antigravity = await readFile(join(root, '.agents/rules/local-python.md'), 'utf8');
  assert.match(antigravity, /^trigger: glob$/m);
  // Quoted because YAML reads a value starting with `*` as an alias anchor, and an
  // invalid frontmatter block is discarded with no message at all.
  assert.match(antigravity, /^globs: "pyproject\.toml", "\*\.py"$/m);

  const copilot = await readFile(join(root, '.github/instructions/local-python.instructions.md'), 'utf8');
  assert.match(copilot, /^applyTo: "pyproject\.toml,\*\.py"$/m);
  await rm(root, { recursive: true, force: true });
});

test('a scoped file is gated like any other: drift and absence both fail the check', async () => {
  const root = await scopedRepo();
  await writePlanned(root, await plan(root, { surfaces: 'cursor' }));
  const onDisk = join(root, '.cursor/rules/local-python.mdc');

  const statusOf = async () =>
    (await checkTargets(root, { surfaces: 'cursor' })).find((f) => f.file?.endsWith('local-python.mdc'))?.status;
  assert.equal(await statusOf(), 'current');

  await writeFile(onDisk, (await readFile(onDisk, 'utf8')).replace('<!-- simt:end -->', 'tampered\n<!-- simt:end -->'));
  assert.equal(await statusOf(), 'drift');

  await rm(onDisk);
  assert.equal(await statusOf(), 'absent');
  await rm(root, { recursive: true, force: true });
});

// --------------------------------------------------------------- the frontmatter itself

test('a quoted pattern is read as the pattern, not as the quotes around it', async () => {
  const root = await scopedRepo();
  const [rule] = (await loadRules(root)).filter((r) => r.id === 'local-python');
  assert.deepEqual(rule.scope, ['pyproject.toml', '*.py']);
  assert.equal(rule.error, null);
  await rm(root, { recursive: true, force: true });
});

test('a scope that matches everything is refused, because it is not narrowing', async () => {
  // `**` is the pattern a surface applies when it is given none, so a profile carrying
  // it is the eager profile wearing a costume.
  for (const bad of ['["**"]', '["**/*"]', '["*"]']) {
    const root = await scopedRepo(bad);
    const rule = (await loadRules(root)).find((r) => r.id === 'local-python');
    assert.notEqual(rule.error, null, `${bad} should be refused`);
    assert.match(rule.error, /narrows/);
    await rm(root, { recursive: true, force: true });
  }
});

test('an empty scope is refused too', async () => {
  const root = await scopedRepo('[]');
  const rule = (await loadRules(root)).find((r) => r.id === 'local-python');
  assert.notEqual(rule.error, null);
  await rm(root, { recursive: true, force: true });
});

// --------------------------------------------------------------- the surface table

test('only surfaces whose scoping key was read in the vendor docs can narrow', () => {
  const byId = new Map(SURFACES.map((s) => [s.id, s]));
  for (const id of ['cursor', 'antigravity', 'copilot']) {
    assert.equal(canScope(byId.get(id)), true, `${id} documents a scoping key`);
  }
  // Claude: `paths:` is documented AND broken. opencode: has no per-rule channel.
  assert.equal(canScope(byId.get('claude')), false);
  assert.equal(canScope(byId.get('opencode')), false);
});

test('every key the scoped shape emits is in the vendor docs, checked on both shapes', () => {
  assert.deepEqual(undocumentedKeys(), []);
});

test('an eager rule still emits no scoping frontmatter (decision 3)', () => {
  const byId = new Map(SURFACES.map((s) => [s.id, s]));
  assert.deepEqual(byId.get('cursor').ruleFrontmatter({ id: 'x', description: 'd', alwaysApply: true }), [
    'description: d',
    'alwaysApply: true',
  ]);
  assert.deepEqual(byId.get('antigravity').ruleFrontmatter({ id: 'x', description: 'd', alwaysApply: true }), [
    'trigger: always_on',
    'description: d',
  ]);
  assert.deepEqual(byId.get('copilot').ruleFrontmatter({ id: 'x', description: 'd', alwaysApply: true }), [
    'applyTo: "**"',
  ]);
});

// --------------------------------------------------------------- the shipped profiles

test('every shipped profile that declares a scope has patterns that narrow', async () => {
  const rules = await loadRules(process.cwd());
  const scoped = rules.filter((r) => r.scope);
  assert.ok(scoped.length > 0, 'the feature is exercised by shipped content, not only by fixtures');
  for (const r of scoped) {
    assert.equal(r.error, null, `${r.id}: ${r.error}`);
    assert.ok(r.scope.every((g) => g !== '**' && g !== '*'), `${r.id} carries a catch-all`);
    assert.ok(r.scope.every((g) => typeof g === 'string' && g.length > 0), `${r.id} has an empty pattern`);
  }
});

test('a profile is only narrowed by a surface, never by a bare key the reader would see', async () => {
  // ADR-022: a profile carrying a bare key reads as an editor's instruction and is
  // silently inert. `simt-scope` is the tool's own key and is stripped from the body.
  const rules = await loadRules(process.cwd());
  for (const r of rules.filter((x) => x.scope)) {
    assert.ok(!r.body.includes('simt-scope'), `${r.id} leaks its own frontmatter into the body`);
  }
});