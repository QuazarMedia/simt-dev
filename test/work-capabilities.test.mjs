// Plan 0004 W10: what can be verified now, and what needs an environment this repository
// does not have.
//
// The failure this pins is a capability card that reads its own footnotes as evidence. A
// reachable endpoint is not a read path, a granted permission is not an installed adapter,
// and a rubric an agent follows by hand is not a check the tool ran. Each of those is
// asserted here by the card that reports it, and the module is held to opening no socket
// and reading no credential while it decides.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { CAPABILITY_SOURCES, VALIDATION_KINDS, capabilityCards, probeLocal } from '../src/work/capabilities.mjs';
import { keepTemp } from './fixture.mjs';

async function repo(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'simt-capabilities-'));
  keepTemp(root);
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }
  return root;
}

const cardFor = (cards, kind) => cards.find((card) => card.kind === kind);

test('every validation kind is reported separately, in a fixed order, even with nothing available', () => {
  const cards = capabilityCards();
  assert.deepEqual(cards.map((card) => card.kind), VALIDATION_KINDS);
  assert.deepEqual(VALIDATION_KINDS, ['structural', 'rubric', 'replay', 'remote-read', 'remote-write']);
  assert.deepEqual(CAPABILITY_SOURCES, ['declared', 'local', 'adapter', 'target', 'authorized']);
  for (const card of cards) {
    assert.equal(card.available, false, `${card.kind} claims availability with no source`);
    assert.equal(card.assurance, null, `${card.kind} claims assurance with no evidence`);
  }
  assert.match(cardFor(cards, 'structural').reason, /no gate or scope validator/);
  assert.equal(cardFor(cards, 'rubric').mode, 'agent-workflow');
});

test('a docs-only repository declares its own check, and its rubric stays an agent workflow', async () => {
  const root = await repo({
    'README.md': '# country knowledge\n',
    'Germany/rates.md': '# rates\n',
    'eval/validate.mjs': 'export const check = () => true;\n',
    'simt.json': JSON.stringify({
      id: 'fixture',
      gates: { docs: 'node eval/validate.mjs' },
      work: { version: 1, scopes: [{ id: 'de', paths: ['Germany'], validators: ['node eval/validate.mjs'] }] },
    }),
  });
  const local = await probeLocal(root);
  assert.deepEqual(local.gates, [{ id: 'docs', command: 'node eval/validate.mjs' }]);
  assert.deepEqual(local.runnerFiles, [], 'a docs tree has no runner manifest, and none is invented');

  const cards = capabilityCards({ work: { version: 1, scopes: [{ id: 'de', paths: ['Germany'], validators: ['node eval/validate.mjs'] }] }, local });
  const structural = cardFor(cards, 'structural');
  assert.equal(structural.available, true);
  assert.equal(structural.mode, 'runner');
  assert.equal(structural.assurance, 'declared', 'a declared command is a claim until something reports a run');
  assert.equal(structural.authorized, null, 'a local check needs no remote authorization');

  const rubric = cardFor(cards, 'rubric');
  assert.equal(rubric.available, false, 'no callable rubric adapter exists');
  assert.equal(rubric.declared, false);
  assert.equal(rubric.mode, 'agent-workflow');
  assert.equal(rubric.assurance, null);
  assert.match(rubric.reason, /agent workflow/);
});

test('a remote-repo-shaped fixture offers its structure tests and marks every live check unavailable', async () => {
  const work = {
    version: 1,
    targets: [{ namespace: 'tenant-a', type: 'calculation' }],
    adapters: ['rest-client'],
  };
  const root = await repo({
    'pyproject.toml': '[project]\nname = "remote"\n',
    'recipes/app/create-calculation.md': '# create\n\n@mutates\n@not_idempotent\n',
    'tests/test_recipe.py': 'def test_create():\n    assert True\n',
    'simt.json': JSON.stringify({ id: 'fixture', gates: { test: 'uv run pytest' }, work }),
  });
  const local = await probeLocal(root);
  assert.deepEqual(local.runnerFiles, ['pyproject.toml']);

  const cards = capabilityCards({
    work,
    local,
    // Declared in the manifest, and the descriptor says it is not installed: a declaration
    // of intent is not a capability.
    adapters: [{ id: 'rest-client', operations: ['read', 'write'], installed: false }],
  });
  assert.equal(cardFor(cards, 'structural').available, true, 'the mocked structure tests are runnable locally');
  for (const kind of ['rubric', 'replay', 'remote-read', 'remote-write']) {
    const card = cardFor(cards, kind);
    assert.equal(card.available, false, `${kind} claims a live capability offline`);
    assert.equal(card.mode === 'runner', false, `${kind} was reported as a local runner`);
  }
  assert.match(cardFor(cards, 'remote-read').reason, /not installed|no installed adapter/);
  assert.equal(cardFor(cards, 'remote-write').authorized, false);
});

