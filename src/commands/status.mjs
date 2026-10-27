// `simt status --line`
//
// One line from the last `check`, for shell prompts, tmux and agent status
// lines: `simt PASS ✓rules ✓hooks 3/3gates`. The line is the gate state *as
// of the last check* — it reads only `.simt/check.json` plus one
// `git rev-parse HEAD`, so it answers in milliseconds while `check` itself
// takes the time projection takes.
//
// Bare `status` is a usage error, the way `plan` without a subcommand is: the
// only mode this command has is `--line`, and running something else by
// default would invent a second answer to what the status is.

import { EXIT, emit, emitJson, fail, isJson } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { currentHead, readCheckCache, renderStatusLine } from '../status.mjs';

export async function statusCommand(args, flags) {
  const root = flags.root ?? args[0] ?? process.cwd();
  if (flags.line !== true) {
    return fail('status needs --line', EXIT.USAGE, `run: ${CLI} status --line --root ${root}`);
  }

  const record = await readCheckCache(root);
  if (record === null) {
    // Informational, not a failure: a repository that never ran `check` — or
    // one a writer just invalidated — has no state to report, and a prompt
    // that errored until the first check would train its reader to ignore it.
    if (isJson(flags)) {
      emitJson({ ok: true, command: 'status', root, line: null, cached: false, stale: false });
      return EXIT.OK;
    }
    emit('simt no cache - run check');
    return EXIT.OK;
  }

  const head = await currentHead(root);
  // Stale when HEAD moved since the check ran. When either side is unknown
  // there is nothing to compare, so the record stands as written.
  const stale = head !== null && record.head !== null && head !== record.head;
  const line = renderStatusLine(record, stale);
  const code = record.blocking === 0 ? EXIT.OK : EXIT.FAIL;

  if (isJson(flags)) {
    emitJson({
      ok: code === EXIT.OK,
      command: 'status',
      root,
      line,
      cached: true,
      stale,
      rulesOk: record.rulesOk,
      hooksOk: record.hooksOk,
      gatesRun: record.gatesRun,
      gatesTotal: record.gatesTotal,
      blocking: record.blocking,
      warnings: record.warnings,
    });
    return code;
  }
  emit(line);
  return code;
}
