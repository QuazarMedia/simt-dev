// A manifest value this build cannot read is a config finding, not a crash and not a pass
// (review 0005 PR02).
//
// The defect these pin: `gates.preCommit` written as a string reported `ok: true` with zero
// hooks, a numeric one made `check` throw "is not iterable", and `hooks run` treated either
// as an empty list. The rule the tests hold: every command that reads the manifest answers
// about the same value in the same words, and an invalid enabled gate never exits zero.

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { manifestProblems, unknownKeys, loadManifest } from '../src/manifest/schema.mjs';
import { TOOLS } from '../src/mcp/tools.mjs';
import { git, simt, tempDir } from './fixture.mjs';

async function repo(manifest) {
  const root = await tempDir('simt-manifest-config-');
  await git(['init', '-q', root]);
  await writeFile(join(root, 'package.json'), '{ "name": "fixture", "version": "1.0.0" }\n');
  if (manifest !== undefined) {
    await writeFile(join(root, 'simt.json'), typeof manifest === 'string' ? manifest : `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return root;
}

const tool = (list, name) => list.find((entry) => entry.name === name);

test('the schema names every gate option this build reads', () => {
  const cases = [
    [{ gates: { preCommit: 'lint' } }, /gates\.preCommit must be a list/],
    [{ gates: { preCommit: 7 } }, /gates\.preCommit must be a list/],
    [{ gates: { prePush: ['test', 3] } }, /gates\.prePush must be a list/],
    [{ gates: { commands: { lint: true } } }, /gates\.commands must be an object/],
    [{ gates: { cwd: { lint: 3 } } }, /gates\.cwd must be an object/],
    [{ gates: { evidence: 'loud' } }, /gates\.evidence must be/],
    [{ gates: { prePushSkipTest: { maxCommits: 5 } } }, /gates\.prePushSkipTest must be/],
    [{ gates: { prePushSkipTest: { maxCommits: 5, paths: ['docs/**'], extensions: 'md' } } }, /extensions must be a list/],
    [{ federation: 'acme' }, /federation must be an object/],
    [{ local: [] }, /local must be an object/],
  ];
  for (const [manifest, expected] of cases) {
    const problems = manifestProblems(manifest);
    assert.equal(problems.length, 1, JSON.stringify(manifest));
    assert.match(problems[0], expected);
  }
});

test('an explicit empty gate list is legal, and an unknown key is named but not invalid', () => {
  assert.deepEqual(manifestProblems({ gates: { preCommit: [], prePush: [] } }), []);
  assert.deepEqual(manifestProblems({ note: 'kept by hand' }), [], 'an unknown key is not an invalid value');
  assert.deepEqual(unknownKeys({ id: 'x', note: 'kept by hand', 'x-mine': 1 }), ['note']);
});

test('absent, unreadable, malformed, unsupported and invalid are five different answers', async () => {
  const absent = await repo();
  const a = await loadManifest(absent);
  assert.deepEqual([a.exists, a.manifest, a.problems], [false, null, []]);

  // A directory in the manifest's place reads as EISDIR: the file is there and cannot be
  // read, which is not the same answer as "this repository was never adopted".
  const unreadable = await repo();
  await mkdir(join(unreadable, 'simt.json'));
  const u = await loadManifest(unreadable);
  assert.equal(u.exists, true);
  assert.equal(u.manifest, null);
  assert.match(u.problems[0], /^unreadable: /);

  const malformed = await repo('{ "id": "x", }');
  const m = await loadManifest(malformed);
  assert.equal(m.exists, true);
  assert.match(m.problems[0], /^unparseable: /);

  const newer = await repo({ id: 'x', version: 2 });
  const n = await loadManifest(newer);
  assert.match(n.problems[0], /unsupported manifest version 2/);
  assert.equal(n.manifest.id, 'x', 'the keys are still readable, so a repair can preserve them');

  const invalid = await repo({ id: 'x', gates: { preCommit: 'lint' } });
  const i = await loadManifest(invalid);
  assert.equal(i.version, 1);
  assert.match(i.problems[0], /gates\.preCommit must be a list/);
});

test('check names an invalid gate list and exits nonzero', async () => {
  const root = await repo({ id: 'fixture', gates: { preCommit: 'lint' } });
  const run = await simt(['check', '--root', root, '--json']);
  assert.notEqual(run.code, 0, `${run.stdout}${run.stderr}`);
  const payload = JSON.parse(run.stdout);
  const finding = payload.findings.find((f) => f.status === 'manifest-invalid');
  assert.ok(finding, 'the invalid gate list is a named finding');
  assert.match(finding.detail, /gates\.preCommit must be a list/);
});

test('check keeps an explicit empty gate list and a stranger key green', async () => {
  const root = await repo({ id: 'fixture', gates: { preCommit: [], prePush: [] }, note: 'mine' });
  const run = await simt(['check', '--root', root, '--json']);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.findings.some((f) => f.status === 'manifest-invalid'), false, 'an empty list is a declaration');
  const stranger = payload.findings.find((f) => f.status === 'manifest-unknown-key');
  assert.ok(stranger, 'an unknown key is named');
  assert.match(stranger.detail, /unknown key `note`/);
});

test('doctor names the same value and exits with the config code', async () => {
  const root = await repo({ id: 'fixture', gates: { prePush: 3 } });
  const run = await simt(['doctor', '--root', root, '--json']);
  assert.equal(run.code, 3, `${run.stdout}${run.stderr}`);
  const payload = JSON.parse(run.stdout);
  const finding = payload.findings.find((f) => f.id === 'manifest-invalid');
  assert.ok(finding, JSON.stringify(payload.findings));
  assert.match(finding.detail, /gates\.prePush must be a list/);
});

test('hooks run fails with a config gate instead of reporting nothing runs', async () => {
  const root = await repo({ id: 'fixture', gates: { preCommit: 'lint' } });
  const run = await simt(['hooks', 'run', 'pre-commit', '--root', root, '--json']);
  assert.notEqual(run.code, 0, `${run.stdout}${run.stderr}`);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.failed, true);
  assert.equal(payload.gates[0].name, 'config');
  assert.match(payload.gates[0].detail, /gates\.preCommit must be a list of gate names/);
});

test('status reports the repository as not ok', async () => {
  const root = await repo({ id: 'fixture', gates: { preCommit: 'lint' } });
  const run = await simt(['status', '--root', root, '--json']);
  assert.notEqual(run.code, 0, `${run.stdout}${run.stderr}`);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.ok, false);
  assert.match(payload.gitHooks.gatesError, /gates\.preCommit must be a list/);
});

test('the MCP check and doctor tools answer with the same finding', async () => {
  const root = await repo({ id: 'fixture', gates: { preCommit: { lint: true } } });
  const checked = await tool(TOOLS, 'check').run({ root });
  assert.equal(checked.ok, false);
  assert.ok(checked.findings.some((f) => f.status === 'manifest-invalid'));
  const diagnosed = await tool(TOOLS, 'doctor').run({ root });
  assert.ok(diagnosed.findings.some((f) => f.id === 'manifest-invalid'));
});
