import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  gradeGovernance, gradeImpact, gradePacket, gradeRanking, measureRetrievalLatency,
  PACKET_BUDGETS, renderRetrievalSummary, summarizeLatency, summarizeRetrieval,
} from '../packages/bench/src/retrieval-metrics.mjs';

function close(actual, expected) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-9, `${actual} differs from ${expected}`);
}

test('computes ranking metrics from unique paths with binary relevance', () => {
  const ranking = ['wrong', 'right', 'right', 'a', 'b', 'c', 'd', 'also-right', 'e', 'f', 'g', 'late'];
  const result = gradeRanking(ranking, ['right', 'also-right', 'late', 'missing']);
  close(result.recallAt5, 1 / 4);
  close(result.recallAt10, 1 / 2);
  close(result.reciprocalRank, 1 / 2);
  close(result.ndcgAt10, (1 / Math.log2(3) + 1 / 3) / (1 + 1 / Math.log2(3) + 1 / 2 + 1 / Math.log2(5)));
  assert.deepEqual(gradeRanking(['x'], []), { recallAt5: null, recallAt10: null, reciprocalRank: null, ndcgAt10: null });
  assert.deepEqual(gradeRanking([], ['x']), { recallAt5: 0, recallAt10: 0, reciprocalRank: 0, ndcgAt10: 0 });
});

test('grades only surviving subtask evidence, using exact UTF-8 byte budgets', () => {
  const gold = {
    subtasks: [
      { files: ['alpha', 'beta'], facets: { FILES: ['alpha', 'beta'], TESTS: ['alpha.test'] } },
      { files: ['gamma'], facets: { FILES: ['gamma'], DECISIONS: ['ADR-001'] } },
    ],
    excludes: ['sensitive.md'],
  };
  for (const budget of PACKET_BUDGETS) {
    const packet = {
      text: 'é'.repeat(budget / 2),
      files: ['alpha', 'gamma', 'unrelated'],
      facets: { FILES: ['gamma'], TESTS: ['unrelated.test'], DECISIONS: ['ADR-001'], CAUTIONS: ['sensitive.md'] },
    };
    assert.deepEqual(gradePacket(packet, gold, budget), {
      bytes: budget, fits: true, subtaskRecall: [0.5, 1], minSubtaskCoverage: 0.5,
      meanSubtaskRecall: 0.75, facetCompleteness: 0.75, coveredFacets: ['CAUTIONS', 'DECISIONS', 'FILES'],
    });
    assert.deepEqual(gradePacket({ ...packet, text: packet.text + 'a' }, gold, budget), {
      bytes: budget + 1, fits: false, subtaskRecall: [0, 0], minSubtaskCoverage: 0,
      meanSubtaskRecall: 0, facetCompleteness: 0, coveredFacets: [],
    });
  }
  assert.equal(gradePacket({ text: '' }, {}, 1024).facetCompleteness, null);
  assert.equal(gradePacket({ text: '' }, {}, 1024).meanSubtaskRecall, null);
  assert.throws(() => gradePacket({}, gold, 1024), /rendered text/);
});

test('separates impact precision, recall and noise and grades governance independently', () => {
  const ranking = ['direct', 'hub', 'hub', 'historical', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'late'];
  const gold = { dependents: ['direct', 'late', 'unseen'], cochange: ['historical'], hubOnly: ['hub', 'direct'] };
  const result = gradeImpact(ranking, gold);
  close(result.precisionAt10, 1 / 5);
  close(result.recallFull, 3 / 4);
  close(result.hubNoiseRatio, 1 / 11);
  assert.deepEqual(gradeImpact([], gold), { precisionAt10: null, recallFull: 0, hubNoiseRatio: null });
  assert.deepEqual(gradeGovernance(['ADR-001', 'ADR-001', 'foreign', 'rule'], ['ADR-001', 'rule', 'inherited']), {
    precision: 2 / 3, recall: 2 / 3,
  });
  assert.deepEqual(gradeGovernance([], []), { precision: null, recall: null });
});

test('measures warm and cold calls locally and summarizes only recorded durations', async () => {
  assert.deepEqual(summarizeLatency([]), { samples: 0, p50Ms: null, p95Ms: null });
  assert.deepEqual(summarizeLatency([20, 4, 2, 1]), { samples: 4, p50Ms: 3, p95Ms: 20 });
  assert.throws(() => summarizeLatency([Infinity]), /finite/);
  let clock = 0;
  let prepared = 0;
  const disposed = [];
  const report = await measureRetrievalLatency({
    prepare: async () => {
      prepared += 1;
      clock += 50;
      return { calls: 0 };
    },
    run: async (repo) => {
      clock += repo.calls === 0 ? 10 : 2;
      repo.calls += 1;
    },
    dispose: async (repo) => disposed.push(repo.calls),
    samples: 3,
    now: () => clock,
  });
  assert.equal(prepared, 4);
  assert.deepEqual(disposed, [1, 1, 1, 4]);
  assert.deepEqual(report, {
    cold: { samples: 3, p50Ms: 10, p95Ms: 10 },
    warm: { samples: 3, p50Ms: 2, p95Ms: 2 },
  });
});

test('emits stable stratified summaries and retains missing measurements', () => {
  const rows = [
    { id: '3', stratum: 'lexical', metrics: { recallAt10: 0.5, ndcgAt10: null } },
    { id: '2', stratum: 'composite', metrics: { minSubtaskCoverage: 1 } },
    { id: '1', stratum: 'lexical', metrics: { recallAt10: 1 } },
  ];
  const summary = summarizeRetrieval(rows);
  assert.equal(JSON.stringify(summary), JSON.stringify(summarizeRetrieval([...rows].reverse())));
  assert.deepEqual(summary[1].metrics, { ndcgAt10: { value: null, measured: 0 }, recallAt10: { value: 0.75, measured: 2 } });
  assert.match(renderRetrievalSummary(summary), /\| lexical \| 2 \| recallAt10 \| 0\.750000 \| 2 \|/);
});
