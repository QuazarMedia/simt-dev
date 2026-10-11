// Publish simt-dev to all three channels from one machine, in the order they
// depend on: npm -> PyPI -> Homebrew.
//
// This is the manual twin of `.github/workflows/publish.yml` - for a machine
// that cannot run Actions (a free-tier month with no minutes left, a laptop,
// an air-gapped release). It is not a replacement for the workflow: it cannot
// mint the OIDC identity that PyPI's trusted publishing exchanges, so the PyPI
// step uploads with an API token instead. Everything else is the same three
// artefacts carrying the same bytes, in the same forced order.
//
// The order is not a preference (ADR-058): Homebrew downloads the npm tarball
// at install time, so a formula naming a version that is not live on the npm
// registry installs a 404. The brew step therefore fetches that tarball, and
// fails loudly if npm has not been published first.
//
// It is idempotent: each channel checks whether this version is already live
// and skips rather than failing, so a re-run after an interruption continues
// where it stopped. `--dry-run` performs every safe step - the wheel/tarball
// parity check, the registry checks, the build, the formula render - and stops
// before anything leaves the machine.
//
// Authentication is read from the environment, never stored here:
//   NPM_TOKEN    npm auth token (or be logged in with `npm login`)
//   PYPI_TOKEN   PyPI API token - trusted publishing is CI-only, so this step
//                needs a token (pypi.org -> your account -> API tokens). If unset,
//                twine falls back to ~/.pypirc, which keeps the token off this
//                command line.
//   TAP          the Homebrew tap to push to, as owner/repo
//   GITHUB_TOKEN token with write access to the tap (or rely on local git auth)
//
// pip is pointed at pypi.org explicitly: this machine's ambient pip config
// resolves to a private mirror that does not carry `build` or `twine`, and a
// publish that cannot install its own tooling is a publish that cannot finish.
// Override with SIMT_PIP_INDEX_URL if you need a different index.

