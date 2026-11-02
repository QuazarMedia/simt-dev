// Which half of the suite a test file belongs to.
//
// The suite is one tier of 1,800 tests that takes minutes, so a change that touches one module
// still pays for every CLI spawn in every other file. The split is by what the file *does*,
// not by a list someone maintains: a file that spawns the CLI is integration, and a file that
// imports modules and calls them is unit.
//
// The list was the wrong answer and is the one thing this file exists to avoid. A tier list is
// a second copy of the test set, and the failure is silent in the direction that matters: a
// new integration file left out of the list still passes `test:unit`, and the tier it was
// missing from is the one the change needed.

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UNIT = 'unit';
export const INTEGRATION = 'integration';

// Every way a test file reaches the CLI: the shared `simt` helper (imported as `simtCli`),
// the `BIN` path, or its own spawn (`child_process`, including the dynamic `import()` form a
// file uses when it needs one call and not an import at the top).
const SPAWNS = /child_process|\bsimtCli\b|\bBIN\b/;

export function tierOf(source) {
  return SPAWNS.test(source) ? INTEGRATION : UNIT;
}

export function tiers() {
  return [UNIT, INTEGRATION];
}

/** The test files in one tier, or in every tier in the order `all` runs them. */
export async function files(tier) {
  const here = dirname(fileURLToPath(import.meta.url));
  const names = (await readdir(here)).filter((name) => name.endsWith('.test.mjs')).sort();
  const chosen = [];
  for (const name of names) {
    if (tier === 'all' || tierOf(await readFile(join(here, name), 'utf8')) === tier) chosen.push(join(here, name));
  }
  return chosen;
}