test('a reachable endpoint is an observation, never an authorization or a write path', () => {
  const work = { version: 1, targets: [{ namespace: 'tenant-a', type: 'calculation' }] };
  const cards = capabilityCards({
    work,
    adapters: [{ id: 'rest-client', operations: ['read', 'write'], installed: true }],
    observations: [{ namespace: 'tenant-a', type: 'calculation', reachable: true, operations: ['read'] }],
  });

  const read = cardFor(cards, 'remote-read');
  assert.equal(read.available, true);
  assert.equal(read.assurance, 'observed', 'the target answered, and that is what an observation is worth');
  assert.match(read.reason, /reports read support/);

  const write = cardFor(cards, 'remote-write');
  assert.equal(write.available, false, 'a reachable target with a write adapter is still not an authorized mutation');
  assert.equal(write.authorized, false);
  assert.match(write.reason, /reachable endpoint does not imply authorization/);
});

test('authorization without an adapter is permission without capability, and an unnamed grant grants nothing', () => {
  const work = { version: 1, targets: [{ namespace: 'tenant-a', type: 'calculation' }] };
  const granted = capabilityCards({
    work,
    adapters: [{ id: 'rest-client', operations: ['write'], installed: false }],
    observations: [{ namespace: 'tenant-a', type: 'calculation', reachable: true, operations: ['write'] }],
    authorizations: [{ namespace: 'tenant-a', type: 'calculation', actor: 'agent', operations: ['write'] }],
  });
  const write = cardFor(granted, 'remote-write');
  assert.equal(write.authorized, true);
  assert.equal(write.available, false, 'nothing installed can carry the authorization out');
  assert.match(write.reason, /no installed adapter can carry it out/);

  const unnamed = capabilityCards({
    work,
    adapters: [{ id: 'rest-client', operations: ['write'], installed: true }],
    authorizations: [{ namespace: 'tenant-a', type: 'calculation', operations: ['write'] }],
  });
  assert.equal(cardFor(unnamed, 'remote-write').authorized, false, 'an authorization that names no actor is not one');

  const carried = capabilityCards({
    work,
    adapters: [{ id: 'rest-client', operations: ['write'], installed: true }],
    authorizations: [{ namespace: 'tenant-a', type: 'calculation', actor: 'agent', operations: ['write'] }],
  });
  const allowed = cardFor(carried, 'remote-write');
  assert.equal(allowed.available, true);
  assert.equal(allowed.mode, 'adapter');
  assert.equal(allowed.assurance, 'declared', 'permission plus an adapter is still a claim until an effect is read back');
  assert.match(allowed.reason, /writes tenant-a:calculation as agent/);
});

test('the cards are a pure function of their input and open nothing', async () => {
  const input = {
    work: { version: 1, targets: [{ namespace: 't', type: 'o' }] },
    adapters: [{ id: 'a', operations: ['read', 'write'], installed: true }],
    observations: [{ namespace: 't', type: 'o', reachable: true, operations: ['read'] }],
    authorizations: [{ namespace: 't', type: 'o', actor: 'agent', operations: ['write'] }],
  };
  assert.deepEqual(capabilityCards(input), capabilityCards(structuredClone(input)));

  const source = await readFile(new URL('../src/work/capabilities.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:net|node:http|node:https|node:tls|fetch\(|child_process/);
  assert.doesNotMatch(source, /process\.env|\.ssh|id_rsa|credentials/);
});
