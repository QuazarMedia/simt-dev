// Run one tier of the suite.
//
// `npm run test:unit` runs the files that never spawn the CLI, which is the tier a change to
// one module needs: it is 452 tests in nine seconds against 1,830 in a minute. The file list
// comes from `test/tier.mjs`, so a new test file joins its tier without anyone updating a list
// (ADR-137).
//
// `npm test` keeps its own shape and is not routed through here. `test/ci.test.mjs` asserts
// that the test script names the files it runs, because `node --test test/` is a directory
// that 22 and 24 resolve as a module path, and that assertion is worth more than the symmetry
// of one entry point.
//
// The interpreter is `process.execPath`, not `node`: a suite run under a different binary than
// the one that started it tests an interpreter nobody asked about.

import { spawnSync } from 'node:child_process';
import { cpus } from 'node:os';

import { files, tiers } from '../test/tier.mjs';

const which = process.argv[2];

if (!tiers().includes(which)) {
  process.stderr.write(`run-tests: expected ${tiers().join(' or ')}; got ${which ?? 'nothing'}\n`);
  process.exit(2);
}

const list = await files(which);
const result = spawnSync(
  process.execPath,
  ['--test', `--test-concurrency=${cpus().length}`, ...list],
  { stdio: 'inherit' },
);

process.exit(result.status ?? 1);
