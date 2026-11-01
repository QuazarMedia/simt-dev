// Harness data records.
//
// ADR-013: content is data, the engine is code. A harness is a record under
// `harnesses/`, not a row in a table the engine edits. A new harness arrives as a new
// file; the engine — this loader and the views over it — never changes shape to make a
// product work. The surface row, the reader row, the hook dialect and the plugin layout
// of one harness land together in one file and cannot drift apart, which is the failure
// the five-module spread they used to occupy made routine.
//
// Records are sparse: a facet is present only when the harness has one. DeepSeek has a
// reader row and nothing else; Copilot has a surface row, a reader row and a scoping key;
// Claude has all seven. Absence is a fact — a facet that is not there is one the vendor
// documents none of — so the views filter, they do not fill.
//
// The shipped records live in `harnesses/` at the package root. A repository may override
// them under `.simt/harnesses/` the way it overrides `ecosystems/`: a same-id record is a
// shallow merge over the shipped one (arrays replaced whole), a new id is appended, and a
// record that does not parse is skipped, never a crash.
//
// The package root is computed here rather than imported from workspace.mjs for the same
// reason `ecosystem/records.mjs` computes it: workspace.mjs is part of the import graph
// that builds these tables at evaluation time, and an import cycle would leave the binding
// in the temporal dead zone. This file is two levels below the root (src/harness/), so
// two levels up is the root — a fixed path, not a heuristic.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHIPPED_DIR = join(PACKAGE_ROOT, 'harnesses');

/**
 * The records in force for a repository: the shipped set, with a repo-local
 * `.simt/harnesses/` merged over it. `null` is the shipped set alone, which is what the
 * const-iterating tests and every call without a root read.
 */
export function loadHarnesses(root = null) {
  const base = shipped();
  if (!root) return base;
  const localDir = join(root, '.simt', 'harnesses');
  if (!existsSync(localDir)) return base;
  const byId = new Map(base.map((r) => [r.id, r]));
  for (const file of readdirSync(localDir)) {
    if (!file.endsWith('.json')) continue;
    const id = file.slice(0, -5);
    const rec = parse(join(localDir, file));
    if (!rec) continue;
    // Same id: a shallow merge over the shipped record, so a local override that omits
    // a field keeps the shipped one. New id: the record as-is.
    byId.set(id, byId.has(id) ? { ...byId.get(id), ...rec } : rec);
  }
  return [...byId.values()];
}

/** The shipped records, read once per process and cached. */
function shipped() {
  if (shippedCache) return shippedCache;
  const map = new Map();
  if (existsSync(SHIPPED_DIR)) readRecords(SHIPPED_DIR, map);
  shippedCache = [...map.values()];
  return shippedCache;
}

let shippedCache = null;

/** Read one directory of records into `into`, keyed by the file stem. */
function readRecords(dir, into) {
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const id = file.slice(0, -5);
    const rec = parse(join(dir, file));
    // The id must match the file stem: a mismatch is a record pointing at the wrong
    // harness, and shipping it would make two names mean one record.
    if (rec && rec.id === id) into.set(id, rec);
  }
}

/** One record, or null when the file is absent, unreadable or does not parse. */
function parse(path) {
  try {
    const rec = JSON.parse(readFileSync(path, 'utf8'));
    return rec && typeof rec === 'object' ? rec : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The views. Each returns the rows the old module constant held, in the order
// the const-iterating tests pin: the records' `*Order` fields, not readdir's.
// ---------------------------------------------------------------------------

/** The surface rows, in the order `project` iterates them (ADR-020's union order). */
export function harnessSurfaces(root = null) {
  return loadHarnesses(root)
    .filter((r) => r.surface)
    .sort((a, b) => a.surfaceOrder - b.surfaceOrder)
    .map((r) => r.surface);
}

/** The pointer rows, in their table order. */
export function harnessPointers(root = null) {
  return loadHarnesses(root)
    .filter((r) => r.pointer)
    .sort((a, b) => a.pointerOrder - b.pointerOrder)
    .map((r) => r.pointer);
}

/** The reader rows, in the order the reader table lists its harnesses. */
export function harnessLoaders(root = null) {
  return loadHarnesses(root)
    .filter((r) => r.loader)
    .sort((a, b) => a.loaderOrder - b.loaderOrder)
    .map((r) => r.loader);
}

/** Surface ids whose scoping key was read in the vendor's own documentation. */
export function harnessScopeKeys(root = null) {
  return new Set(loadHarnesses(root).filter((r) => r.scopeKey === true).map((r) => r.id));
}

/** The hook dialect per harness, keyed by id: the data a config document and a decision are shaped by. */
export function harnessHooks(root = null) {
  const out = {};
  for (const r of loadHarnesses(root)) if (r.hooks) out[r.id] = r.hooks;
  return out;
}

/** The payload extraction contract per harness, keyed by id: how a hook payload names its tool, its input and its writes. */
export function harnessPayloads(root = null) {
  const out = {};
  for (const r of loadHarnesses(root)) if (r.payload) out[r.id] = r.payload;
  return out;
}

/** The plugin layouts, in the order the `simt plugin` help line names its kinds. */
export function harnessPlugins(root = null) {
  return loadHarnesses(root)
    .filter((r) => r.plugin)
    .sort((a, b) => a.pluginOrder - b.pluginOrder)
    .map((r) => ({ id: r.id, ...r.plugin }));
}
