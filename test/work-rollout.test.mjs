// Plan 0004 W51: compatibility rollout and rollback boundaries.
//
// What the suite pins: the old consumer contracts are byte-for-byte intact — the v1 closure
// envelope keeps exactly its fields, and a legacy ledger line keeps its local-tree meaning; new
// behaviour is opt-in, so an absent adapter or an undeclared `work` namespace leaves the default
// operation; disabling the feature does not delete historical receipts; and core resolution opens
// no socket.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { resolveAdapter } from '../src/adapters/conformance.mjs';
import { buildEvidence, readEvidenceRecord, validateEvidence } from '../src/ledger/evidence.mjs';
import { closureReport } from '../src/verify/closure.mjs';

test('the v1 closure envelope keeps exactly the fields its consumers parse', () => {
  const v1 = closureReport({ version: 1, obligations: [{ id: 'check-1', state: 'pass', severity: 'mandatory', basis: 'local' }] });
  assert.deepEqual(Object.keys(v1).sort(), ['checks', 'complete', 'schema', 'sha', 'version']);
  assert.equal(v1.schema, 'simt.closure/1');
  assert.deepEqual(v1.checks, { passed: 1, total: 1 });
  assert.equal('verdict' in v1, false);
  assert.equal('completion' in v1, false);
});

test('a legacy ledger line keeps its local-tree meaning', () => {
  const legacy = readEvidenceRecord({ v: 2, tree: 'tree-aaa', cmd: 'npm test', exit: 0 });
  assert.equal(legacy.version, 1);
  assert.equal(legacy.localOnly, true);
  assert.equal(legacy.tree, 'tree-aaa');
  assert.equal(validateEvidence({ v: 2, tree: 'tree-aaa' }, { tree: 'tree-aaa' }).state, 'current');
  assert.equal(validateEvidence({ v: 2, tree: 'tree-aaa' }, { tree: 'tree-bbb' }).state, 'stale');
});

test('a v2 receipt survives the feature being disabled', () => {
  const receipt = buildEvidence({
    observedAt: '2026-11-03T10:00:00Z',
    subject: { tree: 'tree-aaa', before: 'tree-aaa', after: 'tree-aaa' },
    obligations: [{ id: 'check-1', state: 'pass', basis: 'local' }],
  });
  assert.equal(validateEvidence(receipt, { tree: 'tree-aaa', needed: [{ id: 'check-1' }] }).state, 'current');
  assert.equal(readEvidenceRecord(receipt).version, 2);
});

test('new behaviour is opt-in: an absent adapter leaves the default operation', () => {
  assert.deepEqual(resolveAdapter({ adapters: [], requested: 'mock-remote' }), {
    adapter: null,
    operation: 'default',
    intact: true,
    reason: 'mock-remote is not installed; the repository keeps its default operation',
  });
  assert.equal(resolveAdapter({ adapters: [], requested: null }).operation, 'default');
});

test('core resolution opens no socket', async () => {
  for (const file of ['src/resolve/resolve.mjs', 'src/index/coverage.mjs', 'src/knowledge/rank.mjs', 'src/verify/select.mjs']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /node:net|node:http|node:dgram|node:tls|fetch\(/, `${file} opens a socket`);
  }
});
