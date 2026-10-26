// pack new | lint | publish - the author side of a pack (plan 0003 R45).
//
// The vendored side is `test/packs.test.mjs`: bytes under `.simt/packs/` and the
// digest the manifest pins. This file is the other side: how a pack comes to
// exist (`new`), how it is judged (`lint`, including the measured-ΔR summary the
// success metric asks the pack to state), and how its bytes become obtainable
// (`publish`) - without ever fetching at render time.
//
// Staged in temp directories with no siblings, per ADR-031, and every command run
// through the binary rather than imported, so what is tested is what a reader runs.
// The one exception is the pure validators, which are imported for their edge cases:
// a table of sources is not a behaviour the binary renders.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import { packDigest } from '../src/packs.mjs';
import { BENCH_JSON, PACK_JSON, describeSourceProblem, describeVersionProblem, npmPackageOf, packRuleFiles, readPack } from '../src/packs/manage.mjs';
import { buildManifest, manifestText } from '../src/projection/manifest.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt.mjs');
const exec = promisify(execFile);
const made = [];

after(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

async function scratch(prefix = 'simt-packcli-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** One run of the real binary. Extra env (PATH stubs) via `env`. */
async function run(args, { cwd = null, env = {} } = {}) {
  try {
    // `process.execPath`, not `'node'`: a test that strips PATH (the npm-missing
    // refusal) would otherwise fail to spawn the binary itself, because command
    // lookup reads the child's PATH.
    const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], {
      maxBuffer: 16 << 20,
      ...(cwd === null ? {} : { cwd }),
      env: { ...process.env, ...env },
    });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    return { code: error.code, out: (error.stdout ?? '') + (error.stderr ?? '') };
  }
}

const RULE = (id) => `---\nsimt-id: ${id}\nsimt-applies: []\n---\n\n# Rule\n`;

/** A pack directory with identity, one rule, and the scaffold's unmeasured summary. */
async function scaffolded(root, name = 'house', source = 'git+https://example.invalid/house.git') {
  const dir = join(root, name);
  await mkdir(join(dir, 'rules', 'stacks'), { recursive: true });
  await writeFile(join(dir, PACK_JSON), `${JSON.stringify({ name, version: '0.1.0', source }, null, 2)}\n`);
  await writeFile(join(dir, 'rules', 'stacks', `${name}.md`), RULE(name));
  await writeFile(
    join(dir, BENCH_JSON),
    `${JSON.stringify({ schemaVersion: 1, pack: name, version: '0.1.0', measured: false, digest: null, tasks: 0, arms: { without: { resolved: 0, total: 0 }, with: { resolved: 0, total: 0 } }, dR: 0, run: '', measuredAt: '' }, null, 2)}\n`,
  );
  return dir;
}

/** The digest a bench summary binds to: every byte but the summary itself. */
async function contentDigest(dir) {
  return packDigest(dir, { exclude: [BENCH_JSON] });
}

/** Record a measurement of the pack's current bytes: with 31/40, without 22/40. */
async function measure(dir, name = 'house', version = '0.1.0') {
  const digest = await contentDigest(dir);
  const bench = {
    schemaVersion: 1,
    pack: name,
    version,
    measured: true,
    digest,
    tasks: 40,
    arms: { without: { resolved: 22, total: 40 }, with: { resolved: 31, total: 40 } },
    dR: 0.225,
    run: 'bench-2026-10-27-house',
    measuredAt: '2026-10-27',
  };
  await writeFile(join(dir, BENCH_JSON), `${JSON.stringify(bench, null, 2)}\n`);
  return bench;
}

test('pack new previews by default and writes with --yes', async () => {
  const root = await scratch();
  const preview = await run(['pack', 'new', 'house', '--source', 'git+https://example.invalid/house.git', '--root', root]);
  assert.equal(preview.code, 0);
  assert.match(preview.out, /PLAN     pack\.json/);
  assert.match(preview.out, /PLAN     bench\.json/);
  assert.match(preview.out, /PLAN     rules\/stacks\/house\.md/);
  let exists = true;
  try {
    await readFile(join(root, 'house', PACK_JSON), 'utf8');
  } catch {
    exists = false;
  }
  assert.equal(exists, false, 'a preview that wrote is not a preview');

  const applied = await run(['pack', 'new', 'house', '--source', 'git+https://example.invalid/house.git', '--root', root, '--yes']);
  assert.equal(applied.code, 0, applied.out);
  assert.match(applied.out, /WRITE    pack\.json/);
  assert.match(applied.out, /pack lint/);
  const pack = JSON.parse(await readFile(join(root, 'house', PACK_JSON), 'utf8'));
  assert.deepEqual(pack, { name: 'house', version: '0.1.0', source: 'git+https://example.invalid/house.git' });
});

