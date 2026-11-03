// The plan-4 read-only doors (W20/W29), exercised as a consumer runs them.
//
// Every test below runs `bin/simt.mjs` from a directory that is not this checkout, because a
// door that only works from its own source tree is the failure ADR-031 exists to catch. The
// documents are written to a temporary directory and passed by path, or piped as `-`.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const BIN = fileURLToPath(new URL('../bin/simt.mjs', import.meta.url));

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'simt-doors-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

function run(cwd, args, { input } = {}) {
  const result = execFileSync(process.execPath, [BIN, ...args], {
    cwd,
    input: input ?? '',
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return result;
}

function json(cwd, args, options) {
  return JSON.parse(run(cwd, [...args, '--json'], options));
}

const CLAIMS = {
  claims: [
    { id: 'c1', subject: 'rates.2024', predicate: 'vat', type: 'number', value: 20, unit: 'percent', status: 'reviewed', validFrom: '2024-01-01', recordedFrom: '2024-01-02' },
    { id: 'c2', subject: 'rates.2024', predicate: 'vat', type: 'number', value: 19, unit: 'percent', status: 'reviewed', validFrom: '2024-01-01', recordedFrom: '2024-01-02' },
    { id: 'c3', subject: 'totals', predicate: 'gross', type: 'number', value: 100, status: 'reviewed', validFrom: '2024-01-01', recordedFrom: '2024-01-02' },
  ],
  edges: [{ from: 'c3', kind: 'derived-from', to: 'c1', status: 'reviewed' }],
};

function write(dir, name, doc) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(doc));
  return path;
}

test('work inspect reports the five validations and says no work declaration exists', () => {
  const dir = repo();
  const payload = json(dir, ['work', 'inspect']);
  assert.equal(payload.command, 'work inspect');
  assert.deepEqual(
    payload.capabilities.map((card) => card.kind),
    ['structural', 'rubric', 'replay', 'remote-read', 'remote-write'],
  );
  assert.equal(payload.work.declared, false);
  // A repository with no declared gate must not be told a structural check is available.
  const structural = payload.capabilities.find((card) => card.kind === 'structural');
  assert.equal(structural.available, false);
});

test('knowledge why separates what a claim derives from what depends on it', () => {
  const dir = repo();
  const payload = json(dir, ['knowledge', 'why', 'c1', '--claims', write(dir, 'claims.json', CLAIMS)]);
  // c1 is the source of the edge, so nothing feeds it and c3 is what it would break.
  assert.deepEqual(payload.lineage.reachable.filter((id) => id !== 'c1'), []);
  assert.deepEqual(payload.impact.reachable.filter((id) => id !== 'c1'), ['c3']);
  assert.equal(payload.conflicts.length, 1);
  assert.equal(payload.conflicts[0].verdict, 'contradiction');
  assert.equal(payload.certifies, false);
});

test('knowledge why refuses an id the document does not hold, and says how many it does', () => {
  const dir = repo();
  const claims = write(dir, 'claims.json', CLAIMS);
  assert.throws(() => run(dir, ['knowledge', 'why', 'nope', '--claims', claims]), (error) => {
    assert.match(String(error.stderr), /no claim nope/);
    assert.match(String(error.stderr), /3 claim/);
    return true;
  });
});

test('verify plan offers only what the constraints admit, and reports what it excluded', () => {
  const dir = repo();
  const doc = write(dir, 'plan.json', {
    obligations: [{ id: 'o1', state: 'not-run', predicate: { kind: 'replay' } }],
    capabilities: [
      { id: 'offline', predicateKinds: ['replay'], coverage: 'all', cost: 1, latency: 1 },
      { id: 'network-only', obligations: ['o1'], requiresNetwork: true, cost: 1 },
    ],
    constraints: { network: false },
  });
  const payload = json(dir, ['verify', 'plan', '--input', doc]);
  assert.deepEqual(payload.plan.offers.map((offer) => offer.id), ['offline']);
  assert.deepEqual(payload.plan.excluded, [{ id: 'network-only', reason: 'network' }]);
  assert.equal(payload.plan.offers[0].executed, false);
});

