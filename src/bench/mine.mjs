// Task miner for `simt bench mine` (R01).
//
// Walks git history for non-merge commits that change both test files and
// implementation files, splits each candidate into `test.patch` and `gold.patch`,
// and validates in an isolated temporary worktree (twice, so flaky tests are
// dropped) that BASE + test.patch fails (RED) and BASE + test.patch + gold.patch
// passes (GOLD).
//
// Hidden test patches live in `~/.cache/simt-dev/vault/<repo-id>/<task-id>/`
// outside every worktree (RepoTrials / PatchGym), while deterministic task
// descriptors live in `.simt/bench/tasks/<id>.json`.

import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, platform as osPlatform, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { CONFIG_DIR, STATE_DIR } from '../name.mjs';
import { readManifest } from '../projection/manifest.mjs';
import { packageVersion } from '../package-version.mjs';
import { TASK_SCHEMA_VERSION, normaliseTask } from './task-schema.mjs';
// Q70: the per-language test-file patterns are the records' `testConventions` (ADR-013),
// not hardcoded regexes in this file. A new language's test convention lands in a record.
import { testConventions } from '../ecosystem/records.mjs';

const exec = promisify(execFile);

// The `testConventions` records' `base` sources, compiled once. De-duplicated because a
// language may share a pattern with a sibling (the JVM pattern matches both `.java` and
// `.kt`); a duplicate RegExp is the same check run twice.
const LANG_TEST_PATTERNS = [...new Set(testConventions().flatMap((c) => c.base ?? []))].map((src) => new RegExp(src));

/** Default target task count when mining a repository's history. */
export const DEFAULT_MINE_TARGET = 20;

/**
 * Test paths excluded by default, overridable via `simt.json` `bench.mine.exclude`
 * (review 0003 Q48: the pack integration test was hardcoded here, a repo fact, not a miner fact).
 */
const DEFAULT_EXCLUDES = ['test/pack.test.mjs'];

/**
 * Classify whether a repository-relative path is a test file.
 *
 * Covers the ecosystems named in plan 0003 §5 R01:
 *   - `test/`, `tests/`, `spec/`, `__tests__/`, `src/test/`
 *   - `*.test.*`, `*.spec.*`, `*_test.*`, `*_spec.*`
 *   - `*_test.go` (Go)
 *   - `test_*.py` (pytest)
 *   - `tests/*.rs` (Cargo integration tests)
 *   - `*Test.java`, `*Tests.java`, `*Test.kt`, `*Tests.kt` (Gradle / Maven)
 *
 * @param {string} relPath forward-slash repository-relative path
 * @returns {boolean}
 */
