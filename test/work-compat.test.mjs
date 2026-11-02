// Plan 0004 W01: the predecessor audit and the compatibility baseline.
//
// The failure this slice exists for is a document that says Complete while one of its
// own cells records 55.6% against a 60% bar, and no evidence column at all. The audit is
// tested against that shape, and against the real plan 0003 tracker, because an audit
// that only passes on a fixture proves the fixture.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { auditPredecessor, captureBaseline, compareBaselines, metricOf } from '../packages/bench/src/compat.mjs';
import { keepTemp } from './fixture.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

/** A tree with the files a case names. The audit reads docs; it does not need git. */
async function repo(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'simt-compat-'));
  keepTemp(root);
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }
  return root;
}

test('metricOf reads a bar and a measurement, and refuses to grade a claim', () => {
  assert.deepEqual(metricOf('recall@10 55.6% (bar 60%)'), {
    claim: 'recall@10 55.6% (bar 60%)',
    measured: 55.6,
    bar: 60,
    disposition: 'missed',
  });
  assert.equal(metricOf('exact 100% (bar 90%)').disposition, 'met');
  assert.equal(metricOf('unmeasured').disposition, 'unmeasured');
  // A bare phrase is a claim, not a measurement: grading it either way would invent a
  // number the tracker never recorded.
  assert.equal(metricOf('exact scope/representation resolution').disposition, 'claim');
  assert.equal(metricOf('—').disposition, 'none');
});

const TRACKED = `# plan

## 14. Tracker

| ID | Slice | Needs ADR | Success metric | State | SHA / evidence |
| --- | --- | --- | --- | --- | --- |
| R01 | measured and missed | — | recall@10 55.6% (bar 60%) | Complete | abc1234 · test: npm test |
| R02 | complete with no evidence | ADR-076 | exact scope | Complete | |
| R03 | unmeasured and unmatched | ADR-9999 | unmeasured | Queued | |
`;

test('audit: a row is graded by its own cells, not by its state', async () => {
  const root = await repo({ 'docs/research/0099.md': TRACKED });
  const audit = await auditPredecessor(root, { docPrefix: '0099' });
  assert.equal(audit.found, 3);
  const byId = new Map(audit.rows.map((row) => [row.id, row]));
  assert.equal(byId.get('R01').disposition, 'metric-missed');
  assert.equal(byId.get('R01').evidence.sha, 'abc1234');
  assert.equal(byId.get('R01').evidence.test, 'npm test');
  assert.equal(byId.get('R02').disposition, 'unverified');
  assert.equal(byId.get('R03').disposition, 'open');
  assert.equal(byId.get('R03').metric.disposition, 'unmeasured');
  assert.equal(byId.get('R03').adr.status, null, 'an unmatched record has no status to claim');
  assert.ok(audit.issues.some((issue) => /R01: measured 55\.6% against a 60% bar/.test(issue)), audit.issues.join('\n'));
  assert.ok(audit.issues.some((issue) => /R02: complete with no evidence/.test(issue)), audit.issues.join('\n'));
  assert.ok(audit.issues.some((issue) => /R03: names ADR-9999/.test(issue)), audit.issues.join('\n'));
});

test('audit: the real plan 0003 is read through the parser, including the R22 miss', async () => {
  const audit = await auditPredecessor(ROOT);
  assert.equal(audit.error, undefined, audit.error);
  assert.match(audit.doc, /^0003-/);
  assert.equal(audit.found, 55, 'R01-R55 are the predecessor rows');
  for (const row of audit.rows) assert.equal(typeof row.disposition, 'string', `${row.id} has no disposition`);
  const r22 = audit.rows.find((row) => row.id === 'R22');
  assert.deepEqual(
    { measured: r22.metric.measured, bar: r22.metric.bar, disposition: r22.metric.disposition },
    { measured: 55.6, bar: 60, disposition: 'missed' },
  );
  // Plan 0003's tracker has no evidence column. That is the honest finding, and it is
  // reported once rather than as fifty-five invented per-row failures.
  assert.ok(audit.issues.some((issue) => /no evidence column/.test(issue)), audit.issues.join('\n'));
  assert.ok(audit.unmeasured.length > 0, 'the unmeasured claims the plan itself names are surfaced');
});

test('baseline: two captures of one tree are equal, and survive a JSON round trip elsewhere', async () => {
  const root = await repo({ 'AGENTS.md': '# notes\n', 'simt.json': '{"schemaVersion":1}\n' });
  const first = await captureBaseline(root);
  const second = await captureBaseline(root);
  assert.deepEqual(second, first, 'a baseline that changes between captures cannot detect a change');

  // ADR-031's shape: the baseline is read back in a directory with no siblings, so an
  // absolute path baked into it would make the comparison fail for the wrong reason.
  const elsewhere = await mkdtemp(join(tmpdir(), 'simt-compat-'));
  try {
    const path = join(elsewhere, 'baseline.json');
    await writeFile(path, `${JSON.stringify(first, null, 2)}\n`);
    const reloaded = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(compareBaselines(first, reloaded), { equal: true, differences: [] });
  } finally {
    await rm(elsewhere, { recursive: true, force: true });
  }
});

test('baseline: records the environment, the loader bytes and no network unless configured', async () => {
  const root = await repo({ 'simt.json': '{"schemaVersion":1}\n' });
  const baseline = await captureBaseline(root);
  assert.equal(baseline.network, 'none');
  assert.equal(baseline.environment.seed, 0);
  assert.equal(baseline.environment.model, null);
  assert.match(baseline.environment.version, /\d+\.\d+\.\d+/);
  assert.ok(baseline.loaders.length > 0, 'every loader has bytes to compare');
  for (const row of baseline.loaders) assert.equal(typeof row.totalBytes, 'number', `${row.reader} has no bytes`);
  assert.deepEqual(baseline.json.map((entry) => entry.command), ['harness loaders', 'plan status']);
  for (const entry of baseline.json) assert.equal(entry.ok, true, `${entry.command} failed to capture`);
});

test('baseline: a changed projection is a named difference, not an equal document', async () => {
  const root = await repo({ 'AGENTS.md': '# notes\n' });
  const before = await captureBaseline(root);
  await writeFile(join(root, 'AGENTS.md'), '# notes changed\n');
  const after = await captureBaseline(root);
  const { equal, differences } = compareBaselines(before, after);
  assert.equal(equal, false);
  assert.ok(differences.some((diff) => diff.path === 'projections.0.digest'), JSON.stringify(differences));
  assert.ok(differences.every((diff) => typeof diff.path === 'string' && diff.path !== ''));
});
