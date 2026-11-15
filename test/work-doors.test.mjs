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

test('knowledge why exits non-zero on a claim the reader refused (A06)', () => {
  // The refused record stayed in the map, so the requested id was found, `renderWhy`
  // printed `asserts undefined undefined = undefined`, and the command exited 0.
  const dir = repo();
  const claims = write(dir, 'bad-claims.json', { claims: [{ id: 'bad' }] });
  assert.throws(() => run(dir, ['knowledge', 'why', 'bad', '--claims', claims]), (error) => {
    assert.match(String(error.stderr), /claim bad was refused/);
    assert.doesNotMatch(String(error.stdout ?? ''), /asserts undefined/);
    return true;
  });
});

test('a refused sibling stays reported but leaves the why-graph (A07)', () => {
  const dir = repo();
  const claims = write(dir, 'mixed-claims.json', {
    claims: [
      { id: 'c1', subject: 'de.vat', predicate: 'standard-rate', type: 'number', value: 19, unit: '%' },
      { id: 'refused-sibling' },
    ],
    edges: [{ from: 'c1', to: 'refused-sibling', kind: 'derived-from', status: 'reviewed' }],
  });
  const payload = json(dir, ['knowledge', 'why', 'c1', '--claims', claims]);
  assert.equal(payload.impact.reachable.includes('refused-sibling'), false, 'a refused claim is not a dependent');
  assert.equal(payload.lineage.reachable.includes('refused-sibling'), false, 'a refused claim is not a source');
  assert.equal(payload.graph.edges, 0, 'the edge to the refused claim is still in the graph');
  assert.equal(payload.impact.total, 1, 'the refused claim was counted as a dependent node');
  assert.equal(payload.lineage.total, 1, 'the refused claim was counted as a source node');
  assert.ok(
    payload.problems.some((problem) => problem.includes('refused-sibling')),
    'the refusal is still reported in the problems list',
  );
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

test('a paged door says how much it cut, and the next page continues from there', () => {
  const dir = repo();
  const claims = write(dir, 'claims.json', CLAIMS);
  const first = json(dir, ['knowledge', 'why', 'c1', '--claims', claims, '--limit', '1']);
  // c1 is depended on by c3, so the impact walk has two nodes and a page of one cuts it.
  assert.equal(first.page.size, 1);
  assert.equal(first.impact.total, 2);
  assert.deepEqual(first.impact.reachable, ['c1']);
  assert.equal(first.impact.truncated, true);

  const second = json(dir, ['knowledge', 'why', 'c1', '--claims', claims, '--limit', '1', '--page', '1']);
  assert.deepEqual(second.impact.reachable, ['c3']);
  assert.equal(second.impact.truncated, false);

  // `size` is the limit; printing it after "of" made `page 0 of 1` read as one page when
  // the document held two nodes (A18).
  const text = run(dir, ['knowledge', 'why', 'c1', '--claims', claims, '--limit', '1']);
  assert.match(text, /page\s+0 \(limit 1, 2 node\(s\)\)/);
  assert.doesNotMatch(text, /page\s+0 of 1/);

  // A present flag with a bad value is a usage error, not the default (A19).
  for (const bad of [['--limit', 'foo'], ['--page', '-1']]) {
    assert.throws(() => run(dir, ['knowledge', 'why', 'c1', '--claims', claims, ...bad]), (error) => {
      assert.equal(error.status, 2, `${bad.join(' ')} did not exit 2`);
      assert.match(String(error.stderr), /--(limit|page) must be/);
      return true;
    });
  }
});

test('export filters by permission before the page, and import accepts it as data only', () => {
  const dir = repo();
  const doc = write(dir, 'facts.json', {
    repository: 'producer',
    permissionsHeld: ['public'],
    limit: 5,
    facts: [
      { id: 'a', text: 'public one', revision: { ref: 'r1', digest: 'sha256-a' } },
      { id: 'b', text: 'internal one', permission: 'internal', revision: { ref: 'r1', digest: 'sha256-b' } },
      { id: 'c', text: 'public two', revision: { ref: 'r1', digest: 'sha256-c' } },
    ],
  });
  const exported = json(dir, ['knowledge', 'export', '--input', doc]);
  assert.deepEqual(exported.bundle.facts.map((fact) => fact.id), ['a', 'c']);
  assert.equal(exported.bundle.omitted.restricted, 1);

  const bundle = write(dir, 'bundle.json', exported.bundle);
  const imported = json(dir, ['knowledge', 'import', '--input', bundle]);
  assert.equal(imported.ok, true);
  assert.deepEqual(imported.facts.map((fact) => fact.id), ['a', 'c']);
  assert.equal(imported.executed, false);
  assert.deepEqual(imported.effects, []);
});

test('an expired packet is refused, and the refusal names the expiry', () => {
  const dir = repo();
  const packet = {
    schema: 'simt.bundle/1',
    version: 1,
    producer: { repository: 'r', digest: 'sha256-p' },
    expiresAt: '2026-01-01',
    facts: [{ id: 'a', text: 'one', revision: { ref: 'r1', digest: 'sha256-a' } }],
  };
  const wrapped = write(dir, 'wrapped.json', { bundle: packet, at: '2026-06-01' });
  assert.throws(() => run(dir, ['knowledge', 'import', '--input', wrapped]), (error) => {
    assert.match(String(error.stdout), /expired|2026-01-01/);
    return true;
  });
});

test('the doors the knowledge module declares exist on both surfaces, and neither writes', async () => {
  const { SPEC } = await import('../src/commands/spec.mjs');
  const { TOOLS } = await import('../src/mcp/tools.mjs');
  const { checkDoors, READ_ONLY_DOORS } = await import('../src/knowledge/bundle.mjs');
  // The structural check W23's acceptance names, run against the real registry rather than a
  // fixture: the fixture version passed while none of the four doors existed.
  const cli = SPEC.map((row) => ({ name: row.path, writes: row.writes !== undefined }));
  const mcp = TOOLS.map((tool) => ({ name: tool.name, writes: false }));
  assert.deepEqual(checkDoors({ cli, mcp }), { ok: true, errors: [], doors: READ_ONLY_DOORS.map((door) => door.name) });
});

test('a change with no admissible validator is unverified, never a green claim', () => {
  const dir = repo();
  const doc = write(dir, 'select.json', {
    changed: ['docs/rates.md'],
    typed: [{ id: 'o1', paths: ['docs/rates.md'] }],
    validators: [],
  });
  const payload = json(dir, ['verify', 'select', '--input', doc]);
  assert.equal(payload.selection.status, 'unverified');
  assert.equal(payload.selection.claimsGreen, false);
  assert.deepEqual(payload.selection.unverified, [{ obligation: 'o1', reason: 'no-admissible-validator' }]);
  assert.equal(payload.selection.plan.length, 0);
});

test('a mandatory validator is taken before any cheaper alternative', () => {
  const dir = repo();
  const doc = write(dir, 'select.json', {
    changed: ['docs/rates.md'],
    typed: [{ id: 'o1', paths: ['docs/rates.md'] }],
    validators: [
      { id: 'cheap', covers: ['o1'], cost: 1 },
      { id: 'mandatory', covers: ['o1'], cost: 9, mandatory: true },
    ],
  });
  const payload = json(dir, ['verify', 'select', '--input', doc]);
  const byId = new Map(payload.selection.plan.map((entry) => [entry.id, entry]));
  assert.equal(byId.get('mandatory').basis, 'mandatory');
  // A floor is not a candidate: once the mandatory validator covers o1, nothing is left to
  // cover, so the cheaper alternative is not taken as well.
  assert.equal(byId.has('cheap'), false);
  assert.equal(payload.selection.status, 'ok');
});

test('a Git hook may not run a remote validator, and the refusal cites no absent command', () => {
  const dir = repo();
  const doc = write(dir, 'select.json', {
    changed: ['src/a.mjs'],
    typed: [{ id: 'o1', paths: ['src/a.mjs'] }],
    validators: [{ id: 'live-read', class: 'remote', covers: ['o1'], environment: 'production' }],
    invocation: 'git-hook',
  });
  const payload = json(dir, ['verify', 'select', '--input', doc]);
  assert.equal(payload.run.ok, false);
  assert.equal(payload.run.code, 'remote-from-hook');
  assert.ok(!/simt verify run/.test(payload.run.remedy), 'the remedy cites a command this binary cannot dispatch');
  assert.deepEqual(payload.selection.environment, ['production']);

  const allowed = json(dir, ['verify', 'select', '--input', write(dir, 'ok.json', {
    changed: ['src/a.mjs'],
    typed: [{ id: 'o1', paths: ['src/a.mjs'] }],
    validators: [{ id: 'live-read', class: 'remote', covers: ['o1'], environment: 'production' }],
  })]);
  assert.equal(allowed.run.ok, true);
  assert.equal(allowed.run.executesRemote, true);
});

test('knowledge why answers what applied at a date, not what is newest', () => {
  const dir = repo();
  const doc = write(dir, 'history.json', {
    claims: [
      { id: 'old', subject: 'vat', predicate: 'rate', type: 'number', value: 19, validFrom: '2024-01-01', validTo: '2025-01-01', recordedFrom: '2024-01-01' },
      { id: 'new', subject: 'vat', predicate: 'rate', type: 'number', value: 20, validFrom: '2025-01-01', recordedFrom: '2025-01-01' },
    ],
  });
  const then = json(dir, ['knowledge', 'why', 'old', '--claims', doc, '--as-of', '2024-06-01', '--known-at', '2025-06-01']);
  assert.equal(then.at.result, 'applicable');
  assert.deepEqual(then.at.claims.map((claim) => claim.id), ['old']);

  const now = json(dir, ['knowledge', 'why', 'old', '--claims', doc, '--as-of', '2025-06-01', '--known-at', '2025-06-01']);
  assert.deepEqual(now.at.claims.map((claim) => claim.id), ['new']);
});

test('a bitemporal question with one date is refused rather than answered', () => {
  const dir = repo();
  const doc = write(dir, 'history.json', {
    claims: [{ id: 'a', subject: 'vat', predicate: 'rate', type: 'number', value: 19, validFrom: '2024-01-01', recordedFrom: '2024-01-01' }],
  });
  assert.throws(() => run(dir, ['knowledge', 'why', 'a', '--claims', doc, '--as-of', '2024-06-01']), (error) => {
    assert.match(String(error.stderr), /knownAt/);
    return true;
  });
});
