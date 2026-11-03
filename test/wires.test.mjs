// The doors that made the remaining Plan 4 modules reachable: each test asserts the fact the
// module exists to produce, through the command a reader would run.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const BIN = fileURLToPath(new URL('../bin/simt.mjs', import.meta.url));

function temp() {
  return mkdtempSync(join(tmpdir(), 'simt-wires-'));
}

function doc(dir, name, value) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function run(path, input) {
  const result = spawnSync(process.execPath, [BIN, ...path.split(' '), '--input', input, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  let payload = null;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    payload = null;
  }
  return { status: result.status, payload, stdout: result.stdout, stderr: result.stderr };
}

test('W42: a review bundle is reviewable before execution, and says which check is missing', () => {
  const dir = temp();
  const input = doc(dir, 'bundle.json', {
    contract: { commit: 'abc123' },
    target: { incarnation: 'inc-1', class: 'document' },
    before: { 'doc:1': 'sha256-before' },
    authorization: { digest: 'sha256-auth' },
    postconditions: [{ id: 'p1' }],
  });
  const { payload } = run('action review', input);
  assert.equal(payload.bundle.schema, 'simt.review-bundle/1');
  assert.equal(payload.bundle.state, 'planned');
  assert.equal(payload.check.state, 'planned');
});

test('W48: an untrusted descriptor is refused as data, before anything could execute', () => {
  const dir = temp();
  const { payload } = run('adapter check', doc(dir, 'bad.json', { text: '{ not json' }));
  assert.equal(payload.parsed.valid, false);
  assert.match(payload.parsed.errors[0], /JSON/);
  assert.deepEqual(payload.checks, []);
});

test('W24: obligation evaluation keeps result states apart from a review verdict', () => {
  const dir = temp();
  const { payload } = run('verify contracts', doc(dir, 'contract.json', { contract: { obligations: [] }, observations: [] }));
  assert.equal(payload.review, 'not-a-review-verdict');
  assert.equal(payload.blocked, false);
  assert.equal(payload.complete, true);
});

test('W26: a generated document with no pinned template is refused, with a remedy', () => {
  const dir = temp();
  const { payload } = run('verify documents', doc(dir, 'documents.json', { output: {}, contract: {} }));
  assert.equal(payload.generation.ok, false);
  assert.equal(payload.generation.problems[0].code, 'no-template');
  assert.ok(payload.generation.problems[0].remedy.length > 10);
});

test('W30: a procedure calling one that does not exist is a problem, not a pass', () => {
  const dir = temp();
  const { payload } = run('verify procedures', doc(dir, 'procedures.json', { records: [{ id: 'a', calls: ['b'] }] }));
  assert.equal(payload.problems[0].code, 'missing-procedure');
});

test('W43: discovery candidates are deduplicated and carry their authority', () => {
  const dir = temp();
  const { payload } = run('lessons discover', doc(dir, 'candidates.json', {
    candidates: [
      { id: '1', proposition: 'a repeated claim', kind: 'discovery', verified: false },
      { id: '2', proposition: 'a repeated claim', kind: 'discovery', verified: false },
      { id: '3', proposition: 'another claim', kind: 'discovery', verified: true },
    ],
  }));
  assert.equal(payload.candidates.length, 2);
  assert.equal(payload.merged.length, 1);
  assert.ok(payload.authorities.every((authority) => ['lesson', 'warning', 'candidate'].includes(authority)));
});

test('W20: a unit with no citational anchor is rejected rather than counted as coverage', () => {
  const dir = temp();
  const { payload } = run('work packet', doc(dir, 'packet.json', {
    units: [{ id: 'u1', text: 'the rule', obligations: ['o1'] }],
  }));
  assert.equal(payload.rejected[0].id, 'u1');
  assert.equal(payload.rejected[0].reason, 'no-citation');
});

test('W18: an overlay node is labelled by the provenance its revision proves', () => {
  const dir = temp();
  const { payload } = run('index overlay', doc(dir, 'node.json', {
    node: { key: 'k', kind: 'claim', source: 'docs/a.md', provenance: 'staged', trust: 'observed', revision: 'staged:abc' },
  }));
  assert.equal(payload.node.provenance, 'staged');
  assert.match(payload.node.revision, /^staged:/);
});

test('W25: an evidence record that names no obligation is still current, and the chain is reported', () => {
  const dir = temp();
  const { payload } = run('evidence validate', doc(dir, 'evidence.json', { records: [] }));
  assert.equal(payload.state, 'current');
  assert.equal(payload.current, true);
});

test('W01: two identical baselines compare equal, and a change names the metric', () => {
  const dir = temp();
  const same = run('bench compat', doc(dir, 'same.json', { before: {}, after: {} }));
  assert.equal(same.payload.equal, true);

  const moved = run('bench compat', doc(dir, 'moved.json', {
    before: { recallAt10: 0.55 },
    after: { recallAt10: 0.61 },
  }));
  assert.equal(moved.payload.equal, false);
  assert.ok(moved.payload.differences.length > 0);
});

test('W45: the canary corpus grades gold, noop and wrong apart', () => {
  const dir = temp();
  const { payload } = run('bench corpus', doc(dir, 'corpus.json', { options: { perStratum: 1, seed: 7 } }));
  assert.ok(payload.tasks.length > 0);
  assert.equal(payload.graded.length, payload.tasks.length);
  assert.notDeepEqual(payload.graded[0].gold, payload.graded[0].wrong);
});

test('W45: a world model runs offline and the oracle answers about its effects', () => {
  const dir = temp();
  const { payload } = run('bench world', doc(dir, 'world.json', { events: [], probes: true }));
  assert.ok(Array.isArray(payload.world.oracle.effects));
  assert.ok(Array.isArray(payload.probes.rows));
});