test('pack new --yes --dry-run is a rehearsal, and a second new refuses', async () => {
  const root = await scratch();
  const rehearsal = await run(['pack', 'new', 'house', '--source', 'git+https://example.invalid/house.git', '--root', root, '--yes', '--dry-run']);
  assert.equal(rehearsal.code, 0);
  assert.match(rehearsal.out, /DRY-RUN/);

  await run(['pack', 'new', 'house', '--source', 'git+https://example.invalid/house.git', '--root', root, '--yes']);
  const again = await run(['pack', 'new', 'house', '--source', 'git+https://example.invalid/house.git', '--root', root, '--yes']);
  assert.notEqual(again.code, 0, 'a scaffold that overwrote would destroy work');
  assert.match(again.out, /already exists/);
});

test('pack new refuses a bad name, a missing source and an unusable source', async () => {
  const root = await scratch();
  assert.equal((await run(['pack', 'new', '--root', root, '--yes'])).code, 2);
  assert.equal((await run(['pack', 'new', '../escape', '--source', 'git+https://example.invalid/x.git', '--root', root, '--yes'])).code, 2);
  const noSource = await run(['pack', 'new', 'house', '--root', root, '--yes']);
  assert.equal(noSource.code, 2);
  assert.match(noSource.out, /needs --source/);
  const badSource = await run(['pack', 'new', 'house', '--source', 'nota-source', '--root', root, '--yes']);
  assert.equal(badSource.code, 2);
  assert.match(badSource.out, /neither an npm package/);
});

test('pack new writes package.json for an npm source, naming the scoped package', async () => {
  const root = await scratch();
  const { code, out } = await run(['pack', 'new', 'house', '--source', 'npm:@example/house-pack', '--root', root, '--yes']);
  assert.equal(code, 0, out);
  const pkg = JSON.parse(await readFile(join(root, 'house', 'package.json'), 'utf8'));
  // The naive split names the empty string here: `@example/house-pack`.split('@')[0].
  assert.equal(pkg.name, '@example/house-pack');
  assert.equal(pkg.version, '0.1.0');
});

test('a scaffolded pack passes lint, unmeasured, and states nothing', async () => {
  const root = await scratch();
  const dir = await scaffolded(root);
  const { code, out } = await run(['pack', 'lint', dir]);
  assert.equal(code, 0, out);
  assert.match(out, /PASSED/);
  assert.match(out, /unmeasured/);
  assert.ok(!out.includes('dR +'), 'an unmeasured pack states no ΔR');
});

test('pack lint --require-measured rejects a pack with no bench summary', async () => {
  const root = await scratch();
  const dir = await scaffolded(root);
  const unmeasured = await run(['pack', 'lint', dir, '--require-measured']);
  assert.equal(unmeasured.code, 1, 'the acceptance: a pack without a bench summary fails when measurement is required');
  assert.match(unmeasured.out, /PACK-BENCH-UNMEASURED/);

  await rm(join(dir, BENCH_JSON));
  const missing = await run(['pack', 'lint', dir, '--require-measured']);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /PACK-BENCH-MISSING/);
});

test('a measured pack passes, and lint states its ΔR', async () => {
  const root = await scratch();
  const dir = await scaffolded(root);
  await measure(dir);
  const { code, out } = await run(['pack', 'lint', dir, '--require-measured']);
  assert.equal(code, 0, out);
  assert.match(out, /measured dR \+0\.225 over 40 tasks/);
});

