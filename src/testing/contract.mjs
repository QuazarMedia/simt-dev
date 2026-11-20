// The focused test runner contract: one validated argv a repository declares when the
// built-in detectors do not recognise its stack.
//
// Detection used to be a fixed chain. A package carrying a `package.json` reached the Node
// branch first whatever else it contained, and a package whose runner was absent from the
// chain had no way to say so: the gate answered `unsupported` to a repository that runs
// its tests every day. The contract is data, so the answer comes from the repository's own
// declaration instead of a patch to the chain (ADR-013).
//
// It is argv, never a shell string. A command string needs a shell to split it, and a
// shell reads the selected file names as its own syntax; argv has neither problem, and a
// path containing a space stays one argument.

import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The report formats a configured runner may declare. `none` means stdout is the report. */
const RUNNER_REPORTS = ['none', 'tap', 'json', 'junit'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCommandList = (value) => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.length > 0);

/**
 * What is wrong with one `test.runner` declaration, or null.
 *
 * The reader is a person who edited `simt.json` by hand, so the answer is a sentence that
 * names the field and the shape it needs. The manifest schema calls this too, which is why
 * an invalid declaration is a config finding and not a runtime surprise.
 *
 * @param {unknown} spec
 * @returns {string|null}
 */
export function runnerSpecProblem(spec) {
  if (!isObject(spec)) return 'test.runner must be an object';
  if (!isCommandList(spec.command)) {
    return 'test.runner.command must be a non-empty argv list, e.g. ["npm", "run", "--silent", "test", "--"]';
  }
  if (spec.report !== undefined && !RUNNER_REPORTS.includes(spec.report)) {
    return `test.runner.report must be one of ${RUNNER_REPORTS.join(', ')}`;
  }
  if (spec.report === 'junit' && typeof spec.reportPath !== 'string') {
    return 'test.runner.reportPath is required when report is "junit"';
  }
  if (spec.reportPath !== undefined && typeof spec.reportPath !== 'string') {
    return 'test.runner.reportPath must be a path string';
  }
  if (spec.requires !== undefined && !(Array.isArray(spec.requires) && spec.requires.every((item) => typeof item === 'string' && item.length > 0))) {
    return 'test.runner.requires must be a list of executable names';
  }
  if (spec.cwd !== undefined && typeof spec.cwd !== 'string') {
    return 'test.runner.cwd must be a path string relative to the package';
  }
  return null;
}

/**
 * Whether an executable a runner declares can be found.
 *
 * A name with a separator is a path and is checked as one; a bare name is looked up on
 * PATH, which is where the child will look for it. The point is to answer "unsupported"
 * before spawning: a missing tool otherwise arrives as exit 1, indistinguishable from a
 * test that failed.
 *
 * @param {string} command
 * @param {{path?: string, fileExists?: (path: string) => boolean, cwd?: string}} [options]
 * @returns {boolean}
 */
export function commandAvailable(command, { path = process.env.PATH ?? '', fileExists = isExecutable, cwd = process.cwd() } = {}) {
  if (command.includes('/') || isAbsolute(command)) {
    const target = isAbsolute(command) ? command : resolve(cwd, command);
    return fileExists(target);
  }
  for (const dir of path.split(delimiter)) {
    if (dir && fileExists(join(dir, command))) return true;
  }
  return false;
}

function isExecutable(target) {
  try {
    accessSync(target, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Expand one template element. `{files}` expands to many elements and is handled apart. */
function expand(element, { files, pkg, root, report }) {
  const filled = element
    .replaceAll('{package}', pkg ?? '')
    .replaceAll('{root}', root)
    .replaceAll('{files}', files.join(' '));
  return report === null ? filled : filled.replaceAll('{report}', report);
}

/**
 * Turn a validated declaration into the argv one run executes.
 *
 * `{files}` in an element expands to the selected files as separate arguments; a
 * declaration without it has the files appended, which is what `npm run test --` and
 * `pytest` both expect. `{package}` is the package directory relative to the root, and
 * `{root}` the worktree the run executes in, so one declaration serves a monorepo.
 *
 * @param {object} spec a declaration `runnerSpecProblem` accepted
 * @param {{worktree: string, pkg?: string, files: string[]}} input
 * @returns {{cmd: string, args: string[], reportPaths?: string[], cwd: string}}
 */
export function compileRunner(spec, { worktree, pkg = '', files }) {
  const reportPath = typeof spec.reportPath === 'string' ? resolve(worktree, spec.reportPath) : null;
  const expansion = { files: [...files], pkg, root: worktree, report: reportPath };
  const [cmd, ...rest] = spec.command;
  const args = [];
  let placed = false;
  for (const element of rest) {
    if (element === '{files}') {
      args.push(...files);
      placed = true;
    } else if (element.includes('{files}')) {
      args.push(expand(element, expansion));
      placed = true;
    } else {
      args.push(expand(element, expansion));
    }
  }
  if (!placed) args.push(...files);
  const cwd = spec.cwd === undefined ? worktree : resolve(worktree, spec.cwd);
  const built = { cmd: expand(cmd, expansion), args, cwd };
  if (reportPath !== null) built.reportPaths = [reportPath];
  return built;
}

/**
 * The path a configured runner's report must stay inside.
 *
 * `{report}` lets the declaration pass the path to its own runner through whatever flag
 * that runner takes (`--junitxml={report}`, `--output={report}`); this tool never invents
 * a flag the command does not have. A report outside the package would be a write this
 * run does not own, so it is refused rather than resolved.
 */
export function reportPathProblem(spec, worktree) {
  if (typeof spec?.reportPath !== 'string') return null;
  const target = resolve(worktree, spec.reportPath);
  const fromRoot = relative(worktree, target);
  if (fromRoot.startsWith('..') || fromRoot.split(sep).includes('..') || isAbsolute(fromRoot)) {
    return 'test.runner.reportPath must stay inside the package it runs in';
  }
  return null;
}