export function isTestPath(relPath) {
  const norm = String(relPath).replaceAll('\\', '/').replace(/^\.\//, '');
  if (!norm) return false;
  const segments = norm.split('/');
  const base = segments[segments.length - 1];

  if (
    norm.startsWith('test/') ||
    norm.startsWith('tests/') ||
    norm.startsWith('spec/') ||
    norm.startsWith('__tests__/') ||
    norm.startsWith('src/test/') ||
    segments.includes('__tests__') ||
    segments.includes('test') ||
    segments.includes('tests') ||
    segments.includes('spec')
  ) {
    return true;
  }

  if (/\.(?:test|spec)\.[A-Za-z0-9]+$/.test(base)) return true;
  if (/_(?:test|spec)\.[A-Za-z0-9]+$/.test(base)) return true;
  if (LANG_TEST_PATTERNS.some((re) => re.test(base))) return true;

  return false;
}

/**
 * Parse TAP version 13 output from `node --test --test-reporter=tap`.
 *
 * Leaf test cases carry `type: 'test'` in their YAML block; suite headers carry
 * `type: 'suite'` and are used only to build `parent > child` qualified IDs.
 *
 * @param {string} text
 * @returns {{passed: string[], failed: string[]}}
 */
export function parseTapOutput(text) {
  const passed = [];
  const failed = [];
  const lines = String(text ?? '').split('\n');
  const stack = [];
  let pending = null;

  const flush = () => {
    if (!pending) return;
    if (pending.type !== 'suite' && !pending.hadChild && !pending.directive) {
      const id = [...pending.ancestors, pending.name].join(' > ');
      if (pending.ok) passed.push(id);
      else failed.push(id);
    }
    pending = null;
  };

  for (const raw of lines) {
    const sub = /^(\s*)# Subtest:\s+(.*)$/.exec(raw);
    if (sub) {
      flush();
      const indent = sub[1].length;
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }
      if (stack.length > 0) {
        stack[stack.length - 1].hadChild = true;
      }
      stack.push({ indent, name: sub[2].trim(), hadChild: false });
      continue;
    }

    const res = /^(\s*)(not ok|ok)\s+\d+(?:\s+-\s+(.*?))?(?:\s+#\s*(SKIP|TODO)\b.*)?$/i.exec(raw);
    if (res) {
      flush();
      const indent = res[1].length;
      while (stack.length > 0 && stack[stack.length - 1].indent > indent) {
        stack.pop();
      }
      let hadChild = false;
      if (stack.length > 0 && stack[stack.length - 1].indent === indent) {
        hadChild = stack.pop().hadChild;
      }
      const ancestors = stack.map((s) => s.name);
      const ok = res[2].toLowerCase() === 'ok';
      const name = (res[3] ?? '').trim();
      const directive = res[4] ? res[4].toUpperCase() : null;
      if (name) {
        pending = { indent, ok, name, ancestors, hadChild, directive, type: null };
      }
      continue;
    }

    if (pending) {
      const typeMatch = /^\s*type:\s*['"]?(test|suite)['"]?\s*$/.exec(raw);
      if (typeMatch) {
        pending.type = typeMatch[1];
      } else if (/^\s*\.\.\.\s*$/.test(raw)) {
        flush();
      }
    }
  }
  flush();

  return {
    passed: dedupeSorted(passed),
    failed: dedupeSorted(failed),
  };
}

/**
 * Parse Vitest `--reporter=json` output.
 *
 * @param {string} text
 * @returns {{passed: string[], failed: string[]}}
 */
export function parseVitestJson(text) {
  const passed = [];
  const failed = [];
  const raw = String(text ?? '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return { passed, failed };

  let doc;
  try {
    doc = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { passed, failed };
  }

  for (const suite of doc.testResults ?? []) {
    for (const assertion of suite.assertionResults ?? []) {
      const parts = [...(assertion.ancestorTitles ?? []), assertion.title].filter(Boolean);
      const id = parts.length > 0 ? parts.join(' > ') : (assertion.fullName ?? '').trim();
      if (!id) continue;
      if (assertion.status === 'passed') passed.push(id);
      else if (assertion.status === 'failed') failed.push(id);
    }
  }

  return {
    passed: dedupeSorted(passed),
    failed: dedupeSorted(failed),
  };
}

/**
 * Parse JUnit XML output (used by pytest `--junitxml`, Gradle and Maven).
 *
 * @param {string} xml
 * @returns {{passed: string[], failed: string[]}}
 */
export function parseJunitXml(xml) {
  const passed = [];
  const failed = [];
  const source = String(xml ?? '');
  const tagRe = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;

  for (const match of source.matchAll(tagRe)) {
    const attrs = match[1] ?? '';
    const inner = match[2] ?? '';
    const name = xmlAttr(attrs, 'name');
    const classname = xmlAttr(attrs, 'classname');
    if (!name) continue;
    if (/<skipped\b/i.test(inner)) continue;

    const id = classname ? `${classname} > ${name}` : name;
    if (/<(?:failure|error)\b/i.test(inner)) failed.push(id);
    else passed.push(id);
  }

  return {
    passed: dedupeSorted(passed),
    failed: dedupeSorted(failed),
  };
}

function xmlAttr(attrs, key) {
  const m = new RegExp(`\\b${key}=["']([^"']*)["']`).exec(attrs);
  if (!m) return '';
  return m[1]
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .trim();
}

/**
 * Parse `go test -json` JSONL event stream.
 *
 * Only leaf test events (carrying `Test`) are recorded; package-level summary
 * events without `Test` are ignored.
 *
 * @param {string} text
 * @returns {{passed: string[], failed: string[]}}
 */
export function parseGoTestJson(text) {
  const passed = [];
  const failed = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof ev.Test !== 'string' || ev.Test.length === 0) continue;
    const id = ev.Package ? `${ev.Package} > ${ev.Test}` : ev.Test;
    if (ev.Action === 'pass') passed.push(id);
    else if (ev.Action === 'fail') failed.push(id);
  }

  return {
    passed: dedupeSorted(passed),
    failed: dedupeSorted(failed),
  };
}

/**
 * Parse libtest's text output, which `cargo test` prints for every test binary.
 *
 * A line is a result only when it has the `test <name> ... <status>` shape.
 * Harness summaries (`test result: ok.`), compile output and doctest prose are
 * not results. `ignored` is neither a pass nor a failure: counting it as one
 * would make a skipped test look like evidence the change works.
 *
 * @param {string} text
 * @returns {{passed: string[], failed: string[]}}
 */
export function parseCargoTestOutput(text) {
  const passed = [];
  const failed = [];
  for (const line of String(text ?? '').split('\n')) {
    const match = /^test\s+(.+?)\s+\.\.\.\s+(ok|FAILED|ignored)\s*$/.exec(line.trimEnd());
    if (!match || match[2] === 'ignored') continue;
    (match[2] === 'ok' ? passed : failed).push(match[1]);
  }
  return {
    passed: dedupeSorted(passed),
    failed: dedupeSorted(failed),
  };
}

/**
 * Read every JUnit XML a run left behind, from report files or report
 * *directories* (review 0003 Q48: Gradle writes one XML per class under
 * `build/test-results/test/`, Maven under `target/surefire-reports/`; reading
 * a single file saw none of them, so both graders read nothing). Directories
 * are walked recursively in sort order so the concatenation is deterministic.
 *
 * @param {string[]} paths report files and/or directories
 * @returns {Promise<string>} the concatenated XML, '' when nothing is there
 */
export async function readReports(paths) {
  const chunks = [];
  for (const p of paths ?? []) {
    let isDir = false;
    try {
      isDir = (await stat(p)).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      const files = await listXml(p);
      for (const file of files) {
        chunks.push(await readFile(file, 'utf8').catch(() => ''));
      }
    } else {
      chunks.push(await readFile(p, 'utf8').catch(() => ''));
    }
  }
  return chunks.join('\n');
}

/** Every `*.xml` under `dir`, sorted, for a deterministic read order. */
async function listXml(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listXml(full)));
    else if (entry.name.endsWith('.xml')) out.push(full);
  }
  return out;
}

