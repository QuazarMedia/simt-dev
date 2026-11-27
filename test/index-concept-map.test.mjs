import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  buildConceptMap, buildConceptObservations, extractConceptFileTerms, selectConceptExpansions,
} from '../src/index/concept-map.mjs';
import { readConceptExpansions, readGraph } from '../src/index/graph-read.mjs';
import { rankMapV2 } from '../src/index/map-v2.mjs';
import { SQLITE_FILE } from '../src/index/persist.mjs';
import { reindex } from '../src/index/store.mjs';
import { ensureGit, git, tempDir } from './fixture.mjs';

test('buildConceptMap filters low support, weak PPMI, and overly common code terms', () => {
  const filler = Array.from({ length: 20 }, (_, i) => ({
    proseTerms: [`topic${i}`, 'commonprose'],
    codeTerms: [`mod${i}`, 'sharedutil'],
  }));
  const observations = buildConceptObservations({
    fileEntries: [
      ...filler,
      { proseTerms: ['logout', 'premature'], codeTerms: ['sessionttl', 'slidingwindow'] },
      { proseTerms: ['logout', 'unexpectedly'], codeTerms: ['sessionttl', 'slidingwindow'] },
      { proseTerms: ['once'], codeTerms: ['singlehit'] },
    ],
  });
  const rows = buildConceptMap(observations);
  const logoutTargets = rows.filter((row) => row.proseTerm === 'logout').map((row) => row.codeTerm);
  assert.ok(logoutTargets.includes('sessionttl'));
  assert.ok(logoutTargets.includes('slidingwindow'));
  assert.equal(rows.some((row) => row.codeTerm === 'sharedutil'), false);
  assert.equal(rows.some((row) => row.proseTerm === 'once'), false);

  const selected = selectConceptExpansions(rows, ['logout', 'sessionttl']);
  assert.equal(selected.terms.some((row) => row.term === 'sessionttl'), false);
  assert.ok(selected.terms.some((row) => row.term === 'slidingwindow'));
  assert.ok(selected.expansions.every((row) => row.weight > 0 && row.weight <= 0.35));
});

test('concept_map recovers zero-overlap symptom files from comments, commits, and ADRs with zero exact-query drift', async () => {
  const root = await tempDir('index-concept-map-');
  await mkdir(join(root, 'src', 'auth'), { recursive: true });
  await mkdir(join(root, 'src', 'billing'), { recursive: true });
  await mkdir(join(root, 'src', 'catalog'), { recursive: true });
  await mkdir(join(root, 'docs', 'decisions'), { recursive: true });

  for (let i = 0; i < 16; i += 1) {
    await writeFile(
      join(root, 'src', 'catalog', `item-${i}.mjs`),
      `// Catalog module ${i}\nexport function item${i}(value) { return value; }\n`,
    );
  }
  await ensureGit(root);

  await writeFile(
    join(root, 'src', 'billing', 'invoice.mjs'),
    '// Compute invoice totals cleanly.\nexport function buildInvoice(rows) {\n  return rows.length;\n}\n',
  );
  await git(['add', 'src/billing/invoice.mjs'], { cwd: root });
  await git(['commit', '-m', 'add billing invoice helper'], { cwd: root });

  await writeFile(
    join(root, 'src', 'auth', 'expiry.mjs'),
    'export function extendWindow(ttlMs) {\n  return ttlMs + 60000;\n}\n',
  );
  await writeFile(
    join(root, 'docs', 'decisions', 'ADR-001-session-window.md'),
    '# ADR-001: Prevent premature logout during active browsing\n\n'
    + 'Status: Accepted\n\nAffects: `src/auth/expiry.mjs`\n\n'
    + 'Extending the sliding window prevents unexpected logout.\n',
  );
  await git(['add', 'src/auth/expiry.mjs', 'docs/decisions/ADR-001-session-window.md'], { cwd: root });
  await git(['commit', '-m', 'prevent premature logout while browsing'], { cwd: root });
  await writeFile(
    join(root, 'src', 'auth', 'expiry.mjs'),
    'export function extendWindow(ttlMs) {\n  return ttlMs + 90000;\n}\n',
  );
  await git(['commit', '-am', 'stop unexpected logout on idle refresh'], { cwd: root });
  await reindex(root);

  const db = new DatabaseSync(join(root, SQLITE_FILE), { readOnly: true });
  try {
    assert.equal(db.prepare("select value from meta where key = 'concept_map'").get().value, '1');
  } finally {
    db.close();
  }

  const graph = await readGraph(root);
  const off = await rankMapV2(root, graph, 'premature logout', { conceptMap: false });
  const on = await rankMapV2(root, graph, 'premature logout', { conceptMap: true, explain: true });

  const onTop3 = on.ranked.slice(0, 3).map((row) => row.path);
  assert.ok(onTop3.includes('src/auth/expiry.mjs'));
  assert.ok(on.feedback.conceptExpansions.some((row) => row.from === 'logout' && (row.to === 'expiry' || row.to === 'extendwindow')));
  const explainRow = on.evidence.find((row) => row.path === 'src/auth/expiry.mjs');
  assert.ok(explainRow?.channels.bm25f?.conceptExpansions?.length > 0);
  assert.equal(off.feedback.conceptExpansions.length, 0);

  // Exact-match query should not trigger concept expansion (0% drift)
  const exactOff = await rankMapV2(root, graph, 'extendWindow', { conceptMap: false });
  const exactOn = await rankMapV2(root, graph, 'extendWindow', { conceptMap: true });
  assert.deepEqual(exactOn.ranked, exactOff.ranked);
  assert.equal(exactOn.feedback.conceptExpansions.length, 0);
});

test('extractConceptFileTerms strips code noise and cold DB reads empty concept expansions', async () => {
  const { proseTerms, codeTerms } = extractConceptFileTerms(
    'src/payments/retry.mjs',
    '// Guard against duplicate charge retries on timeout.\nexport async function retryCharge() { return true; }\n',
    'javascript',
    [{ name: 'retryCharge', exported: 1 }],
  );
  assert.ok(proseTerms.includes('duplicate'));
  assert.ok(proseTerms.includes('charge'));
  assert.equal(proseTerms.includes('return'), false);
  assert.ok(codeTerms.includes('retrycharge'));
  assert.ok(codeTerms.includes('payments'));

  const root = await tempDir('index-concept-cold-');
  assert.deepEqual(await readConceptExpansions(root, ['duplicate']), { expansions: [], terms: [] });
});
