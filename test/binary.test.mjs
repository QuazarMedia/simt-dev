// The binary channel: a release asset that runs with no Node on PATH.
//
// The npm, PyPI and Homebrew channels are covered by packaging.test.mjs. This
// file covers the fourth: a single-file executable built from the same shipped
// file set, published beside its siblings in the GitHub release, and installed
// into a repository's .simt/bin by a one-line download.
//
// Most of what follows is static - checkable from this checkout with no network
// and no build, in the same spirit as packaging.test.mjs. The one check that
// cannot be static - running the built bytes against a Gradle fixture with no
// Node on PATH, which is the acceptance criterion for the channel (ADR-098) -
// runs when the host is a release target and nodejs.org is reachable, and is
// skipped rather than failed when either is missing: a contributor on an
// unsupported host must still get a green suite.

import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import test from 'node:test';

import { renderWorkflow } from '../src/ci/workflow.mjs';
import { renderShim } from '../src/hooks/shim.mjs';
import {
  TARGETS,
  LOCAL_BIN,
  LOCAL_BIN_DIR,
  assetName,
  assetNameExpr,
  releaseBase,
  releaseUrl,
  localInstall,
} from '../src/distribute/release.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const buildScript = await readFile(new URL('../scripts/build-sea.mjs', import.meta.url), 'utf8');

/** The node floor, as `major.minor.patch`, from the engines range. */
function enginesFloor() {
  const m = />=\s*([\d.]+)/.exec(pkg.engines.node);
  assert.ok(m, 'package.json must pin a node floor');
  return m[1];
}

// ---------------------------------------------------------------------------
// The channel facts: one module, three rendered surfaces
// ---------------------------------------------------------------------------

test('binary: the release builds exactly the platforms a remedy can name', () => {
  // The locator's remedy downloads from this list at runtime; a platform here
  // that the release does not build is a remedy that fetches a 404, and one
  // missing is a machine whose remedy cannot name its own asset.
  assert.deepEqual(TARGETS, ['darwin-arm64', 'darwin-x64', 'linux-x64']);
});

test('binary: the asset name is the package name plus version plus target', () => {
  // The build script, the CI step and the formula all name assets from this one
  // function. The package name, not the command: it sits beside the npm tarball
  // `simt-dev-0.5.0.tgz`, where one name for the project is what a reader
  // matching names expects.
  for (const target of TARGETS) {
    assert.equal(assetName('1.2.3', target), `simt-dev-1.2.3-${target}`);
  }
  assert.throws(() => assetName('1.2.3', 'win32-x64'), /unknown target/);
});

