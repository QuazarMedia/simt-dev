// Run one tier of the suite, optionally under node's coverage report.
//
// `npm run test:unit` runs the files that never spawn the CLI, which is the tier a change to
// one module needs: it is 392 tests in nine seconds against 1,830 in a minute. The file list
// comes from `test/tier.mjs`, so a new test file joins its tier without anyone updating a list
// (ADR-137).
//
// `npm test` keeps its own shape and is not routed through here. `test/ci.test.mjs` asserts
// that the test script names the files it runs, because `node --test test/` is a directory
// that 22 and 24 resolve as a module path, and that assertion is worth more than the symmetry
// of one entry point.
//
// Coverage is measured on the unit tier because that is the tier where the code under test is
// in THIS process. An integration test runs the CLI in a child, and node's coverage report is
// per-process: counting those runs would mean `NODE_V8_COVERAGE` on every child and a merge
// step, and a report that quietly attributed the child's work to the test file would be worse
// than one that says what it measured. `npm run test:coverage` therefore reports the unit
// tier, and the number it prints is a floor for `src/`, not a ceiling.
//
// The interpreter is `process.execPath`, not `node`: a suite run under a different binary than
// the one that started it tests an interpreter nobody asked about.

import { spawnSync } from 'node:child_process';
import { cpus } from 'node:os';

import { files, tiers } from '../test/tier.mjs';

const args = process.argv.slice(2);
const which = args.find((arg) => !arg.startsWith('--'));
const coverage = args.includes('--coverage');
const unknown = args.filter((arg) => arg.startsWith('--') && arg !== '--coverage');

if (unknown.length > 0 || !tiers().includes(which)) {
  process.stderr.write(
    `run-tests: expected ${tiers().join(' or ')}, optionally with --coverage; got ${args.join(' ') || 'nothing'}\n`,
  );
  process.exit(2);
}

const flags = ['--test', `--test-concurrency=${cpus().length}`];
if (coverage) {
  // The exclusions are the files that are not the code under test: the tests themselves, this
  // runner, the CLI entry point (child processes) and the vendored Node builds for the SEA.
  flags.push(
    '--experimental-test-coverage',
    '--test-coverage-exclude=test/**',
    '--test-coverage-exclude=scripts/**',
    '--test-coverage-exclude=bin/**',
    '--test-coverage-exclude=.sea-cache/**',
  );
}

const result = spawnSync(process.execPath, [...flags, ...(await files(which))], { stdio: 'inherit' });

process.exit(result.status ?? 1);
