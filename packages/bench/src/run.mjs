// Run benchmark tasks across arms, and re-grade a stored run.
//
// The orchestrator owns the plan and nothing else: an arm is materialised by the registry
// in `arms.mjs`, a harness is driven by the adapter record in `adapters.mjs`, a workspace
// is built by `workspace.mjs`, a verdict comes from the task's own oracle in `graders.mjs`,
// and a record is written by `records.mjs` (review 0003 Q78). What is left here is the
// order those five things happen in.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

import { extractOpenedSkills, matchSkillsForPaths } from '../../../src/graph/compile.mjs';
import { loadRegistry } from '../../../src/graph/load.mjs';
import { LOCAL_DIR } from '../../../src/state.mjs';
import { packageVersion } from '../../../src/package-version.mjs';
import { readManifest } from '../../../src/projection/manifest.mjs';
import {
  ADAPTER_SCHEMA_VERSION,
  adapterIsolation,
  applyPatch,
  executeAdapter,
  loadAdapters,
} from './adapters.mjs';
import { BUILTIN_ARMS, describeArm, parseArmSpec } from './arms.mjs';
import { gradeWithOracle } from './graders.mjs';
// Importing the tests grader registers the oracle it grades for; the runner asks the
// registry rather than the module, so a second oracle needs no change here.
import './grade.mjs';
import { resolveVaultDir } from '../../../src/testing/vault.mjs';
import {
  RECORD_SCHEMA_VERSION,
  corpusDigestOf,
  experimentOf,
  runIdFor,
  runRecord,
} from '../../../src/measure/records.mjs';
import { DEFAULT_BOOTSTRAP_SEED } from '../../../src/measure/stats.mjs';
import { loadTasks, readTask } from '../../../src/measure/tasks.mjs';
import { mapPool, prepareBaseTree, prepareIsolatedWorkspace } from './workspace.mjs';

const DEFAULT_REPS = 3;
const DEFAULT_MAX_TURNS = 25;
const DEFAULT_AGENT_TIMEOUT_MS = 120_000;
const DEFAULT_CONCURRENCY = 4;

function runsBaseDir(root) {
  return join(root, LOCAL_DIR, 'bench', 'runs');
}

