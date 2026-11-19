// A repository may declare its own ecosystem (review 0005 PR10).
//
// The contract is small: a validated record under `.simt/ecosystems/` may name the facts
// its markers prove, the language its extensions belong to, how its tests are named, and
// the gate row that proves it. Everything it cannot say - or says badly - is quarantined
// whole, named by `check`, and leaves the shipped record with its id in force.

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  ecosystemFindings,
  ecosystemGateRows,
  ecosystemProblems,
  languageResolver,
  loadEcosystems,
} from '../src/ecosystem/records.mjs';
import { validateRecord } from '../src/ecosystem/schema.mjs';
import { langOf } from '../src/index/store.mjs';
import { fingerprint } from '../src/resolve/fingerprint.mjs';
import { isTestPath } from '../src/testing/paths.mjs';
import { tempDir } from './fixture.mjs';

async function repo(files = {}) {
  const root = await tempDir("ecosystem-");
  await mkdir(join(root, '.simt', 'ecosystems'), { recursive: true });
  for (const [path, body] of Object.entries(files)) {
    await writeFile(join(root, path), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
  return root;
}

const acme = {
  v: 1,
  id: 'acme',
  tool: 'acme',
  facts: ['has-acme-spec'],
  markers: ['acme.spec'],
  manifestOrder: 99,
  gates: { preCommit: ['build'] },
  languages: [
    { lang: 'acme', exts: ['.acme'], testConventions: { base: ['\\.acmetest\\.acme$'] } },
  ],
};

test('a local record proves its own facts from its own markers', async () => {
  const root = await repo({ 'acme.spec': 'x', '.simt/ecosystems/acme.json': acme });
  const print = await fingerprint(root);
  assert.ok(print.facts.includes('has-acme-spec'));
  assert.equal(print.factEvidence['has-acme-spec'], 'acme.spec');

  const missing = await repo({ '.simt/ecosystems/acme.json': acme });
  assert.ok(!(await fingerprint(missing)).facts.includes('has-acme-spec'));
});

test('a local record adds a language, a test naming and a gate row', async () => {
  const root = await repo({ '.simt/ecosystems/acme.json': acme });
  assert.equal(languageResolver(root).acme, 'acme');
  assert.equal(languageResolver().acme, undefined);
  assert.equal(langOf('src/thing.acme', root), 'acme');
  assert.equal(langOf('src/thing.acme'), '');

  assert.equal(isTestPath('src/thing.acmetest.acme', root), true);
  assert.equal(isTestPath('src/thing.acmetest.acme'), false);
  // The built-in conventions still answer for the same root.
  assert.equal(isTestPath('test/thing.js', root), true);

  const row = ecosystemGateRows(root).find((entry) => entry.fact === 'has-acme-spec');
  assert.ok(row, 'the record contributes a gate row');
  assert.equal(row.tool, 'acme');
  assert.deepEqual(row.preCommit, ['build']);
});

test('an invalid record is quarantined whole, and named', async () => {
  const root = await repo({
    // `manifestOrder` with no `facts` is the shape that crashed `init` on `facts[0]`.
    '.simt/ecosystems/broken.json': { id: 'broken', manifestOrder: 3 },
  });
  assert.ok(!loadEcosystems(root).some((record) => record.id === 'broken'));
  assert.equal(ecosystemGateRows(root).length, ecosystemGateRows().length, 'built-ins survive');
  const problems = ecosystemProblems(root);
  assert.equal(problems.length >= 1, true);
  assert.equal(problems[0].file, '.simt/ecosystems/broken.json');
  assert.equal(problems[0].status, 'ecosystem-record-invalid');
  assert.match(problems[0].detail, /manifestOrder needs facts/);
});

test('an override that is valid merges over the shipped record', async () => {
  const root = await repo({
    '.simt/ecosystems/node.json': { v: 1, id: 'node', languages: [{ lang: 'node', exts: ['.jsx'] }] },
  });
  const node = loadEcosystems(root).find((record) => record.id === 'node');
  assert.equal(node.id, 'node');
  // Local fields win, shipped fields the local record omits stay.
  assert.deepEqual(node.languages, [{ lang: 'node', exts: ['.jsx'] }]);
  // A shipped field the local record omits stays, which is what makes an override
  // an override and not a replacement.
  assert.ok(Array.isArray(node.dependabot));
});

test('the schema refuses a future version and a self-contradicting id', () => {
  assert.equal(validateRecord('acme', { ...acme, v: 99 }).ok, false);
  assert.equal(validateRecord('acme', { ...acme, id: 'other' }).ok, false);
  assert.equal(validateRecord('acme', { ...acme, markers: ['../escape'] }).ok, false);
  assert.equal(validateRecord('acme', { ...acme, languages: [{ lang: 'acme', exts: ['acme'] }] }).ok, false);
  assert.equal(validateRecord('acme', acme).ok, true);
});

test('an invalid local record becomes a blocking check finding', async () => {
  const root = await repo({ '.simt/ecosystems/broken.json': { id: 'broken', v: 7 } });
  const [finding] = ecosystemFindings(root);
  assert.equal(finding.file, '.simt/ecosystems/broken.json');
  assert.equal(finding.status, 'ecosystem-record-invalid');
  assert.match(finding.detail, /newer than this build/);
  assert.match(finding.remedy, /remove it/);
});
