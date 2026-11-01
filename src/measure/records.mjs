// Stored benchmark run records, schema v2.
//
// A v1 record said what an arm scored and nothing about the conditions it scored under.
// Two records from different rule text, different corpora or different harness versions
// were indistinguishable, so a report could compare them and call the difference an
// effect. The record now carries the experiment that produced it, and
// the run id names the model whenever a model other than the harness default was used:
// two models driven through one harness used to overwrite each other's run directory.
//
// Loading is tolerant in one direction only: a record that does not parse is skipped and
// reported as a warning, because one corrupt file is not an empty corpus. A reader that
// answers "no runs" for a directory of unreadable files hides the corruption entirely.
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { arch, cpus, platform } from 'node:os';
import { join, resolve } from 'node:path';

import { LOCAL_DIR } from '../state.mjs';
import { packageVersion } from '../package-version.mjs';

export const RECORD_SCHEMA_VERSION = 2;

/** Directory a run's records are stored under, with the pre-move path as a fallback. */
export function runsDir(root) {
  return join(resolve(root), LOCAL_DIR, 'bench', 'runs');
}

function legacyRunsDir(root) {
  return join(resolve(root), '.simt', 'bench', 'runs');
}

/**
 * The run directory name for one arm and repetition.
 *
 * The model is part of the name when it is a real choice. A `default` model (or a
 * harness whose model is itself) adds nothing to the name, and a name that changes for
 * every run would make the stored path useless to a reader.
 *
 * @param {{harness: string, model?: string|null, arm: string, rep: number}} spec
 * @returns {string}
 */
export function runIdFor({ harness, model, arm, rep }) {
  const named =
    typeof model === 'string' && model.length > 0 && model !== 'default' && model !== harness;
  return `${harness}-${named ? `${model}-` : ''}${arm}-r${rep}`;
}

/**
 * The conditions a run was produced under, recorded so a report can refuse to pool
 * records that were not comparable.
 *
 * @param {{simtVersion?: string, rulesDigest?: string|null, adapterVersion?: string|null,
 *   corpusDigest?: string|null, seed?: number|null, isolation?: string}} input
 * @returns {object}
 */
export function experimentOf({
  simtVersion = packageVersion(),
  rulesDigest = null,
  adapterVersion = null,
  corpusDigest = null,
  seed = null,
  isolation = 'none',
} = {}) {
  return {
    simtVersion,
    rulesDigest,
    adapterVersion,
    corpusDigest,
    seed,
    isolation,
    hardware: `${platform()}/${arch()}/${cpus().length}cpu`,
  };
}

/**
 * A digest of the corpus a run was measured against.
 *
 * It is the sorted task ids and their base commits, hashed: a re-mine that changes which
 * tasks exist, or where they start, changes the digest, and a report can say the two
 * records were not measured on the same corpus.
 *
 * @param {object[]} tasks normalised task descriptors
 * @returns {string}
 */
export function corpusDigestOf(tasks = []) {
  const lines = [...tasks]
    .map((task) => `${task.id}\0${task.base}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(lines).digest('hex').slice(0, 16);
}

/**
 * Build one record.
 *
 * `status` is the record's own claim: `ok` measured something, `error` did not. An error
 * record keeps the run's identity so the report can exclude it by name rather than by
 * looking for a missing field.
 *
 * @param {object} input
 * @returns {object}
 */
export function runRecord({
  task,
  arm,
  harness,
  model,
  rep,
  measured = true,
  isolation = 'none',
  experiment = null,
  status = 'ok',
  error = null,
  agent = null,
  resolved = false,
  gatesPassed = false,
  f2pPassed = [],
  usage = null,
  costUsd = null,
  diff = { files: 0, outsideBlastRadius: 0 },
  skills = null,
  probe = null,
}) {
  const record = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    task: String(task?.id ?? task ?? ''),
    stratum: String(task?.stratum ?? 'unknown'),
    arm,
    harness,
    model,
    rep,
    measured: Boolean(measured),
    isolation,
    experiment,
    status,
    agent,
    resolved: Boolean(resolved),
    gatesPassed: Boolean(gatesPassed),
    f2pPassed: [...f2pPassed],
    usage: usage ?? { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, turns: 0, toolCalls: 0 },
    costUsd: typeof costUsd === 'number' && Number.isFinite(costUsd) ? costUsd : null,
    diff,
    skills,
    probe,
  };
  if (error !== null) record.error = String(error);
  return record;
}

/**
 * Read every stored record, and report the files it could not read.
 *
 * @param {string} root
 * @returns {Promise<{records: object[], warnings: string[]}>}
 */
export async function readRunRecords(root) {
  let base = runsDir(root);
  let entries = await readdir(base, { withFileTypes: true }).catch(() => null);
  if (entries === null) {
    base = legacyRunsDir(root);
    entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  }
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));

  const records = [];
  const warnings = [];
  const readOne = async (file) => {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      warnings.push(`could not read ${file}: ${error.message ?? error}`);
      return;
    }
    try {
      const record = JSON.parse(text);
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        warnings.push(`skipped ${file}: not a record object`);
        return;
      }
      records.push(record);
    } catch (error) {
      warnings.push(`skipped ${file}: ${error.message ?? error}`);
    }
  };

  for (const entry of sorted) {
    if (entry.name.startsWith('.')) continue;
    const full = join(base, entry.name);
    if (entry.isDirectory()) {
      const files = (await readdir(full).catch(() => []))
        .filter((file) => file.endsWith('.json') && !file.startsWith('.'))
        .sort();
      for (const file of files) await readOne(join(full, file));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      await readOne(full);
    }
  }
  return { records, warnings };
}

/**
 * Every stored record. A caller that has nowhere to put a warning gets the records and
 * no warnings; the report is the caller that shows them.
 *
 * @param {string} root
 * @returns {Promise<object[]>}
 */
export async function loadRunRecords(root) {
  return (await readRunRecords(root)).records;
}
