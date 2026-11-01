// `simt status [--line]`
//
// Two questions, one command. `--line` is for shell prompts, tmux and agent status lines:
// one line from the last `check`, read only from `.simt/check.json` plus one
// `git rev-parse HEAD`, so it answers in milliseconds while `check` itself takes the time
// projection takes. Bare `status` is the aggregate a UI's home view asks for - last
// check, git hooks, agent hooks, evidence for the tree on disk, active leases, tracker
// state, the last journal set - and it was a usage error until.
//
// The line's cache lives in `status.mjs`; the aggregate lives in `status-snapshot.mjs`.
// Both report the gate *as of the last check* rather than measuring: a status command
// that ran the gate would cost what the gate costs, and a prompt that waited for it is a
// prompt nobody reads.

import { EXIT, emit, emitJson, isJson, present } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { currentHead, readCheckCache, renderStatusLine } from '../status.mjs';
import { renderSnapshot, statusSnapshot } from '../status-snapshot.mjs';
import { commandRoot } from '../repo-root.mjs';

export async function statusCommand(args, flags) {
  const root = commandRoot(flags, args);
  if (flags.line === true) return statusLine(root, flags);

  const snapshot = await statusSnapshot(root);
  const code = snapshot.ok ? EXIT.OK : EXIT.FAIL;
  if (isJson(flags)) {
    emitJson(snapshot);
    return code;
  }
  emit(renderSnapshot(snapshot));
  return code;
}

async function statusLine(root, flags) {
  const record = await readCheckCache(root);
  if (record === null) {
    // Informational, not a failure: a repository that never ran `check` — or
    // one a writer just invalidated — has no state to report, and a prompt
    // that errored until the first check would train its reader to ignore it.
    present({ ok: true, command: 'status', root, line: null, cached: false, stale: false }, () => 'simt no cache - run check', flags);
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
