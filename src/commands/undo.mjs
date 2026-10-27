// `simt undo [--yes] [--json]`
//
// Restore the last journaled set of writes (plan 0003 R49): every file the last
// writing run changed goes back to its pre-run bytes, and files the run created
// are deleted. A run that wrote nothing leaves no set, so there is nothing to
// restore and the command says so.
//
// The safety is the journal's, not the flag's: when any file in the set no
// longer matches the bytes the run left, the whole undo is refused — restoring
// the rest around a hand edit would silently merge two authors' intentions.
// Like every other writer this command previews without `--yes`.

import { EXIT, emit, emitJson, isJson, writeMode } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { listJournalSets, readJournalSet, undoLastJournalSet } from '../journal.mjs';

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
  const paths = set.entries.map((e) => e.path);

  if (!mode.apply) {
    if (isJson(flags)) {
      emitJson({ ok: true, command: 'undo', root, set: id, restores: paths, dryRun: true });
      return EXIT.OK;
    }
    emit(
      [`last write  ${set.command} (${id})`, ...paths.map((p) => `restore   ${p}`), '', `would restore ${paths.length} file(s); apply with: ${CLI} undo --yes`].join(
        '\n',
      ),
      { maxBytes: flags.maxBytes ?? 0 },
    );
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
  if (isJson(flags)) {
    emitJson({ ok: true, command: 'undo', root, set: result.set, restored: result.restored });
    return EXIT.OK;
  }
  emit(
    [`undone    ${result.set}`, ...result.restored.map((p) => `restored  ${p}`)].join('\n'),
    { maxBytes: flags.maxBytes ?? 0 },
  );
  return EXIT.OK;
}
