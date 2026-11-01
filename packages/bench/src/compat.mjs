// Plan 0004 W01: the predecessor audit and the compatibility baseline.
//
// Two questions, one module, because both answer "what are we starting from":
//
//   auditPredecessor   what plan 0003's tracker actually records, read through the real
//                      parser rather than a second table reader, and what it does not
//                      record at all — a Complete row with no evidence, a metric below
//                      its own bar, a claim labelled unmeasured.
//   captureBaseline    the observable behaviour a later slice must not change: the
//                      projection bytes, the loader bytes, the public JSON of a fixed
//                      command list, and the environment those were measured in.
//
// The baseline exists to be compared, so it is canonical and path-free: the root is
// replaced with `<root>` and the `root` key is dropped, which is what makes a fixture
// captured in one directory compare equal after it is copied to another. The plan's
// Accept is explicit that it must round-trip "from an installed package at a path with
// no siblings" (ADR-031) — an absolute path in the baseline would make that impossible.
//
// What this does not do: it opens no socket and reads no sibling checkout. `network` is
// recorded from the manifest rather than assumed, so a capture that found a local model
// endpoint says so instead of claiming isolation it did not have.

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { loadPlanState, splitRow, findColumn } from '../../../src/plan/index.mjs';
import { run } from '../../../src/run.mjs';
import { describeVersion } from '../../../src/package-version.mjs';
import { MANIFEST, MANIFEST_LEGACY } from '../../../src/projection/manifest.mjs';

/** The commands whose public JSON the baseline pins. Read-only by construction: a
 *  writer would make the capture mutate the tree it is measuring. */
const BASELINE_COMMANDS = ['harness loaders', 'plan status'];

/** Where a predecessor's decisions live, relative to the repository root. */
const DECISIONS_DIR = 'docs/decisions';

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Strip the one path-dependent key and spell the root as `<root>` everywhere else. */
function canonical(value, root) {
  if (typeof value === 'string') return root === undefined || root === '' ? value : value.split(root).join('<root>');
  if (Array.isArray(value)) return value.map((item) => canonical(item, root));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'root') continue;
      out[key] = canonical(item, root);
    }
    return out;
  }
  return value;
}

/** The document a command answered with, or null when it failed. `run()` returns the
 *  captured output as `documents` — the same object `--json` printed — rather than a
 *  rendering method, so reading it here is reading the surface, not a re-render. */
function jsonOf(result) {
  if (result.ok !== true) return null;
  return Array.isArray(result.documents) && result.documents.length > 0 ? result.documents[0] : null;
}

/**
 * The status line of an ADR, or null when no record with that number exists.
 *
 * Read from the file rather than from an index: the index is a projection, and the
 * question here is what the record itself says about whether it is in force.
 */
async function adrStatus(root, number) {
  let entries;
  try {
    entries = await readdir(join(root, DECISIONS_DIR));
  } catch {
    return null;
  }
  const name = entries.find((entry) => new RegExp(`^ADR-0*${number}-`).test(entry));
  if (name === undefined) return null;
  const text = await readFile(join(root, DECISIONS_DIR, name), 'utf8');
  const line = text.split('\n').find((l) => /^Status:/i.test(l));
  return { file: `${DECISIONS_DIR}/${name}`, status: line ? line.replace(/^Status:\s*/i, '').trim() : null };
}

function numberFromRef(ref) {
  const match = /ADR-0*(\d+)/.exec(ref);
  return match === null ? null : Number(match[1]);
}

/**
 * A metric cell read for a verdict rather than copied.
 *
 * The plan's own cells carry both numbers — `recall@10 55.6% (bar 60%)` — and the
 * defect W01 exists for is that a row reading Complete was never compared against them.
 * A cell with no `bar` is a claim, not a measurement, and is reported as unmeasured.
 */
