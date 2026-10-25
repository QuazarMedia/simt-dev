// Mined task descriptors, read back from the tool state's `bench/tasks/` directory (plan 0003 R01).
//
// Extracted from bench/run.mjs on its second real reader (ADR-002): the R40 advice engine
// needs the two facts a run record does not carry — the prompt, which classifies the task,
// and the gold stat, which says how many files the change touched. A second private loader
// beside the first would drift the first time one learned a filter the other lacked.
//
// Deterministic by construction: the directory is read sorted, the filter is exact, and no
// part of this touches a model, a network or a clock.
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CONFIG_DIR } from '../name.mjs';

const STATE_DIR = `.${CONFIG_DIR}`;

/**
 * Load mined benchmark task descriptors.
 *
 * @param {string} root the repository
 * @param {string[]} [filterIds] exact task ids to keep; empty means load them all
 * @returns descriptor objects sorted by id (id, base, sourceCommit, prompt, testCmd,
 *   f2p, p2p, gold {files, linesAdded, linesRemoved}, vault)
 */
export async function loadTasks(root, filterIds = []) {
  const tasksDir = join(resolve(root), STATE_DIR, 'bench', 'tasks');
  const entries = (await readdir(tasksDir).catch(() => []))
    .filter((f) => f.endsWith('.json'))
    .sort();

  const filterSet = new Set(filterIds);
  const tasks = [];
  for (const entry of entries) {
    const data = JSON.parse(await readFile(join(tasksDir, entry), 'utf8'));
    if (filterSet.size > 0 && !filterSet.has(data.id)) continue;
    tasks.push(data);
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}
