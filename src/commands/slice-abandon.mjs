// `simt slice abandon <id>`: take the slice back down. The worktree is removed, the
// branch deleted, and the tracker row returns to the ready state. Extracted from the
// command so the three slice states do not share one file.

import { unlink } from 'node:fs/promises';
import { relative } from 'node:path';

import { EXIT, emit, emitJson, fail, isJson, writeMode } from '../output/index.mjs';
import { planDone } from '../plan/index.mjs';
import { loadFormat } from '../plan/template.mjs';
import { CLI } from '../name.mjs';
import { git, gitText } from '../sys/git.mjs';
import { mainCheckout, places, readSliceRecord, recordPath, resolveSlice, sliceSession } from './slice.mjs';

/**
 * `simt slice abandon <id>`: take the slice back down. The worktree is
 * removed, the branch deleted, and the tracker row returns to the ready
 * state — abandonment is a state the tracker can see, not a worktree that
 * silently rots. Preview names everything that would be destroyed; `--yes`
 * is the consent to destroy it.
 */
async function abandonSlice(root, id, flags) {
  const mode = writeMode(flags);
  const main = await mainCheckout(root);
  const resolved = await resolveSlice(main, id);
  // A prompt slice has no tracker row: the record file stands in for it, and the
  // abandon removes the record file where a tracked abandon would reset the row.
  const record = resolved.error ? await readSliceRecord(main, id) : null;
  if (resolved.error && record === null) {
    return fail(resolved.error, EXIT.USAGE, resolved.remedy);
  }
  const promptMode = record !== null;
  const doc = promptMode ? record.title : resolved.slice.doc;
  const recRel = relative(main, recordPath(main, id));
  const { branch, worktree } = places(main, id);
  const session = sliceSession(flags);
  const apply = `run: ${CLI} slice abandon ${id} --yes`;

  let preview = null;
  if (!promptMode) {
    const loaded = await loadFormat(main);
    if (loaded.error) return fail(loaded.error, EXIT.USAGE, loaded.remedy);
    const readyDisplay = loaded.format.canonical(loaded.format.ready) ?? 'Queued';
    preview = await planDone(main, id, { state: readyDisplay, dryRun: true });
    if (preview.error) return fail(preview.error, EXIT.USAGE, preview.remedy ?? `run: ${CLI} plan status`);
  }
  const stateLine = promptMode ? `state    (no tracker row; removing ${recRel})` : `state    ${preview.from} -> ${preview.to}`;
  const stateJson = promptMode ? { row: false, record: recRel } : { from: preview.from, to: preview.to, changed: preview.wouldChange };

  if (!mode.apply) {
    if (isJson(flags)) {
      emitJson({
        ok: true,
        command: 'slice abandon',
        root,
        id,
        dryRun: true,
        branch,
        worktree: relative(main, worktree),
        state: stateJson,
        remedy: apply,
      });
      return EXIT.OK;
    }
    const lines = [
      `repo     ${root}`,
      `slice    ${id}  ${doc}`,
      `remove   ${relative(main, worktree)} and branch ${branch} (on apply)`,
      stateLine,
      `apply    ${apply}`,
    ];
    emit(lines.join('\n'));
    return EXIT.OK;
  }

  // Abandoning from inside the worktree would pull the floor out: the shell's
  // own directory is the thing being removed. Compared through git, not through
  // strings, because the caller's spelling of the path may differ in symlinks.
  const top = await gitText(root, ['rev-parse', '--show-toplevel']).catch(() => null);
  if (top !== null && (top === worktree || top.startsWith(`${worktree}/`))) {
    return fail(
      `cannot abandon ${id} from inside its worktree`,
      EXIT.USAGE,
      `move to the main checkout (${main}) and rerun: ${apply}`,
    );
  }

  const removed = [];
  try {
    await git(main, ['worktree', 'remove', '--force', worktree]);
    removed.push(`removed  ${relative(main, worktree)}`);
  } catch (error) {
    const detail = String(error.stderr ?? error.message ?? error).trim().split('\n')[0];
    removed.push(`kept     ${relative(main, worktree)} (${detail})`);
  }
  try {
    await git(main, ['branch', '-D', branch]);
    removed.push(`deleted  ${branch}`);
  } catch (error) {
    const detail = String(error.stderr ?? error.message ?? error).trim().split('\n')[0];
    removed.push(`kept     ${branch} (${detail})`);
  }

  let row = null;
  if (promptMode) {
    // No row to reset; the record file is the only mark of the slice, and it goes.
    try {
      await unlink(recordPath(main, id));
    } catch {
      // A record that is already gone is not a second failure: the worktree and
      // branch are what abandonment exists to take down.
    }
  } else {
    const loaded = await loadFormat(main);
    if (loaded.error) return fail(loaded.error, EXIT.USAGE, loaded.remedy);
    const readyDisplay = loaded.format.canonical(loaded.format.ready) ?? 'Queued';
    row = await planDone(main, id, { state: readyDisplay, dryRun: false });
    if (row.error) {
      return fail(
        `the worktree is down, but the tracker row was not updated: ${row.error}`,
        EXIT.FAIL,
        row.remedy ?? `run: ${CLI} plan status`,
      );
    }
  }

  const released = await releaseSlice(main, id, session);
  const leaseLine =
    released.released === true
      ? `released the slice lease`
      : released.error
        ? `the slice lease could not be released (${released.error}); the TTL reaps it`
        : 'no slice lease was held';
  const abandonStateJson = promptMode ? { row: false, record: recRel, removed: true } : { from: row.from, to: row.to, changed: row.changed };
  if (isJson(flags)) {
    emitJson({
      ok: true,
      command: 'slice abandon',
      root,
      id,
      branch,
      worktree: relative(main, worktree),
      lease: released.released === true ? { slice: id, session } : null,
      state: abandonStateJson,
    });
    return EXIT.OK;
  }
  const lines = [
    `repo     ${root}`,
    `slice    ${id}  ${doc}`,
    ...removed,
    promptMode ? `state    (no tracker row; removed ${recRel})` : `state    ${row.from} -> ${row.to}`,
    `lease    ${leaseLine}`,
  ];
  emit(lines.join('\n'));
  return EXIT.OK;
}

export { abandonSlice };
