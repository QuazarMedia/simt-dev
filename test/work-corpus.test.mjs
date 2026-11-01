// Plan 0004 W02: the outcome corpus.
//
// The acceptance bar is stated in rates, not adjectives: gold 100%, no-op only where the
// task says no change is due, and a deliberately wrong artifact rejected. A corpus that
// cannot fail those is not measuring resolution.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  WORK_STRATA,
  buildCanary,
  goldSubmission,
  gradeOutcome,
  noopSubmission,
  publicTask,
  wrongSubmission,
} from '../packages/bench/src/work-corpus.mjs';
import { gradeWithOracle } from '../packages/bench/src/graders.mjs';
import { normaliseTask } from '../src/measure/task-schema.mjs';

const CANARY = buildCanary();
const PER_STRATUM = 30;

/** The share of tasks a submission policy resolves. */
function rate(tasks, submissionFor) {
  return tasks.filter((task) => gradeOutcome(task, submissionFor(task)).resolved).length / tasks.length;
}

test('canary: thirty independent tasks in each stratum', () => {
  assert.equal(CANARY.length, WORK_STRATA.length * PER_STRATUM);
  for (const stratum of WORK_STRATA) {
    const own = CANARY.filter((task) => task.stratum === stratum);
    assert.equal(own.length, PER_STRATUM, `${stratum} has ${own.length} tasks`);
    assert.equal(new Set(own.map((task) => task.id)).size, PER_STRATUM, `${stratum} reuses an id`);
    // A prompt copied across tasks is one task reported thirty times.
    assert.equal(new Set(own.map((task) => task.prompt)).size, PER_STRATUM, `${stratum} repeats a prompt`);
  }
});

test('canary: gold resolves every task, and a no-op resolves only the ones that need none', () => {
  assert.equal(rate(CANARY, goldSubmission), 1);
  const acceptedNoops = CANARY.filter((task) => gradeOutcome(task, noopSubmission()).resolved);
  assert.ok(acceptedNoops.length > 0, 'no no-op-valid task was built, so the control proves nothing');
  for (const task of acceptedNoops) {
    assert.equal(task.oracle.mutationRequired, false, `${task.id} accepted a no-op while requiring a change`);
  }
  const required = CANARY.filter((task) => task.oracle.mutationRequired);
  assert.ok(required.length > 0);
  assert.equal(rate(required, noopSubmission), 0, 'a no-op resolved a task that requires a change');
});

test('canary: a wrong artifact is rejected, and an effect the task did not allow fails a right answer', () => {
  assert.equal(rate(CANARY, wrongSubmission), 0);
  const task = CANARY.find((entry) => entry.oracle.mutationRequired);
  const gold = goldSubmission(task);
  const verdict = gradeOutcome(task, { ...gold, effects: [...gold.effects, 'push:origin'] });
  assert.equal(verdict.resolved, false);
  assert.deepEqual(verdict.disallowedEffects, ['push:origin']);
});

test('projection: an arm cannot read its own answer key', () => {
  for (const task of CANARY.slice(0, 10)) {
    const projected = JSON.stringify(publicTask(task));
    // The expectation token and the oracle's predicates are the verdict; neither leaves
    // the grader. The prompt names the work item, which is not the same fact.
    assert.doesNotMatch(projected, /predicates|hidden/);
    assert.doesNotMatch(projected, /-done/, 'the expected artifact content is in the projection');
    assert.equal(JSON.parse(projected).stratum, task.stratum);
  }
});

test('schema: an outcome oracle needs predicates, and refuses a kind it cannot grade', () => {
  const base = { schemaVersion: 2, id: 'x1', base: 'fixture', prompt: 'do it' };
  assert.throws(() => normaliseTask({ ...base, oracle: { type: 'outcome' } }), /lists its predicates/);
  assert.throws(
    () => normaliseTask({ ...base, oracle: { type: 'outcome', predicates: [{ kind: 'magic', path: 'a' }] } }),
    /is not one this package grades/,
  );
  const ok = normaliseTask({
    ...base,
    oracle: { type: 'outcome', predicates: [{ kind: 'artifact-contains', path: 'a.md', value: 'x' }] },
  });
  assert.equal(ok.oracle.predicates[0].kind, 'artifact-contains');
  assert.equal(ok.oracle.mutationRequired, false);
});

test('registry: an outcome task is graded through the oracle registry', async () => {
  const task = CANARY.find((entry) => entry.oracle.mutationRequired);
  const withGold = await mkdtemp(join(tmpdir(), 'simt-work-'));
  const without = await mkdtemp(join(tmpdir(), 'simt-work-'));
  try {
    await writeFile(join(withGold, 'submission.json'), JSON.stringify(goldSubmission(task)));
    const verdict = await gradeWithOracle(withGold, task, { vaultRoot: withGold, initialHead: 'HEAD' });
    assert.equal(verdict.resolved, true);
    const missing = await gradeWithOracle(without, task, { vaultRoot: without, initialHead: 'HEAD' });
    assert.equal(missing.resolved, false);
    assert.match(missing.error, /submission\.json/);
  } finally {
    await rm(withGold, { recursive: true, force: true });
    await rm(without, { recursive: true, force: true });
  }
});
