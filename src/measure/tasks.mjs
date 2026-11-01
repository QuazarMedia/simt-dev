// Mined task descriptors, read back from the tool state's `bench/tasks/` directory.
//
// Extracted from bench/run.mjs on its second real reader (ADR-002): the advice engine
// needs the two facts a run record does not carry — the prompt, which classifies the
// task, and the gold stat, which says how many files the change touched. A second private
// loader beside the first would drift the first time one learned a filter the other
// lacked.
//
// Every descriptor passes through `task-schema.mjs`, so a reader never has to guess
// whether a field is present: an unreadable task is refused with its file named, and a v1
// descriptor is normalised rather than skipped. Deterministic by construction: the
// directory is read sorted, the filter is exact, and nothing here touches a model, a
// network or a clock.
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { STATE_DIR } from '../name.mjs';
import { normaliseTask } from './task-schema.mjs';

/** The directory a repository's mined tasks live in. */
export function tasksDir(root) {
  return join(resolve(root), STATE_DIR, 'bench', 'tasks');
}

/** The file one task descriptor lives in. */
export function taskPath(root, id) {
  return join(tasksDir(root), `${id}.json`);
}

/**
 * Read one task descriptor by id.
 *
 * @param {string} root
 * @param {string} id
 * @returns {Promise<object|null>} the v2 descriptor, or null when the file is absent
 */
export async function readTask(root, id) {
  const text = await readFile(taskPath(root, id), 'utf8').catch(() => null);
  if (text === null) return null;
  return normaliseTask(JSON.parse(text), { source: taskPath(root, id) });
}

/**
 * Load mined benchmark task descriptors.
 *
 * @param {string} root the repository
 * @param {string[]} [filterIds] exact task ids to keep; empty means load them all
 * @returns {Promise<object[]>} v2 descriptors sorted by id (id, base, prompt, stratum,
 *   oracle, f2p, p2p, gold {files, linesAdded, linesRemoved}, vault)
 */
export async function loadTasks(root, filterIds = []) {
  const dir = tasksDir(root);
  const entries = (await readdir(dir).catch(() => [])).filter((file) => file.endsWith('.json')).sort();

  const filterSet = new Set(filterIds);
  const tasks = [];
  for (const entry of entries) {
    const file = join(dir, entry);
    let raw;
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      throw new Error(`${file}: ${error.message ?? error}`);
    }
    if (filterSet.size > 0 && !filterSet.has(String(raw?.id ?? ''))) continue;
    tasks.push(normaliseTask(raw, { source: file }));
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}
