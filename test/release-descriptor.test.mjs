// One release, resolved once (review 0005 PR27).
//
// The behaviour that matters is not "the workflow runs" - it cannot run here - but
// that resolution has one answer, that promotion refuses a world that moved, and that
// a retry after a partial promotion is safe. The rehearsal fixture directory is the
// same shape the script reads in production, so a case this file covers is a case a
// maintainer can reproduce with `--simulate`.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  checkDescriptor,
  descriptorId,
  digestOf,
  evidenceLines,
  formulaChecksums,
  parseRequest,
  promotionStep,
  resolveRelease,
  verifyRelease,
} from '../src/distribute/descriptor.mjs';
import { TARGETS, assetName, releaseUrl } from '../src/distribute/release.mjs';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'release-descriptor.mjs');
const VERSION = '0.7.0';
const COMMIT = 'a'.repeat(40);

/** A complete, consistent estate. Every case below departs from it in one place. */
function estate(overrides = {}) {
  const assetBytes = (target) => Buffer.from(`binary for ${target}\n`);
  const probe = {
    latestVersion: async () => VERSION,
    npmHas: async () => true,
    tagCommit: async () => COMMIT,
    asset: async (version, target) => assetBytes(target),
    tapFormula: async () => null,
    ...overrides,
  };
  return { probe, assetBytes };
}

async function resolved(overrides) {
  const { probe } = estate(overrides);
  const { descriptor, errors } = await resolveRelease(VERSION, probe);
  assert.deepEqual(errors, []);
  assert.ok(descriptor);
  return descriptor;
}

test('descriptor: the version input is a concrete release or a request, never text', () => {
  assert.deepEqual(parseRequest(''), { request: 'latest', version: null, error: null });
  assert.deepEqual(parseRequest('latest'), { request: 'latest', version: null, error: null });
  assert.equal(parseRequest(' 0.7.0 ').version, '0.7.0');
  assert.equal(parseRequest('0.7.0-rc.1').version, '0.7.0-rc.1');
  for (const bad of ['v0.7.0', '^0.7.0', '0.7', 'latest; rm -rf /', '0.7.0\n0.8.0', '$(id)']) {
    const parsed = parseRequest(bad);
    assert.equal(parsed.version, null, `${bad} was accepted as a version`);
    assert.match(parsed.error, /not a concrete x\.y\.z release/);
  }
});

