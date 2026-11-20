// ADR-200: a repository that runs simt-dev from a live source checkout has no
// release to pin. `projection.follows: "source"` is the declaration, and every
// pin reader honours it: the version gate is skipped, the writers emit the
// declaration in place of the pin pair, and the drift comparison does not judge
// a declaration it did not write. A pinning repository is untouched by all of
// it, which is what the paired assertions pin down.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import test from 'node:test';

import { assertVersionPin, followsSource, packageVersion } from '../src/package-version.mjs';
import { buildManifest, manifestDrift, withGenerated } from '../src/projection/manifest.mjs';
import { manifestProblems } from '../src/manifest/schema.mjs';
import { runGates } from '../src/hooks/dispatcher.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';
import { keepTemp, simt as simtCli } from './fixture.mjs';
import { fixture } from './hooks2-fixture.mjs';

const exec = promisify(execFile);

/** Run the binary and report the outcome, exit code included (see ci.test.mjs). */
const run = (args, opts = {}) => simtCli(args, { ...opts, env: { NO_COLOR: '1', ...opts.env } });

test('followsSource reads the declaration, and nothing else', () => {
  assert.equal(followsSource({ projection: { follows: 'source' } }), true);
  assert.equal(followsSource({ projection: { follows: 'source', place: 'top' } }), true, 'a repo-owned sub-key does not hide it');
  assert.equal(followsSource({ projection: { follows: 'release' } }), false, 'any other value is not a declaration');
  assert.equal(followsSource({ projection: { version: '0.9.0' } }), false, 'a pin is not a declaration');
  assert.equal(followsSource({}), false);
  assert.equal(followsSource(null), false);
});

test('a declaration suppresses a version mismatch; a pin alone does not', () => {
  const stale = `${packageVersion()}-x`;
  assert.ok(assertVersionPin({ projection: { version: stale } }), 'a pinning repo with a stale pin fails');
  assert.equal(assertVersionPin({ projection: { follows: 'source', version: stale } }), null, 'the declaration wins over a leftover pin');
  assert.equal(assertVersionPin({ projection: { follows: 'source' } }), null);
});

test('dispatcher: a stale pin beside the declaration is not a version gate', async () => {
  // The stale-pin test in hooks2.test.mjs fails the event before any gate runs. The
  // declaration takes the same manifest and lets the event proceed to the gates it
  // actually declared: the checkout is the pin, so there is nothing to be stale against.
  const root = await fixture({
    scripts: { lint: 'echo ok' },
    manifest: { gates: { preCommit: ['lint'], prePush: [] }, projection: { follows: 'source', version: `${packageVersion()}-x` } },
  });
  const result = await runGates('pre-commit', { root, manifest: { gates: { preCommit: ['lint'], prePush: [] }, projection: { follows: 'source', version: `${packageVersion()}-x` } } });
  assert.ok(!result.gates.some((g) => g.name === 'version'), 'no version gate on a follows-source manifest');
  assert.equal(result.gates.find((g) => g.name === 'lint').status, 'passed');
});

test('buildManifest writes the declaration in place of the pin pair', () => {
  const m = buildManifest({ root: '/tmp/r', stack: ['node'], sha: 'abc1234', version: packageVersion(), followSource: true });
  assert.deepEqual(m.projection, { follows: 'source' }, 'no release pin beside the declaration');
  // A pinning build is unchanged: the pair is written exactly as before.
  const pinned = buildManifest({ root: '/tmp/r', stack: ['node'], sha: 'abc1234', version: packageVersion() });
  assert.deepEqual(pinned.projection, { simtDevSha: 'abc1234', version: packageVersion() });
});

test('a repo-owned projection sub-key survives both shapes', () => {
  const withPlace = buildManifest({
    root: '/tmp/r',
    stack: [],
    sha: 'abc1234',
    version: '1.0.0',
    existing: { projection: { place: 'top' } },
    followSource: true,
  });
  assert.deepEqual(withPlace.projection, { place: 'top', follows: 'source' });
  const pinned = buildManifest({
    root: '/tmp/r',
    stack: [],
    sha: 'abc1234',
    version: '1.0.0',
    existing: { projection: { place: 'top', simtDevSha: 'old', version: '0.9.0' } },
    followSource: false,
  });
  assert.deepEqual(pinned.projection, { place: 'top', simtDevSha: 'abc1234', version: '1.0.0' });
});

