// The outcome corpus: tasks beyond test-changing commits.
//
// Git-history mining finds one kind of task: a commit that changed both implementation
// and tests. Work whose result is a corrected document, a repaired recipe, a remote
// metadata change or a UI-only action leaves no such commit, so it needs a task that
// states what would settle it without a hidden test to run.
//
// That statement is the `outcome` oracle (see `src/measure/task-schema.mjs`): predicates
// over the artifacts and effects the attempt may produce. This module builds the canary
// corpus, projects a task into what an arm may see, and grades a submission against the
// oracle.
//
// The corpus is synthetic on purpose. The plan's pilots are evidence for the structural
// shape — a document with a citation, a recipe with a declared effect, a remote object
// with an intended delta — never for their content: nothing confidential is copied here,
// and `publicTask` is what makes that checkable rather than promised.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { OUTCOME_PREDICATE_KINDS, normaliseTask } from '../../../src/measure/task-schema.mjs';
import { registerOracle } from './graders.mjs';

/** The strata an outcome corpus reports separately. A pooled gain cannot hide a loss. */
export const WORK_STRATA = Object.freeze(['source', 'knowledge', 'recipe', 'remote', 'ui']);

/** One predicate per stratum, so a stratum is a shape rather than a label. */
const SHAPE = Object.freeze({
  source: 'artifact-equals',
  knowledge: 'artifact-contains',
  recipe: 'artifact-matches',
  remote: 'artifact-equals',
  ui: 'artifact-contains',
});

/** The literal a `matches` predicate accepts, so gold output can be built from it. */
function literalFromPattern(pattern) {
  return pattern.replace(/^\^/, '').replace(/\$$/, '').replace(/\\(.)/g, '$1');
}

function submissionPath(stratum, token) {
  return `${stratum}/${token}.md`;
}

/**
 * The canary: `perStratum` independent tasks in each of the five strata.
 *
 * Deterministic from `seed`, because a corpus that changes between builds cannot be
 * compared across arms. Every seventh task is no-op-valid: its predicate asserts the
 * artifact is *absent*, which is what a task must say when doing nothing is a correct
 * answer. The rest require a mutation, and a no-op has to fail them.
 */
export function buildCanary({ perStratum = 30, seed = 7 } = {}) {
  if (!Number.isInteger(perStratum) || perStratum <= 0) throw new Error('perStratum must be a positive integer');
  const tasks = [];
  for (const stratum of WORK_STRATA) {
    for (let index = 0; index < perStratum; index += 1) {
      const token = `${stratum}-${seed}-${String(index).padStart(2, '0')}`;
      const path = submissionPath(stratum, token);
      const mutationRequired = index % 7 !== 0;
      const predicate = !mutationRequired
        ? { kind: 'artifact-absent', path }
        : SHAPE[stratum] === 'artifact-matches'
          ? { kind: 'artifact-matches', path, pattern: `^${token}-done$` }
          : { kind: SHAPE[stratum], path, value: `${token}-done` };
      const id = `w-${stratum}-${String(index).padStart(2, '0')}`;
      tasks.push(
        normaliseTask(
          {
            schemaVersion: 2,
            id,
            base: 'fixture',
            prompt: `${mutationRequired ? 'Produce' : 'Decide whether to produce'} ${path} for the ${stratum} work item ${token}. ${mutationRequired ? 'The artifact has to carry the item token.' : 'Leave the tree unchanged when the item needs no artifact.'}`,
            stratum,
            agentVisible: { kind: 'repository' },
            oracle: {
              type: 'outcome',
              predicates: [predicate],
              allowedEffects: mutationRequired ? [`write:${path}`] : [],
              mutationRequired,
            },
            gold: { files: mutationRequired ? 1 : 0, linesAdded: mutationRequired ? 1 : 0, linesRemoved: 0 },
            hidden: { token, path, expect: mutationRequired ? predicate.value ?? literalFromPattern(predicate.pattern) : null },
          },
          { source: id },
        ),
      );
    }
  }
  return tasks;
}

/**
 * What an arm may see. The oracle's predicates and the hidden expectation are the answer
 * key; a projection that carried them would let an arm read its own verdict.
 */
