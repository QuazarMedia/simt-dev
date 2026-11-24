// Q71: a harness is a data record under `harnesses/`, not a row in a table the
// engine edits (ADR-013). This file is the regression net for that ruling, and for
// the failure the review named as evidence: one harness's surface row, reader row,
// hook dialect and plugin layout used to live in five modules, and they could drift
// apart — a new harness arrived as five coordinated edits.
//
// The net has two halves. The structural tests pin WHICH records each view returns
// and in what order, against the known-good selection — if a view starts filling a
// facet a record does not declare, or reorders, one of them fails. The byte-identity
// tests pin the CONTENT: each view must return the record's facet unreshaped, so a
// view that starts transforming a row (a renamed key, a filled default) fails here.
// The rendered bytes those rows produce are pinned separately by the module nets —
// surfaces, agenthooks, plugins and loaders — so this file owns the plumbing between
// the data and the views, and they own the bytes.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  harnessHooks,
  harnessLoaders,
  harnessPayloads,
  harnessPlugins,
  harnessPointers,
  harnessScopeKeys,
  harnessSurfaces,
  loadHarnesses,
} from '../src/harness/records.mjs';
import { surfaces } from '../src/projection/surfaces.mjs';
import { loaders } from '../src/projection/loaders.mjs';
import { adapters, hookPath } from '../src/agenthooks/render.mjs';
import { pluginKinds } from '../src/plugins.mjs';

// The shipped records, read in the test so a view can be pinned against the data it
// must return unreshaped. The records are the known-good values: they were generated
// from the five module tables the views replace, and that generation was checked
// byte-identical before the tables went.
const SHIPPED_DIR = fileURLToPath(new URL('../harnesses/', import.meta.url));
async function recordFiles() {
  const out = {};
  for (const file of (await readdir(SHIPPED_DIR)).sort()) {
    if (!file.endsWith('.json')) continue;
    out[file.slice(0, -5)] = JSON.parse(await readFile(join(SHIPPED_DIR, file), 'utf8'));
  }
  return out;
}

async function tmpRoot() {
  return await mkdtemp(join(tmpdir(), 'harness-records-'));
}

const ALL_IDS = ['opencode', 'claude', 'codex', 'cursor', 'antigravity', 'gemini', 'copilot', 'deepseek'];

// --- The records load ----------------------------------------------------------

test('the shipped records load, one per file, ids unique and exactly the eight harnesses', () => {
  const records = loadHarnesses();
  assert.equal(records.length, 8);
  assert.deepEqual([...records.map((r) => r.id)].sort(), [...ALL_IDS].sort());
});

// --- Which records each view returns, and in what order ------------------------

test('each view returns exactly the records that declare the facet, in their declared order', () => {
  // Surfaces, by surfaceOrder — the order `project` iterates them.
  assert.deepEqual(harnessSurfaces().map((r) => r.id), ['opencode', 'cursor', 'claude', 'antigravity', 'copilot']);
  // Pointers, by pointerOrder.
  assert.deepEqual(harnessPointers().map((r) => r.id), ['claude-md', 'gemini-md']);
  // Reader rows, by loaderOrder — all eight harnesses read a rule surface.
  assert.deepEqual(harnessLoaders().map((r) => r.id), ALL_IDS);
  // Plugin layouts, by pluginOrder — the order the `simt plugin` help line names them.
  assert.deepEqual(harnessPlugins().map((r) => r.id), ['claude', 'gemini', 'cursor', 'opencode']);
  // Hook dialect and payload contract, by id — six: copilot and deepseek declare neither.
  assert.deepEqual(Object.keys(harnessHooks()).sort(), ['antigravity', 'claude', 'codex', 'cursor', 'gemini', 'opencode']);
  assert.deepEqual(Object.keys(harnessPayloads()).sort(), ['antigravity', 'claude', 'codex', 'cursor', 'gemini', 'opencode']);
  // Scoping keys — the three surfaces whose scoping key was read in the vendor's docs.
  assert.deepEqual([...harnessScopeKeys()].sort(), ['antigravity', 'copilot', 'cursor']);
});

test('absence is a fact: deepseek declares a reader row and nothing else', async () => {
  const files = await recordFiles();
  // No surface, no pointer, no hook, no payload, no plugin: the vendor documents none of
  // them, and the views filter rather than fill, so a missing facet stays missing.
  assert.equal(files.deepseek.surface, undefined);
  assert.equal(files.deepseek.pointer, undefined);
  assert.equal(files.deepseek.hooks, undefined);
  assert.equal(files.deepseek.payload, undefined);
  assert.equal(files.deepseek.plugin, undefined);
  assert.ok(files.deepseek.loader);
  assert.equal(harnessSurfaces().some((r) => r.id === 'deepseek'), false);
  assert.equal(harnessHooks().deepseek, undefined);
});

// --- Byte identity with the record files --------------------------------------

test("harnessSurfaces returns each record's surface row unreshaped, in surfaceOrder", async () => {
  const files = await recordFiles();
  const expected = Object.values(files)
    .filter((r) => r.surface)
    .sort((a, b) => a.surfaceOrder - b.surfaceOrder)
    .map((r) => r.surface);
  assert.deepEqual(harnessSurfaces(), expected);
});

