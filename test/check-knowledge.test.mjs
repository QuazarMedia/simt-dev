// `simt check` validates the knowledge inputs a repository has authored (Plan 0005 K2).
//
// Six doors read six files under `.simt/knowledge/`, and each asserts a shape before
// it can answer. A file that is absent is legal; a file that is present but does not
// parse, or that misses the shape its door reads, is a red state no one sees until an
// agent reads the door. The gate catches it first: one finding per defect, naming the
// file, the defect, and the remedy. A repo that authored nothing keeps its check as it
// was - no findings, no change to the exit code.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git } from './fixture.mjs';
import { KNOWLEDGE_DIR, knowledgeInputFindings } from '../src/knowledge/inputs.mjs';
import { checkCommand, checkRepo } from '../src/commands/sync.mjs';

/** A scratch repository, initialized so the commands under test can resolve it. */
async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'simt-check-know-'));
  await git(['init', '-q', root]);
  return root;
}

/** Write the named inputs under the repository's knowledge directory. */
async function inputs(root, files) {
  const dir = join(root, KNOWLEDGE_DIR);
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
}

/** The findings this test is about: those under the knowledge directory. */
const knowledgeFindings = (findings) => findings.filter((f) => f.file?.startsWith('.simt/knowledge/'));

// The six inputs, each minimal and shaped for its door. A repo that authors all six
// and gets no findings is the "valid inputs stay green" case.
const VALID = {
  'claims.json': { claims: [{ id: 'c1', subject: 's', predicate: 'p', value: 'v' }], edges: [], artifacts: [] },
  'units.json': { units: [{ id: 'u1', path: 'a.md', text: 't' }] },
  'debt.json': { items: [{ id: 'd1', kind: 'k', effort: 1 }] },
  'impact.json': { graph: { nodes: [{ id: 'n1' }], edges: [] }, change: { refs: ['n1'] } },
  'derivations.json': { receipts: [], outputs: [], changes: [], observed: [] },
  'export.json': { schema: 'simt.bundle/1', version: 1, facts: [] },
};

// --- the validator, in isolation --------------------------------------------

test('a repo without the knowledge directory yields no findings', async () => {
  const root = await repo();
  assert.deepEqual(await knowledgeInputFindings(root), []);
});

test('valid inputs yield no findings', async () => {
  const root = await repo();
  await inputs(root, VALID);
  assert.deepEqual(await knowledgeInputFindings(root), []);
});

test('an unparseable input is a finding that names the file and a remedy', async () => {
  const root = await repo();
  await inputs(root, { 'claims.json': '{ not json' });
  const findings = await knowledgeInputFindings(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, '.simt/knowledge/claims.json');
  assert.equal(findings[0].status, 'invalid');
  assert.match(findings[0].detail, /not JSON/);
  assert.ok(findings[0].remedy);
});

test('an input that is not a JSON object is a finding', async () => {
  const root = await repo();
  await inputs(root, { 'units.json': '[1, 2, 3]' });
  const findings = await knowledgeInputFindings(root);
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /object/);
});

test('each door is checked against the shape it reads', async () => {
  // why: claims must be a list.
  let root = await repo();
  await inputs(root, { 'claims.json': { claims: 'not a list' } });
  assert.ok((await knowledgeInputFindings(root)).some((f) => f.detail.includes('claims list')));

  // rank: units must be a list.
  root = await repo();
  await inputs(root, { 'units.json': { units: {} } });
  assert.ok((await knowledgeInputFindings(root)).some((f) => f.detail.includes('units list')));

  // debt: items must be a list.
  root = await repo();
  await inputs(root, { 'debt.json': { items: 'nope' } });
  assert.ok((await knowledgeInputFindings(root)).some((f) => f.detail.includes('items list')));

  // impact: a graph with nodes is required.
  root = await repo();
  await inputs(root, { 'impact.json': { change: { refs: ['n1'] } } });
  assert.ok((await knowledgeInputFindings(root)).some((f) => f.detail.includes('graph')));

  // impact: a present change.refs must be a list.
  root = await repo();
  await inputs(root, { 'impact.json': { graph: { nodes: [{ id: 'n1' }] }, change: { refs: 'n1' } } });
  assert.ok((await knowledgeInputFindings(root)).some((f) => f.detail.includes('change.refs')));

  // derivations: a present field must be a list.
  root = await repo();
  await inputs(root, { 'derivations.json': { receipts: 'nope' } });
  assert.ok((await knowledgeInputFindings(root)).some((f) => f.detail.includes('receipts')));

  // import: the schema must be the bundle schema.
  root = await repo();
  await inputs(root, { 'export.json': { version: 1, facts: [] } });
  assert.ok((await knowledgeInputFindings(root)).some((f) => f.detail.includes('schema')));
});

test('an absent file is legal: a repo with a subset of inputs validates only what is present', async () => {
  const root = await repo();
  // Only the claims door is authored; the other five files are absent.
  await inputs(root, { 'claims.json': { claims: [{ id: 'c1' }] } });
  assert.deepEqual(await knowledgeInputFindings(root), []);
});

// --- the gate: checkRepo and checkCommand -----------------------------------

test('checkRepo fails on a malformed input and names the file and remedy', async () => {
  const root = await repo();
  await inputs(root, { 'claims.json': { claims: 'not a list' } });
  const { ok, findings } = await checkRepo(root);
  assert.equal(ok, false);
  const finding = knowledgeFindings(findings).find((f) => f.file === '.simt/knowledge/claims.json');
  assert.ok(finding, 'the malformed input was not reported');
  assert.equal(finding.status, 'invalid');
  assert.ok(finding.remedy);
});

test('checkRepo passes on valid inputs', async () => {
  const root = await repo();
  await inputs(root, VALID);
  const { findings } = await checkRepo(root);
  assert.deepEqual(knowledgeFindings(findings), []);
});

test('checkRepo is unaffected by an absent knowledge directory', async () => {
  const root = await repo();
  const { findings } = await checkRepo(root);
  assert.deepEqual(knowledgeFindings(findings), []);
});

test('checkCommand exits non-zero and prints the file and remedy', async () => {
  const root = await repo();
  await inputs(root, { 'claims.json': '{ not json' });
  let out = '';
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    out += chunk;
    return write(chunk, ...rest);
  };
  try {
    const code = await checkCommand([], { root });
    assert.equal(code, 1);
    assert.match(out, /claims\.json/);
    assert.match(out, /remedy:/);
  } finally {
    process.stdout.write = write;
  }
});