test('descriptor: one explicit release resolves to version, commit and every asset digest', async () => {
  const descriptor = await resolved();
  assert.equal(descriptor.version, VERSION);
  assert.equal(descriptor.tag, `v${VERSION}`);
  assert.equal(descriptor.commit, COMMIT);
  assert.deepEqual(
    descriptor.assets.map((asset) => asset.target),
    TARGETS,
  );
  for (const target of TARGETS) {
    const asset = descriptor.assets.find((a) => a.target === target);
    assert.equal(asset.name, assetName(VERSION, target));
    assert.equal(asset.url, releaseUrl(VERSION, target));
    assert.equal(asset.sha256, digestOf(Buffer.from(`binary for ${target}\n`)));
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(descriptor.id, descriptorId(descriptor));
  assert.equal(descriptor.id, (await resolved()).id, 'the same release has two ids');
});

test('descriptor: latest is resolved from the registry exactly once', async () => {
  let reads = 0;
  const { probe } = estate({
    latestVersion: async () => {
      reads += 1;
      return VERSION;
    },
  });
  const { descriptor, errors } = await resolveRelease('latest', probe);
  assert.deepEqual(errors, []);
  assert.equal(reads, 1);
  assert.equal(descriptor.version, VERSION);
});

test('descriptor: a missing tag names the tag and the workflow that creates it', async () => {
  const { probe } = estate({ tagCommit: async () => null });
  const { descriptor, errors } = await resolveRelease(VERSION, probe);
  assert.equal(descriptor, null);
  assert.match(errors.join('\n'), /tag v0\.7\.0 is not on the remote/);
  assert.match(errors.join('\n'), /publish\.yml/);
});

test('descriptor: a staged npm version is refused with the approval it needs', async () => {
  const { probe } = estate({ npmHas: async () => false });
  const { descriptor, errors } = await resolveRelease(VERSION, probe);
  assert.equal(descriptor, null);
  assert.match(errors.join('\n'), /not on the npm registry/);
  assert.match(errors.join('\n'), /npm stage approve/);
});

test('descriptor: an undownloadable asset is a partial release, named per target', async () => {
  const { probe } = estate({
    asset: async (version, target) => {
      if (target === 'linux-x64') throw new Error('404');
      return Buffer.from(`binary for ${target}\n`);
    },
  });
  const { descriptor, errors } = await resolveRelease(VERSION, probe);
  assert.equal(descriptor, null);
  assert.match(errors.join('\n'), /linux-x64/);
  assert.match(errors.join('\n'), /not downloadable/);
  assert.ok(!errors.join('\n').includes('darwin-arm64'), 'the assets that resolved were reported as failures');
});

test("descriptor: the tap is checked against the release's bytes when it names this version", async () => {
  const { probe, assetBytes } = estate();
  const good = TARGETS.map(
    (target) =>
      `    url "${releaseUrl(VERSION, target)}"\n    sha256 "${digestOf(assetBytes(target))}"`,
  ).join('\n');
  const agrees = await resolveRelease(VERSION, { ...probe, tapFormula: async () => good });
  assert.deepEqual(agrees.errors, []);
  assert.deepEqual([...formulaChecksums(good, VERSION).keys()].sort(), TARGETS.slice().sort());

  const wrong = good.replace(digestOf(assetBytes('linux-x64')), 'f'.repeat(64));
  const disagrees = await resolveRelease(VERSION, { ...probe, tapFormula: async () => wrong });
  assert.equal(disagrees.descriptor, null);
  assert.match(disagrees.errors.join('\n'), /the formula and the asset disagree/);
});

test('descriptor: a recheck refuses a release whose world moved', async () => {
  const descriptor = await resolved();

  const moved = await verifyRelease(descriptor, {
    ...estate().probe,
    latestVersion: async () => '0.8.0',
  });
  assert.equal(moved.ok, false);
  assert.match(moved.errors.join('\n'), /moved from 0\.7\.0 to 0\.8\.0/);

  const bytes = await verifyRelease(descriptor, {
    ...estate().probe,
    asset: async (version, target) => Buffer.from(`clobbered ${target}\n`),
  });
  assert.equal(bytes.ok, false);
  assert.match(bytes.errors.join('\n'), /not the resolved bytes/);

  const gone = await verifyRelease(descriptor, {
    ...estate().probe,
    tagCommit: async () => null,
  });
  assert.equal(gone.ok, false);
  assert.match(gone.errors.join('\n'), /now resolves to \(nothing\)/);

  const tap = await verifyRelease(descriptor, {
    ...estate().probe,
    tapFormula: async () => `    url "${releaseUrl(VERSION, 'linux-x64')}"\n    sha256 "${'f'.repeat(64)}"`,
  });
  assert.equal(tap.ok, false, 'the recheck ignored a tap that disagrees with the release');
  assert.match(tap.errors.join('\n'), /formula and the asset disagree/);

  assert.deepEqual(await verifyRelease(descriptor, estate().probe), { ok: true, errors: [] });
});

test('descriptor: a retry skips what is published and refuses different bytes', async () => {
  const descriptor = await resolved();
  assert.equal(promotionStep(null, descriptor).action, 'publish');
  assert.equal(promotionStep({ version: '0.6.0', sha256: null }, descriptor).action, 'publish');
  assert.equal(promotionStep({ version: VERSION, sha256: descriptor.id }, descriptor).action, 'skip');
  const conflict = promotionStep({ version: VERSION, sha256: 'b'.repeat(64) }, descriptor);
  assert.equal(conflict.action, 'conflict');
  assert.match(conflict.reason, /different bytes/);
});

test('descriptor: a descriptor that was edited after resolution is refused', async () => {
  const descriptor = await resolved();
  const tampered = {
    ...descriptor,
    assets: descriptor.assets.map((asset) =>
      asset.target === 'linux-x64' ? { ...asset, sha256: '0'.repeat(64) } : asset,
    ),
  };
  assert.match(checkDescriptor(tampered).join('\n'), /id does not match its contents/);
  assert.match(checkDescriptor({ ...descriptor, schema: 99 }).join('\n'), /schema 99/);
  assert.match(checkDescriptor({ ...descriptor, commit: 'nope' }).join('\n'), /names no commit/);
});

test('descriptor: the evidence block names every asset digest, stably', async () => {
  const descriptor = await resolved();
  const lines = evidenceLines(descriptor);
  assert.equal(lines[0], `release     simt-dev ${VERSION}`);
  assert.equal(lines[1], `commit      ${COMMIT}`);
  for (const asset of descriptor.assets) {
    assert.ok(lines.some((line) => line.includes(asset.name) && line.includes(asset.sha256)));
  }
  assert.equal(lines.at(-1), `descriptor  ${descriptor.id}`);
  assert.deepEqual(evidenceLines(await resolved()), lines);
});

// ---------------------------------------------------------------------------
// The script: the same rehearsal a maintainer runs, against a directory.

async function fixture(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'release-descriptor-'));
  await mkdir(join(dir, 'assets'), { recursive: true });
  const versions = overrides.versions ?? [VERSION];
  await writeFile(join(dir, 'npm-version.txt'), overrides.latest ?? VERSION);
  await writeFile(join(dir, 'npm.json'), JSON.stringify({ versions }));
  const tags = overrides.tags ?? { [VERSION]: COMMIT };
  await writeFile(join(dir, 'tags.json'), JSON.stringify(tags));
  for (const target of TARGETS) {
    if (overrides.missing === target) continue;
    await writeFile(join(dir, 'assets', assetName(VERSION, target)), `binary for ${target}\n`);
  }
  if (overrides.tap) await writeFile(join(dir, 'tap.rb'), overrides.tap);
  return dir;
}

