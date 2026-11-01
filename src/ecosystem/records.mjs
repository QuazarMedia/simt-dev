// Ecosystem and language data records.
//
// ADR-013: content is data, the engine is code. An ecosystem is a record under
// `ecosystems/`, not a row in a table the engine edits. A new ecosystem arrives as a
// new file; the engine — this loader and the views over it — never changes shape to
// make a product work. The Dependabot entry, the card's build/focused/fallback lines,
// the language tables and the manifest's gate rows are all READ from the same records,
// so a product and its facets land together in one file and cannot drift apart.
//
// The shipped records live in `ecosystems/` at the package root. A repository may
// override them under `.simt/ecosystems/`: a same-id record is a shallow merge over the
// shipped one (arrays replaced whole), a new id is appended, and a record that does not
// parse is skipped, never a crash — the shipped default wins and the reader fixes the
// file on the next run.
//
// The package root is computed here rather than imported from workspace.mjs because
// workspace.mjs imports projection/manifest.mjs, which imports this module: an import
// cycle that would leave the binding in the temporal dead zone when manifest.mjs builds
// its table at evaluation time. This file is two levels below the root (src/ecosystem/),
// so two levels up is the root — a fixed path, not a heuristic.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHIPPED_DIR = join(PACKAGE_ROOT, 'ecosystems');

/**
 * The records in force for a repository: the shipped set, with a repo-local
 * `.simt/ecosystems/` merged over it. `null` is the shipped set alone, which is what the
 * const-iterating tests and every call without a root read.
 */
export function loadEcosystems(root = null) {
  const base = shipped();
  if (!root) return base;
  const localDir = join(root, '.simt', 'ecosystems');
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
    // ecosystem, and shipping it would make two names mean one record.
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

/**
 * The gate rows, in manifest order: one per record that declares a `manifestOrder`, the
 * nine tool ecosystems a fresh adoption seeds gates from. `preCommit` is emitted only
 * when present (the Maven row has none) and `file` only when set, so the rows keep the
 * exact shape the const-iterating tests pin.
 */
export function ecosystemGateRows(root = null) {
  return loadEcosystems(root)
    .filter((r) => r.manifestOrder != null)
    .sort((a, b) => a.manifestOrder - b.manifestOrder)
    .map((r) => {
      const row = { fact: r.facts[0], tool: r.tool };
      if (r.file === true) row.file = true;
      if (Array.isArray(r.gates?.preCommit)) row.preCommit = r.gates.preCommit;
      if (Array.isArray(r.gates?.prePush)) row.prePush = r.gates.prePush;
      row.commands = r.gates?.commands ?? {};
      return row;
    });
}

/**
 * The Dependabot entries in the table's order. Each record contributes zero or more
 * `{fact?|stack?, value, manifest}` rows; the order is the records' `order`, not
 * detection's, so a config whose entry order followed readdir could not be diffed.
 * `ecosystems()` downstream deduplicates by `value`; this view only orders and flattens.
 */
export function dependabotEntries(root = null) {
  const entries = [];
  for (const r of loadEcosystems(root)) {
    for (const e of r.dependabot ?? []) entries.push({ ...e });
  }
  entries.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return entries.map(({ order, ...rest }) => rest);
}

/** The card's build lines, in their first-match-wins order. */
export function cardBuilds(root = null) {
  const builds = [];
  for (const r of loadEcosystems(root)) if (r.card?.build) builds.push({ ...r.card.build });
  builds.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return builds.map(({ order, ...rest }) => rest);
}

/** The card's focused-test lines, in their first-match-wins order. */
export function cardFocused(root = null) {
  const focused = [];
  for (const r of loadEcosystems(root)) for (const e of r.card?.focused ?? []) focused.push({ ...e });
  focused.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return focused.map(({ order, ...rest }) => rest);
}

/** The card's fallback lines — verbs the gate table does not seed, used by the card alone. */
export function cardFallbacks(root = null) {
  const fallbacks = [];
  for (const r of loadEcosystems(root)) for (const e of r.card?.fallback ?? []) fallbacks.push({ ...e });
  fallbacks.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return fallbacks.map(({ order, ...rest }) => rest);
}

/**
 * The extension table, keyed by language. The records' `exts` are the single source; a
 * language named by more than one record unions, so the same table the indexer extracts
 * from and the resolver maps from cannot desynchronize.
 */
export function languageExts(root = null) {
  const exts = {};
  for (const r of loadEcosystems(root)) {
    for (const l of r.languages ?? []) {
      if (!Array.isArray(l.exts)) continue;
      exts[l.lang] = exts[l.lang] ? [...new Set([...exts[l.lang], ...l.exts])] : [...l.exts];
    }
  }
  return exts;
}

/**
 * The extension-to-language map: an extension without its dot, to the language that owns
 * it. `canonical` names the extensions that resolve to the language (the JavaScript
 * record claims `.ts` for extraction but not for resolution); absent it, `exts` does.
 */
export function languageResolver(root = null) {
  const map = {};
  for (const r of loadEcosystems(root)) {
    for (const l of r.languages ?? []) {
      for (const ext of l.canonical ?? l.exts ?? []) {
        map[ext.startsWith('.') ? ext.slice(1) : ext] = l.lang;
      }
    }
  }
  return map;
}

/**
 * The per-language test-path conventions: one entry per language that declares
 * `testConventions`. The miner compiles the `base` sources to regexes; a language may
 * contribute a pattern that also matches a sibling's files (the JVM pattern matches both
 * `.java` and `.kt`), which the caller de-duplicates.
 */
export function testConventions(root = null) {
  const out = [];
  for (const r of loadEcosystems(root)) {
    for (const l of r.languages ?? []) {
      if (l.testConventions) out.push({ lang: l.lang, ...l.testConventions });
    }
  }
  return out;
}

/**
 * Does a data condition match a repository's signals? A condition is one of:
 *   {fact: 'has-x'}    one named fact
 *   {facts: ['a','b']} any of the listed facts
 *   {stack: 'gradle'}  one named stack tag
 */
export function matches(condition, { stack = new Set(), facts = new Set() } = {}) {
  if (!condition) return false;
  if (condition.fact) return facts.has(condition.fact);
  if (Array.isArray(condition.facts)) return condition.facts.some((f) => facts.has(f));
  if (condition.stack) return stack.has(condition.stack);
  return false;
}

/**
 * Resolve a card template. A string is the whole template, its `{placeholder}`s left for
 * the reader. An object is the Node shape: a static default, and a dynamic form when the
 * repository's own test script matches — the manager is the repo's committed runner, so
 * `<manager> test -- <file>` is the ADR-010 shape (never `npx`).
 */
export function evalTemplate(template, { scripts = {}, runner = null } = {}) {
  if (typeof template === 'string') return template;
  const test = scripts?.test ?? '';
  if (!new RegExp(template.ifScriptMatches).test(test)) return template.static;
  const run = runner?.run ?? 'npm';
  return template.dynamic.replaceAll('{runner}', run);
}
