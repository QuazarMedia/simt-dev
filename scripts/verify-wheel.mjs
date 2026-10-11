// Build the wheel and prove it carries the bytes npm ships.
//
// This is the one check in this release path that cannot be static. The
// packaging tests assert that `force-include` and `files` NAME the same paths;
// this asserts that the paths, once built, contain the same CONTENT. Those are
// different questions and the first can pass while the second fails - a
// hatchling plugin, a stale build cache, an `__pycache__` directory in the
// tree, or a `.gitignore` rule that silently excludes a file the tarball had.
//
// It runs in the release workflow, where a Python and a registry are available
// by construction. It does NOT run in `npm test`: a test that needed `pip`
// would not run for the next person who clones this repository, and would run
// differently on the machine that wrote it, which is the failure ADR-031
// exists to prevent.
//
// The comparison is by content hash, not by size and not by list membership.
// A file that changed by one byte in one channel and not the other is exactly
// the defect this is here to catch, and matching sizes would miss it.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Contents of a `.tgz`, as `relative-path -> sha256 of the bytes`. */
async function hashTarball(tgz, prefix) {
  const dir = await mkdtemp(join(tmpdir(), 'verify-tgz-'));
  const out = join(dir, 'x');
  await mkdir(out);
  await exec('tar', ['-xzf', tgz, '-C', out]);
  const { stdout } = await exec('find', [out, '-type', 'f']);
  const map = new Map();
  for (const abs of stdout.split('\n').filter(Boolean)) {
    const rel = abs.slice(out.length + 1);
    if (!rel.startsWith(prefix)) continue;
    const bytes = await readFile(abs);
    map.set(rel.slice(prefix.length), createHash('sha256').update(bytes).digest('hex'));
  }
  await rm(dir, { recursive: true, force: true });
  return map;
}

/** Contents of a wheel's vendored tree, as `relative-path -> sha256`. */
async function hashWheelVendored(whl, prefix) {
  const dir = await mkdtemp(join(tmpdir(), 'verify-whl-'));
  const out = join(dir, 'x');
  await mkdir(out);
  // `unzip -q` rather than a hand-rolled zip reader: the wheel is a zip, and a
  // zip's directory is at the END of the file, which is where a partial upload
  // would show up first.
  await exec('unzip', ['-q', whl, '-d', out]);
  const { stdout } = await exec('find', [out, '-type', 'f']);
  const map = new Map();
  for (const abs of stdout.split('\n').filter(Boolean)) {
    const rel = abs.slice(out.length + 1);
    if (!rel.startsWith(prefix)) continue;
    const bytes = await readFile(abs);
    map.set(rel.slice(prefix.length), createHash('sha256').update(bytes).digest('hex'));
  }
  await rm(dir, { recursive: true, force: true });
  return map;
}

function differences(npmMap, wheelMap, compared) {
  const out = [];
  for (const path of compared) {
    if (!npmMap.has(path) && !wheelMap.has(path)) out.push(`  missing from BOTH:  ${path}`);
    else if (!npmMap.has(path)) out.push(`  only in wheel:    ${path}`);
    else if (!wheelMap.has(path)) out.push(`  only in npm:      ${path}`);
    else if (wheelMap.get(path) !== npmMap.get(path)) out.push(`  differs:           ${path}`);
  }
  // A file in the wheel that `files` does not name is also a problem: it means
  // the wheel ships something npm does not, which is the mirror of the same
  // defect and the direction that is easiest to introduce by accident.
  for (const path of wheelMap.keys()) {
    if (!compared.has(path)) out.push(`  wheel-only file:  ${path}`);
  }
  return out;
}

