// Run one tier of the suite, optionally under node's coverage report.
//
// `npm run test:unit` runs the files that never spawn the CLI, which is the tier a change to
// one module needs: it is 392 tests in nine seconds against 1,830 in a minute. The file list
// comes from `test/tier.mjs`, so a new test file joins its tier without anyone updating a list
// (ADR-137).
//
// `npm test` is the pre-push gate and runs the `gate` view: every file except benches and
// studio, the exclusion classified in `test/tier.mjs` (ADR-259). The full suite keeps its
// own script, `test:all`, and `test/ci.test.mjs` asserts that it names the files it runs,
// because `node --test test/` is a directory that 22 and 24 resolve as a module path, and
// that assertion is worth more than the symmetry of one entry point.
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

import { files, tiers, GATE, INTEGRATION } from '../test/tier.mjs';

const args = process.argv.slice(2);
const which = args.find((arg) => !arg.startsWith('--'));
const coverage = args.includes('--coverage');
const unknown = args.filter((arg) => arg.startsWith('--') && arg !== '--coverage');

// `gate` is a view over the tiers, not a tier: `tiers()` partitions the suite, and the
// view overlaps both halves, so it is accepted here and not listed there (ADR-259).
const accepted = [...tiers(), GATE];
if (unknown.length > 0 || !accepted.includes(which)) {
  process.stderr.write(
    `run-tests: expected ${tiers().join(' or ')} or gate, optionally with --coverage; got ${args.join(' ') || 'nothing'}\n`,
  );
  process.exit(2);
}

// A fixed concurrency, not the host CPU count: a result that changes with the machine
// is not reproducible, and six-core and two-core runners used to run different suites.
// The unit tier keeps the gate's declared budget of four, because its wall-clock bars
// are calibrated under four-way load. The gate view runs those same unit files, so it
// keeps four as well. The integration tier is CLI-spawn bound - the parent idles while
// children run - and carries no bar sized against its load, so it runs at eight: a
// developer's iteration tier halves without moving a calibration.
const flags = ['--test', `--test-concurrency=${which === INTEGRATION ? 8 : 4}`];
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
