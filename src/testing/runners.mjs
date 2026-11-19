// Which runner a repository uses, and the command that runs one set of test files.
//
// Detection reads the repository's own manifest, never a guess from a directory name: the
// runner that is installed is the runner a contributor runs. This module is
// production-facing because `simt gate` runs the repository's tests;
// the bench uses the same answer, so a benchmarked run and a gated run cannot disagree
// about what `test` means.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { CLI } from '../name.mjs';
import { compileRunner, runnerSpecProblem } from './contract.mjs';
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
 * The Node runtime a test child may use.
 *
 * A package's default runner is `node --test`, and the obvious spelling of that is
 * `process.execPath`. Under a single-executable build `process.execPath` is this tool,
 * not Node: the child re-ran `simt --test`, printed help and exited 0, so a failing suite
 * looked like a pass (review 0005 PR11). `node` from PATH is the consumer's runtime; the
 * executable is only used when it is one.
 *
 * @param {{execPath?: string, sea?: boolean}} [input]
 * @returns {string}
 */
export function nodeCommand({ execPath = process.execPath, sea = Boolean(process.versions?.sea) } = {}) {
  if (sea) return 'node';
  const name = basename(execPath).replace(/\.exe$/i, '');
  return /^node(js)?$/i.test(name) ? execPath : 'node';
}

/**
 * A JUnit report path this process owns.
 *
 * The report used to be written beside the sources as `.bench-junit.xml`, so running the
 * gate in a Python repository left a file in the package directory. It
 * belongs to the run, so it lives in the temporary directory and `cleanupReports` removes
 * it once the run has been read.
 */
function junitReportPath() {
  junitCounter += 1;
  return join(tmpdir(), `${CLI}-junit-${process.pid}-${junitCounter}.xml`);
}

/**
 * Detect the test runner for a repository and build the command for a set of changed test
 * files.
 *
 * When the repository declares `test.runner`, that declaration answers instead of this
 * chain. It is validated here as well as at the manifest boundary, because the bench
 * calls this function directly and a caller that skips the manifest must not run an
 * unchecked argv.
 *
 * @param {string} root
 * @param {string[]} testFiles
 * @param {{spec?: object|null, pkg?: string}} [options]
 * @returns {Promise<{runner: string, displayCmd: string, requires?: string[],
 *   buildExec: (worktree: string) => {cmd: string, args: string[], reportPaths?: string[], cwd?: string},
 *   parse: (stdout: string, reportText?: string) => {passed: string[], failed: string[]}}|null>}
 */
export async function detectTestRunner(root, testFiles, { spec = null, pkg = '' } = {}) {
  const files = [...testFiles].sort();

  if (spec !== null && spec !== undefined) {
    const problem = runnerSpecProblem(spec);
    if (problem !== null) throw new Error(problem);
    const parse =
      spec.report === 'junit'
        ? (_stdout, reportText) => parseJunitXml(reportText ?? '')
        : spec.report === 'json'
          ? (stdout) => parseVitestJson(stdout)
          : spec.report === 'tap'
            ? (stdout) => parseTapOutput(stdout)
            : () => ({ passed: [], failed: [] });
    // The display is the argv one run executes, expanded for this package, so a reader
    // can paste it and a template placeholder never reaches the report.
    const preview = compileRunner(spec, { worktree: root, pkg, files });
    return {
      runner: 'configured',
      displayCmd: [preview.cmd, ...preview.args].join(' '),
      requires: Array.isArray(spec.requires) ? spec.requires : [],
      buildExec: (worktree) => compileRunner(spec, { worktree, pkg, files }),
      parse,
    };
  }

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
    // copied it), so the JSON parser serves both
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
        cmd: nodeCommand(),
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
      requires: ['cargo'],
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
      requires: ['go'],
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
    // The environment rules are in the `uv` profile: a committed `uv.lock` owns the
    // interpreter, then `poetry.lock`. A bare `pytest` in a uv project is whatever the
    // shell happens to have, which is the different copy of the package the rule warns
    // about. Without either lockfile, `pytest` is the declared command.
    const launcher = existsSync(join(root, 'uv.lock'))
      ? { cmd: 'uv', prefix: ['run', 'pytest'], requires: ['uv'] }
      : existsSync(join(root, 'poetry.lock'))
        ? { cmd: 'poetry', prefix: ['run', 'pytest'], requires: ['poetry'] }
        : { cmd: 'pytest', prefix: [], requires: ['pytest'] };
    return {
      runner: 'pytest',
      requires: launcher.requires,
      displayCmd: [launcher.cmd, ...launcher.prefix, ...files].join(' '),
      buildExec: () => {
        const reportPath = junitReportPath();
        return {
          cmd: launcher.cmd,
          args: [...launcher.prefix, `--junitxml=${reportPath}`, ...files],
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
      requires: existsSync(join(root, 'gradlew')) ? [] : ['gradle'],
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
      requires: ['mvn'],
      displayCmd: `mvn test ${arg.join(' ')}`.trim(),
      buildExec: (worktree) => ({
        cmd: 'mvn',
        args: ['test', ...arg],
        // Surefire writes one XML per class here.
        reportPaths: [join(worktree, 'target', 'surefire-reports')],
      }),
      parse: (_stdout, reportText) => parseJunitXml(reportText ?? ''),
    };
  }

  return null;
}