/**
 * Detect the test runner for a repository and build the command for a set of
 * changed test files.
 *
 * @param {string} root
 * @param {string[]} testFiles
 * @returns {Promise<{runner: string, displayCmd: string, buildExec: (worktree: string) => {cmd: string, args: string[], reportPaths?: string[]}, parse: (stdout: string, reportText?: string) => {passed: string[], failed: string[]}}|null>}
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
        buildExec: (wt) => ({
          cmd: existsSync(join(wt, bin)) ? join(wt, bin) : 'vitest',
          args: ['run', '--reporter=json', ...files],
        }),
        parse: (stdout) => parseVitestJson(stdout),
      };
    }
    // Jest emits the same `testResults`/`assertionResults` JSON shape as
    // Vitest (Vitest copied it), so the JSON parser serves both (review 0003
    // Q48: a jest repository fell through to `node --test` and parsed TAP
    // out of JSON).
    if (deps.jest || /\bjest\b/.test(testScript)) {
      const bin = join('node_modules', '.bin', 'jest');
      return {
        runner: 'jest',
        displayCmd: `jest --json ${files.join(' ')}`,
        buildExec: (wt) => ({
          cmd: existsSync(join(wt, bin)) ? join(wt, bin) : 'jest',
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
    // Cargo has no "run this file" argument. An integration test is a target
    // named after its file in `tests/`, so it can be selected with `--test`.
    // A source file carries inline unit tests and can only be reached by the
    // crate's test binary, so one such file means the whole crate runs.
    const targets = dedupeSorted(
      files.filter((f) => /^tests\/[^/]+\.rs$/.test(f)).map((f) => basename(f, '.rs')),
    );
    const integrationOnly = files.length > 0 && files.every((f) => /^tests\/[^/]+\.rs$/.test(f));
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
    const pkgs = dedupeSorted(
      files.map((f) => {
        const dir = dirname(f);
        return dir === '.' ? './...' : `./${dir}`;
      }),
    );
    return {
      runner: 'go-test',
      displayCmd: `go test -json ${pkgs.join(' ')}`,
      buildExec: () => ({
        cmd: 'go',
        args: ['test', '-json', ...pkgs],
      }),
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
      buildExec: (wt) => {
        const reportPath = join(wt, '.bench-junit.xml');
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
    const classes = files
      .map((f) => basename(f).replace(/\.(?:java|kt)$/, ''))
      .filter(Boolean);
    const filterArgs = classes.flatMap((c) => ['--tests', `*${c}*`]);
    return {
      runner: 'gradle',
      displayCmd: `./gradlew test ${filterArgs.join(' ')}`.trim(),
      buildExec: (wt) => ({
        cmd: existsSync(join(wt, 'gradlew')) ? join(wt, 'gradlew') : 'gradle',
        args: ['test', ...filterArgs],
        // One XML per test class; readReports walks the directory.
        reportPaths: [join(wt, 'build', 'test-results', 'test')],
      }),
      parse: (_stdout, reportText) => parseJunitXml(reportText ?? ''),
    };
  }

  if (existsSync(join(root, 'pom.xml'))) {
    const classes = files
      .map((f) => basename(f).replace(/\.(?:java|kt)$/, ''))
      .filter(Boolean);
    const arg = classes.length > 0 ? [`-Dtest=${classes.join(',')}`] : [];
    return {
      runner: 'maven',
      displayCmd: `mvn test ${arg.join(' ')}`.trim(),
      buildExec: (wt) => ({
        cmd: 'mvn',
        args: ['test', ...arg],
        // Surefire writes one XML per class here; never read before (review 0003 Q48).
        reportPaths: [join(wt, 'target', 'surefire-reports')],
      }),
      parse: (_stdout, reportText) => parseJunitXml(reportText ?? ''),
    };
  }

  return null;
}

/**
 * Resolve the hidden verifier vault root outside every worktree.
 *
 * Precedence:
 *   1. `SIMT_DEV_VAULT_DIR` (explicit override for hermetic tests)
 *   2. `$XDG_CACHE_HOME/simt-dev/vault/<repo-id>`
 *   3. `~/Library/Caches/simt-dev/vault/<repo-id>` on macOS, or `~/.cache/simt-dev/vault/<repo-id>`
 *
 * @param {string} root
 * @param {{env?: NodeJS.ProcessEnv, home?: string, platform?: string}} [options]
 * @returns {string}
 */