export function metricOf(cell) {
  const raw = String(cell ?? '').trim();
  if (raw === '' || /^[—–-]$/.test(raw)) return { claim: null, measured: null, bar: null, disposition: 'none' };
  if (/unmeasured/i.test(raw)) return { claim: raw, measured: null, bar: null, disposition: 'unmeasured' };
  const bar = /bar\s+(\d+(?:\.\d+)?)\s*%/i.exec(raw);
  const all = [...raw.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) => Number(m[1]));
  const measured = all.length === 0 ? null : all[0];
  // No number is a phrase, not a measurement. Only the word "unmeasured" earns that
  // disposition; a claim nobody measured is a claim.
  if (bar === null || measured === null) return { claim: raw, measured, bar: null, disposition: 'claim' };
  const limit = Number(bar[1]);
  return { claim: raw, measured, bar: limit, disposition: measured >= limit ? 'met' : 'missed' };
}

/**
 * Audit the predecessor plan through the tracker parser.
 *
 * Every row gets a disposition, including the rows the tracker cannot support: a
 * tracker with no evidence column is not fifty-five verified slices, it is a document
 * whose states cannot be checked against commits, and the audit says that once instead
 * of manufacturing a passing result per row.
 */
export async function auditPredecessor(root, { docPrefix = '0003-' } = {}) {
  const loaded = await loadPlanState(root);
  if (loaded.error) return { root, error: loaded.error, remedy: loaded.remedy };
  const { docs, slices, format } = loaded;
  const doc = docs.find((entry) => entry.name.startsWith(docPrefix));
  if (doc === undefined) {
    return {
      root,
      error: `no tracker whose name starts with ${docPrefix}`,
      remedy: `run: simt plan labels --root ${root}`,
      documents: docs.map((entry) => entry.name),
    };
  }
  const columns = doc.trackers[0] ?? [];
  const evidenceIdx = findColumn(columns, format.evidenceHeaders);
  const adrIdx = findColumn(columns, ['needs adr', 'needs-adr', 'adr', 'decision']);
  const metricIdx = findColumn(columns, ['success metric', 'success-metric', 'metric', 'accept']);
  const lines = doc.text.split('\n');
  const issues = [];
  if (evidenceIdx < 0) {
    issues.push(`${doc.name}: the tracker has no evidence column, so no state can be checked against a commit`);
  }
  const rows = [];
  for (const slice of slices.filter((entry) => entry.docPath === doc.path)) {
    const line = lines[slice.line - 1] ?? '';
    const cells = splitRow(line);
    const evidenceCell = evidenceIdx < 0 ? '' : (cells[evidenceIdx] ?? '').trim();
    const sha = /[0-9a-f]{7,40}/i.exec(evidenceCell)?.[0] ?? null;
    const testName = /test:\s*(.+)$/i.exec(evidenceCell)?.[1]?.trim() ?? null;
    let adr = null;
    if (adrIdx >= 0) {
      const ref = /ADR-0*\d+/i.exec(cells[adrIdx] ?? '')?.[0] ?? null;
      if (ref !== null) {
        const number = numberFromRef(ref);
        const record = (await adrStatus(root, number)) ?? { file: null, status: null };
        adr = { ref, ...record };
        if (record.file === null) issues.push(`${slice.id}: names ${ref}, which no record in ${DECISIONS_DIR} matches`);
      }
    }
    const metric = metricIdx < 0 ? metricOf('') : metricOf(cells[metricIdx]);
    const finished = slice.state === 'complete' || slice.state === 'accepted';
    if (finished && evidenceIdx >= 0 && evidenceCell === '') {
      issues.push(`${slice.id}: ${slice.state} with no evidence recorded`);
    }
    if (finished && metric.disposition === 'missed') {
      issues.push(`${slice.id}: measured ${metric.measured}% against a ${metric.bar}% bar, recorded complete without a disposition`);
    }
    if (metric.disposition === 'unmeasured') {
      issues.push(`${slice.id}: claim is labelled unmeasured and has no disposition`);
    }
    rows.push({
      id: slice.id,
      state: slice.state,
      disposition: !finished ? 'open' : evidenceCell === '' && evidenceIdx >= 0 ? 'unverified' : metric.disposition === 'missed' ? 'metric-missed' : 'recorded',
      evidence: evidenceIdx < 0 ? null : { sha, test: testName, raw: evidenceCell },
      adr,
      metric,
    });
  }
  const unmeasured = doc.text
    .split('\n')
    .map((text, index) => ({ line: index + 1, text: text.trim() }))
    .filter((entry) => /unmeasured/i.test(entry.text));
  return {
    root,
    doc: doc.name,
    path: doc.path,
    found: rows.length,
    rows,
    issues,
    unmeasured,
  };
}

