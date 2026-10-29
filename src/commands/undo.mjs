// `simt undo [--yes] [--json]`
//
// Restore the last journaled set of writes (plan 0003 R49): every file the last
// writing run changed goes back to its pre-run bytes, files the run created
// are deleted, and git config keys the run set go back to their pre-run
// values (review 0003 Q22). A run that wrote nothing leaves no set, so there
// is nothing to restore and the command says so.
//
// The safety is the journal's, not the flag's: when any file in the set no
// longer matches the bytes the run left, the whole undo is refused — restoring
// the rest around a hand edit would silently merge two authors' intentions.
// Like every other writer this command previews without `--yes`.

import { EXIT, emit, emitJson, isJson, writeMode } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { beforeText, entryLabel, listJournalSets, readGitValue, readJournalSet, undoLastJournalSet } from '../journal.mjs';
import { diffField, emitDiffs, readBefore } from '../diff.mjs';
import { join } from 'node:path';
import { invalidateCheckCache } from '../status.mjs';

export async function undoCommand(positional, flags) {
  const root = flags.root ?? positional[0] ?? process.cwd();
  const mode = writeMode(flags);

  const [id] = await listJournalSets(root);
  if (!id) {
    if (isJson(flags)) {
      emitJson({ ok: true, command: 'undo', root, set: null, restored: [], dryRun: !mode.apply });
      return EXIT.OK;
    }
    emit('nothing to undo: no journaled writes', { maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }

  const set = await readJournalSet(root, id);
  const labels = set.entries.map(entryLabel);
  // The `--diff` pairs: what the tree holds now against what the restore
  // would put back. A null before is a file the run created (or a key it
  // set from unset), so the restore deletes it — the after side is empty
  // (R50).
  const diffs =
    flags.diff === true
      ? await Promise.all(
        set.entries.map(async (e) => {
          if (e.kind === 'git-config') {
            return { path: entryLabel(e), before: await readGitValue(root, e.key), after: e.before ?? null };
          }
          return { path: e.path, before: await readBefore(join(root, e.path)), after: beforeText(e) };
        }),
      )
      : [];

  if (!mode.apply) {
    if (isJson(flags)) {
      emitJson({ ok: true, command: 'undo', root, set: id, restores: labels, dryRun: true, ...diffField(diffs, flags) });
      return EXIT.OK;
    }
    const files = set.entries.filter((e) => e.kind !== 'git-config').length;
    const keys = set.entries.length - files;
    emit(
      [
        `last write  ${set.command} (${id})`,
        ...labels.map((p) => `restore   ${p}`),
        '',
        `would restore ${files} file(s)${keys > 0 ? ` and ${keys} git config key(s)` : ''}; apply with: ${CLI} undo --yes`,
      ].join('\n'),
      { maxBytes: flags.maxBytes ?? 0 },
    );
    // After the report: the report says what, the diff shows it (R50).
    emitDiffs(diffs, flags);
    return EXIT.OK;
  }

  const result = await undoLastJournalSet(root);
  if (result.empty) {
    if (isJson(flags)) {
      emitJson({ ok: true, command: 'undo', root, set: null, restored: [] });
      return EXIT.OK;
    }
    emit('nothing to undo: no journaled writes', { maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }
  if (result.refused) {
    if (isJson(flags)) {
      emitJson({ ok: false, command: 'undo', root, set: result.set, refused: result.refused, restored: [] });
      return EXIT.FAIL;
    }
    emit(
      [
        `refused   ${result.set}`,
        `touched   ${result.refused.path}  ${result.refused.detail}`,
        '',
        'nothing was restored; re-run the writing command or merge by hand, then undo again',
      ].join('\n'),
      { maxBytes: flags.maxBytes ?? 0 },
    );
    return EXIT.FAIL;
  }
  // The tree is back to before the run, so a `check` from after the run no
  // longer describes it — the line goes back to "no cache" (R48). A restored
  // set always restored something, so there is nothing to gate on.
  await invalidateCheckCache(root);
  if (isJson(flags)) {
    emitJson({ ok: true, command: 'undo', root, set: result.set, restored: result.restored, ...diffField(diffs, flags) });
    return EXIT.OK;
  }
  emit(
    [`undone    ${result.set}`, ...result.restored.map((p) => `restored  ${p}`)].join('\n'),
    { maxBytes: flags.maxBytes ?? 0 },
  );
  // After the report: the report says what, the diff shows it (R50).
  emitDiffs(diffs, flags);
  return EXIT.OK;
}
