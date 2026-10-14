// `simt bench mine` - mine verified benchmark tasks from git history (R01).
//
// Like every writer in this CLI, `bench mine` is a preview by default and writes
// task descriptors to `.simt-dev/bench/tasks/<id>.json` and hidden test patches
// to the verifier vault only when authorised with `--yes` (and not `--dry-run`).

import { resolve } from 'node:path';

import { CLI } from '../name.mjs';
import { EXIT, emit, emitJson, fail, isJson, writeMode } from '../output/index.mjs';
import { DEFAULT_MINE_TARGET, mineTasks } from '../bench/mine.mjs';

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
    `mode     ${result.applied ? 'applied' : dryRun ? 'dry-run (writes nothing)' : `preview (pass --yes to validate and write)`}`,
    `commits  ${result.candidatesCount} candidate(s) touch both test and implementation paths`,
  ];

  if (result.applied) {
    lines.push(`mined    ${result.tasks.length} verified task(s)`);
    lines.push(`tasks    ${result.tasksDir}`);
    lines.push(`vault    ${result.vaultRoot}`);
    for (const task of result.tasks) {
      const subject = task.prompt.split('\n')[0];
      lines.push(
        `task     ${task.id}  f2p=${task.f2p.length}  p2p=${task.p2p.length}  files=${task.gold.files}  +${task.gold.linesAdded}/-${task.gold.linesRemoved}  ${subject}`,
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