/**
 * The observable behaviour of one root, as data.
 *
 * Every command runs through `run()` — the same registry and guard rails the CLI uses —
 * so this measures the installed package's behaviour rather than a second rendering of
 * it. A command that fails is recorded by its exit code rather than omitted: a baseline
 * that silently loses a surface cannot report it later.
 */
export async function captureBaseline(root, { commands = BASELINE_COMMANDS } = {}) {
  let manifestText = null;
  for (const name of [MANIFEST, MANIFEST_LEGACY]) {
    try {
      manifestText = await readFile(join(root, name), 'utf8');
      break;
    } catch {
      // try the next spelling
    }
  }
  let localConfigured = false;
  if (manifestText !== null) {
    try {
      const manifest = JSON.parse(manifestText);
      localConfigured = manifest.local !== undefined && manifest.local !== null;
    } catch {
      localConfigured = false;
    }
  }

  const json = [];
  for (const command of commands) {
    const result = await run(command, { root, flags: { json: true } });
    const payload = jsonOf(result);
    json.push({
      command,
      ok: result.ok === true,
      code: result.code ?? null,
      digest: payload === null ? null : sha256(JSON.stringify(canonical(payload, root))),
    });
  }

  const loaders = json.find((entry) => entry.command === 'harness loaders');
  let loaderRows = [];
  if (loaders !== undefined && loaders.ok) {
    const result = await run('harness loaders', { root, flags: { json: true } });
    const payload = jsonOf(result);
    loaderRows = (payload?.rows ?? [])
      .map((row) => ({ reader: row.reader, totalBytes: row.totalBytes ?? null, cap: row.cap ?? null, droppedBytes: row.droppedBytes ?? null }))
      .sort((a, b) => (a.reader < b.reader ? -1 : 1));
  }

  const projections = [];
  for (const file of ['AGENTS.md', '.editorconfig', '.gitattributes']) {
    let text = null;
    try {
      text = await readFile(join(root, file), 'utf8');
    } catch {
      // an absent baseline is a fact about the fixture, not a failure to capture
    }
    projections.push({
      file,
      present: text !== null,
      bytes: text === null ? null : Buffer.byteLength(text, 'utf8'),
      digest: text === null ? null : sha256(canonical(text, root)),
    });
  }

  return {
    schema: 1,
    environment: {
      version: describeVersion().trim(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      // The capture is deterministic and model-free; recording the fields the plan asks
      // for as null is the honest answer, not an omission to fill in later.
      model: null,
      harness: null,
      seed: 0,
    },
    network: localConfigured ? 'local-configured' : 'none',
    json,
    loaders: loaderRows,
    projections,
  };
}

/** Walk two canonical values and name every path that differs. */
export function compareBaselines(before, after, { limit = 50 } = {}) {
  const differences = [];
  const walk = (a, b, path) => {
    if (differences.length >= limit) return;
    const aJson = JSON.stringify(a);
    const bJson = JSON.stringify(b);
    if (aJson === bJson) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        walk(a[index], b[index], path === '' ? String(index) : `${path}.${index}`);
      }
      return;
    }
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        walk(a[key], b[key], path === '' ? key : `${path}.${key}`);
      }
      return;
    }
    differences.push({ path, before: a ?? null, after: b ?? null });
  };
  walk(before, after, '');
  return { equal: differences.length === 0, differences };
}