async function script(dir, args, env = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      maxBuffer: 8 << 20,
      env: { ...process.env, NO_COLOR: '1', ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('script: a simulated dry run writes the descriptor and the job outputs', async () => {
  const dir = await fixture();
  const out = join(dir, 'release', 'descriptor.json');
  const outputs = join(dir, 'github-output');
  try {
    const run = await script(dir, [`--simulate=${dir}`, '--request=latest', `--out=${out}`, '--print'], {
      GITHUB_OUTPUT: outputs,
    });
    assert.equal(run.code, 0, run.stderr);
    const descriptor = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(descriptor.version, VERSION);
    assert.match(run.stdout, new RegExp(`release     simt-dev ${VERSION}`));
    const written = await readFile(outputs, 'utf8');
    assert.match(written, new RegExp(`^version=${VERSION}$`, 'm'));
    assert.match(written, new RegExp(`^commit=${COMMIT}$`, 'm'));
    assert.match(written, new RegExp(`^descriptor=\\{.*"version":"${VERSION}".*\\}$`, 'm'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('script: a moving latest fails the recheck instead of promoting two releases', async () => {
  const dir = await fixture();
  try {
    const resolvedRun = await script(dir, [`--simulate=${dir}`, `--request=${VERSION}`, `--out=${join(dir, 'd.json')}`]);
    assert.equal(resolvedRun.code, 0, resolvedRun.stderr);

    await writeFile(join(dir, 'npm-version.txt'), '0.8.0');
    const recheck = await script(dir, [`--simulate=${dir}`, `--recheck=${join(dir, 'd.json')}`]);
    assert.equal(recheck.code, 1);
    assert.match(recheck.stderr, /::error::.*moved from 0\.7\.0 to 0\.8\.0/);
    assert.match(recheck.stderr, /re-run the workflow/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('script: staged npm, a missing asset and a tap mismatch all fail with their remedy', async () => {
  const staged = await fixture({ versions: ['0.6.0'] });
  const missing = await fixture({ missing: 'linux-x64' });
  const tap = await fixture({
    tap: `    url "${releaseUrl(VERSION, 'linux-x64')}"\n    sha256 "${'f'.repeat(64)}"`,
  });
  try {
    const a = await script(staged, [`--simulate=${staged}`, `--request=${VERSION}`]);
    assert.equal(a.code, 1);
    assert.match(a.stderr, /npm stage approve/);

    const b = await script(missing, [`--simulate=${missing}`, `--request=${VERSION}`]);
    assert.equal(b.code, 1);
    assert.match(b.stderr, /linux-x64.*not downloadable/);

    const c = await script(tap, [`--simulate=${tap}`, `--request=${VERSION}`]);
    assert.equal(c.code, 1);
    assert.match(c.stderr, /formula and the asset disagree/);
  } finally {
    for (const dir of [staged, missing, tap]) await rm(dir, { recursive: true, force: true });
  }
});

test('script: an unknown version shape is refused before anything is read', async () => {
  const run = await script(ROOT, ['--request=latest; echo pwned']);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /not a concrete x\.y\.z release/);
});

test('script: --commit must agree with the tag it resolves', async () => {
  const dir = await fixture();
  try {
    const wrong = await script(dir, [`--simulate=${dir}`, `--request=${VERSION}`, `--commit=${'b'.repeat(40)}`]);
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /but this run is for/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// `dirname` is used by the fixture writer above; kept explicit rather than assumed.
void dirname;
