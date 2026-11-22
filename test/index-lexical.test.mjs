import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  collectFileTerms, rankByLexicalTerms, SIGNATURE_TERMS, smoothedIdf, sparseTfIdfCosine, topFileSignature,
} from '../src/index/lexical.mjs';
import { SQLITE_FILE } from '../src/index/persist.mjs';
import { readFieldedFts, readFileSignatures, readGraph, readLexicalStats, reindex } from '../src/index/store.mjs';
import { ensureGit, git, tempDir } from './fixture.mjs';

const escrow = 'src/settlement.mjs';
const approval = 'src/approval.mjs';
const support = 'src/support.mjs';
const removed = 'src/old.mjs';

async function fixture() {
  const root = await tempDir('index-lexical-');
  await mkdir(join(root, 'src'));
  const files = {
    [escrow]: 'export function settleEscrow(ledger) { return ledger; }\n// escrow ledger settlement\n',
    [approval]: 'export function approveEscrow(ledger) { return ledger; }\n// escrow ledger approval\n',
    [support]: 'export function support() { return null; }\n// support support support support\n',
    [removed]: '// support singularcanary\n',
    'src/long.mjs': `${Array.from({ length: 50 }, (_, i) => `// support signal${i}\n`).join('')}${'// support\n'.repeat(800)}`,
  };
  for (let i = 0; i < 8; i += 1) files[`src/service-${i}.mjs`] = '// support service\n';
  for (const [path, data] of Object.entries(files)) await writeFile(join(root, path), data);
  await ensureGit(root);
  await reindex(root, { fielded: true });
  return root;
}

test('uses continuous rarity, not a corpus frequency cutoff', () => {
  assert.equal(smoothedIdf(10, 5), Math.log(2));
  assert.ok(smoothedIdf(10, 1) > smoothedIdf(10, 2));
  assert.ok(smoothedIdf(10, 9) > smoothedIdf(10, 10));
  assert.ok(smoothedIdf(10, 10) > 0);
  assert.throws(() => smoothedIdf(10, 11), /document frequency/);
});

test('rarity favours domain files and links siblings without an import', async () => {
  const root = await fixture();
  const stats = await readLexicalStats(root);
  const files = collectFileTerms(await readFieldedFts(root));
  const { signatures, error } = await readFileSignatures(root, [escrow, approval, support, 'src/long.mjs']);
  assert.equal(error, null);
  assert.equal(stats.error, null);
  assert.equal(stats.documents, 13);
  assert.equal(stats.terms.get('support').df, 11, 'hundreds of mentions in one file count as one document');
  assert.ok(stats.terms.get('support').cf > 800);
  assert.equal(stats.terms.get('escrow').df, 2);

  const ranking = rankByLexicalTerms(files, 'support escrow ledger', stats);
  assert.ok([escrow, approval].includes(ranking[0].path));
  assert.ok(ranking.findIndex(({ path }) => path === support) > 1);
  assert.deepEqual((await readGraph(root)).edges, []);
  const likeness = sparseTfIdfCosine(signatures.get(escrow), signatures.get(approval));
  assert.ok(likeness > sparseTfIdfCosine(signatures.get(escrow), signatures.get(support)));
  assert.equal(likeness, sparseTfIdfCosine([...signatures.get(escrow)].reverse(), signatures.get(approval)));
  assert.equal(sparseTfIdfCosine([], signatures.get(approval)), 0);

  const actual = signatures.get('src/long.mjs');
  const expected = topFileSignature(files.get('src/long.mjs'), stats);
  assert.equal(actual.length, SIGNATURE_TERMS);
  assert.deepEqual(actual.map(({ term }) => term), expected.map(({ term }) => term));
  assert.ok(actual.every(({ weight }, i) => Math.abs(weight - expected[i].weight) < 1e-12));
});

test('updates only changed documents and keeps counts and signatures equal to a clean rebuild', async () => {
  const root = await fixture();
  const prior = await readFileSignatures(root, [escrow]);
  await writeFile(join(root, approval), 'export function approveEscrow(ledger) { return ledger; }\n// settlement\n');
  await git(['add', approval], { cwd: root });
  await git(['rm', removed], { cwd: root });

  const update = await reindex(root);
  assert.equal(update.updated, 1);
  assert.equal(update.removed, 1);
  const stats = await readLexicalStats(root);
  assert.equal(stats.documents, 12);
  assert.equal(stats.terms.get('support').df, 10);
  assert.equal(stats.terms.get('settlement').df, 2);
  assert.equal(stats.terms.has('singularcanary'), false);
  const updated = await readFileSignatures(root, [escrow, approval, removed]);
  assert.equal(updated.signatures.has(removed), false);
  assert.notDeepEqual(prior.signatures.get(escrow), updated.signatures.get(escrow));

  await rm(join(root, SQLITE_FILE));
  await reindex(root, { fielded: true });
  assert.deepEqual(await readLexicalStats(root), stats);
  assert.deepEqual(await readFileSignatures(root, [escrow, approval, removed]), updated);
});

test('backfills an already-fielded cache once when term statistics first ship', async () => {
  const root = await fixture();
  const before = await readLexicalStats(root);
  const database = new DatabaseSync(join(root, SQLITE_FILE));
  try {
    database.exec(`drop view file_signatures; drop table term_stats; drop table file_terms;
      drop table lexical_files; delete from meta where key = 'lexical_terms'`);
  } finally {
    database.close();
  }
  assert.equal((await reindex(root)).updated, 13);
  assert.deepEqual(await readLexicalStats(root), before);
  assert.equal((await reindex(root)).updated, 0);
});