/** Two string lists hold the same members, ignoring order and duplicates. */
function sameStringSet(a, b) {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * The experiment a batch is measured under: the conditions every record in it shares.
 *
 * Recorded rather than inferred, because two batches that differ in rule text, corpus or
 * adapter were not the same experiment and a report must be able to say so.
 */
async function batchExperiment(root, { adapter, tasks, isolation, model }) {
  const manifest = await readManifest(root).catch(() => ({ data: null }));
  const projection = manifest?.data?.projection ?? {};
  return experimentOf({
    simtVersion: packageVersion(),
    rulesDigest: projection.sha ?? projection.simtDevSha ?? null,
    adapterVersion: `${adapter.id}@${ADAPTER_SCHEMA_VERSION}${model ? `:${model}` : ''}`,
    corpusDigest: corpusDigestOf(tasks),
    seed: DEFAULT_BOOTSTRAP_SEED,
    isolation,
  });
}

/**
 * Run benchmark tasks across one or more arms and repetitions.
 *
 * A preview answers the plan and writes nothing; `apply` prepares one base tree per task,
 * materialises each arm over a copy of it, drives the adapter, grades through the task's
 * oracle, and stores the record beside the agent's patch.
 *
 * @param {string} root
 * @param {object} [options]
 */
export async function runBench(
  root,
  {
    apply = false,
    arms = ['current'],
    harness = 'gold',
    model,
    reps = DEFAULT_REPS,
    tasks: filterTaskIds = [],
    vaultRoot = resolveVaultDir(root),
    timeoutMs = DEFAULT_AGENT_TIMEOUT_MS,
    maxTurns = DEFAULT_MAX_TURNS,
    concurrency = DEFAULT_CONCURRENCY,
    cwd = process.cwd(),
    adapters: adapterTable,
    registryLoader = loadRegistry,
  } = {},
) {
  const adapters = adapterTable ?? (await loadAdapters());
  const adapter = adapters[harness];
  if (!adapter) {
    throw new Error(`unknown harness "${harness}"; known harnesses: ${Object.keys(adapters).sort().join(', ')}`);
  }

  if (!Number.isInteger(reps) || reps < 1) {
    throw new Error(`--reps must be a positive integer, received ${reps}`);
  }

  const armSpecs = [];
  for (const raw of arms.length > 0 ? arms : ['current']) {
    armSpecs.push(await parseArmSpec(raw, cwd));
  }

  const tasks = await loadTasks(root, filterTaskIds);
  if (tasks.length === 0 && (apply || filterTaskIds.length > 0)) {
    throw new Error(
      filterTaskIds.length > 0
        ? `no mined tasks matched: ${filterTaskIds.join(', ')}`
        : `no mined tasks found in .simt/bench/tasks`,
    );
  }

  const resolvedModel = model ?? (adapter.kind === 'oracle' ? adapter.id : 'default');
  // An oracle harness scripts the workspace instead of driving an agent, so its numbers
  // calibrate the grader and are never an arm's measurement (review 0003 Q49).
  const measured = adapter.kind !== 'oracle';
  const isolation = adapterIsolation(adapter);
  const experiment = await batchExperiment(root, { adapter, tasks, isolation, model: resolvedModel });
  const timeoutForRun = timeoutMs ?? adapter.timeoutMs;

  const plannedRuns = [];
  for (const armSpec of armSpecs) {
    for (let rep = 1; rep <= reps; rep += 1) {
      const runId = runIdFor({ harness, model: resolvedModel, arm: armSpec.name, rep });
      for (const task of tasks) plannedRuns.push({ runId, armSpec, rep, task });
    }
  }

  if (!apply) {
    return {
      applied: false,
      root,
      harness,
      model: resolvedModel,
      arms: armSpecs.map((arm) => arm.name),
      armDescriptions: armSpecs.map((arm) => `${arm.name}: ${describeArm(arm)}`),
      reps,
      taskCount: tasks.length,
      experiment,
      runs: plannedRuns.map((item) =>
        runRecord({
          task: item.task,
          arm: item.armSpec.name,
          harness,
          model: resolvedModel,
          rep: item.rep,
          measured,
          isolation,
          experiment: { ...experiment, model: resolvedModel },
          status: 'planned',
          usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, turns: 0, toolCalls: 0 },
        }),
      ),
    };
  }

  const regRes = await registryLoader().catch((error) => ({
    ok: false,
    registry: null,
    errors: [String(error?.message ?? error)],
  }));
  if (!regRes.ok) {
    // `loadRegistry` reports a missing or invalid registry in `ok`/`errors`; it does not
    // throw, so a `.catch` fallback silently turned that into `skills: []` and scored the
    // batch against an empty catalogue. A batch that cannot say what it measured is an
    // exclusion, not a zero-skill measurement.
    const detail = (regRes.errors ?? []).join('; ') || 'the skill registry could not be read';
    return {
      applied: true,
      root,
      harness,
      model: resolvedModel,
      arms: armSpecs.map((arm) => arm.name),
      armDescriptions: armSpecs.map((arm) => `${arm.name}: ${describeArm(arm)}`),
      reps,
      taskCount: tasks.length,
      experiment,
      runs: plannedRuns.map((item) => ({
        ...runRecord({
          task: item.task,
          arm: item.armSpec.name,
          harness,
          model: resolvedModel,
          rep: item.rep,
          measured,
          isolation,
          experiment: { ...experiment, model: resolvedModel },
          status: 'error',
          error: `skill registry: ${detail}`,
        }),
        runId: item.runId,
      })),
    };
  }
  const registrySkills = regRes.registry?.skills ?? [];
  const knownSkillNames = new Set(registrySkills.map((skill) => skill.name));

  const baseRunsDir = runsBaseDir(root);
  for (const armSpec of armSpecs) {
    for (let rep = 1; rep <= reps; rep += 1) {
      const runDir = join(baseRunsDir, runIdFor({ harness, model: resolvedModel, arm: armSpec.name, rep }));
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, '.arm.json'), `${JSON.stringify(armSpec, null, 2)}\n`, 'utf8');
    }
  }
  const parentDir = await mkdtemp(join(tmpdir(), 'bench-batch-'));
  try {
    // One export per task, copied per run: the harness is what the batch measures, not
    // the cost of unpacking the same commit once per arm and repetition.
    const bases = new Map();
    for (const task of tasks) {
      if (bases.has(task.base)) continue;
      try {
        bases.set(task.base, await prepareBaseTree(root, task.base, parentDir));
      } catch {
        bases.set(task.base, null);
      }
    }

    const records = await mapPool(plannedRuns, concurrency, async (item) => {
      let slotDir = null;
      try {
        const prepared = await prepareIsolatedWorkspace(root, item.task.base, item.armSpec, item.task, {
          parentDir,
          baseDir: bases.get(item.task.base) ?? undefined,
        });
        slotDir = prepared.slotDir;
        const { workDir, initialHead, env, promptPrefix } = prepared;
        const { usage, costUsd, transcript, agent } = await executeAdapter(adapter, workDir, item.task, {
          vaultRoot,
          model: resolvedModel,
          maxTurns,
          env,
          timeoutMs: timeoutForRun,
          slotDir,
          promptPrefix,
        });

        const grade = await gradeWithOracle(workDir, item.task, { vaultRoot, initialHead, timeoutMs: timeoutForRun });
        const expectedSkills = matchSkillsForPaths(registrySkills, grade.goldFiles ?? []);
        const openedSkills =
          adapter.kind === 'oracle'
            ? adapter.oracle?.from === 'vault'
              ? expectedSkills
              : []
            : extractOpenedSkills(transcript, knownSkillNames);

        const record = runRecord({
          task: item.task,
          arm: item.armSpec.name,
          harness,
          model: resolvedModel,
          rep: item.rep,
          measured,
          isolation,
          experiment: { ...experiment, model: resolvedModel },
          status: 'ok',
          agent,
          resolved: grade.resolved,
          gatesPassed: grade.gatesPassed,
          f2pPassed: grade.f2pPassed ?? [],
          usage,
          costUsd,
          diff: grade.diff,
          skills: { expected: expectedSkills, opened: openedSkills },
        });

        const runDir = join(baseRunsDir, item.runId);
        await Promise.all([
          writeFile(join(runDir, `${item.task.id}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8'),
          writeFile(join(runDir, `${item.task.id}.patch`), grade.agentPatch),
        ]);

        return { ...record, runId: item.runId };
      } catch (error) {
        // One failed run is one exclusion, not a lost batch: the old path exited 3 and
        // left a half-written run behind (review 0003 Q47).
        return {
          ...runRecord({
            task: item.task,
            arm: item.armSpec.name,
            harness,
            model: resolvedModel,
            rep: item.rep,
            measured,
            isolation,
            experiment: { ...experiment, model: resolvedModel },
            status: 'error',
            error: String(error?.message ?? error),
          }),
          runId: item.runId,
        };
      } finally {
        if (slotDir !== null) await rm(slotDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    return {
      applied: true,
      root,
      harness,
      model: resolvedModel,
      arms: armSpecs.map((arm) => arm.name),
      armDescriptions: armSpecs.map((arm) => `${arm.name}: ${describeArm(arm)}`),
      reps,
      taskCount: tasks.length,
      experiment,
      runs: records,
    };
  } finally {
    await rm(parentDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function resolveRegradeTargets(root, target) {
  const base = runsBaseDir(root);
  const direct = resolve(root, target);
  const candidate = existsSync(direct) ? direct : join(base, target);

  if (target === 'all') {
    const dirs = (await readdir(base, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(base, entry.name))
      .sort();
    const files = [];
    for (const dir of dirs) {
      const entries = (await readdir(dir).catch(() => []))
        .filter((file) => file.endsWith('.json') && !file.startsWith('.'))
        .sort();
      for (const entry of entries) files.push(join(dir, entry));
    }
    return files;
  }

  const targetStat = await stat(candidate).catch(() => null);
  if (!targetStat) throw new Error(`stored run not found: ${target}`);
  if (targetStat.isFile()) return [candidate];
  if (targetStat.isDirectory()) {
    const entries = (await readdir(candidate).catch(() => []))
      .filter((file) => file.endsWith('.json') && !file.startsWith('.'))
      .sort();
    return entries.map((file) => join(candidate, file));
  }
  return [];
}

/**
 * Re-grade a stored run (or run directory) deterministically from its saved agent patch,
 * and verify that the reproduced grade matches the stored record.
 *
 * @param {string} root
 * @param {string} target
 * @param {{apply?: boolean, vaultRoot?: string, timeoutMs?: number, concurrency?: number}} [options]
 */
export async function regradeRun(
  root,
  target,
  {
    apply = false,
    vaultRoot = resolveVaultDir(root),
    timeoutMs = DEFAULT_AGENT_TIMEOUT_MS,
    concurrency = DEFAULT_CONCURRENCY,
  } = {},
) {
  const files = await resolveRegradeTargets(root, target);
  if (files.length === 0) throw new Error(`no stored task runs found under ${target}`);

  const base = runsBaseDir(root);
  const parentDir = await mkdtemp(join(tmpdir(), 'bench-regrade-'));

  try {
    const results = await mapPool(files, concurrency, async (runFilePath) => {
      const stored = JSON.parse(await readFile(runFilePath, 'utf8'));
      const runDir = dirname(runFilePath);
      const runId = runDir.startsWith(base) ? runDir.slice(base.length + 1) : runDir.split(sep).pop();

      const task = await readTask(root, stored.task);
      if (!task) throw new Error(`task descriptor missing for ${stored.task}`);
      if (!task.base) throw new Error(`task ${stored.task} names no base commit`);

      const armMetaPath = join(runDir, '.arm.json');
      const armSpec = await readFile(armMetaPath, 'utf8')
        .then((text) => JSON.parse(text))
        .catch(() => ({
          name: stored.arm,
          kind: BUILTIN_ARMS.has(stored.arm) ? 'builtin' : 'custom',
          base: BUILTIN_ARMS.has(stored.arm) ? stored.arm : null,
          write: {},
          remove: [],
          env: {},
        }));

      const patchPath = runFilePath.replace(/\.json$/, '.patch');
      const agentPatch = await readFile(patchPath).catch(() => Buffer.alloc(0));

      const { slotDir, workDir, initialHead } = await prepareIsolatedWorkspace(root, task.base, armSpec, task, {
        parentDir,
      });
      try {
        await applyPatch(workDir, agentPatch, { timeoutMs });

        const grade = await gradeWithOracle(workDir, task, { vaultRoot, initialHead, timeoutMs });

        // The verdicts alone cannot tell "the same tests passed" from "the same number of
        // tests passed"; the fail-to-pass set is compared too (review 0003 Q59).
        const reproduced =
          grade.resolved === stored.resolved &&
          grade.gatesPassed === stored.gatesPassed &&
          sameStringSet(grade.f2pPassed ?? [], stored.f2pPassed ?? []) &&
          grade.diff.files === stored.diff?.files &&
          grade.diff.outsideBlastRadius === stored.diff?.outsideBlastRadius;

        const updated = {
          ...stored,
          resolved: grade.resolved,
          gatesPassed: grade.gatesPassed,
          f2pPassed: grade.f2pPassed ?? [],
          diff: grade.diff,
        };

        if (apply) await writeFile(runFilePath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
        return { ...updated, runId, reproduced };
      } finally {
        await rm(slotDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    return {
      applied: apply,
      root,
      target,
      regraded: results.length,
      reproducedCount: results.filter((result) => result.reproduced).length,
      allReproduced: results.every((result) => result.reproduced),
      runs: results,
    };
  } finally {
    await rm(parentDir, { recursive: true, force: true }).catch(() => {});
  }
}