test('binary: the URL a surface renders is the one the release serves', () => {
  // The remedy, the CI step and the formula render URLs from releaseBase and
  // assetName. A URL rendered here that the release does not serve is a
  // download of nothing, with an error message that blames the reader.
  for (const target of TARGETS) {
    const url = releaseUrl('1.2.3', target);
    assert.equal(url, `${releaseBase('1.2.3')}/${assetName('1.2.3', target)}`);
    assert.match(url, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/v1\.2\.3\//);
  }
});

test('binary: the runtime-derived name completes to a published asset', () => {
  // The remedy and the CI step cannot know the platform where their text was
  // written, so they derive it from uname or the runner and complete
  // assetNameExpr there. If that completion ever produced a name the release
  // does not publish, the download would 404 on exactly the machines the list
  // exists to cover.
  for (const target of TARGETS) {
    const [os, arch] = target.split('-');
    const completed = assetNameExpr('1.2.3').replaceAll('$os', os).replaceAll('$arch', arch);
    assert.equal(completed, assetName('1.2.3', target), `the shell completion for ${target} is not a published asset`);
  }
});

test('binary: the repository-local path is beneath .simt, named for the command', () => {
  // The locator checks this path before PATH, so a repository's pinned bytes
  // are the bytes its gate runs. It must sit with the tool's other per-repo
  // state, and be named for what the reader types.
  assert.equal(LOCAL_BIN_DIR, '.simt/bin');
  assert.equal(LOCAL_BIN, `${LOCAL_BIN_DIR}/simt`);
});

test('binary: the one-line install is copy-paste safe', () => {
  // The remedy renders this into an error message a reader copies. A newline
  // would split the copy; a single quote would terminate the locator's own
  // quoting of the remedy (src/locate.mjs refuses to render one); a URL baked
  // for one platform would 404 for the colleague who clones the shim.
  const line = localInstall('1.2.3');
  assert.ok(!line.includes('\n'), 'the install must be one line');
  assert.ok(!line.includes("'"), 'a single quote would break the locator\'s quoting of the remedy');
  assert.ok(line.includes(releaseBase('1.2.3')), 'the install must fetch from the release');
  assert.ok(line.includes(assetNameExpr('1.2.3')), 'the install must complete the asset name at runtime');
  assert.ok(line.includes(`-o ${LOCAL_BIN}`), 'the install must land where the locator looks');
  assert.match(line, /uname -s/, 'the platform must be derived, not baked in');
});

// ---------------------------------------------------------------------------
// The generated CI install step: run it, not just read it
// ---------------------------------------------------------------------------

const STEP_HEADER = '      - name: install the pinned gate binary';

/**
 * The install step's shell script, extracted from the rendered workflow.
 *
 * Extracted rather than restated: a test that restates the step cannot catch the
 * step drifting from the workflow, and a restated copy would pass while the YAML
 * shipped something else.
 */
function installStepScript() {
  const lines = renderWorkflow({ npm: false }).split('\n');
  const start = lines.indexOf(STEP_HEADER);
  assert.ok(start !== -1, 'the rendered workflow has no binary install step');
  const runAt = lines.findIndex((line, i) => i > start && line === '        run: |');
  assert.ok(runAt !== -1, 'the install step has no run block');
  const body = [];
  for (let i = runAt + 1; i < lines.length && lines[i].startsWith('          '); i += 1) {
    body.push(lines[i].slice(10));
  }
  return `${body.join('\n')}\n`;
}

/**
 * Run the step with stub `uname`, `curl` and `openssl`, and report what it did:
 * the URLs it fetched, the directory it worked in, and the finished process.
 *
 * `served` is the sha256 the release is pretending to serve; `verified` is what
 * the local hashing step reports. They differ in the refusal case.
 */
async function runInstallStep({ served, verified }) {
  const script = installStepScript();
  // A GitHub expression reaching the shell is a command substitution trying to
  // EXECUTE its substituted value - `os=$('${{ runner.os }}' | …)` runs the
  // command `Linux` - which `set -eu` refuses. The step once rendered exactly
  // that, and no pattern-match assertion noticed.
  assert.ok(!script.includes('${{'), 'a workflow expression reached the install step shell');

  const dir = await mkdtemp(path.join(tmpdir(), 'simt-ci-step-'));
  const stubBin = path.join(dir, 'stub-bin');
  const work = path.join(dir, 'work');
  await mkdir(stubBin, { recursive: true });
  await mkdir(work, { recursive: true });
  const stub = async (name, text) => {
    const file = path.join(stubBin, name);
    await writeFile(file, text);
    await chmod(file, 0o755);
  };
  await stub('uname', '#!/bin/sh\ncase "$1" in\n  -s) echo Linux ;;\n  -m) echo x86_64 ;;\nesac\n');
  await stub('openssl', `#!/bin/sh\necho '${verified}  "$2"'\n`);
  await stub(
    'curl',
    `#!/bin/sh
out=
url=
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift; out="$1" ;;
    -fsSL) ;;
    *) url="$1" ;;
  esac
  shift
done
echo "$url" >> "$LOG"
case "$url" in
  *.sha256)
    if [ -n "$out" ]; then printf '%s  %s\\n' '${served}' "$(basename "$url")" > "$out"
    else printf '%s  %s\\n' '${served}' "$(basename "$url")"; fi ;;
  *) printf 'fake binary payload\\n' > "$out" ;;
esac
`,
  );
  const log = path.join(dir, 'curl.log');
  await writeFile(path.join(dir, 'step.sh'), script);
  const result = spawnSync('/bin/sh', [path.join(dir, 'step.sh')], {
    cwd: work,
    env: { PATH: `${stubBin}:${process.env.PATH}`, LOG: log },
    encoding: 'utf8',
  });
  const urls = (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  return { result, work, urls, dir };
}

test('binary: the generated CI install step runs, and fetches this machine\'s asset', async () => {
  // The step is the whole of S35's consumer CI for a repository without npm, so
  // it is executed and judged by what it did: derived the platform in the shell,
  // fetched the asset and the .sha256 beside it, verified the two against each
  // other, and installed the bytes where the locator looks for them.
  const sha = 'a'.repeat(64);
  const run = await runInstallStep({ served: sha, verified: sha });
  try {
    assert.equal(run.result.status, 0, `the install step failed:\n${run.result.stderr}`);
    const installed = path.join(run.work, LOCAL_BIN);
    assert.ok(existsSync(installed), 'the step installed nothing');
    assert.ok((await stat(installed)).mode & 0o100, 'the installed binary is not executable');
    assert.equal(await readFile(installed, 'utf8'), 'fake binary payload\n');
    const asset = assetName(pkg.version, 'linux-x64');
    assert.deepEqual(run.urls, [`${releaseBase(pkg.version)}/${asset}`, `${releaseBase(pkg.version)}/${asset}.sha256`]);
  } finally {
    await rm(run.dir, { recursive: true, force: true });
  }
});

test('binary: the generated CI install step refuses bytes that do not match the published sha256', async () => {
  // The published checksum is the only thing standing between a tampered or
  // half-uploaded asset and somebody's gate job. An install that proceeds
  // anyway is worse than one that fails, because it runs bytes nobody verified.
  const run = await runInstallStep({ served: 'a'.repeat(64), verified: 'b'.repeat(64) });
  try {
    assert.notEqual(run.result.status, 0, 'a tampered asset passed the checksum step');
    assert.match(run.result.stderr, /checksum mismatch/);
    assert.ok(!existsSync(path.join(run.work, LOCAL_BIN)), 'the step installed a binary it refused to verify');
  } finally {
    await rm(run.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The build: pinned inputs, one source of truth for the output name
// ---------------------------------------------------------------------------

test('binary: the build pins the node floor, not a newer runtime', () => {
  // The SEA base is an official node binary downloaded per target. Pinning a
  // version above the engines floor would ship a runtime the package does not
  // declare; below it, a runtime that violates the declaration. The floor is
  // the only version both statements are true of.
  const pin = /const NODE_VERSION = 'v([\d.]+)'/m.exec(buildScript);
  assert.ok(pin, 'the build script must pin its node base');
  assert.equal(pin[1], enginesFloor(), 'the SEA base must be the engines floor');
});

test('binary: the build names its output from the channel facts', () => {
  // The asset name is rendered by src/distribute/release.mjs. If the build
  // script spelled it a second way, the release would publish bytes under a
  // name no remedy, CI step or formula fetches.
  assert.match(buildScript, /import\s*\{[^}]*\bTARGETS\b[^}]*\bassetName\b[^}]*\}\s*from\s*'\.\.\/src\/distribute\/release\.mjs'/);
});

test('binary: the bootstrap materializes real files, then imports the entry', () => {
  // The bootstrap is the whole self-extraction: it writes the shipped file set
  // to a per-node-version, per-digest cache directory and imports bin/simt.mjs
  // from there. Real files at real paths are what make every import.meta.url
  // root computation in src/ work unmodified - a bootstrap that inlined the
  // tool instead would have to re-implement each one.
  //
  // The template is extracted rather than pattern-matched against the whole
  // script, because the invariants below are about the generated text alone.
  const start = buildScript.indexOf('function renderBootstrap');
  const open = buildScript.indexOf('return `', start);
  const template = buildScript.slice(open + 'return `'.length, buildScript.indexOf('`;', open));

  assert.match(template, /path\.join\(dir, 'bin', 'simt\.mjs'\)/, 'the bootstrap must import the real entry point');
  assert.match(template, /process\.version, DIGEST/, 'the cache must be keyed by runtime and payload');
  assert.match(template, /'\.digest'/, 'the materialization must be idempotent by marker');
  // Node v22 runs the SEA entry as CommonJS (node_sea.cc: LoadSingleExecutable
  // Application calls run_cjs unconditionally), so the bootstrap is CJS even
  // though the tool it imports is ESM. An `import` at its top level would be a
  // SyntaxError on every run of every binary this script builds.
  assert.match(template, /'use strict'/, 'the bootstrap must be CJS');
  assert.ok(!/^\s*import\s/m.test(template), 'the bootstrap must not use ESM imports');
});

test('binary: darwin binaries are codesigned after injection', () => {
  // postject rewrites the Mach-O and strips its signature; an unsigned binary
  // is killed on first run, with a dialog that names neither the tool nor the
  // fix. Ad-hoc signing is the whole of what a release asset can carry.
  assert.match(buildScript, /'codesign',\s*\['--force',\s*'-s',\s*'-'/, 'the build must ad-hoc sign darwin binaries');
});

test('binary: build outputs are gitignored', async () => {
  // The build writes multi-hundred-megabyte node bases and final binaries. If
  // either directory were tracked, a build on a contributor's machine would
  // stage them, and the release asset would be committed twice under two names.
  const gitignore = await readFile(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.match(gitignore, /^dist\/$/m);
  assert.match(gitignore, /^\.sea-cache\/$/m);
});

// ---------------------------------------------------------------------------
// The acceptance criterion: a Gradle fixture, no Node on PATH
// ---------------------------------------------------------------------------

/** The release target for this machine, or null when the host builds nothing. */
function hostTarget() {
  const map = { darwin: 'darwin', linux: 'linux' };
  const os = map[process.platform];
  if (!os) return null;
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
  return arch ? `${os}-${arch}` : null;
}

/** A PATH that contains no node: the current one, minus any directory that has one. */
function pathWithoutNode() {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return dirs.filter((dir) => !existsSync(path.join(dir, 'node'))).join(path.delimiter);
}

async function networkAvailable() {
  try {
    const res = await fetch('https://nodejs.org/dist/index.json', { signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch {
    return false;
  }
}

test('binary: the built bytes run a Gradle fixture with no Node on PATH', { timeout: 15 * 60_000 }, async (t) => {
  const target = hostTarget();
  if (!target) return t.skip('this host is not a release target');
  if (!(await networkAvailable())) return t.skip('nodejs.org is unreachable; the build cannot fetch its base');

  const dist = path.join(ROOT, 'dist');
  const bin = path.join(dist, assetName(pkg.version, target));
  if (!existsSync(bin)) {
    t.diagnostic(`building ${assetName(pkg.version, target)} (first run downloads the node base)`);
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-sea.mjs'), target], { stdio: 'inherit' });
  }
  assert.ok(existsSync(bin), 'the build produced no binary');

  // The published checksum is part of the contract: a mismatch means the bytes
  // on disk are not the bytes the release would serve.
  const published = (await readFile(bin + '.sha256', 'utf8')).trim().split(/\s+/)[0];
  const actual = createHash('sha256').update(await readFile(bin)).digest('hex');
  assert.equal(actual, published, 'the binary does not match its published sha256');

  const env = { ...process.env, PATH: pathWithoutNode() };
  assert.ok(env.PATH.split(path.delimiter).every((dir) => !existsSync(path.join(dir, 'node'))), 'the PATH still contains a node');

  const versionOut = spawnSync(bin, ['--version'], { env, encoding: 'utf8' });
  assert.equal(versionOut.status, 0, `--version failed: ${versionOut.stderr}`);
  assert.match(versionOut.stdout.trim(), new RegExp(`^simt-dev ${pkg.version}$`));

  // The fixture is a repository the tool detects as Gradle: one build file,
  // nothing else. `check` must run to completion from the release binary -
  // the bytes a repository without npm pins - and report its findings.
  const fixture = await mkdtemp(path.join(tmpdir(), 'simt-sea-'));
  try {
    execFileSync('mkdir', ['-p', path.join(fixture, 'app')]);
    await writeFile(path.join(fixture, 'app', 'build.gradle'), 'plugins { id "com.android.application" }\n');

    // The fixture is a repository the tool detects as Gradle: one build file,
    // nothing else. `check` must run to completion from the release binary -
    // the bytes a repository without npm pins. A bare fixture has findings, so
    // the gate is red by construction: exit 1 with a report is the tool
    // working; a crash or an empty run is what this test exists to catch.
    const check = spawnSync(bin, ['check'], { cwd: fixture, env, encoding: 'utf8' });
    assert.equal(check.status, 1, `check did not run the gate:\n${check.stdout}\n${check.stderr}`);
    assert.match(check.stdout, /ABSENT\s+AGENTS\.md/, 'check reported nothing about the fixture');
    assert.ok(!/SyntaxError|ERR_MODULE_NOT_FOUND/.test(check.stderr), `the binary crashed: ${check.stderr}`);

    // The hook path is the one that runs on an agent's hot path: it must start
    // and answer from the release binary too.
    const hook = spawnSync(bin, ['agent-hook', 'pre-tool-use', '--harness', 'cursor'], { cwd: fixture, env, encoding: 'utf8' });
    assert.equal(hook.status, 0, `agent-hook failed: ${hook.stderr}`);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('binary: the hook shim hands over to the binary the repository downloaded, with no Node on PATH', async () => {
  // The other half of the acceptance criterion, literal: the shim a repository
  // without npm installs runs. The stub proves the resolution the locator was
  // given - the repository's own `.simt/bin` copy, ahead of PATH, with every
  // directory containing a node stripped out - and the second run proves the
  // failure the branch exists to replace: no copy, no fallback, no pass.
  const fixture = await mkdtemp(path.join(tmpdir(), 'simt-shim-'));
  try {
    const local = path.join(fixture, LOCAL_BIN);
    await mkdir(path.dirname(local), { recursive: true });
    await writeFile(local, '#!/bin/sh\necho "stub "$@\n');
    await chmod(local, 0o755);
    const shim = path.join(fixture, '.simt-hooks', 'pre-commit');
    await mkdir(path.dirname(shim), { recursive: true });
    await writeFile(shim, renderShim('pre-commit', { npm: false }));
    await chmod(shim, 0o755);

    const env = { ...process.env, PATH: pathWithoutNode() };
    const run = spawnSync('/bin/sh', [shim], { cwd: fixture, env, encoding: 'utf8' });
    assert.equal(run.status, 0, `the shim did not hand over:\n${run.stderr}`);
    const prefix = 'stub hooks run pre-commit --root ';
    assert.ok(run.stdout.startsWith(prefix), `the shim ran the wrong program: ${run.stdout}`);
    // The shim derives ROOT with `git rev-parse … || pwd`, and macOS resolves
    // the temp path through a symlink; compare physically.
    assert.equal(realpathSync(run.stdout.trim().slice(prefix.length)), realpathSync(fixture));

    await rm(local, { force: true });
    const refused = spawnSync('/bin/sh', [shim], { cwd: fixture, env, encoding: 'utf8' });
    assert.notEqual(refused.status, 0, 'the shim passed with no dispatcher to run');
    assert.match(refused.stderr, /cannot locate/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