export function resolveVaultDir(root, { env = process.env, home = homedir(), platform = osPlatform() } = {}) {
  const repoId = repoIdentifier(root);
  if (env.SIMT_DEV_VAULT_DIR) {
    return join(resolve(env.SIMT_DEV_VAULT_DIR), repoId);
  }
  const cacheBase = env.XDG_CACHE_HOME
    ? resolve(env.XDG_CACHE_HOME)
    : platform === 'darwin'
      ? join(home, 'Library', 'Caches')
      : join(home, '.cache');
  return join(cacheBase, CONFIG_DIR, 'vault', repoId);
}

/**
 * The stable identity a repository's vault is keyed on: the basename for a
 * human-readable prefix, and the root commit (first commit in history) for the
 * digest. The root commit is identical in every clone and survives remote
 * renames, so the vault lands in the same directory on every machine with the
 * same history (review 0003 Q48: the absolute-path key made the committed
 * corpus unrunnable from any other checkout). Outside git it degrades to the
 * absolute-path digest: a root with no history has no better identity, and the
 * vault path must never fail because git is absent.
 *
 * Sync, like package-version.mjs: the vault path is computed on every read, and
 * a path that throws is worse than one that is occasionally less specific.
 */
function repoIdentifier(root) {
  const full = resolve(root);
  const name = basename(full).replace(/[^A-Za-z0-9._-]/g, '-') || 'repo';
  try {
    const sha = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split(/\s/)[0];
    if (/^[0-9a-f]{40}$/.test(sha)) return `${name}-root-${sha.slice(0, 8)}`;
  } catch {
    // Not a git root (or no commits): fall through to the path digest.
  }
  const digest = createHash('sha256').update(full).digest('hex').slice(0, 8);
  return `${name}-${digest}`;
}