export function publicTask(task) {
  return {
    id: task.id,
    prompt: task.prompt,
    stratum: task.stratum,
    agentVisible: { kind: task.agentVisible.kind },
    allowedEffects: [...(task.oracle.allowedEffects ?? [])],
    mutationRequired: task.oracle.mutationRequired === true,
  };
}

/** The submission a correct attempt makes, built from the oracle rather than guessed. */
export function goldSubmission(task) {
  const artifacts = {};
  for (const predicate of task.oracle.predicates) {
    if (predicate.kind === 'artifact-absent') continue;
    artifacts[predicate.path] = predicate.kind === 'artifact-matches' ? literalFromPattern(predicate.pattern) : predicate.value;
  }
  const effects = Object.keys(artifacts).map((path) => `write:${path}`);
  return { artifacts, effects };
}

/** An attempt that does nothing. Correct exactly when the task says no change is due. */
export function noopSubmission() {
  return { artifacts: {}, effects: [] };
}

/**
 * An attempt that touches the right artifact with the wrong content, or creates an
 * artifact the task says must be absent. A grader that accepts this is measuring
 * activity, not resolution.
 */
export function wrongSubmission(task) {
  const artifacts = {};
  for (const predicate of task.oracle.predicates) {
    if (predicate.kind === 'artifact-absent') artifacts[predicate.path] = 'created anyway';
    // Deliberately carries none of the expected text: appending to it would still satisfy
    // a `contains` predicate, and the control has to fail every kind it is aimed at.
    else artifacts[predicate.path] = 'wrong content';
  }
  return { artifacts, effects: Object.keys(artifacts).map((path) => `write:${path}`) };
}

/**
 * Grade one submission against its task's predicates and allowed effects.
 *
 * An effect the task did not allow is a failure even when every artifact is right: the
 * point of declaring effects is that a correct-looking result produced the wrong way is
 * not the same outcome.
 */
export function gradeOutcome(task, submission = {}) {
  const artifacts = submission.artifacts ?? {};
  const effects = Array.isArray(submission.effects) ? submission.effects : [];
  const allowed = new Set(task.oracle.allowedEffects ?? []);
  const disallowedEffects = effects.filter((effect) => !allowed.has(effect));
  const failures = [];
  for (const predicate of task.oracle.predicates) {
    const text = artifacts[predicate.path];
    const label = `${predicate.kind} ${predicate.path}`;
    if (predicate.kind === 'artifact-absent') {
      if (text !== undefined) failures.push(`${label}: artifact is present`);
      continue;
    }
    if (typeof text !== 'string') {
      failures.push(`${label}: artifact is missing`);
      continue;
    }
    if (predicate.kind === 'artifact-equals' && text !== predicate.value) failures.push(`${label}: content differs`);
    if (predicate.kind === 'artifact-contains' && !text.includes(predicate.value)) failures.push(`${label}: content lacks the token`);
    if (predicate.kind === 'artifact-matches' && !new RegExp(predicate.pattern).test(text)) failures.push(`${label}: content does not match`);
  }
  return {
    resolved: failures.length === 0 && disallowedEffects.length === 0,
    failures,
    disallowedEffects,
    mutationRequired: task.oracle.mutationRequired === true,
  };
}

// The runner asks the task's oracle; this is how an `outcome` task gets an answer without
// the runner knowing what a predicate is. The adapter writes `submission.json` into the
// workspace, the same way the gold adapter lands an operator's bytes.
registerOracle('outcome', async (workDir, task) => {
  let submission;
  try {
    submission = JSON.parse(await readFile(join(workDir, 'submission.json'), 'utf8'));
  } catch (e) {
    return {
      resolved: false,
      gatesPassed: false,
      diff: { files: 0, outsideBlastRadius: 0 },
      f2pPassed: [],
      error: `no readable submission.json: ${e.message}`,
    };
  }
  const verdict = gradeOutcome(task, submission);
  return {
    resolved: verdict.resolved,
    gatesPassed: verdict.resolved,
    diff: { files: Object.keys(submission.artifacts ?? {}).length, outsideBlastRadius: 0 },
    f2pPassed: [],
    failures: verdict.failures,
    disallowedEffects: verdict.disallowedEffects,
  };
});