import { exec, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const run = promisify(execFile);

const ROOT = join(import.meta.dirname, '..');
const TAP_DEFAULT = 'QuazarMedia/homebrew-tap';
const PIP_INDEX = process.env.SIMT_PIP_INDEX_URL ?? 'https://pypi.org/simple/';

function die(message) {
  process.stderr.write(`publish-local: ${message}\n`);
  process.exit(1);
}

/** A step label that reads the same in dry-run and live mode. */
function banner(label, dry) {
  process.stdout.write(`\n=== ${label}${dry ? ' (dry-run: no publish)' : ''} ===\n`);
}

/** The registry npm is configured to publish to, as a trailing-slash URL. */
async function npmRegistry() {
  const { stdout } = await run('npm', ['config', 'get', 'registry']);
  return stdout.trim() || 'https://registry.npmjs.org/';
}

/** `npm view name@version version`, or null when the version is not on the registry. */
async function npmLive(name, version) {
  try {
    const { stdout } = await run('npm', ['view', `${name}@${version}`, 'version']);
    return stdout.trim();
  } catch {
    return null;
  }
}

/** The PyPI JSON API answers 404 for a version that has never been uploaded. */
async function pypiLive(name, version) {
  try {
    const { stdout } = await execAsync(`curl -fsS -o /dev/null -w '%{http_code}' --max-time 20 https://pypi.org/pypi/${name}/${version}/json`);
    return stdout.trim() === '200';
  } catch {
    return false;
  }
}

/**
 * Poll a predicate until it is truthy or the deadline passes. A registry can
 * accept a publish (npm answers 202, twine returns 0) and then take minutes to
 * make the version visible; checking once and dying on that first 404 is a
 * false negative that strands the remaining channels. So wait, with a bound.
 */
async function waitFor(predicate, { intervalMs = 5000, timeoutMs = 180000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * One venv for the whole run, with `build` and `twine` installed from the
 * public index. A venv rather than the ambient interpreter because the ambient
 * one is whatever the machine ships - here an old system Python whose pip
 * resolves to a private mirror. Isolation is what makes the build reproducible.
 */
async function makeVenv() {
  const dir = await mkdtemp(join(tmpdir(), 'simt-publish-venv-'));
  await run('python3', ['-m', 'venv', dir]);
  const pip = join(dir, 'bin', 'pip');
  await execAsync(`${JSON.stringify(pip)} install -q --index-url ${PIP_INDEX} --upgrade pip build twine`, { cwd: ROOT });
  return { dir, python: join(dir, 'bin', 'python'), twine: join(dir, 'bin', 'twine') };
}

/** The one check that cannot be static: the wheel carries the tarball's bytes. */
async function verifyParity(env) {
  process.stdout.write('wheel/tarball parity: ');
  try {
    // verify-wheel.mjs builds both artefacts in its own temp venv; the pip index
    // override reaches it through the environment, since it passes process.env on.
    await run('node', ['scripts/verify-wheel.mjs'], { cwd: ROOT, env });
    process.stdout.write('ok\n');
  } catch {
    process.stdout.write('FAILED\n');
    die('the wheel and the tarball carry different bytes; fix the parity before publishing.');
  }
}

/** Build the sdist and wheel into `dist/` for the PyPI upload. */
async function buildDists(venv, env) {
  process.stdout.write('building sdist + wheel into dist/ ');
  await rm(join(ROOT, 'dist'), { recursive: true, force: true });
  // `build` creates its own isolated env and installs the backend (hatchling)
  // into it; that pip reads PIP_INDEX_URL from this environment, so the index
  // override must reach it or the build fetches the backend from the mirror.
  await execAsync(`${JSON.stringify(venv.python)} -m build`, { cwd: ROOT, env });
  process.stdout.write('ok\n');
}

async function publishNpm({ name, version, tag, dry }) {
  banner(`npm ${version}`, dry);
  if (await npmLive(name, version)) {
    process.stdout.write(`already live on npm; skipping\n`);
    return;
  }
  if (dry) {
    process.stdout.write(`would: npm publish --tag ${tag}\n`);
    return;
  }
  if (!process.env.NPM_TOKEN) {
    die('NPM_TOKEN is not set; export it or run `npm login` first.');
  }
  // The tag is explicit rather than implicit: this package reserved 1.0.0 as a
  // placeholder before the 0.x line, so npm will not auto-apply `latest` to a
  // lower version and refuses the publish. Naming the tag is how 0.1.x shipped,
  // and it is a no-op for a package with no higher reserved version.
  // A valid NPM_TOKEN is passed as the registry-specific config flag, which is
  // the highest-priority source npm consults - it outranks a stale token in
  // ~/.npmrc, which is exactly what shadows the NODE_AUTH_TOKEN env var and
  // turns a valid credential into a 401. NODE_AUTH_TOKEN is aligned to the same
  // value so every source agrees. With no NPM_TOKEN, fall through to npm's own
  // auth (a fresh `npm login`).
  const registry = await npmRegistry();
  const authArgs = process.env.NPM_TOKEN
    ? [`--${registry.replace(/^https?:/, '')}:_authToken=${process.env.NPM_TOKEN}`]
    : [];
  const npmEnv = process.env.NPM_TOKEN
    ? { ...process.env, NODE_AUTH_TOKEN: process.env.NPM_TOKEN }
    : process.env;
  process.stdout.write(`npm publish --tag ${tag}\n`);
  await run('npm', ['publish', '--tag', tag, ...authArgs], { cwd: ROOT, env: npmEnv });
  // npm answers 202 and propagates over a few minutes; wait rather than die on
  // the first pre-propagation 404.
  if (!(await waitFor(() => npmLive(name, version) !== null))) {
    die('npm accepted the publish (202) but the version did not become live within the wait window; check the npm registry.');
  }
  process.stdout.write(`simt-dev@${version} is live on npm (tag: ${tag})\n`);
}

async function publishPyPI({ name, version, venv, dry }) {
  banner(`PyPI ${version}`, dry);
  if (await pypiLive(name, version)) {
    process.stdout.write('already live on PyPI; skipping\n');
    return;
  }
  process.stdout.write('uploading with twine ');
  if (dry) {
    process.stdout.write('(dry-run: not uploading)\n');
    return;
  }
  // A PYPI_TOKEN env var is used directly. Otherwise twine falls back to
  // ~/.pypirc, the standard way a maintainer keeps the credential off the
  // command line and out of a transcript. Neither is enough: trusted publishing
  // is CI-only, so a manual upload must carry an API token one way or the other.
  const hasPypirc = Boolean(await stat(join(homedir(), '.pypirc')).catch(() => null));
  if (!process.env.PYPI_TOKEN && !hasPypirc) {
    die('no PyPI credential: set PYPI_TOKEN (pypi.org -> your account -> API tokens) or create ~/.pypirc.');
  }
  const twineEnv = process.env.PYPI_TOKEN
    ? { ...process.env, TWINE_USERNAME: '__token__', TWINE_PASSWORD: process.env.PYPI_TOKEN }
    : process.env;
  await run(venv.twine, ['upload', '--non-interactive', '--verbose', 'dist/*'], {
    cwd: ROOT,
    env: twineEnv,
  });
  // twine returns 0 on acceptance; PyPI propagates over a short delay. Wait for
  // it rather than die on the first 404, which would strand the Homebrew step.
  process.stdout.write('\nwaiting for PyPI to propagate ');
  if (!(await waitFor(() => pypiLive(name, version)))) {
    die('twine accepted the upload but the version did not appear on PyPI within the wait window; check the upload log.');
  }
  process.stdout.write('ok\n');
}

/**
 * Homebrew consumes what npm produced: fetch the live tarball, checksum it,
 * render the formula, and push it to the tap. A 404 here means npm has not
 * been published (or approved) yet, which is the ordering this whole path
 * exists to enforce.
 */
async function publishBrew({ name, version, tap, dry }) {
  banner(`Homebrew ${version}`, dry);

  const url = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
  const tgz = join(tmpdir(), `${name}-${version}.tgz`);
  let fetchable = true;
  try {
    await execAsync(`curl -fsSL --max-time 60 -o ${JSON.stringify(tgz)} ${url}`);
  } catch {
    fetchable = false;
  }

  // The formula's checksum is a hash of the live tarball, so it cannot be known
  // until npm has published. Before that point a dry run reports and moves on;
  // a live run is a hard failure, because a formula that cannot be checked is
  // a formula that installs a 404.
  if (!fetchable) {
    if (dry) {
      process.stdout.write('npm is not live yet; the formula is rendered at publish time. Re-run --only=brew once npm has published.\n');
      return;
    }
    die(`${url} is not downloadable - the npm channel must be live first. Publish it, then re-run.`);
  }

  const sha256 = createHash('sha256').update(await readFile(tgz)).digest('hex');
  await rm(tgz, { force: true });
  process.stdout.write(`tarball sha256 ${sha256.slice(0, 12)}…\n`);

  if (dry) {
    process.stdout.write('would: render Formula/simt-dev.rb and push it to the tap\n');
    return;
  }

  process.stdout.write('rendering Formula/simt-dev.rb ');
  await run('node', ['scripts/release-formula.mjs', `--version=${version}`, `--sha256=${sha256}`], { cwd: ROOT });
  process.stdout.write('ok\n');

  const formula = join(ROOT, 'Formula', 'simt-dev.rb');
  const tapDir = process.env.TAP_DIR;
  if (!tapDir || !(await stat(join(tapDir, 'Formula')).catch(() => null))) {
    die(`TAP_DIR must point at the cloned tap (it needs a Formula/ directory); set TAP_DIR=${TAP_DEFAULT} checkout.`);
  }

  await cp(formula, join(tapDir, 'Formula', 'simt-dev.rb'));
  const g = (args) => execAsync(`git ${args}`, { cwd: tapDir });
  await g('add Formula/simt-dev.rb');
  const { stdout } = await g('diff --cached --quiet; echo $?');
  if (stdout.trim() === '0') {
    process.stdout.write('the tap already has this version; nothing to push\n');
    return;
  }
  await g(`commit -m "simt-dev ${version}"`);
  if (process.env.GITHUB_TOKEN) {
    // Push through the token rather than the ambient credential, so a release
    // does not depend on whichever git identity happens to be signed in.
    await execAsync(
      `git push https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${tap}.git HEAD:main`,
      { cwd: tapDir },
    );
  } else {
    await g('push origin HEAD:main');
  }
  process.stdout.write(`pushed simt-dev ${version} to the ${tap} tap\n`);
}

function parseFlags(argv) {
  const flags = { dry: false, skipVerify: false, only: null, version: null, tag: 'latest' };
  for (const raw of argv) {
    if (raw === '--dry-run') flags.dry = true;
    else if (raw === '--skip-verify') flags.skipVerify = true;
    else if (raw.startsWith('--only=')) {
      const v = raw.slice('--only='.length);
      if (!['npm', 'pypi', 'brew'].includes(v)) die(`--only must be npm, pypi or brew, got ${v}`);
      flags.only = v;
    } else if (raw.startsWith('--version=')) {
      const v = raw.slice('--version='.length);
      if (!/^\d+\.\d+\.\d+$/.test(v)) die(`--version must be x.y.z, got ${v}`);
      flags.version = v;
    } else if (raw.startsWith('--tag=')) {
      flags.tag = raw.slice('--tag='.length);
    } else die(`unknown flag ${raw} (usage: --dry-run, --skip-verify, --only=<channel>, --version=x.y.z, --tag=<name>)`);
  }
  return flags;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const name = pkg.name;
  const version = flags.version ?? pkg.version;
  const tap = process.env.TAP ?? TAP_DEFAULT;

  const env = { ...process.env, PIP_INDEX_URL: PIP_INDEX };
  process.stdout.write(`simt-dev ${version} -> npm, PyPI, Homebrew (${tap})${flags.dry ? ' [DRY RUN]' : ''}\n`);

  let venv = null;
  try {
    if (!flags.skipVerify) await verifyParity(env);

    const wantPyPI = !flags.only || flags.only === 'pypi';
    if (wantPyPI) {
      venv = await makeVenv();
      await buildDists(venv, env);
    }

    if (!flags.only || flags.only === 'npm') await publishNpm({ name, version, tag: flags.tag, dry: flags.dry });
    if (wantPyPI) await publishPyPI({ name, version, venv, dry: flags.dry });
    if (!flags.only || flags.only === 'brew') await publishBrew({ name, version, tap, dry: flags.dry });

    process.stdout.write(`\ndone. ${name}@${version} ${flags.dry ? 'would be' : 'is'} on all three channels.\n`);
  } finally {
    if (venv) await rm(venv.dir, { recursive: true, force: true });
  }
}

// Guarded the way release-formula.mjs is: a test that imports this module must
// not run the publish with the test runner's argv.
const ENTRY_POINT = process.argv[1] ? new URL(import.meta.url).pathname === process.argv[1] : false;
if (ENTRY_POINT) {
  main().catch((err) => die(err.message));
}