test('lint refuses a summary measured at other bytes, or whose arithmetic does not close', async () => {
  const root = await scratch();
  const dir = await scaffolded(root);
  const bench = await measure(dir);

  await writeFile(join(dir, 'rules', 'stacks', 'house.md'), RULE('house') + '\nchanged\n');
  const stale = await run(['pack', 'lint', dir]);
  assert.equal(stale.code, 1);
  assert.match(stale.out, /PACK-BENCH-STALE/);
  assert.ok(stale.out.includes(bench.digest), 'the digest it was measured at must be printed');

  await writeFile(join(dir, 'rules', 'stacks', 'house.md'), RULE('house'));
  const doctored = { ...bench, dR: 0.9 };
  await writeFile(join(dir, BENCH_JSON), `${JSON.stringify(doctored, null, 2)}\n`);
  const invalid = await run(['pack', 'lint', dir]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.out, /PACK-BENCH-INVALID/);
  assert.match(invalid.out, /its arms resolve to 0\.2250/);
});

test('lint refuses a pack with no identity, no rules, or a rule nobody selects', async () => {
  const root = await scratch();
  const empty = join(root, 'empty');
  await mkdir(empty, { recursive: true });
  const noJson = await run(['pack', 'lint', empty]);
  assert.equal(noJson.code, 1);
  assert.match(noJson.out, /PACK-JSON-INVALID/);

  await writeFile(join(empty, PACK_JSON), 'not json\n');
  const badJson = await run(['pack', 'lint', empty]);
  assert.equal(badJson.code, 1);
  assert.match(badJson.out, /PACK-JSON-INVALID/);

  const dir = await scaffolded(root);
  await rm(join(dir, 'rules'), { recursive: true, force: true });
  await mkdir(join(dir, 'rules'), { recursive: true });
  const noRules = await run(['pack', 'lint', dir]);
  assert.equal(noRules.code, 1);
  assert.match(noRules.out, /PACK-NO-RULES/);

  await writeFile(join(dir, 'rules', 'stray.md'), '# no frontmatter\n');
  const noId = await run(['pack', 'lint', dir]);
  assert.equal(noId.code, 1);
  assert.match(noId.out, /PACK-RULE-WITHOUT-ID/);
});

test('lint refuses a pack that carries a skill registry', async () => {
  // ADR-061 ruled the registry workspace data; a pack carrying one reopens it by
  // accident, and no gate would ever name it because nothing reads it.
  const root = await scratch();
  const dir = await scaffolded(root);
  await mkdir(join(dir, 'graph'), { recursive: true });
  await writeFile(join(dir, 'graph', 'skills.graph.json'), '{"version":1,"skills":[]}\n');
  const { code, out } = await run(['pack', 'lint', dir]);
  assert.equal(code, 1);
  assert.match(out, /PACK-CARRIES-REGISTRY/);
});

test('lint checks the adopting manifest pin when the pack is vendored', async () => {
  const root = await scratch();
  const dir = await scaffolded(join(root, '.simt', 'packs'), 'house');
  const manifest = buildManifest({ root, stack: [], sha: 'abc1234', version: '0.2.1' });
  manifest.packs = [{ name: 'house', source: 'git+https://example.invalid/house.git', version: '9.9.9', digest: '0'.repeat(40) }];
  await writeFile(join(root, MANIFEST_FILE), manifestText(manifest));

  const { code, out } = await run(['pack', 'lint', dir]);
  assert.equal(code, 1);
  assert.match(out, /PACK-VERSION-DRIFT/);
  assert.match(out, /PACK-DIGEST-DRIFT/);
  assert.match(out, /declared 9\.9\.9/);
});

test('pack publish of a git-sourced pack names the tag-and-push instead', async () => {
  const root = await scratch();
  const dir = await scaffolded(root);
  for (const extra of [[], ['--yes']]) {
    const { code, out } = await run(['pack', 'publish', dir, ...extra]);
    assert.equal(code, 1, 'publishing a git pack is a refusal either way: --yes authorises writes, not a different repository');
    assert.match(out, /PACK-PUBLISH-MANUAL/);
    assert.match(out, /git tag v0\.1\.0 && git push/);
  }
});

test('pack publish refuses a pack that fails lint before touching any registry', async () => {
  const root = await scratch();
  const dir = await scaffolded(root);
  await rm(join(dir, 'rules'), { recursive: true, force: true });
  await mkdir(join(dir, 'rules'), { recursive: true });
  const { code, out } = await run(['pack', 'publish', dir, '--yes']);
  assert.equal(code, 1);
  // The underlying lint finding arrives as the detail: publish names the refusal,
  // lint names the defect, and one of each is enough for the reader to act.
  assert.match(out, /PACK-INVALID/);
  assert.match(out, /fails lint/);
  assert.match(out, /carries no rule files/);
});

