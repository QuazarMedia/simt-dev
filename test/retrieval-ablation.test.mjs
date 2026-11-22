import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { runRetrievalAblation } from '../packages/bench/src/ablate.mjs';
import { RETRIEVAL_ARMS } from '../packages/bench/src/retrieval-ablation.mjs';
import { simt, tempDir } from './fixture.mjs';

function syntheticFixture() {
  const tasks = [];
  const gold = {};
  const files = {};
  for (let i = 0; i < 30; i += 1) {
    const id = `lexical-${i}`;
    const relevant = `src/route-${i}.ts`;
    tasks.push({ id, stratum: 'lexical', prompt: `Update route ${i}` });
    gold[id] = { files: [relevant] };
    files[relevant] = 'export const route = 1;\n';
  }
  return { tasks, gold, files };
}

const canonicalOrder = (files) => Object.keys(files).sort();

test('runs paired bootstrap comparisons with actual arm feature toggles and stable receipts', async () => {
  const fixture = syntheticFixture();
  const featuresPerArm = new Map();
  const evaluate = ({ arm, features, task, files }) => {
    assert.equal(Object.hasOwn(task, 'gold'), false);
    featuresPerArm.set(arm, features);
    const route = canonicalOrder(files).find((path) => path === `src/route-${task.id.slice(8)}.ts`);
    const examples = ['other.ts', route];
    if (features.includes('bm25f-ident')) {
      // Mixed deltas exercise non-degenerate seeded resampling.
      return { ranking: Number(task.id.slice(8)) < 24 ? examples.reverse() : examples };
    }
    return { ranking: examples };
  };
  const tasks = fixture.tasks.map((task) => ({ ...task, gold: fixture.gold[task.id] }));
  const options = { ...fixture, tasks, evaluate };
  const first = await runRetrievalAblation(options);
  const repeat = await runRetrievalAblation({ ...options, tasks: [...options.tasks].reverse() });
  assert.equal(JSON.stringify(first), JSON.stringify(repeat));
  assert.deepEqual(first.arms.map((arm) => arm.name), RETRIEVAL_ARMS);
  assert.deepEqual(featuresPerArm.get('baseline-v1'), []);
  assert.deepEqual(featuresPerArm.get('+cochange'), ['cochange']);
  assert.equal(featuresPerArm.get('full-v2').length, 7);
  assert.equal(first.samples, 1000);
  const bm25f = first.arms.find(({ name }) => name === '+bm25f-ident');
  const mrr = bm25f.comparisons.find(({ metric }) => metric === 'reciprocalRank');
  assert.equal(mrr.paired, 30);
  assert.equal(mrr.favorableDelta, 0.4);
  assert.ok(mrr.ci95[0] > 0 && mrr.ci95[0] < mrr.favorableDelta && mrr.ci95[1] > mrr.favorableDelta);
  assert.equal(mrr.verdict, 'improved');
  assert.equal(bm25f.comparisons.find(({ metric }) => metric === 'recallAt10').verdict, 'inconclusive');
});

test('rejects order-dependent and repeated-run output changes', async () => {
  const fixture = syntheticFixture();
  await assert.rejects(runRetrievalAblation({
    ...fixture,
    evaluate: ({ files }) => ({ ranking: Object.keys(files) }),
    selected: ['baseline-v1'],
  }), /non-deterministic retrieval: baseline-v1/);
  let calls = 0;
  await assert.rejects(runRetrievalAblation({
    ...fixture,
    evaluate: () => ({ ranking: [String(calls++)] }),
    selected: ['baseline-v1'],
  }), /non-deterministic retrieval: baseline-v1/);
});

test('marks missing pairs and does not promote inconclusive or absent arms', async () => {
  const fixture = syntheticFixture();
  const result = await runRetrievalAblation({
    ...fixture,
    selected: ['+cochange', '+symbol-bind'],
    evaluate: ({ arm, task }) => {
      if (arm === '+symbol-bind' || (arm === '+cochange' && task.id === 'lexical-0')) return null;
      return { ranking: ['irrelevant.ts'] };
    },
  });
  assert.equal(result.arms.find(({ name }) => name === '+cochange').comparisons[0].verdict, 'incomplete');
  const absent = result.arms.find(({ name }) => name === '+symbol-bind');
  assert.equal(absent.missing, 30);
  assert.deepEqual(absent.comparisons, []);
});

test('grades packet, impact and governance observations in their respective strata', async () => {
  const cases = [
    { id: 'split', stratum: 'composite' },
    { id: 'trace', stratum: 'impact-governance' },
  ];
  const packet = { text: 'FILES\n  target', files: ['target'], facets: { FILES: ['target'] } };
  const result = await runRetrievalAblation({
    tasks: cases,
    gold: {
      split: { subtasks: [{ files: ['target'], facets: { FILES: ['target'] } }] },
      trace: { impact: { dependents: ['caller'], hubOnly: ['hub'] }, governance: ['ADR-001'] },
    },
    selected: ['+symbol-bind'],
    evaluate({ task, features, budgets }) {
      return task.id === 'split'
        ? { packets: Object.fromEntries(budgets.map((budget) => [budget, packet])) }
        : { impact: features.includes('symbol-bind') ? ['caller'] : ['caller', 'hub'], governance: ['ADR-001'] };
    },
  });
  const [baseline, candidate] = result.arms;
  assert.equal(baseline.summary[0].metrics['facetCompleteness@2048'].value, 1);
  assert.equal(baseline.summary[1].metrics.governanceRecall.value, 1);
  const noise = candidate.comparisons.find(({ metric }) => metric === 'hubNoiseRatio');
  assert.equal(noise.favorableDelta, 0.5);
  assert.equal(noise.lowerIsBetter, true);
  assert.equal(noise.verdict, 'insufficient-tasks');
});

test('bench ablate replays a synthetic corpus offline within five seconds', async () => {
  const cwd = await tempDir('retrieval-replay-');
  const fixture = syntheticFixture();
  const observations = Object.fromEntries(
    ['baseline-v1', '+bm25f-ident'].map((arm) => [arm, Object.fromEntries(fixture.tasks.map((task) => [
      task.id, { ranking: [fixture.gold[task.id].files[0]] },
    ]))]),
  );
  const input = join(cwd, 'observations.json');
  await writeFile(input, JSON.stringify({ ...fixture, observations }));
  const args = ['bench', 'ablate', '--input', input, '--arm', '+bm25f-ident', '--json'];
  const env = { SIMT_DEV_WORKSPACE: 'off', LC_ALL: 'C' };
  const left = await simt(args, { cwd, env, timeout: 5000 });
  const right = await simt(args, { cwd, env: { ...env, LC_ALL: 'en_US.UTF-8' }, timeout: 5000 });
  assert.equal(left.code, 0, left.stderr || left.stdout);
  assert.equal(right.code, 0, right.stderr || right.stdout);
  assert.equal(left.stdout, right.stdout);
  const payload = JSON.parse(left.stdout);
  assert.equal(payload.mode, 'retrieval-replay');
  assert.equal(payload.tasks, 30);
  assert.deepEqual(payload.arms.map(({ name }) => name), ['baseline-v1', '+bm25f-ident']);
  assert.equal(payload.arms[1].comparisons[0].verdict, 'inconclusive');
});
