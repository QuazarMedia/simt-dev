// `simt ignore` — render the one ignore list into every reader's dialect
// (plan 0003 R52).
//
// Shape copied from `ci`: the plan is printed first, nothing is written
// without `--yes`, `--diff` shows the same plan as unified diffs and `undo`
// restores the set (R49). Three of the four targets are generated from the
// list; `.claude/settings.json` is merged, never replaced — see src/ignore.mjs
// for why that distinction exists.

import { join } from 'node:path';

import { EXIT, emit, emitJson, fail, isJson, note, writeMode } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { commitJournal, journaledWriteFile } from '../journal.mjs';
import { diffField, emitDiffs, readBefore } from '../diff.mjs';
import { CLAUDE_SETTINGS, IGNORE_FILE, parseIgnoreList, planIgnore } from '../ignore.mjs';

export async function ignoreCommand(args, flags) {
  const root = flags.root ?? process.cwd();

  let source;
  try {
    source = await readBefore(join(root, IGNORE_FILE));
  } catch (error) {
    return fail(`${IGNORE_FILE} could not be read: ${error.message}`, EXIT.FAIL, `fix the file's permissions, then re-run: ${CLI} ignore`);
  }
  if (source === null) {
    // A missing list is a missing input, not an empty one: rendering four empty
    // files from a file that does not exist would answer the request with
    // silence the reader has no way to tell from success.
    return fail(
      `no ${IGNORE_FILE} in ${root}`,
      EXIT.FAIL,
      `create ${IGNORE_FILE} with one path or glob per line (# comments), then: ${CLI} ignore`,
    );
  }

  const entries = parseIgnoreList(source);
  if (entries.length === 0) {
    return fail(
      `${IGNORE_FILE} parses to zero entries`,
      EXIT.FAIL,
      `add one path or glob per line to ${IGNORE_FILE}, then: ${CLI} ignore`,
    );
  }

  const plan = await planIgnore(entries, (path) => readBefore(join(root, path)));
  if (!plan.ok) {
    return fail(plan.error, EXIT.FAIL, `repair ${CLAUDE_SETTINGS} by hand, then re-run: ${CLI} ignore`);
  }

  const mode = writeMode(flags);
  const changed = plan.targets.filter((t) => t.action !== 'unchanged');
  const diffs =
    flags.diff === true
      ? changed.map((t) => ({ path: t.path, before: t.before, after: t.after }))
      : [];

  // Nothing to do: the report says so from the same plan the write would have
  // used, so "unchanged" cannot disagree with what `--yes` would have written.
  if (changed.length === 0) {
    if (isJson(flags)) {
      emitJson({
        ok: true,
        command: 'ignore',
        root,
        source: IGNORE_FILE,
        entries: entries.length,
        files: plan.targets.map((t) => ({ path: t.path, action: t.action, bytes: byteLen(t.after) })),
        written: false,
        dryRun: false,
      });
    } else {
      emit(plan.targets.map((t) => `current  ${t.path}  ${byteLen(t.after)} bytes`).join('\n'));
      note('every target already matches the list; nothing to write');
    }
    return EXIT.OK;
  }

  const lines = [
    `repo      ${root}`,
    `source    ${IGNORE_FILE} (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'})`,
    '',
  ];
  for (const t of plan.targets) {
    lines.push(`file      ${t.path}`, `action    ${t.action}`);
    if (t.action === 'update' && t.before !== null) {
      // An update whose before side has lines the list does not: those lines
      // are about to stop existing. Named here because a preview that only says
      // "update" hides the deletion inside the diff the reader has to ask for.
      const dropped = countDropped(t.before, t.after);
      if (dropped > 0) lines.push(`replaces  ${dropped} line(s) not in ${IGNORE_FILE} (shown by --diff)`);
    }
  }

  // Exactly one JSON document per run, emitted once on whichever path ends it:
  // a preview and its write are two phases of ONE answer, and a reader that
  // parses the first document gets "written: false" while the run writes.
  const payload = (written) => ({
    ok: true,
    command: 'ignore',
    root,
    source: IGNORE_FILE,
    entries: entries.length,
    files: plan.targets.map((t) => ({ path: t.path, action: t.action, bytes: byteLen(t.after) })),
    written,
    dryRun: !mode.apply,
    ...diffField(diffs, flags),
  });

  if (!isJson(flags)) emit(lines.join('\n'));

  if (!mode.apply) {
    // After the report: the report says what, the diff shows it (R50).
    emitDiffs(diffs, flags);
    if (isJson(flags)) {
      emitJson(payload(false));
    } else {
      note('');
      note(mode.dryRun ? 'dry-run  nothing written' : `dry-run  nothing written; apply with: ${CLI} ignore --yes`);
    }
    return EXIT.OK;
  }

  // Journaled so `undo` restores this run (R49). Every note writes to stderr,
  // so the `--json` document remains the only bytes on stdout.
  const journal = [];
  for (const t of changed) {
    await journaledWriteFile(root, journal, join(root, t.path), t.after);
    note(`wrote    ${t.path} (${t.action})`);
  }
  await commitJournal(root, 'ignore', journal);

  if (isJson(flags)) emitJson(payload(true));
  // After the report: the report says what, the diff shows it (R50).
  emitDiffs(diffs, flags);
  return EXIT.OK;
}

function byteLen(text) {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * How many lines the new bytes drop from the old: lines the current file has
 * that the list does not produce. Used only for the plan's `replaces` note —
 * the diff is the authoritative statement of what goes.
 */
function countDropped(before, after) {
  const kept = new Set(after.split('\n'));
  return before.split('\n').filter((line) => line.trim() !== '' && !kept.has(line)).length;
}