test('verify plan stops rather than repeating an offer nothing can satisfy', () => {
  const dir = repo();
  const doc = write(dir, 'plan.json', {
    obligations: [{ id: 'o1', state: 'not-run', requiresDecision: true }],
    capabilities: [],
  });
  const payload = json(dir, ['verify', 'plan', '--input', doc]);
  assert.equal(payload.plan.offers.length, 0);
  assert.equal(payload.plan.stop.retry, false);
  assert.equal(payload.plan.stop.missing[0].kind, 'decision');
});

test('verify status never reads an unreachable verifier as a pass', () => {
  const dir = repo();
  // An obligation with no recorded state is `unknown`, which is also not a pass; both start
  // from a recorded pass here so the only unresolved one is the unreachable verifier.
  const doc = write(dir, 'status.json', {
    obligations: [{ id: 'o1', state: 'pass' }, { id: 'o2', state: 'pass' }],
    evidence: [{ obligation: 'o1', state: 'pass' }, { obligation: 'o2', state: 'unavailable' }],
  });
  const payload = json(dir, ['verify', 'status', '--input', doc]);
  assert.equal(payload.report.verdict, 'BLOCK');
  assert.deepEqual(payload.report.unresolved.map((check) => check.state), ['unavailable']);
});

test('a bare verify group reads the status it defaults to', () => {
  const dir = repo();
  const doc = write(dir, 'status.json', { obligations: [{ id: 'o1', state: 'pass' }], evidence: [{ obligation: 'o1', state: 'pass' }] });
  const payload = json(dir, ['verify', '--input', doc]);
  assert.equal(payload.command, 'verify status');
  assert.equal(payload.report.verdict, 'COMPLETE');
});

test('action status calls an interrupted dispatch what it is', () => {
  const dir = repo();
  const journal = write(dir, 'journal.json', {
    journal: [{ state: 'planned' }, { from: 'planned', to: 'ready' }, { from: 'ready', to: 'executing' }],
  });
  const payload = json(dir, ['action', 'status', '--journal', journal]);
  assert.equal(payload.state, 'executing');
  assert.equal(payload.inFlight, true);
  assert.equal(payload.resumable, true);
  assert.equal(payload.guarantee.promise, 'at-least-once');
  assert.match(payload.reason, /may be in flight/);
});

test('an empty journal is an unknown state, not a passed one', () => {
  const dir = repo();
  const journal = write(dir, 'empty.json', { journal: [] });
  const payload = json(dir, ['action', 'status', '--journal', journal]);
  assert.equal(payload.state, null);
  assert.equal(payload.resumable, false);
  assert.equal(payload.recovery, null);
});

test('the doors read a document from stdin when the flag is -', () => {
  const dir = repo();
  const payload = json(dir, ['verify', 'plan', '--input', '-'], { input: JSON.stringify({ obligations: [], capabilities: [] }) });
  assert.equal(payload.plan.offers.length, 0);
});

test('a document that is not JSON is a usage error, not a crash', () => {
  const dir = repo();
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{not json');
  assert.throws(() => run(dir, ['verify', 'status', '--input', bad]), (error) => {
    assert.equal(error.status, 2);
    assert.match(String(error.stderr), /is not JSON/);
    return true;
  });
});

test('each door answers over MCP with the same facts the command reports', async () => {
  const { TOOLS } = await import('../src/mcp/tools.mjs');
  const names = ['work_inspect', 'knowledge_why', 'verify_plan', 'verify_status', 'action_status'];
  for (const name of names) assert.ok(TOOLS.some((tool) => tool.name === name), `${name} is not exposed`);

  const status = TOOLS.find((tool) => tool.name === 'verify_status');
  const result = await status.run({ document: { obligations: [{ id: 'o1' }], evidence: [{ obligation: 'o1', state: 'fail' }] } });
  assert.equal(result.doc.command, 'verify status');
  assert.equal(result.doc.report.verdict, 'BLOCK');

  const why = TOOLS.find((tool) => tool.name === 'knowledge_why');
  const explained = await why.run({ id: 'c3', document: CLAIMS });
  assert.equal(explained.doc.command, 'knowledge why');
  assert.deepEqual(explained.doc.lineage.reachable.filter((id) => id !== 'c3'), ['c1']);
});