/**
 * Compute diff stats (`files`, `linesAdded`, `linesRemoved`) from a unified diff buffer.
 *
 * @param {Buffer|string} patch
 * @param {number} fileCount
 * @returns {{files: number, linesAdded: number, linesRemoved: number}}
 */
export function patchStats(patch, fileCount) {
  const text = Buffer.isBuffer(patch) ? patch.toString('utf8') : String(patch ?? '');
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+')) linesAdded += 1;
    else if (line.startsWith('-')) linesRemoved += 1;
  }
  return { files: fileCount, linesAdded, linesRemoved };
}

/**
 * Extract candidate commits from git history in a single `git log` pass.
 *
 * Keeps non-merge commits with at least one parent that modify both test paths
 * and implementation paths.
 *
 * @param {string} root
 * @returns {Promise<{ok: boolean, candidates: object[], error?: string}>}
 */
export async function listCandidates(root) {
  let stdout;
  try {
    ({ stdout } = await exec(
      'git',
      ['log', '--no-merges', '--min-parents=1', '--name-only', '--format=%x1e%H%x00%P%x00%s%x00%b%x1f'],
      { cwd: root, maxBuffer: 64 << 20 },
    ));
  } catch (error) {
    return { ok: false, candidates: [], error: error.stderr?.trim() || error.message };
  }

  const candidates = [];
  for (const record of stdout.split('\x1e')) {
    if (!record.trim()) continue;
    const sep = record.indexOf('\x1f');
    if (sep === -1) continue;
    const header = record.slice(0, sep);
    const filesBlock = record.slice(sep + 1);
    const [sha, parents, subject, body] = header.split('\0');
    if (!sha || !parents) continue;
    const base = parents.trim().split(/\s+/)[0];
    if (!base) continue;

    const changed = dedupeSorted(
      filesBlock
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    );
    const testFiles = changed.filter((f) => isTestPath(f));
    const implFiles = changed.filter((f) => !isTestPath(f));
    if (testFiles.length === 0 || implFiles.length === 0) continue;

    const cleanSubject = (subject ?? '').trim();
    const cleanBody = (body ?? '').trim();
    // Subject only by default. A commit body usually narrates the fix ("use x * x * x
    // here"), which hands the agent the answer and measures nothing; a repository whose
    // messages are curated can ask for the whole message with `bench.mine.prompt: "body"`
    // (review 0003 Q49).
    const prompt = cleanSubject;

    candidates.push({
      sha: sha.trim(),
      base,
      subject: cleanSubject,
      body: cleanBody,
      prompt,
      testFiles,
      implFiles,
    });
  }

  return { ok: true, candidates };
}

/**
 * Run a child process in its own process group with a hard timeout so a hanging
 * test or grandchildren cannot outlive the check.
 */
