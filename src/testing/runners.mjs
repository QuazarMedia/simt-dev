// Which runner a repository uses, and the command that runs one set of test files.
//
// Detection reads the repository's own manifest, never a guess from a directory name: the
// runner that is installed is the runner a contributor runs. This module is
// production-facing because `simt gate` runs the repository's tests (review 0003 Q79);
// the bench uses the same answer, so a benchmarked run and a gated run cannot disagree
// about what `test` means.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
  dedupeSorted,
  parseCargoTestOutput,
  parseGoTestJson,
  parseJunitXml,
  parseTapOutput,
  parseVitestJson,
} from './parsers.mjs';

let junitCounter = 0;

/**
 * A JUnit report path this process owns.
 *
 * The report used to be written beside the sources as `.bench-junit.xml`, so running the
 * gate in a Python repository left a file in the package directory (review 0003 Q79). It
 * belongs to the run, so it lives in the temporary directory and `cleanupReports` removes
 * it once the run has been read.
 */
function junitReportPath() {
  junitCounter += 1;
  return join(tmpdir(), `simt-junit-${process.pid}-${junitCounter}.xml`);
}

/**
 * Detect the test runner for a repository and build the command for a set of changed test
 * files.
 *
 * @param {string} root
 * @param {string[]} testFiles
 * @returns {Promise<{runner: string, displayCmd: string,
 *   buildExec: (worktree: string) => {cmd: string, args: string[], reportPaths?: string[]},
 *   parse: (stdout: string, reportText?: string) => {passed: string[], failed: string[]}}|null>}
 */
export async function detectTestRunner(root, testFiles) {
  const files = [...testFiles].sort();

  if (existsSync(join(root, 'package.json'))) {
    let pkg = {};
    try {
      pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    } catch {
      pkg = {};
    }
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const testScript = String(pkg.scripts?.test ?? '');
    if (deps.vitest || /\bvitest\b/.test(testScript)) {
      const bin = join('node_modules', '.bin', 'vitest');
      return {
        runner: 'vitest',
        displayCmd: `vitest run --reporter=json ${files.join(' ')}`,
        buildExec: (worktree) => ({
          cmd: existsSync(join(worktree, bin)) ? join(worktree, bin) : 'vitest',
          args: ['run', '--reporter=json', ...files],
        }),
        parse: (stdout) => parseVitestJson(stdout),
      };
    }
    // Jest emits the same `testResults`/`assertionResults` JSON shape as Vitest (Vitest
    // copied it), so the JSON parser serves both (review 0003 Q48: a Jest repository fell
    // through to `node --test` and parsed TAP out of JSON).
    if (deps.jest || /\bjest\b/.test(testScript)) {
      const bin = join('node_modules', '.bin', 'jest');
      return {
        runner: 'jest',
        displayCmd: `jest --json ${files.join(' ')}`,
        buildExec: (worktree) => ({
          cmd: existsSync(join(worktree, bin)) ? join(worktree, bin) : 'jest',
          args: ['--json', ...files],
        }),
        parse: (stdout) => parseVitestJson(stdout),
      };
    }
    return {
      runner: 'node-test',
      displayCmd: `node --test ${files.join(' ')}`,
      buildExec: () => ({
        cmd: process.execPath,
        args: ['--test', '--test-reporter=tap', ...files],
      }),
      parse: (stdout) => parseTapOutput(stdout),
    };
  }

  if (existsSync(join(root, 'Cargo.toml'))) {
    // Cargo has no "run this file" argument. An integration test is a target named after
    // its file in `tests/`, so it can be selected with `--test`. A source file carries
    // inline unit tests and can only be reached by the crate's test binary, so one such
    // file means the whole crate runs.
    const targets = dedupeSorted(
      files.filter((file) => /^tests\/[^/]+\.rs$/.test(file)).map((file) => basename(file, '.rs')),
    );
    const integrationOnly = files.length > 0 && files.every((file) => /^tests\/[^/]+\.rs$/.test(file));
    const args = ['test'];
    if (integrationOnly) {
      for (const target of targets) args.push('--test', target);
    }
    return {
      runner: 'cargo-test',
      displayCmd: ['cargo', ...args].join(' '),
      buildExec: () => ({ cmd: 'cargo', args }),
      parse: (stdout) => parseCargoTestOutput(stdout),
    };
  }

  if (existsSync(join(root, 'go.mod'))) {
    const packages = dedupeSorted(
      files.map((file) => {
        const dir = dirname(file);
        return dir === '.' ? './...' : `./${dir}`;
      }),
    );
    return {
      runner: 'go-test',
      displayCmd: `go test -json ${packages.join(' ')}`,
      buildExec: () => ({ cmd: 'go', args: ['test', '-json', ...packages] }),
      parse: (stdout) => parseGoTestJson(stdout),
    };
  }

  if (
    existsSync(join(root, 'pyproject.toml')) ||
    existsSync(join(root, 'requirements.txt')) ||
    existsSync(join(root, 'setup.py'))
  ) {
    return {
      runner: 'pytest',
      displayCmd: `pytest ${files.join(' ')}`,
      buildExec: () => {
        const reportPath = junitReportPath();
        return {
          cmd: 'pytest',
          args: [`--junitxml=${reportPath}`, ...files],
          reportPaths: [reportPath],
        };
      },
      parse: (_stdout, reportText) => parseJunitXml(reportText ?? ''),
    };
  }

  if (existsSync(join(root, 'build.gradle.kts')) || existsSync(join(root, 'build.gradle'))) {
    const classes = files.map((file) => basename(file).replace(/\.(?:java|kt)$/, '')).filter(Boolean);
    const filterArgs = classes.flatMap((name) => ['--tests', `*${name}*`]);
    return {
      runner: 'gradle',
      displayCmd: `./gradlew test ${filterArgs.join(' ')}`.trim(),
      buildExec: (worktree) => ({
        cmd: existsSync(join(worktree, 'gradlew')) ? join(worktree, 'gradlew') : 'gradle',
        args: ['test', ...filterArgs],
        // One XML per test class; readReports walks the directory.
        reportPaths: [join(worktree, 'build', 'test-results', 'test')],
      }),
      parse: (_stdout, reportText) => parseJunitXml(reportText ?? ''),
    };
  }

  if (existsSync(join(root, 'pom.xml'))) {
    const classes = files.map((file) => basename(file).replace(/\.(?:java|kt)$/, '')).filter(Boolean);
    const arg = classes.length > 0 ? [`-Dtest=${classes.join(',')}`] : [];
    return {
      runner: 'maven',
      displayCmd: `mvn test ${arg.join(' ')}`.trim(),
      buildExec: (worktree) => ({
        cmd: 'mvn',
        args: ['test', ...arg],
        // Surefire writes one XML per class here (review 0003 Q48).
        reportPaths: [join(worktree, 'target', 'surefire-reports')],
      }),
      parse: (_stdout, reportText) => parseJunitXml(reportText ?? ''),
    };
  }

  return null;
}
