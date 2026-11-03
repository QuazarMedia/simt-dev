// The acceptances of W12, W17, W19, W22, W38, W39, W44, W45, W46 and W47, exercised through the
// commands a reader would run. Each test names the clause it proves; a module that passes its own
// unit test and no door is exactly the state this file exists to make impossible.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const BIN = fileURLToPath(new URL('../bin/simt.mjs', import.meta.url));
const digest = (letter) => `sha256-${letter.repeat(64)}`;

function temp() {
  return mkdtempSync(join(tmpdir(), 'simt-accept-'));
}

function file(dir, name, doc) {
  const path = join(dir, name);
  writeFileSync(path, typeof doc === 'string' ? doc : JSON.stringify(doc));
  return path;
}

function run(args) {
  const result = spawnSync(process.execPath, [BIN, ...args, '--json'], {
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

test('W19: an applicable authority outranks an obsolete hub, and a held permission is filtered first', () => {
  const dir = temp();
  const units = [
    { id: 'a', path: 'knowledge/vat.md', text: 'VAT rate 20 percent applies to services', headings: ['VAT'], authority: 2, evidence: 1 },
    { id: 'b', path: 'blog/old.md', text: 'VAT rate 15 percent services', authority: 1, links: 40, stale: true },
    { id: 'c', path: 'private/vat.md', text: 'VAT internal rate', permission: 'confidential' },
  ];
  const doc = file(dir, 'units.json', { units });
  const ranked = run(['knowledge', 'rank', '--input', doc, '--query', 'VAT rate services']);
  assert.equal(ranked.payload.ranked[0].id, 'a');
  assert.ok(ranked.payload.ranked.find((hit) => hit.id === 'b').labels.includes('obsolete'));

  const denied = file(dir, 'restricted.json', { units, permissionsHeld: ['public'] });
  const filtered = run(['knowledge', 'rank', '--input', denied, '--query', 'VAT rate services']);
  assert.deepEqual(filtered.payload.excluded.filter((entry) => entry.reason === 'permission').map((entry) => entry.id).sort(), ['c']);
  assert.ok(!filtered.payload.ranked.some((hit) => hit.id === 'c'));
});

test('W19: a unit whose scope is unknown is reported beside the answer, not dropped or ranked', () => {
  const dir = temp();
  const doc = file(dir, 'scoped.json', {
    scope: { jurisdiction: 'eu' },
    units: [
      { id: 'known', path: 'a.md', text: 'VAT rate', scope: { jurisdiction: 'eu' } },
      { id: 'unplaced', path: 'b.md', text: 'VAT rate', scope: null },
      { id: 'elsewhere', path: 'c.md', text: 'VAT rate', scope: { jurisdiction: 'us' } },
    ],
  });
  const ranked = run(['knowledge', 'rank', '--input', doc, '--query', 'VAT rate']);
  assert.deepEqual(ranked.payload.ranked.map((hit) => hit.id), ['known']);
  assert.ok(ranked.payload.unknownScope.some((entry) => entry.id === 'unplaced'));
  assert.ok(ranked.payload.excluded.some((entry) => entry.id === 'elsewhere'));
});

test('W17: a changed input selects its output and a receipt-less output is not a minimal safe set', () => {
  const dir = temp();
  const changed = file(dir, 'receipts.json', {
    receipts: [
      {
        id: 'r1',
        output: { path: 'docs/rate.md', digest: digest('a') },
        inputs: [{ ref: 'rates.csv', digest: digest('b') }],
        tools: [{ kind: 'template', id: 'rate', version: '1.0.0', digest: digest('c') }],
      },
    ],
    changes: [{ ref: 'rates.csv', digest: digest('d') }],
  });
  const report = run(['knowledge', 'derivations', '--input', changed]);
  assert.deepEqual(report.payload.candidates.map((entry) => entry.output), ['docs/rate.md']);
  assert.deepEqual(report.payload.problems, []);

  const absent = file(dir, 'absent.json', { outputs: ['docs/unrelated.md'] });
  const unknown = run(['knowledge', 'derivations', '--input', absent]);
  assert.equal(unknown.payload.minimalSafe, false);
});

test('W47: a stale high-impact item outranks an orphan, and a weight change says which rank moved', () => {
  const dir = temp();
  const doc = file(dir, 'debt.json', {
    items: [
      { id: 'stale-source', kind: 'stale', affectedObligations: 9, criticality: 'high', queries: 0 },
      { id: 'orphan', kind: 'orphan', affectedObligations: 0, criticality: 'low', effort: 1 },
    ],
  });
  const report = run(['knowledge', 'debt', '--input', doc]);
  assert.equal(report.payload.ranked[0].id, 'stale-source');
  assert.equal(report.payload.coldStart.cold, true);

  // Two items whose totals cross when the obligations weight falls to zero, so the sensitivity
  // report has a rank change to explain rather than an explanation of no change.
  const tie = file(dir, 'sensitivity.json', {
    items: [
      { id: 'a', affectedObligations: 2, criticality: 'normal' },
      { id: 'b', affectedObligations: 0, criticality: 'high' },
    ],
    sensitivity: { field: 'obligations', to: 0 },
  });
  const shifted = run(['knowledge', 'debt', '--input', tie]);
  assert.ok(shifted.payload.sensitivity.moved.some((entry) => entry.id === 'a'));
  assert.match(shifted.payload.sensitivity.explanation, /obligations/);
});

test('W47: a confidential item is withheld from the estate aggregate', () => {
  const dir = temp();
  const doc = file(dir, 'confidential.json', {
    items: [
      { id: 'public', affectedObligations: 1, criticality: 'normal' },
      { id: 'secret', affectedObligations: 5, criticality: 'high', confidential: true },
    ],
  });
  const report = run(['knowledge', 'debt', '--input', doc]);
  assert.equal(report.payload.aggregate.confidentialExcluded, 1);
  assert.equal(report.payload.ranked.length, 2);
});

test('W12: a heading inside a code fence is not a section, and every heading gets an anchor', () => {
  const dir = temp();
  const doc = file(dir, 'long.md', '# Title\n\nintro\n\n## Rate\n\nVAT 20\n\n```\n## not a heading\n```\n');
  const report = run(['knowledge', 'sections', doc]);
  assert.deepEqual(report.payload.headings.map((heading) => heading.title), ['Title', 'Rate']);
  assert.deepEqual(report.payload.sections.map((section) => section.anchor), ['title', 'rate']);
});

test('W22: a change reaches the artifacts derived from it, and a bound exhaustion is incomplete', () => {
  const dir = temp();
  const graph = file(dir, 'graph.json', {
    nodes: [
      { id: 'claim:a', kind: 'claim' },
      { id: 'doc:b', kind: 'document' },
      { id: 'doc:c', kind: 'document' },
    ],
    edges: [
      { from: 'doc:b', to: 'claim:a', kind: 'derived-from', status: 'reviewed' },
      { from: 'doc:c', to: 'claim:a', kind: 'derived-from', status: 'reviewed' },
    ],
  });
  const report = run(['knowledge', 'impact', '--input', graph, '--refs', 'claim:a']);
  assert.deepEqual(report.payload.affected.artifacts, ['doc:b', 'doc:c']);
  assert.equal(report.payload.complete, true);

  const bounded = run(['knowledge', 'impact', '--input', graph, '--refs', 'claim:a', '--limit', '1']);
  assert.equal(bounded.payload.truncated, true);
  assert.equal(bounded.payload.conservative, true);
});

test('W38: two writers of one section serialize while an independent task dispatches', () => {
  const dir = temp();
  const doc = file(dir, 'schedule.json', {
    capacity: 3,
    tasks: [
      { id: 'a', writes: ['doc:1'] },
      { id: 'b', writes: ['doc:1'] },
      { id: 'c', writes: ['doc:2'] },
    ],
    evidence: { a: { current: true }, b: { current: true }, c: { current: true } },
  });
  const report = run(['work', 'schedule', '--input', doc]);
  assert.deepEqual(report.payload.dispatch.sort(), ['a', 'c']);
  assert.deepEqual(report.payload.serialized.map((entry) => entry.id), ['b']);
  assert.equal(report.payload.serialized[0].resource, 'doc:1');
});

test('W38: an expired predecessor reopens its dependents instead of dispatching them', () => {
  const dir = temp();
  const doc = file(dir, 'stale.json', {
    tasks: [
      { id: 'a' },
      { id: 'b', dependsOn: ['a'] },
    ],
    evidence: { a: { current: false } },
  });
  const report = run(['work', 'schedule', '--input', doc]);
  assert.deepEqual(report.payload.dispatch, ['a']);
  assert.deepEqual(report.payload.waiting.map((entry) => entry.id), ['b']);
});

test('W39: a capsule excludes secrets and a changed target reopens what it had completed', () => {
  const dir = temp();
  const capsule = file(dir, 'capsule.json', {
    goal: 'finish the rate update',
    intent: { digest: 'i1' },
    target: { identity: 'tracker', incarnation: 'inc-1' },
    completed: [{ obligation: 'ob-1', receipt: 'rc-1', revision: 'r7' }],
    budget: { actions: 3 },
  });
  const built = run(['work', 'handoff', '--input', capsule]);
  assert.ok(built.payload.capsule.excluded.includes('secrets'));
  assert.match(built.payload.capsule.digest, /^sha256/);

  const resume = file(dir, 'resume.json', {
    capsule: built.payload.capsule,
    context: { target: { incarnation: 'inc-2' } },
    executed: ['rc-1'],
  });
  const checked = run(['work', 'resume', '--input', resume]);
  assert.equal(checked.payload.resume.resumable, false);
  assert.equal(checked.payload.reopened.reopened[0].obligation, 'ob-1');
  assert.deepEqual(checked.payload.duplicates.duplicates, ['rc-1']);
});

test('W44: two validated runs are insufficient evidence, three are a proposal for review', () => {
  const dir = temp();
  const runs = (count) =>
    Array.from({ length: count }, (_, index) => ({
      id: `t${index}`,
      goal: 'rotate key',
      capability: 'vault',
      validated: true,
      steps: ['read', 'write'],
      values: [`host-${index}`],
    }));

  const two = file(dir, 'two.json', { traces: runs(2) });
  const thin = run(['work', 'graduate', '--input', two]);
  assert.equal(thin.payload.proposals[0].state, 'insufficient-evidence');

  const three = file(dir, 'three.json', {
    traces: runs(3),
    checks: { 'rotate key': { heldOut: { passed: true }, failurePath: { passed: true } } },
  });
  const proposal = run(['work', 'graduate', '--input', three]);
  assert.equal(proposal.payload.proposals[0].state, 'proposable');
  assert.deepEqual(proposal.payload.proposals[0].common, ['read', 'write']);
  assert.equal(proposal.payload.proposals[0].promotion.ready, true);
});

test('W45: a declared relation holds or fails, an undeclared one is reported, and a thin trace is not replayable', () => {
  const dir = temp();
  const trace = { intent: { digest: 'sha256-intent' }, observations: [{ fields: { rate: 0.19 } }], events: [{ id: 'e1' }] };

  const clean = run([
    'bench', 'replay', '--input', file(dir, 'clean.json', {
      trace,
      before: { fields: { rate: 0.19 } },
      after: { fields: { rate: 0.19 } },
      relations: ['rename-invariance', 'read-channel-equivalence'],
      options: { 'read-channel-equivalence': { answers: [{ rate: 0.19 }, { rate: 0.19 }] } },
    }),
  ]);
  assert.equal(clean.status, 0);
  assert.equal(clean.payload.metamorphic.holds, true);
  assert.equal(clean.payload.liveAcceptance, false);

  const violating = run([
    'bench', 'replay', '--input', file(dir, 'violating.json', {
      trace,
      before: { fields: { rate: 0.19 } },
      after: { fields: { rate: 0.2 } },
      relations: ['rename-invariance'],
    }),
  ]);
  assert.equal(violating.status, 1);
  assert.equal(violating.payload.metamorphic.holds, false);

  const undeclared = run([
    'bench', 'replay', '--input', file(dir, 'undeclared.json', { trace, before: { fields: {} }, after: { fields: {} }, relations: ['model-agreement'] }),
  ]);
  assert.equal(undeclared.payload.metamorphic.results[0].holds, false);

  const thin = run([
    'bench', 'replay', '--input', file(dir, 'thin.json', { trace: { intent: { digest: 'sha256-intent' }, observations: [], events: [] }, relations: ['rename-invariance'] }),
  ]);
  assert.equal(thin.payload.trace.replayable, false);
  assert.equal(thin.status, 1);
});

test('W46: an underpowered scope, and a hard constraint, both stay review-required', () => {
  const dir = temp();
  const prereg = { scope: 'doc', capability: 'doc-edit', falseAcceptCeiling: 0.05, minSamples: 30 };

  const thin = run([
    'bench', 'calibrate', '--input', file(dir, 'thin.json', {
      scope: 'doc',
      capability: 'doc-edit',
      pairs: [{ model: 'accept', expert: 'accept', scope: 'doc' }],
      prereg,
    }),
  ]);
  assert.equal(thin.payload.decision.decision, 'review-required');
  assert.match(thin.payload.decision.reason, /underpowered/);

  const pairs = Array.from({ length: 200 }, () => ({ model: 'accept', expert: 'accept', scope: 'doc' }));
  const blocked = run([
    'bench', 'calibrate', '--input', file(dir, 'blocked.json', {
      scope: 'doc',
      capability: 'doc-edit',
      pairs,
      prereg,
      policy: { hardConstraints: ['privacy'] },
    }),
  ]);
  assert.equal(blocked.payload.decision.decision, 'review-required');
  assert.match(blocked.payload.decision.reason, /hard/);

  const clean = run(['bench', 'calibrate', '--input', file(dir, 'clean.json', { scope: 'doc', capability: 'doc-edit', pairs, prereg })]);
  assert.equal(clean.payload.decision.decision, 'autonomous');
});