test("harnessPointers returns each record's pointer row unreshaped, in pointerOrder", async () => {
  const files = await recordFiles();
  const expected = Object.values(files)
    .filter((r) => r.pointer)
    .sort((a, b) => a.pointerOrder - b.pointerOrder)
    .map((r) => r.pointer);
  assert.deepEqual(harnessPointers(), expected);
});

test("harnessLoaders returns each record's reader row unreshaped, in loaderOrder", async () => {
  const files = await recordFiles();
  const expected = Object.values(files)
    .filter((r) => r.loader)
    .sort((a, b) => a.loaderOrder - b.loaderOrder)
    .map((r) => r.loader);
  assert.deepEqual(harnessLoaders(), expected);
});

test("harnessPlugins returns each record's plugin layout with its id, in pluginOrder", async () => {
  const files = await recordFiles();
  // The id is prepended: a layout row in a record is anonymous, and the engine names it.
  const expected = Object.values(files)
    .filter((r) => r.plugin)
    .sort((a, b) => a.pluginOrder - b.pluginOrder)
    .map((r) => ({ id: r.id, ...r.plugin }));
  assert.deepEqual(harnessPlugins(), expected);
});

test('harnessHooks and harnessPayloads key their facets by id, unreshaped', async () => {
  const files = await recordFiles();
  assert.deepEqual(
    harnessHooks(),
    Object.fromEntries(ALL_IDS.map((id) => [id, files[id]?.hooks]).filter(([, v]) => v !== undefined)),
  );
  assert.deepEqual(
    harnessPayloads(),
    Object.fromEntries(ALL_IDS.map((id) => [id, files[id]?.payload]).filter(([, v]) => v !== undefined)),
  );
});

// --- Repo-local overrides -----------------------------------------------------

test('a repo-local .simt/harnesses/ overrides the shipped set', async (t) => {
  const root = await tmpRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = join(root, '.simt', 'harnesses');
  await mkdir(local, { recursive: true });
  // A same-id record that omits a field keeps the shipped one: the merge is shallow.
  await writeFile(join(local, 'claude.json'), JSON.stringify({ id: 'claude', surfaceOrder: 99 }));
  // A new id appends.
  await writeFile(
    join(local, 'myharness.json'),
    JSON.stringify({ id: 'myharness', loaderOrder: 99, loader: { id: 'myharness' } }),
  );
  // A record that does not parse is skipped, never a crash: the shipped set wins.
  await writeFile(join(local, 'broken.json'), '{ not json');

  const records = loadHarnesses(root);
  const claude = records.find((r) => r.id === 'claude');
  assert.equal(claude.surfaceOrder, 99, 'the local override wins');
  assert.ok(claude.loader, 'an omitted field keeps the shipped value');
  assert.ok(records.some((r) => r.id === 'myharness'), 'a new id appends');
  assert.equal(records.length, 9, 'the broken record is skipped, not fatal');
});

test('a root with no .simt/ reads the shipped set alone', async (t) => {
  const root = await tmpRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(loadHarnesses(root), loadHarnesses());
});

// The MCP config path was the first view to read a root; the others froze their tables at
// import time, and a repository that onboarded a harness by data saw it in `mcp install`
// and nowhere else. This is the net that the non-MCP views read the same records: one
// repository-local record with every facet they read, and each view must name it.
test('a repo-local record is visible to the non-MCP views, not just the MCP config path', async (t) => {
  const root = await tmpRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = join(root, '.simt', 'harnesses');
  await mkdir(local, { recursive: true });
  await writeFile(
    join(local, 'custom.json'),
    JSON.stringify({
      id: 'custom',
      surfaceOrder: 99,
      loaderOrder: 99,
      pluginOrder: 99,
      surface: { id: 'custom', label: 'Custom harness', readers: 'a custom agent', primary: null, kind: 'file', rule: null, configDirs: ['.custom'], verified: 'a vendor documents it' },
      loader: {
        id: 'custom',
        label: 'Custom',
        start: [{ scope: 'project', path: 'AGENTS.md', tree: 'chain', atStart: true, why: 'custom' }],
        hooks: { path: '.custom/hooks.json', verified: 'a vendor documents it' },
      },
      hooks: { id: 'custom', event: 'preToolUse', matcher: '.*', denyExit: 2, allow: { decision: 'allow' }, deny: { decision: 'deny' }, verified: 'a vendor documents it' },
      plugin: { rootVar: null, projectVar: 'CUSTOM_PROJECT_DIR', hooksPath: '.custom/hooks.json', runtimeDir: '.custom/simt' },
    }),
  );

  // The projection view sees the surface row.
  assert.ok(surfaces(root).some((s) => s.id === 'custom'));
  // The reader view sees the row, and the hooks file path resolves through it.
  assert.ok(loaders(root).some((l) => l.id === 'custom'));
  assert.equal(hookPath('custom', root), '.custom/hooks.json');
  // The hook dialect view: the record's hooks facet is an adapter.
  assert.ok(adapters(root).some((a) => a.id === 'custom'));
  // The package view: the layout is a buildable kind.
  assert.ok(pluginKinds(root).includes('custom'));

  // Without a root none of the views see it: the shipped set alone, exactly as before.
  assert.equal(surfaces().some((s) => s.id === 'custom'), false);
  assert.equal(pluginKinds().includes('custom'), false);
});
