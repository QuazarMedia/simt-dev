// `simt bench` - benchmark task mining (`bench mine`, R01), runner (`bench run`, R02)
// and statistical report (`bench report`, R03).
//
// Like every writer in this CLI, `bench mine` and `bench run` are previews by
// default and write artifacts to `.simt-dev/bench/` only when authorised with
// `--yes` (and not `--dry-run`). `bench report` is read-only.

import { resolve } from 'node:path';

import { CLI } from '../name.mjs';
import { EXIT, emit, emitJson, fail, isJson, writeMode } from '../output/index.mjs';
import { DEFAULT_MINE_TARGET, mineTasks } from '../bench/mine.mjs';
import { regradeRun, runBench } from '../bench/run.mjs';
import { buildBenchReport } from '../bench/report.mjs';
import { formatRecall, measureRecall } from '../index/map.mjs';
import { ablateBench } from '../bench/ablate.mjs';
import { runBenchProbes } from '../bench/probes.mjs';
import { selectRuleVariants } from '../bench/variants.mjs';
import { criticBench } from '../review/critic.mjs';
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

export async function benchReportCommand(positional, flags) {
  const compareItems = listFlag(flags.compare);
  const pos = [...positional];
  if (compareItems.length === 1 && pos.length >= 1) {
    compareItems.push(pos.shift());
  }
  if (flags.compare !== undefined && compareItems.length !== 2) {
    return fail(
      '--compare requires two arm names: --compare <arm-a> <arm-b>',
      EXIT.USAGE,
      `pass two arms to compare: ${CLI} bench report --compare bare current`,
    );
  }

  const root = resolve(flags.root ?? pos[0] ?? process.cwd());
  const arms = listFlag(flags.arm);

  let report;
  try {
    report = await buildBenchReport(root, {
      arms,
      harness: flags.harness,
      model: flags.model,
      compare: compareItems.length === 2 ? compareItems : null,
    });
  } catch (error) {
    return fail(
      `${root}: ${error.message ?? error}`,
      EXIT.CONFIG,
      `run benchmark arms first with \`${CLI} bench run --yes\` or fix .simt-dev/bench/prices.json`,
    );
  }

  const mapRecall = await recallOrUnmeasured(root);

  if (isJson(flags)) {
    emitJson({
      ok: true,
      command: 'bench report',
      root: report.root,
      pricesLoaded: report.pricesLoaded,
      runCount: report.runCount,
      arms: report.arms,
      comparison: report.comparison,
      mapRecall,
    });
    return EXIT.OK;
  }

  emit(`${report.markdown}\n\n### Map\n\n${formatRecall(mapRecall)}`, { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}

async function recallOrUnmeasured(root) {
  try {
    return await measureRecall(root);
  } catch {
    return { measured: false, reason: 'not run', tasks: 0, missing: 0, recall: null };
  }
}

export async function benchAblateCommand(positional, flags) {
  const root = resolve(flags.root ?? positional[0] ?? process.cwd());
  const { dryRun, apply } = writeMode(flags);
  const harness = flags.harness ?? 'gold';
  const model = flags.model;
  const reps = flags.reps ?? 1;

  let result;
  try {
    result = await ablateBench(root, {
      apply,
      harness,
      model,
      reps,
      includeAll: flags.all === true,
    });
  } catch (error) {
    return fail(
      `${root}: ${error.message ?? error}`,
      EXIT.CONFIG,
      `mine tasks first with \`${CLI} bench mine --yes\` and rerun \`${CLI} bench ablate --yes\``,
    );
  }

  if (isJson(flags)) {
    emitJson({
      ok: true,
      command: 'bench ablate',
      dryRun,
      ...result,
    });
    return EXIT.OK;
  }

  const lines = [
    `bench    ablate  ${result.root}`,
    `mode     ${result.applied ? 'applied' : dryRun ? 'dry-run (writes nothing)' : 'preview / stored runs (pass --yes to execute canary and escalate)'}`,
    `sections ${result.sections.length}  (canary: ${result.canaryTasks}/${result.totalTasks} tasks)`,
    `delete   ${result.deletionCandidates.length > 0 ? result.deletionCandidates.join(', ') : '(none)'}`,
    '',
    result.markdown,
  ];
  if (!result.applied) {
    lines.push('');
    lines.push(`remedy   run: ${CLI} bench ablate --yes`);
  }

  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}

export async function benchProbesCommand(positional, flags) {
  const root = resolve(flags.root ?? positional[0] ?? process.cwd());
  const { dryRun, apply } = writeMode(flags);
  const arms = listFlag(flags.arm);
  const probes = listFlag(flags.task);
  const harness = flags.harness ?? 'gold';
  const reps = flags.reps ?? 1;

  let result;
  try {
    result = await runBenchProbes(root, {
      apply,
      arms: arms.length > 0 ? arms : ['bare', 'current'],
      probes,
      harness,
      reps,
    });
  } catch (error) {
    return fail(
      `${root}: ${error.message ?? error}`,
      EXIT.CONFIG,
      `check --arm and --harness flags and rerun \`${CLI} bench probes --yes\``,
    );
  }

  if (isJson(flags)) {
    emitJson({
      ok: true,
      command: 'bench probes',
      dryRun,
      ...result,
    });
    return EXIT.OK;
  }

  const lines = [
    `bench    probes  ${result.root}`,
    `mode     ${result.applied ? 'applied' : dryRun ? 'dry-run (writes nothing)' : 'preview / stored runs (pass --yes to execute probes)'}`,
    `probes   ${result.probeCount}`,
    '',
    result.markdown,
  ];
  if (!result.applied) {
    lines.push('');
    lines.push(`remedy   run: ${CLI} bench probes --yes`);
  }

  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}

export async function benchVariantsCommand(positional, flags) {
  const root = resolve(flags.root ?? positional[0] ?? process.cwd());
  const { dryRun, apply } = writeMode(flags);
  let result;
  try {
    result = await selectRuleVariants(root, {
      apply,
      harness: flags.harness ?? 'gold',
      model: flags.model,
      reps: flags.reps ?? 1,
      includeAll: flags.all === true,
    });
  } catch (error) {
    return fail(
      `${root}: ${error.message ?? error}`,
      EXIT.CONFIG,
      `mine tasks first with \`${CLI} bench mine --yes\` and rerun \`${CLI} bench variants --yes\``,
    );
  }
  if (isJson(flags)) {
    emitJson({ ok: true, command: 'bench variants', dryRun, ...result });
    return EXIT.OK;
  }
  const lines = [
    `bench    variants  ${result.root}`,
    `mode     ${result.applied ? 'applied' : dryRun ? 'dry-run (writes nothing)' : 'preview / stored runs (pass --yes to execute canary and lock winners)'}`,
    `harness  ${result.harness}  model=${result.model}`,
    `slots    ${result.slots.length}  (canary: ${result.canaryTasks}/${result.totalTasks} tasks)`,
    ...result.slots.map(
      (s) => `slot     ${s.slotId}  status=${s.status}  winner=${s.winner}  dR=${s.dR}  dC=${s.dC}  n=${s.n}  p=${s.p}`,
    ),
  ];
  if (!result.applied) lines.push(`remedy   run: ${CLI} bench variants --yes`);
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}




// `simt bench critic` (plan 0003 R39).
//
// The row's acceptance measured, or reported missing rather than inferred: the
// critic runs over a labelled set of historical diffs and the bench reports
// precision and recall for the BLOCK binary. The metric never gates the critic —
// the row says precision >= 0.8 on >= 30 labelled diffs promotes it to a gate,
// and until a bench here shows that, every report calls the critic advisory.
export async function benchCriticCommand(positional, flags, commands = []) {
  const root = resolve(flags.root ?? positional[0] ?? process.cwd());
  const labelsPath = flags.labels ?? '.simt-dev/critic-labels.jsonl';
  const result = await criticBench(root, { labelsPath, flags, commands });
  if (typeof result === 'number') return result;

  if (isJson(flags)) {
    emitJson(result, { pretty: flags.pretty === true, maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }
  const lines = [
    `bench    critic  ${root}`,
    `labels   ${result.labels} (${labelsPath})  measured ${result.measured}  errors ${result.errors.length}`,
    `counts   tp=${result.tp} fp=${result.fp} fn=${result.fn} tn=${result.tn}`,
    `precision ${result.precision === null ? 'unmeasured' : result.precision.toFixed(3)}`,
    `recall    ${result.recall === null ? 'unmeasured' : result.recall.toFixed(3)}`,
    `gated    ${result.gated ? 'yes' : 'no'}`,
  ];
  if (result.labelsNote) lines.push(`labels   ${result.labelsNote}`);
  for (const error of result.errors) lines.push(`error    ${error}`);
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}