test('pack publish of an npm pack with a mismatched package.json names the mismatch', async () => {
  // Before any network: `npm publish` reads package.json, so a package.json that
  // does not name the source's package is refused locally.
  const root = await scratch();
  const dir = await scaffolded(root, 'house', 'npm:@example/house-pack');
  // package.json first: it is measured bytes, so writing it after measuring
  // would stale the summary and the refusal would be PACK-BENCH-STALE instead.
  await writeFile(join(dir, 'package.json'), '{"name":"@example/other","version":"0.1.0"}\n');
  await measure(dir, 'house');
  const { code, out } = await run(['pack', 'publish', dir]);
  assert.equal(code, 1);
  assert.match(out, /PACK-PACKAGE-MISMATCH/);
});

test('pack publish reports npm missing without a registry round trip', async () => {
  const root = await scratch();
  const dir = await scaffolded(root, 'house', 'npm:@example/house-pack');
  // package.json first: it is measured bytes, so measuring first would stale the
  // summary and the refusal would be PACK-BENCH-STALE instead of PACK-NPM-MISSING.
  await writeFile(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: '@example/house-pack', version: '0.1.0', files: ['rules/**', PACK_JSON, BENCH_JSON] }, null, 2)}\n`,
  );
  await measure(dir, 'house');
  // No npm on PATH: the refusal must come from the spawn, not from the network.
  const { code, out } = await run(['pack', 'publish', dir], { env: { PATH: '/nonexistent' } });
  assert.equal(code, 1);
  assert.match(out, /PACK-NPM-MISSING/);
});

test('pack publish skips a version already live, and publishes with --yes', async () => {
  // A stub npm on PATH: the suite must not require a network, so the registry is
  // a script that answers `view` and records `publish`.
  const root = await scratch();
  const bindir = join(root, 'bin');
  await mkdir(bindir, { recursive: true });
  const published = join(root, 'published.txt');
  await writeFile(
    join(bindir, 'npm'),
    `#!/bin/sh\nif [ \"$1\" = \"view\" ]; then echo \"0.1.0\"; exit 0; fi\nif [ \"$1\" = \"publish\" ]; then echo published >> \"${published}\"; exit 0; fi\nexit 1\n`,
  );
  await chmod(join(bindir, 'npm'), 0o755);
  const env = { PATH: `${bindir}:/usr/bin:/bin` };

  const dir = await scaffolded(root, 'live', 'npm:@example/live-pack');
  // package.json first, for the same reason as the mismatch test: it is measured.
  await writeFile(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: '@example/live-pack', version: '0.1.0', files: ['rules/**', PACK_JSON, BENCH_JSON] }, null, 2)}\n`,
  );
  await measure(dir, 'live');

  const skipped = await run(['pack', 'publish', dir, '--yes'], { env });
  assert.equal(skipped.code, 0, skipped.out);
  assert.match(skipped.out, /SKIPPED.*@example\/live-pack@0\.1\.0 is already live/);
  let marker = null;
  try {
    marker = await readFile(published, 'utf8');
  } catch {
    marker = null;
  }
  assert.equal(marker, null, 'a skipped version must not publish');

  // A missing version reads the way the real registry answers: a 404, not a
  // refusal. Anything else is an unreachable registry, and the command must say
  // that instead (the branch the PATH-stripped test covers from the other side).
  await writeFile(
    join(bindir, 'npm'),
    `#!/bin/sh\nif [ \"$1\" = \"view\" ]; then echo "npm error code E404" >&2; exit 1; fi\nif [ \"$1\" = \"publish\" ]; then echo published >> \"${published}\"; exit 0; fi\nexit 1\n`,
  );
  const planned = await run(['pack', 'publish', dir], { env });
  assert.equal(planned.code, 0, planned.out);
  assert.match(planned.out, /PLAN     npm publish/);
  marker = null;
  try {
    marker = await readFile(published, 'utf8');
  } catch {
    marker = null;
  }
  assert.equal(marker, null, 'a preview must not publish');

  const publishedRun = await run(['pack', 'publish', dir, '--yes'], { env });
  assert.equal(publishedRun.code, 0, publishedRun.out);
  assert.match(publishedRun.out, /PUBLISHED live@0\.1\.0/);
  assert.equal(await readFile(published, 'utf8'), 'published\n');
});