test('a re-init keeps the declaration it finds; --no-follow-source removes it', () => {
  const existing = { projection: { follows: 'source' } };
  const kept = buildManifest({ root: '/tmp/r', stack: [], sha: 'abc', version: '1.0.0', existing });
  assert.deepEqual(kept.projection, { follows: 'source' }, 'absent flag preserves the declaration');
  const removed = buildManifest({ root: '/tmp/r', stack: [], sha: 'abc', version: '1.0.0', existing, followSource: false });
  assert.deepEqual(removed.projection, { simtDevSha: 'abc', version: '1.0.0' }, 'the explicit negative returns the repo to a pin');
});

test('manifestDrift: a declaration is not stale; a leftover pin is, and the repair drops it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'simt-follows-'));
  keepTemp(root);
  const path = join(root, MANIFEST_FILE);
  const clean = buildManifest({ root, stack: ['node'], sha: 'abc1234', version: packageVersion(), followSource: true });
  await writeFile(path, JSON.stringify(clean, null, 2) + '\n');
  assert.equal(await manifestDrift(root, ['node'], 'abc1234'), null, 'a follows-source manifest with no pin is current');

  const stale = { ...clean, projection: { follows: 'source', simtDevSha: 'old', version: '0.9.0' } };
  await writeFile(path, JSON.stringify(stale, null, 2) + '\n');
  const drift = await manifestDrift(root, ['node'], 'abc1234');
  assert.equal(drift?.status, 'stale-generated-field', 'a pin that is present and ignored is stale');
  assert.match(drift.detail, /projection/);
  assert.match(drift.remedy, /sync --yes/);

  // The repair the drift names: the pair is dropped, the declaration and the
  // repo's own sub-keys are kept.
  const expected = buildManifest({ root, stack: ['node'], sha: 'abc1234', version: packageVersion(), existing: stale });
  const patched = withGenerated(stale, expected);
  assert.deepEqual(patched.projection, { follows: 'source' });
});

test('the schema accepts the declaration and names any other value', () => {
  assert.deepEqual(manifestProblems({ projection: { follows: 'source' } }), []);
  assert.deepEqual(manifestProblems({ projection: {} }), [], 'absent is valid');
  assert.deepEqual(manifestProblems({ projection: { follows: 'release' } }), ['projection.follows must be "source" (or absent)']);
});

test('init --follow-source adopts with the declaration and no pin, and check is green', async () => {
  // The estate's sibling repositories run the tool from a checkout and were stale on
  // every release. This is the adoption that leaves them un-stale: the manifest
  // carries the declaration, the pin pair is absent, and `check` reports neither a
  // version mismatch nor a stale generated field.
  const root = await mkdtemp(join(tmpdir(), 'simt-follows-'));
  keepTemp(root);
  await exec('git', ['init', '-q', '.'], { cwd: root });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fx', private: true }, null, 2));

  const { code, stdout } = await run(['init', '--yes', '--follow-source'], { cwd: root });
  assert.equal(code, 0, stdout);
  const manifest = JSON.parse(await readFile(join(root, MANIFEST_FILE), 'utf8'));
  assert.equal(manifest.projection.follows, 'source');
  assert.equal(manifest.projection.version, undefined, 'no release version is recorded');
  assert.equal(manifest.projection.simtDevSha, undefined, 'no rule digest is recorded beside the declaration');

  const check = await run(['check'], { cwd: root });
  assert.equal(check.code, 0, `check on a follows-source repo: ${check.stdout}\n${check.stderr}`);
  assert.doesNotMatch(check.stdout, /VERSION-MISMATCH/);
  assert.doesNotMatch(check.stdout, /STALE-GENERATED-FIELD/);

  // A re-init without the flag keeps the declaration: the choice is the repo's.
  const reinit = await run(['init', '--yes'], { cwd: root });
  assert.equal(reinit.code, 0, reinit.stdout);
  const again = JSON.parse(await readFile(join(root, MANIFEST_FILE), 'utf8'));
  assert.equal(again.projection.follows, 'source');
  assert.equal(again.projection.version, undefined);

  // And the explicit negative returns the repository to a release pin.
  const back = await run(['init', '--yes', '--no-follow-source'], { cwd: root });
  assert.equal(back.code, 0, back.stdout);
  const pinned = JSON.parse(await readFile(join(root, MANIFEST_FILE), 'utf8'));
  assert.equal(pinned.projection.follows, undefined);
  assert.equal(pinned.projection.version, packageVersion());
  assert.ok(pinned.projection.simtDevSha, 'the pin pair is back');
});
