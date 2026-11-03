// Plan 0004 W31: portable object snapshots and semantic deltas.
//
// The fixture is a remote rule object with a declaration list (unordered), a permission field, a
// masked field and an opaque body. What the suite pins: permuted unordered fields produce no
// delta; ordered ones do; a masked permission change is visible and never guessed; a lossy
// snapshot cannot justify replacing the object; frame conditions name what must stay; and a
// promotion resolves logical references instead of copying environment ids.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  CHANGE_KINDS,
  FIELD_CLASSES,
  OBJECT_SCHEMA,
  canReplaceWholeObject,
  canonicalObject,
  explain,
  frameConditions,
  promotionPlan,
  referenceEdges,
  semanticDelta,
} from '../src/actions/delta.mjs';

const rule = (fields = {}, over = {}) =>
  canonicalObject({
    namespace: 'rates/prod',
    type: 'rule',
    id: '42',
    fields: {
      name: 'discount',
      tags: { value: ['b', 'a', 'c'], ordered: false },
      steps: { value: ['one', 'two'], ordered: true },
      visibility: { value: 'public', class: 'privacy' },
      audience: { value: 'staff', class: 'permission' },
      approver: { value: { ref: 'rates/team', kind: 'read' }, class: 'reference' },
      method: { value: { ref: 'pricing/calc', kind: 'call' }, class: 'reference' },
      body: { value: { text: 'select 1' }, class: 'opaque' },
      ...fields,
    },
    ...over,
  });

test('the schema names the field classes and change kinds', () => {
  assert.equal(OBJECT_SCHEMA, 'simt.object/1');
  assert.deepEqual(FIELD_CLASSES, ['identity', 'functional', 'permission', 'privacy', 'reference', 'opaque']);
  assert.deepEqual(CHANGE_KINDS, ['added', 'removed', 'changed', 'renamed', 'reset', 'unknown']);
});

test('a permuted unordered collection is not a delta; a reordered sequence is', () => {
  const permuted = rule({ tags: { value: ['c', 'a', 'b'], ordered: false } });
  assert.deepEqual(semanticDelta(rule(), permuted).changes, []);

  const reordered = rule({ steps: { value: ['two', 'one'], ordered: true } });
  const delta = semanticDelta(rule(), reordered);
  assert.equal(delta.changes.length, 1);
  assert.equal(delta.changes[0].field, 'steps');
  assert.equal(delta.changes[0].kind, 'changed');
});

test('a privacy or permission change appears even when its value is masked', () => {
  const masked = rule({ audience: { value: null, class: 'permission', masked: true } });
  const delta = semanticDelta(rule(), masked);
  const change = delta.changes.find((entry) => entry.field === 'audience');
  assert.ok(change, 'a privilege change disappeared from the delta');
  assert.equal(change.kind, 'unknown');
  assert.equal(change.visible, true);
  assert.match(explain(change), /permission field whose value is masked/);
});

test('a masked functional field stays unknown rather than guessed', () => {
  const masked = rule({ name: { value: null, masked: true } });
  const delta = semanticDelta(rule(), masked);
  assert.equal(delta.changes.length, 0);
  assert.deepEqual(delta.unknown, [{ field: 'name', reason: 'masked', class: 'functional' }]);
  assert.equal(delta.lossy, true);
  assert.equal(canReplaceWholeObject(masked), false);
  assert.equal(canReplaceWholeObject(canonicalObject({ namespace: 'n', type: 't', id: '1', fields: { a: 'b' } })), true);
});

test('add, remove, rename and reset each have a stable explanation', () => {
  const after = rule({
    name: { value: 'discount-v2', class: 'functional', default: 'discount-v2' },
    approver: { value: { ref: 'rates/lead', kind: 'read' }, class: 'reference' },
    extra: 'new',
  });
  const before = rule({ extra: undefined });
  delete before.fields.extra;
  const delta = semanticDelta(before, after);
  const byField = Object.fromEntries(delta.changes.map((change) => [change.field, change]));

  assert.equal(byField.name.kind, 'reset');
  assert.match(explain(byField.name), /resized? to its declared default|reset to its declared default/);
  assert.equal(byField.approver.kind, 'renamed');
  assert.match(explain(byField.approver), /now references "rates\/lead" instead of "rates\/team"/);
  assert.equal(byField.extra.kind, 'added');
  assert.equal(explain(byField.extra), 'extra was added');

  const removed = semanticDelta(rule(), canonicalObject({ namespace: 'rates/prod', type: 'rule', id: '42', fields: { name: 'discount' } }));
  assert.equal(removed.changes.find((entry) => entry.field === 'tags').kind, 'removed');
});

test('declared references become typed edges, and an opaque body stays incomplete', () => {
  const edges = referenceEdges(rule());
  assert.deepEqual(edges.calls, ['pricing/calc']);
  assert.deepEqual(edges.reads, ['rates/team']);
  assert.deepEqual(edges.writes, []);
  assert.equal(edges.incomplete, true);
  assert.equal(edges.opaque[0].field, 'body');
  assert.match(edges.opaque[0].digest, /^sha256-/);
  assert.equal(edges.opaque[0].dependsOn, 'unknown');
});

test('frame conditions name every untouched readable field', () => {
  const delta = semanticDelta(rule(), rule({ name: 'discount-v2' }));
  const frames = frameConditions(rule(), delta);
  assert.deepEqual(frames.map((frame) => frame.field), ['approver', 'audience', 'method', 'steps', 'tags', 'visibility']);
  assert.equal(frames.find((frame) => frame.field === 'audience').expect, 'staff');
  assert.equal(frames.some((frame) => frame.field === 'name'), false);
});

test('promotion resolves logical references per target and rejects raw ids', () => {
  const delta = semanticDelta(rule(), rule({ approver: { value: { ref: 'rates/lead', kind: 'read' }, class: 'reference' } }));
  const targets = [
    { name: 'staging', map: { 'rates/lead': 'id-77' }, rawIds: ['id-77'] },
    { name: 'prod', map: {}, rawIds: ['id-91'] },
  ];
  const plan = promotionPlan(delta, targets);
  assert.equal(plan.rejected.length, 0);
  assert.deepEqual(plan.plans[0].resolved, [
    { target: 'staging', resolved: 'id-77' },
    { target: 'prod', resolved: null },
  ]);
  assert.deepEqual(plan.plans[0].unmapped, ['prod']);

  const rawDelta = semanticDelta(rule(), rule({ approver: { value: { ref: 'id-91', kind: 'read' }, class: 'reference' } }));
  const rawPlan = promotionPlan(rawDelta, targets);
  assert.equal(rawPlan.plans.length, 0);
  assert.match(rawPlan.rejected[0].reason, /environment-local id/);
});

test('an unchanged object has an empty delta, and the module reads nothing', async () => {
  const delta = semanticDelta(rule(), rule());
  assert.deepEqual(delta.changes, []);
  assert.deepEqual(delta.unknown, []);
  assert.equal(canonicalObject({ namespace: 'n', type: 't', id: '1', fields: { a: 'b' } }).digest, canonicalObject({ namespace: 'n', type: 't', id: '1', fields: { a: 'b' } }).digest);
  const source = await readFile(new URL('../src/actions/delta.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});