test('pack lint and publish answer --json with one document that agrees with the exit', async () => {
  const root = await scratch();
  const dir = await scaffolded(root);
  await measure(dir);

  const good = await run(['pack', 'lint', dir, '--json']);
  assert.equal(good.code, 0);
  const goodPayload = JSON.parse(good.out);
  assert.equal(goodPayload.ok, true);
  assert.equal(goodPayload.command, 'pack lint');
  assert.equal(goodPayload.pack.name, 'house');
  assert.match(goodPayload.pack.digest, /^[0-9a-f]{40}$/);
  assert.ok(Array.isArray(goodPayload.findings));
  assert.equal(goodPayload.schemaVersion, 1);

  await rm(join(dir, BENCH_JSON));
  const bad = await run(['pack', 'lint', dir, '--require-measured', '--json']);
  assert.equal(bad.code, 1);
  const badPayload = JSON.parse(bad.out);
  assert.equal(badPayload.ok, false);
  assert.equal(badPayload.findings[0].status, 'pack-bench-missing');

  const published = await run(['pack', 'new', 'house', '--source', 'git+https://example.invalid/house.git', '--root', root, '--json']);
  assert.equal(published.code, 0);
  const newPayload = JSON.parse(published.out);
  assert.equal(newPayload.ok, true);
  assert.equal(newPayload.command, 'pack new');
  assert.ok(newPayload.files.includes(PACK_JSON) && newPayload.files.includes(BENCH_JSON));
  assert.equal(newPayload.schemaVersion, 1);
});

test('bare pack lints the working directory', async () => {
  const root = await scratch();
  const dir = await scaffolded(root);
  const { code, out } = await run(['pack'], { cwd: dir });
  assert.equal(code, 0, out);
  assert.match(out, /PASSED/);
});

// --- the pure validators, edge cases the binary never renders -----------------

test('describeSourceProblem accepts the two obtainable forms and nothing else', () => {
  assert.equal(describeSourceProblem('npm:@example/house-pack'), null);
  assert.equal(describeSourceProblem('npm:house-pack@0.1.0'), null);
  assert.equal(describeSourceProblem('git+https://example.invalid/house.git'), null);
  assert.equal(describeSourceProblem('git+https://example.invalid/house.git#v0.1.0'), null);
  assert.match(describeSourceProblem('nota-source'), /neither an npm package/);
  assert.match(describeSourceProblem('npm:Has-Uppercase'), /not a usable npm package/);
  assert.match(describeSourceProblem('npm:house@not-a-version'), /not x\.y\.z/);
  assert.match(describeSourceProblem('https://example.invalid/house.git'), /neither an npm package/);
  assert.match(describeSourceProblem(''), /names where the bytes come from/);
});

test('describeVersionProblem and npmPackageOf read the same shape the release tooling writes', () => {
  assert.equal(describeVersionProblem('0.1.0'), null);
  assert.match(describeVersionProblem('1.0'), /not x\.y\.z/);
  assert.match(describeVersionProblem(null), /not x\.y\.z/);
  assert.equal(npmPackageOf('npm:@example/house-pack'), '@example/house-pack');
  assert.equal(npmPackageOf('npm:@example/house-pack@0.1.0'), '@example/house-pack');
  assert.equal(npmPackageOf('npm:house-pack@0.1.0'), 'house-pack');
  assert.equal(npmPackageOf('git+https://example.invalid/house.git'), null);
});

test('packRuleFiles collects what the projection would, and readPack reports itself', async () => {
  const root = await scratch();
  const dir = await scaffolded(root);
  assert.deepEqual(await packRuleFiles(dir), ['rules/stacks/house.md']);
  assert.deepEqual((await readPack(dir)).pack, { name: 'house', version: '0.1.0', source: 'git+https://example.invalid/house.git' });
  const missing = await readPack(join(root, 'absent'));
  assert.equal(missing.pack, null);
  assert.match(missing.error, new RegExp(`no ${PACK_JSON}`));
});
