// `simt bench` - benchmark task mining (`bench mine`, R01) and runner (`bench run`, R02).
//
// Like every writer in this CLI, `bench mine` and `bench run` are previews by
// default and write artifacts to `.simt-dev/bench/` only when authorised with
// `--yes` (and not `--dry-run`).

import { resolve } from 'node:path';

import { CLI } from '../name.mjs';
import { EXIT, emit, emitJson, fail, isJson, writeMode } from '../output/index.mjs';
import { DEFAULT_MINE_TARGET, mineTasks } from '../bench/mine.mjs';
import { regradeRun, runBench } from '../bench/run.mjs';
import { listFlag } from './skills.mjs';

export async function benchMineCommand(positional, flags) {
  const root = resolve(flags.root ?? positional[0] ?? process.cwd());
  const { dryRun, apply } = writeMode(flags);

  const result = await mineTasks(root, {
    apply,
    target: DEFAULT_MINE_TARGET,
  });

  if (!result.ok) {
    return fail(
      `${root}: ${result.error}`,
      EXIT.CONFIG,
      `point --root at a git repository and rerun: ${CLI} bench mine --root <path> --yes`,
    );
  }

  if (isJson(flags)) {
    emitJson({
      ok: true,
      command: 'bench mine',
      root: result.root,
      dryRun,
      applied: result.applied,
      candidates: result.candidatesCount,
      tasksDir: result.tasksDir,
      vaultRoot: result.vaultRoot,
      tasks: result.tasks,
    });
    return EXIT.OK;
  }

  const lines = [
    `bench    mine  ${result.root}`,
    `mode     ${result.applied ? 'applied' : dryRun ? 'dry-run (writes nothing)' : 'preview (pass --yes to validate and write)'}`,
    `commits  ${result.candidatesCount} candidate(s) touch both test and implementation paths`,
  ];

  if (result.applied) {
    lines.push(`mined    ${result.tasks.length} verified task(s)`);
    lines.push(`tasks    ${result.tasksDir}`);
    lines.push(`vault    ${result.vaultRoot}`);
    for (const task of result.tasks) {
      const subject = task.prompt.split('\n')[0];
      lines.push(
        `task     ${task.id}  f2p=${task.f2p.length}  p2p=${task.f2p.length}  files=${task.gold.files}  +${task.gold.linesAdded}/-${task.gold.linesRemoved}  ${subject}`,
      );
    }
  } else {
    lines.push(`preview  ${result.tasks.length} candidate(s) queued for RED/GOLD worktree validation`);
    for (const item of result.tasks) {
      lines.push(`queue    ${item.id}  tests=${item.testFiles.length}  impl=${item.implFiles.length}  ${item.subject}`);
    }
    lines.push(`remedy   run: ${CLI} bench mine --yes`);
  }

  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}

export async function benchRunCommand(positional, flags) {
  const root = resolve(flags.root ?? positional[0] ?? process.cwd());
  const { dryRun, apply } = writeMode(flags);

  if (flags.regrade !== undefined) {
    let result;
    try {
      result = await regradeRun(root, flags.regrade, { apply });
    } catch (error) {
      return fail(
        `${root}: ${error.message ?? error}`,
        EXIT.CONFIG,
        `pass a stored run name under .simt-dev/bench/runs/: ${CLI} bench run --regrade <run>`,
      );
    }

    const code = result.allReproduced ? EXIT.OK : EXIT.DRIFT;
    if (isJson(flags)) {
      emitJson({
        ok: code === EXIT.OK,
        command: 'bench run',
        mode: 'regrade',
        root: result.root,
        target: result.target,
        dryRun,
        applied: result.applied,
        regraded: result.regraded,
        reproducedCount: result.reproducedCount,
        allReproduced: result.allReproduced,
        runs: result.runs,
      });
      return code;
    }

    const lines = [
      `bench    regrade  ${result.target}`,
      `mode     ${result.applied ? 'applied' : 'verify (pass --yes to rewrite stored grades)'}`,
      `summary  ${result.reproducedCount}/${result.regraded} reproduced exactly`,
    ];
    for (const run of result.runs) {
      lines.push(
        `run      ${run.runId}/${run.task}  arm=${run.arm}  resolved=${run.resolved}  gates=${run.gatesPassed}  reproduced=${run.reproduced}`,
      );
    }
    emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
    return code;
  }

  const arms = listFlag(flags.arm);
  const tasks = listFlag(flags.task);
  const harness = flags.harness ?? 'gold';
  const model = flags.model;
  const reps = flags.reps ?? 3;

  let result;
  try {
    result = await runBench(root, {
      apply,
      arms: arms.length > 0 ? arms : ['current'],
      harness,
      model,
      reps,
      tasks,
    });
  } catch (error) {
    return fail(
      `${root}: ${error.message ?? error}`,
      EXIT.CONFIG,
      `mine tasks first with \`${CLI} bench mine --yes\` or check --arm / --harness flags`,
    );
  }

  if (isJson(flags)) {
    emitJson({
      ok: true,
      command: 'bench run',
      root: result.root,
      dryRun,
      applied: result.applied,
      harness: result.harness,
      model: result.model,
      arms: result.arms,
      reps: result.reps,
      taskCount: result.taskCount,
      runs: result.runs,
    });
    return EXIT.OK;
  }

  const lines = [
    `bench    run  ${result.root}`,
    `mode     ${result.applied ? 'applied' : dryRun ? 'dry-run (writes nothing)' : 'preview (pass --yes to execute and write runs)'}`,
    `harness  ${result.harness}  (model: ${result.model})`,
    `arms     ${result.arms.join(', ')}  (reps: ${result.reps}, tasks: ${result.taskCount})`,
  ];

  if (result.applied) {
    const resolvedCount = result.runs.filter((r) => r.resolved).length;
    const gatesCount = result.runs.filter((r) => r.gatesPassed).length;
    lines.push(`summary  resolved=${resolvedCount}/${result.runs.length}  gates=${gatesCount}/${result.runs.length}`);
    for (const run of result.runs) {
      lines.push(
        `run      ${run.runId}/${run.task}  arm=${run.arm}  rep=${run.rep}  resolved=${run.resolved}  gates=${run.gatesPassed}  files=${run.diff.files}  outside=${run.diff.outsideBlastRadius}`,
      );
    }
  } else {
    lines.push(`planned  ${result.runs.length} isolated task run(s)`);
    lines.push(`remedy   run: ${CLI} bench run --yes`);
  }

  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}