function runProcess(cmd, args, { cwd, input, env, timeoutMs = 15000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      child.stdout.destroy();
      child.stderr.destroy();
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ code: 1, timedOut: false, stdout, stderr: `${stderr}\n${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, timedOut, stdout, stderr });
    });

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function executeRunner(runner, worktree, env, timeoutMs) {
  const spec = runner.buildExec(worktree);
  // Remove what a previous run left behind before running: a stale report
  // would parse as this run's result, and a directory report accumulates
  // one XML per class across runs.
  for (const p of spec.reportPaths ?? []) {
    if (existsSync(p)) await rm(p, { recursive: true, force: true });
  }
  const res = await runProcess(spec.cmd, spec.args, { cwd: worktree, env, timeoutMs });
  const reportText = await readReports(spec.reportPaths);
  const parsed = runner.parse(res.stdout, reportText);
  return {
    code: res.code,
    timedOut: res.timedOut,
    passed: parsed.passed,
    failed: parsed.failed,
  };
}

/**
 * Validate a single candidate commit in `worktree` by running RED twice and GOLD
 * twice, dropping any candidate whose test outcomes are not identical across both
 * passes.
 */
async function validateCandidate(
  root,
  worktree,
  candidate,
  { timeoutMs = 5000, exclude = DEFAULT_EXCLUDES, promptMode = 'subject' } = {},
) {
  // Skip commits that modify more than 4 test files, or that touch a path
  // the repository's manifest excludes (`simt.json` bench.mine.exclude,
  // defaulting to the pack integration test the committed corpus was mined
  // around): sweeping renames rather than self-contained benchmark tasks.
  if (
    candidate.testFiles.length > 4 ||
    candidate.testFiles.some((f) => exclude.includes(f))
  ) {
    return null;
  }

  let testPatch;
  let goldPatch;
  try {
    ({ stdout: testPatch } = await exec(
      'git',
      ['diff', '--binary', candidate.base, candidate.sha, '--', ...candidate.testFiles],
      { cwd: root, encoding: 'buffer', maxBuffer: 16 << 20 },
    ));
    ({ stdout: goldPatch } = await exec(
      'git',
      ['diff', '--binary', candidate.base, candidate.sha, '--', ...candidate.implFiles],
      { cwd: root, encoding: 'buffer', maxBuffer: 16 << 20 },
    ));
  } catch {
    return null;
  }
  if (!testPatch || testPatch.length === 0 || !goldPatch || goldPatch.length === 0) {
    return null;
  }

  await exec('git', ['reset', '--hard', 'HEAD'], { cwd: worktree }).catch(() => null);
  await exec('git', ['clean', '-fdx'], { cwd: worktree }).catch(() => null);
  const co = await runProcess('git', ['checkout', '-f', candidate.base], { cwd: worktree });
  if (co.code !== 0) return null;
  await exec('git', ['clean', '-fdx'], { cwd: worktree }).catch(() => null);

  const appliedRed = await runProcess('git', ['apply', '-'], { cwd: worktree, input: testPatch });
  if (appliedRed.code !== 0) return null;

  const runnableFiles = candidate.testFiles.filter((f) => existsSync(join(worktree, f)));
  if (runnableFiles.length === 0) return null;

  const runner = await detectTestRunner(worktree, runnableFiles);
  if (!runner) return null;

  const env = { ...process.env, SIMT_DEV_WORKSPACE: 'off', NO_COLOR: '1' };
  // Strip NODE_TEST_CONTEXT so child `node --test` invocations spawned from
  // inside a parent `node --test` run honour `--test-reporter=tap` instead of
  // emitting internal v8 subtest protocol frames.
  delete env.NODE_TEST_CONTEXT;

  // Pass 1 & 2 of RED: BASE + test.patch must fail reproducibly.
  const red1 = await executeRunner(runner, worktree, env, timeoutMs);
  if (red1.code === 0 || red1.timedOut) return null;
  const red2 = await executeRunner(runner, worktree, env, timeoutMs);
  if (red2.code === 0 || red2.timedOut) return null;
  if (!sameList(red1.failed, red2.failed) || !sameList(red1.passed, red2.passed)) {
    return null;
  }

  // Apply gold.patch on top of BASE + test.patch.
  const appliedGold = await runProcess('git', ['apply', '-'], { cwd: worktree, input: goldPatch });
  if (appliedGold.code !== 0) return null;

  // Pass 1 & 2 of GOLD: BASE + test.patch + gold.patch must pass reproducibly.
  const gold1 = await executeRunner(runner, worktree, env, timeoutMs);
  if (gold1.code !== 0 || gold1.timedOut || gold1.failed.length > 0) return null;
  const gold2 = await executeRunner(runner, worktree, env, timeoutMs);
  if (gold2.code !== 0 || gold2.timedOut || gold2.failed.length > 0) return null;
  if (!sameList(gold1.passed, gold2.passed)) return null;

  const redPassedSet = new Set(red1.passed);
  const redFailedSet = new Set(red1.failed);
  // Tests that failed in RED (or could not load before gold.patch existed) and
  // passed in GOLD are FAIL_TO_PASS; tests that passed in both are PASS_TO_PASS.
  const f2p = gold1.passed.filter((id) => redFailedSet.has(id) || !redPassedSet.has(id));
  const p2p = gold1.passed.filter((id) => redPassedSet.has(id) && !redFailedSet.has(id));
  if (f2p.length === 0) return null;

  // 12 hex chars of the source commit: the 7-char form plus a fixed `-01`
  // suffix could not disambiguate two tasks from the same commit (review 0003
  // Q48). Collisions are checked at write time, where the corpus is visible.
  const id = `t-${candidate.sha.slice(0, 12)}-01`;
  const gold = patchStats(goldPatch, candidate.implFiles.length);

  return {
    task: {
      schemaVersion: TASK_SCHEMA_VERSION,
      id,
      base: candidate.base,
      sourceCommit: candidate.sha,
      prompt:
        promptMode === 'body' && candidate.body
          ? `${candidate.subject}\n\n${candidate.body}`
          : candidate.subject,
      promptBasis: promptMode === 'body' && candidate.body ? 'body' : 'subject',
      testCmd: runner.displayCmd,
      f2p,
      p2p,
      gold,
      vault: `vault/${id}`,
    },
    testPatch,
    goldPatch,
  };
}

/**
 * Mine verified benchmark tasks from a repository's git history.
 *
 * When `apply` is false (the default without `--yes`, or under `--dry-run`),
 * candidates are discovered and reported without writing to `.simt/bench/tasks/`
 * or the vault. When `apply` is true, candidates are validated in isolated
 * temporary worktrees until `target` valid tasks are collected, and written
 * deterministically to disk.
 *
 * Writing is append-only: existing task files are left alone unless `replace`
 * is set, which restores the old "reflect exactly this history" semantics by
 * deleting files the current history does not reproduce (review 0003 Q48).
 *
 * @param {string} root
 * @param {{apply?: boolean, target?: number, concurrency?: number, timeoutMs?: number, replace?: boolean, env?: NodeJS.ProcessEnv}} [options]
 */
export async function mineTasks(
  root,
  {
    apply = false,
    target = DEFAULT_MINE_TARGET,
    concurrency = 4,
    timeoutMs = 5000,
    replace = false,
    env = process.env,
  } = {},
) {
  const absRoot = resolve(root);
  const listed = await listCandidates(absRoot);
  if (!listed.ok) {
    return { ok: false, error: listed.error };
  }

  // Repository-declared mining config (review 0003 Q48): an explicit option
  // wins, then the manifest, then the default.
  const { manifest } = await readManifest(absRoot);
  const benchCfg = manifest?.bench?.mine ?? {};
  const effectiveTimeout = benchCfg.timeoutMs ?? timeoutMs;
  const exclude = benchCfg.exclude ?? DEFAULT_EXCLUDES;
  const promptMode = benchCfg.prompt === 'body' ? 'body' : 'subject';

  const tasksDir = join(absRoot, STATE_DIR, 'bench', 'tasks');
  const vaultRoot = resolveVaultDir(absRoot, { env });

  if (!apply) {
    const preview = listed.candidates.slice(0, target).map((c) => ({
      id: `t-${c.sha.slice(0, 12)}-01`,
      base: c.base,
      sourceCommit: c.sha,
      subject: c.subject,
      testFiles: c.testFiles,
      implFiles: c.implFiles,
    }));
    return {
      ok: true,
      applied: false,
      root: absRoot,
      tasksDir,
      vaultRoot,
      candidatesCount: listed.candidates.length,
      tasks: preview,
    };
  }

  if (listed.candidates.length === 0) {
    return {
      ok: true,
      applied: true,
      root: absRoot,
      tasksDir,
      vaultRoot,
      candidatesCount: 0,
      tasks: [],
    };
  }

  const workerCount = Math.max(1, Math.min(concurrency, listed.candidates.length, target));
  const sandbox = await mkdtemp(join(tmpdir(), 'bench-mine-'));
  const worktrees = [];

  try {
    for (let i = 0; i < workerCount; i += 1) {
      // Nest each worktree inside its own subdirectory so `resolve(wt, '..')`
      // never looks like a sibling workspace (ADR-031).
      const wt = join(sandbox, `slot-${i}`, 'repo');
      await mkdir(dirname(wt), { recursive: true });
      await exec('git', ['worktree', 'add', '--detach', wt, 'HEAD'], { cwd: absRoot });
      worktrees.push(wt);
    }

    let cursor = 0;
    const validated = [];

    const runSlot = async (wt) => {
      while (validated.length < target) {
        const index = cursor;
        cursor += 1;
        if (index >= listed.candidates.length) break;
        const candidate = listed.candidates[index];
        const res = await validateCandidate(absRoot, wt, candidate, {
          timeoutMs: effectiveTimeout,
          exclude,
          promptMode,
        });
        if (res) {
          validated.push({ index, ...res });
        }
      }
    };

    await Promise.all(worktrees.map((wt) => runSlot(wt)));

    // Sort by commit history index so task selection is deterministic regardless
    // of which worker finished first.
    validated.sort((a, b) => a.index - b.index);
    const selected = validated.slice(0, target);

    await mkdir(tasksDir, { recursive: true });
    await mkdir(vaultRoot, { recursive: true, mode: 0o700 });
    // The hidden tests are the answer key: 0700 keeps every other local account out.
    // `mkdir` alone does not tighten a vault an earlier run created.
    await chmod(vaultRoot, 0o700).catch(() => {});

    // Mining is append-only (review 0003 Q48: `mineTasks(target 3)` once
    // deleted all 20 committed tasks and wrote 3 others). `replace` restores
    // the old "reflect exactly this history" semantics, and only it deletes.
    if (replace) {
      const existing = await readdir(tasksDir).catch(() => []);
      const keepNames = new Set(selected.map((entry) => `${entry.task.id}.json`));
      for (const name of existing) {
        if (name.endsWith('.json') && !keepNames.has(name)) {
          await rm(join(tasksDir, name), { force: true });
        }
      }
    }

    for (const entry of selected) {
      const taskPath = join(tasksDir, `${entry.task.id}.json`);
      // An id belongs to exactly one source commit. If a file with this id
      // holds a different commit, the 12-char prefix collided and guessing
      // which corpus the reader wants is worse than refusing.
      if (existsSync(taskPath) && !replace) {
        const prior = JSON.parse(await readFile(taskPath, 'utf8'));
        if (prior.sourceCommit !== entry.task.sourceCommit) {
          return {
            ok: false,
            applied: false,
            error: `id collision: ${taskPath} holds task from ${prior.sourceCommit}, mine produced ${entry.task.sourceCommit}; rerun with --replace to take over the corpus`,
          };
        }
      }
      // The miner is the writer, so it writes the schema a reader validates: a task file
      // that only becomes valid on load is a file two readers can disagree about.
      await writeFile(
        taskPath,
        `${JSON.stringify(normaliseTask(entry.task, { source: taskPath }), null, 2)}\n`,
        'utf8',
      );

      const taskVault = join(vaultRoot, entry.task.id);
      await mkdir(taskVault, { recursive: true, mode: 0o700 });
      await chmod(taskVault, 0o700).catch(() => {});
      await writeFile(join(taskVault, 'test.patch'), entry.testPatch);
      await writeFile(join(taskVault, 'gold.patch'), entry.goldPatch);
    }

    // The corpus records where it came from: which commit was HEAD when the
    // mine ran, the target, and the simt version that validated the tasks.
    // No timestamp — a re-mine at the same HEAD is byte-identical.
    const { stdout: headSha } = await exec('git', ['rev-parse', 'HEAD'], { cwd: absRoot });
    await writeFile(
      join(dirname(tasksDir), 'corpus.json'),
      `${JSON.stringify(
        { minedFrom: headSha.trim(), target, simtVersion: packageVersion() },
        null,
        2,
      )}\n`,
      'utf8',
    );

    return {
      ok: true,
      applied: true,
      root: absRoot,
      tasksDir,
      vaultRoot,
      candidatesCount: listed.candidates.length,
      tasks: selected.map((entry) => entry.task),
    };
  } finally {
    for (const wt of worktrees) {
      await exec('git', ['worktree', 'remove', '--force', wt], { cwd: absRoot }).catch(() => null);
    }
    await exec('git', ['worktree', 'prune'], { cwd: absRoot }).catch(() => null);
    await rm(sandbox, { recursive: true, force: true }).catch(() => null);
  }
}

function dedupeSorted(items) {
  return [...new Set(items)].sort();
}

function sameList(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
