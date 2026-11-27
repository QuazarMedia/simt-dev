import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ALL_V3_STRATA,
  V3_ADVERSARIAL_STRATA,
  buildV3RetrievalCorpus,
  scaleFiles50k,
  validateRetrievalCorpus,
} from '../packages/bench/src/multitask-corpus.mjs';
import { runRetrievalAblation } from '../packages/bench/src/retrieval-ablation.mjs';
import { tokenize } from '../src/text/tokens.mjs';

test('buildV3RetrievalCorpus generates 30 tasks per v3 adversarial stratum with zero gold leakage or token overlap', () => {
  const corpus = buildV3RetrievalCorpus();
  assert.deepEqual(V3_ADVERSARIAL_STRATA, ['zero-overlap-symptom', 'error-literal', 'scale-50k']);
  assert.equal(ALL_V3_STRATA.length, 7);
  assert.equal(corpus.tasks.length, 90);
  assert.equal(Object.keys(corpus.gold).length, 90);
  assert.ok(corpus.fixture.commits.length >= 60);

  for (const task of corpus.tasks) {
    assert.deepEqual(Object.keys(task).sort(), ['id', 'prompt', 'stratum']);
    assert.equal('gold' in task, false);
    if (task.stratum === 'zero-overlap-symptom') {
      const pTokens = new Set(tokenize(task.prompt));
      const gTokens = new Set(tokenize(corpus.gold[task.id].files.join(' ')));
      for (const tok of pTokens) assert.equal(gTokens.has(tok), false, `${task.id} leaked ${tok}`);
    }
  }

  validateRetrievalCorpus(corpus, { perStratum: 30, strata: V3_ADVERSARIAL_STRATA });
  assert.throws(
    () => validateRetrievalCorpus({
      tasks: [{ id: 'zero-overlap-01', stratum: 'zero-overlap-symptom', prompt: 'broken unit01' }],
      gold: { 'zero-overlap-01': { files: ['src/impl/unit01.mjs'] } },
    }, { perStratum: 1, strata: ['zero-overlap-symptom'] }),
    /shares token/,
  );
});

test('v3 strata grade cleanly and deterministically under runRetrievalAblation across permutations', async () => {
  const corpus = buildV3RetrievalCorpus({ perStratum: 8 });
  assert.equal(corpus.tasks.length, 24);
  const report = await runRetrievalAblation({
    tasks: corpus.tasks,
    gold: corpus.gold,
    files: corpus.fixture.files,
    selected: ['baseline-v1', 'full-v3'],
    samples: 100,
    evaluate: ({ task, arm }) => ({
      ranking: arm === 'full-v3' ? corpus.gold[task.id].files : ['src/unrelated.mjs', ...corpus.gold[task.id].files],
    }),
  });
  assert.equal(report.tasks, 24);
  const v3 = report.arms.find(({ name }) => name === 'full-v3');
  assert.equal(v3.summary.length, 3);
  for (const row of v3.summary) {
    assert.equal(row.metrics.reciprocalRank.value, 1);
    assert.equal(row.metrics.recallAt10.value, 1);
  }
});

test('scaleFiles50k builds a deterministic 50,000-file repository layout', () => {
  const files = scaleFiles50k(50_000);
  assert.equal(Object.keys(files).length, 50_000);
  assert.ok(files['src/scale/anchor01.mjs']);
  assert.ok(files['src/scale/anchor30.mjs']);
  assert.ok(files['docs/decisions/ADR-001-rate.md']);
});
