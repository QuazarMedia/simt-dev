// `simt lessons [list|review]` — deterministic lesson candidates and promotion to
// `docs/lessons/NNNN-<slug>.md` (plan 0003 R32).

import { resolve } from 'node:path';

import { EXIT, emit, emitJson, fail, isJson, note, writeMode } from '../output/index.mjs';
import { diffField, emitDiffs } from '../diff.mjs';
import { commitJournal } from '../journal.mjs';
import { CLI } from '../name.mjs';
import { parsePathList } from '../argv.mjs';
import {
  LESSONS_DIR,
  LESSONS_FILE,
  captureFromLedger,
  captureRevertedCommits,
  listPromotedLessons,
  promoteLesson,
  readLessonCandidates,
} from '../memory/lessons.mjs';

export async function lessonsListCommand(args, flags) {
  if (args.length > 0) {
    return fail(`unknown lessons argument ${args[0]}`, EXIT.USAGE, `run: ${CLI} lessons`);
  }
  const root = resolve(flags.root ?? process.cwd());
  // Pure: listing must not capture. Capture used to run here, so `list` wrote
  // to the store it was reading and a read-only question had write side
  // effects. Capturing is `lessons capture` now (review 0003 Q36).
  const [{ candidates, errors }, promoted] = await Promise.all([
    readLessonCandidates(root),
    listPromotedLessons(root, { includeExpired: true }),
  ]);
  const live = promoted.filter((l) => !l.expired);
  const expiredCount = promoted.length - live.length;

  const payload = {
    ok: errors.length === 0,
    command: 'lessons list',
    root,
    ledgerFile: LESSONS_FILE,
    lessonsDir: LESSONS_DIR,
    candidateCount: candidates.length,
    promotedCount: live.length,
    expiredCount,
    candidates,
    promoted: live,
    errors,
  };

  if (isJson(flags)) {
    emitJson(payload, { pretty: flags.pretty === true, maxBytes: flags.maxBytes ?? 0 });
    return errors.length === 0 ? EXIT.OK : EXIT.FAIL;
  }

  const lines = [
    `candidates  ${candidates.length} (${LESSONS_FILE})`,
    `promoted    ${live.length} (${LESSONS_DIR})${expiredCount > 0 ? `, ${expiredCount} expired` : ''}`,
  ];

  if (candidates.length > 0) {
    lines.push('', 'CANDIDATES');
    for (const c of candidates) {
      const sigShort = c.signature.slice(0, 19);
      const state = c.status === 'promoted' ? `promoted -> ${c.promotedTo}` : 'candidate';
      lines.push(`  ${c.id}  ${c.kind.padEnd(14)}  ${sigShort}  ${state}  ${c.summary}`);
    }
  }

  if (live.length > 0) {
    lines.push('', 'LESSONS');
    for (const l of live) {
      lines.push(`  ${l.id.padEnd(28)}  ${(l.signature ?? 'no-signature').slice(0, 19)}  ${l.title}`);
    }
  }
  if (expiredCount > 0) {
    lines.push('', `EXPIRED ${expiredCount}`);
    for (const l of promoted.filter((l) => l.expired)) {
      lines.push(`  ${l.id.padEnd(28)}  expired ${l.expires ?? 'no date'}  ${l.title}`);
    }
  }

  for (const err of errors) lines.push(`error       ${err}`);

  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return errors.length === 0 ? EXIT.OK : EXIT.FAIL;
}

/**
 * `simt lessons capture` — the explicit write half of the old `list`.
 *
 * Scans the ledger for fail-then-fix sequences and git history for reverts,
 * and appends any new candidates. A command that writes says so in its name;
 * `list` and `review` previews do not (review 0003 Q36).
 */
export async function lessonsCaptureCommand(args, flags) {
  if (args.length > 0) {
    return fail(`unknown lessons capture argument ${args[0]}`, EXIT.USAGE, `run: ${CLI} lessons capture`);
  }
  const root = resolve(flags.root ?? process.cwd());
  const fromLedger = await captureFromLedger(root);
  const reverts = await captureRevertedCommits(root);

  const payload = {
    ok: true,
    command: 'lessons capture',
    root,
    failThenFix: fromLedger.length,
    reverts: reverts.length,
    captured: [...fromLedger, ...reverts],
  };
  if (isJson(flags)) {
    emitJson(payload, { pretty: flags.pretty === true, maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }
  const lines = [
    `captured    ${payload.captured.length} candidates (${LESSONS_FILE})`,
    `  fail-then-fix  ${fromLedger.length}`,
    `  reverts        ${reverts.length}`,
  ];
  for (const c of payload.captured) {
    lines.push(`  ${c.id}  ${c.kind}  ${c.summary}`);
  }
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}

export async function lessonsReviewCommand(args, flags) {
  if (args.length > 1) {
    return fail(`unknown lessons review argument ${args[1]}`, EXIT.USAGE, `run: ${CLI} lessons review [<id>] [--yes]`);
  }
  const root = resolve(flags.root ?? process.cwd());
  const mode = writeMode(flags);
  const parsedPaths = parsePathList(flags.paths);
  const paths = parsedPaths.length > 0 ? parsedPaths : undefined;
  const title = flags.task ? String(flags.task) : undefined;
  const expires = typeof flags.expires === 'string' && flags.expires.trim() !== '' ? flags.expires.trim() : undefined;

  // Journaled so `undo` restores the promoted file (R49); committed only when
  // the run actually wrote, which commitJournal already guarantees.
  const journal = [];
  const result = await promoteLesson(root, {
    id: args[0],
    apply: mode.apply,
    paths,
    title,
    expires,
    journal: mode.apply ? journal : undefined,
  });
  if (mode.apply && result.ok) await commitJournal(root, 'lessons review', journal);

  if (!result.ok) {
    return fail(result.error, EXIT.FAIL, `record a session failure-then-fix or run: ${CLI} lessons`);
  }

  // The `--diff` pair: the promoted lesson file, created or refreshed (R50). The
  // before-side rides on the result from `promoteLesson`, read before anything
  // was written, so the diff is true in preview and in apply alike.
  const diffs =
    flags.diff === true
      ? [{ path: result.path, before: result.before ?? null, after: result.markdown }]
      : [];

  const payload = {
    ok: true,
    command: 'lessons review',
    root,
    dryRun: mode.dryRun,
    written: result.written,
    path: result.path,
    candidate: result.candidate,
    markdown: result.markdown,
    ...diffField(diffs, flags),
  };

  if (isJson(flags)) {
    emitJson(payload, { pretty: flags.pretty === true, maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }

  const lines = [
    `promote     ${result.candidate.id} (${result.candidate.kind}) -> ${result.path}`,
    `signature   ${result.candidate.signature}`,
    `mode        ${mode.apply ? 'applied' : mode.dryRun ? 'dry-run (writes nothing)' : `preview (pass --yes to write ${result.path})`}`,
    '',
    result.markdown.trimEnd(),
  ];

  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  // After the report: the report says what, the diff shows it (R50).
  emitDiffs(diffs, flags);
  if (!mode.apply) {
    note(`note    dry-run  nothing written; apply with: ${CLI} lessons review --yes`);
  }
  return EXIT.OK;
}
