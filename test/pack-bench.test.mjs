// The bench's deep imports, resolved through the installed core.
//
// `pack-imports.test.mjs` proves the rewritten specifiers have keys in the exports map,
// by string comparison. Nothing imports them: a specifier whose entry is missing from
// `exports` still resolves when the package answers by its own name, because the
// self-reference and the checkout both read the same map, and a relative import
// resolves regardless of it. The only resolution that fails on a missing entry is the
// one a consumer performs — `simt-dev` from a node_modules that holds the tarball,
// not this checkout.
//
// So this file packs the core, builds the bench, installs both tarballs into a
// consumer with nothing else in it — tarball rather than directory, because npm
// symlinks a directory install and the bench's core imports would then resolve beside
// the source checkout (packages/bench/README.md) — and imports every exact deep export
// the bench uses, through that consumer's node_modules. A missing `exports` entry is a
// failure here and in no other test in the suite.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { after, before, test } from 'node:test';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The same discipline `pack.test.mjs` keeps: nothing outside the consumer may answer a
// question in this file, and every inherited `npm_config_*` is dropped so an install
// runs under the config a fresh shell reads, not the developer's home directory.
const NPM_HOME = mkdtempSync(join(tmpdir(), 'simt-dev-pack-bench-home-'));
const NO_ESTATE = {
  ...Object.fromEntries(
    Object.entries({ ...process.env, SIMT_DEV_WORKSPACE: 'off' }).filter(
      ([name]) => !/^npm_config_/i.test(name),
    ),
  ),
  npm_config_cache: join(NPM_HOME, 'cache'),
  npm_config_userconfig: join(NPM_HOME, 'npmrc'),
  npm_config_globalconfig: join(NPM_HOME, 'global-npmrc'),
  npm_config_update_notifier: 'false',
};

/** execFile that reports rather than throws; half of the assertions are on failure text. */
async function run(command, args, options = {}) {
  try {
    const { stdout, stderr } = await exec(command, args, { maxBuffer: 32 << 20, ...options });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (failure) {
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      out: `${failure.stdout ?? ''}${failure.stderr ?? failure}`,
    };
  }
}

let stage = '';

before(async () => {
  stage = await mkdtemp(join(tmpdir(), 'simt-dev-pack-bench-'));

  // The core, exactly as `npm pack` ships it.
  const corePack = join(stage, 'core-pack');
  await mkdir(corePack);
  const packed = await run('npm', ['pack', '--pack-destination', corePack], { cwd: PACKAGE_ROOT });
  assert.equal(packed.code, 0, `npm pack failed:\n${packed.out}`);
  // Not from stdout: npm interleaves `npm notice` lines with the filename.
  const coreTarballs = (await readdir(corePack)).filter((name) => name.endsWith('.tgz'));
  assert.deepEqual(coreTarballs.length, 1, `npm pack wrote ${coreTarballs.length} tarballs: ${coreTarballs}`);

  // The bench, built from the checkout and packed from the build output.
  const benchBuild = join(stage, 'bench-build');
  const built = await run(process.execPath, [join(PACKAGE_ROOT, 'scripts', 'build-bench-package.mjs'), benchBuild], {
    cwd: PACKAGE_ROOT,
    env: NO_ESTATE,
  });
  assert.equal(built.code, 0, `building the bench package failed:\n${built.out}`);
  const benchPack = join(stage, 'bench-pack');
  await mkdir(benchPack);
  const benchPacked = await run(
    'npm',
    ['pack', '--pack-destination', benchPack, benchBuild],
    { cwd: PACKAGE_ROOT, env: NO_ESTATE },
  );
  assert.equal(benchPacked.code, 0, `packing the bench build failed:\n${benchPacked.out}`);
  const benchTarballs = (await readdir(benchPack)).filter((name) => name.endsWith('.tgz'));
  assert.deepEqual(benchTarballs.length, 1, `npm pack wrote ${benchTarballs.length} tarballs: ${benchTarballs}`);

  // The consumer: both tarballs, nothing else, and no path back to the checkout.
  const consumer = join(stage, 'consumer');
  await mkdir(consumer);
  const installed = await run(
    'npm',
    [
      'install', '--no-save', '--no-audit', '--no-fund', '--offline',
      join(corePack, coreTarballs[0]),
      join(benchPack, benchTarballs[0]),
    ],
    { cwd: consumer, env: NO_ESTATE },
  );
  assert.equal(installed.code, 0, `installing both tarballs failed:\n${installed.out}`);

  // Every deep export the built bench imports, scanned from its shipped source —
  // the same scan `pack-imports.test.mjs` compares against the exports map.
  const specifiers = new Set();
  async function scan(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await scan(path);
      else if (entry.name.endsWith('.mjs')) {
        for (const match of (await readFile(path, 'utf8')).matchAll(/from 'simt-dev\/(src\/[^']+)'/g)) {
          specifiers.add(match[1]);
        }
      }
    }
  }
  await scan(join(benchBuild, 'src'));
  assert.ok(specifiers.size > 0, 'the built bench imports no simt-dev/src/ specifier: the scan found nothing to prove');

  // Import them all through the consumer's node_modules in one process.
  const script = [
    `const specifiers = ${JSON.stringify([...specifiers])};`,
    'for (const specifier of specifiers) {',
    `  try { await import('simt-dev/' + specifier); }`,
    '  catch (error) { console.error(specifier, error.message); process.exitCode = 1; }',
    '}',
  ].join('\n');
  const imported = await run(
    process.execPath,
    ['--input-type=module', '-e', script],
    { cwd: consumer, env: NO_ESTATE },
  );
  assert.equal(
    imported.code,
    0,
    `a deep export the bench uses does not resolve through the installed core:\n${imported.out}`,
  );
});

after(async () => {
  await rm(stage, { recursive: true, force: true });
  await rm(NPM_HOME, { recursive: true, force: true });
});

test('every exact deep export the bench uses resolves through the installed core', () => {
  // The work happens in `before`: it is one pipeline, and a test that asserts nothing
  // keeps the file honest about where the proof lives. A `before` failure fails the
  // suite with the exact specifiers that did not resolve.
});