/** Every file under a directory, recursively, as paths relative to `root`. */
async function walk(dir) {
  const out = [];
  const { readdir } = await import('node:fs/promises');
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = entry.name;
    if (entry.isDirectory()) out.push(...(await walk(join(dir, rel))).map((p) => join(rel, p)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * The paths whose content must match, expanded from `package.json`'s `files`.
 *
 * Scoped deliberately. The npm tarball also contains `LICENSE` and
 * `README.md`, which npm adds to every tarball whether they are listed or not;
 * the wheel carries the same two as *distribution metadata* (in METADATA and
 * in `license`/`readme`), not as files. Comparing those made the first run of
 * this script report a difference that is not a defect - so the comparison is
 * of what `files` names, which is the content the tool itself reads, plus
 * `package.json`, which the tool reads `engines.node` out of.
 *
 * `files` names DIRECTORIES, not files - `bin`, `src`, `graph`, `rules`,
 * `docs/decisions` - and npm includes a directory recursively. Comparing the
 * directory names against the wheel's file paths made every one of them report
 * as missing from both, so the expansion happens here rather than at the
 * comparison.
 *
 * @param {string} packageJson the raw package.json
 * @param {string} root the repository root, to expand directories against
 * @returns {Promise<Set<string>>}
 */
async function runtimePaths(packageJson, root) {
  const pkg = JSON.parse(packageJson);
  const paths = new Set(['package.json']);
  for (const entry of pkg.files) {
    const abs = join(root, entry);
    const { stat } = await import('node:fs/promises');
    const info = await stat(abs).catch(() => null);
    if (info?.isDirectory()) {
      for (const file of await walk(abs)) paths.add(`${entry}/${file}`);
    } else {
      paths.add(entry);
    }
  }
  return paths;
}

const root = join(import.meta.dirname, '..');
const staging = await mkdtemp(join(tmpdir(), 'verify-release-'));
const compared = await runtimePaths(await readFile(join(root, 'package.json'), 'utf8'), root);

try {
  console.log('building the npm tarball');
  await exec('npm', ['pack', '--pack-destination', staging], { cwd: root });
  const tgz = join(staging, (await exec('ls', [staging], { cwd: root })).stdout.split('\n').find((f) => f.endsWith('.tgz')));

  console.log('building the wheel');
  const build = join(staging, 'py');
  await mkdir(build);
  // A venv, not the ambient interpreter: the ambient python is whatever the
  // runner ships, and a wheel built by one interpreter is not the wheel a
  // maintainer would build by another. `--no-isolation` is NOT used - isolation
  // is what makes the build reproducible.
  await exec('python3', ['-m', 'venv', build]);
  const pip = join(build, 'bin', 'pip');
  await exec(pip, ['install', '-q', '--upgrade', 'pip', 'build'], { env: process.env });
  await exec(join(build, 'bin', 'python'), ['-m', 'build', '--outdir', build], { cwd: root });
  const { stdout: built } = await exec('ls', [build]);
  const whl = join(build, built.split('\n').find((f) => f.endsWith('.whl')));

  console.log(`hashing ${basename(tgz)} and ${basename(whl)}`);
  const npmMap = await hashTarball(tgz, 'package/');
  const wheelMap = await hashWheelVendored(whl, 'simt_dev/vendored/');

  const problems = differences(npmMap, wheelMap, compared);
  if (problems.length > 0) {
    console.error(`the wheel and the tarball carry different bytes (${npmMap.size} in npm, ${wheelMap.size} in wheel):`);
    console.error(problems.join('\n'));
    console.error('');
    console.error('  REMEDY: `force-include` in pyproject.toml and `files` in package.json must name the');
    console.error('  same paths, and the paths must contain the same content. A file present in one');
    console.error('  and absent in the other is a release where the two channels answer differently.');
    process.exit(1);
  }

  console.log(`OK ${compared.size} paths identical across npm and PyPI`);
  for (const path of [...compared].sort()) {
    if (npmMap.has(path)) console.log(`  ${npmMap.get(path).slice(0, 12)}  ${path}`);
    else console.log(`  ${'(missing)'.padEnd(12)}  ${path}`);
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}
