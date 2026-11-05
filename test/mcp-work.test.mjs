// A16: the tool called `knowledgeWhyFacts(document, id)` and dropped the paging and
// bitemporal arguments the CLI function already took, so an MCP client could not ask for
// page 2 and could not ask what was known at a date. The spec advertised no flags, which
// is why the spec test (A16's other half) could not see the gap.
//
// A17: `knowledge_import` returned `{ok: true, doc}` unconditionally, so an expired bundle
// arrived as a successful call whose payload said the import failed.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TOOLS } from '../src/mcp/tools.mjs';
import { knowledgeExportFacts } from '../src/commands/knowledge.mjs';

const why = TOOLS.find((tool) => tool.name === 'knowledge_why');
const importTool = TOOLS.find((tool) => tool.name === 'knowledge_import');

const document = {
  claims: [
    { id: 'c1', subject: 'rates', predicate: 'vat', type: 'number', value: 20, unit: '%', status: 'reviewed', validFrom: '2024-01-01', recordedFrom: '2024-01-02' },
    { id: 'c2', subject: 'totals', predicate: 'gross', type: 'number', value: 100, status: 'reviewed', validFrom: '2024-01-01', recordedFrom: '2024-01-02' },
  ],
  edges: [{ from: 'c2', kind: 'derived-from', to: 'c1', status: 'reviewed' }],
};

test('knowledge_why carries limit and page through to the answer (A16)', async () => {
  const unpaged = await why.run({ id: 'c2', document });
  assert.equal(unpaged.ok, true);

  const paged = await why.run({ id: 'c2', document, limit: 1, page: 1 });
  assert.equal(paged.ok, true);
  assert.equal(paged.doc.page.size, 1);
  assert.equal(paged.doc.page.index, 1);
  assert.notEqual(paged.doc.page.index, unpaged.doc.page.index, 'page was ignored');
});

test('knowledge_why answers a bitemporal question when both dates are given (A16)', async () => {
  const answered = await why.run({ id: 'c1', document, asOf: '2024-06-01', knownAt: '2024-01-03' });
  assert.notEqual(answered.doc.at, null, 'both dates were passed and no bitemporal answer came back');

  // One date is not a bitemporal question; the CLI refuses it and the transport must too.
  await assert.rejects(why.run({ id: 'c1', document, asOf: '2024-06-01' }), /asOf|knownAt|both|date/i);
});

test('knowledge_import reports a failed import as a failed call (A17)', async () => {
  const exported = knowledgeExportFacts({ facts: [], repository: 'r', revisions: [], expiresAt: '2000-01-01' });
  const expired = await importTool.run({ document: { bundle: exported.bundle, at: '2024-01-01' } });
  assert.equal(expired.ok, false, 'the envelope said the call succeeded');
  assert.equal(expired.doc.ok, false);
  assert.ok(expired.doc.problems.some((problem) => problem.code === 'expired'));

  const valid = await importTool.run({ document: { bundle: knowledgeExportFacts({ facts: [], repository: 'r', revisions: [] }).bundle } });
  assert.equal(valid.ok, true);
  assert.equal(valid.doc.ok, true);
});
