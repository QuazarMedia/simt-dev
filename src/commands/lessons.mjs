// `simt lessons [list|review]` — deterministic lesson candidates and promotion to
// `docs/lessons/NNNN-<slug>.md` (plan 0003 R32).

import { resolve } from 'node:path';

import { EXIT, emit, emitJson, fail, isJson, note, writeMode } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import {
  LESSONS_DIR,
  LESSONS_FILE,
  captureFromLedger,
  captureRevertedCommits,
  listPromotedLessons,
  promoteLesson,
  readLessonCandidates,
} from '../memory/lessons.mjs';

function parsePathsFlag(raw) {
  if (!raw) return undefined;
  const list = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

export async function lessonsListCommand(args, flags) {
  if (args.length > 0) {
    return fail(`unknown lessons argument ${args[0]}`, EXIT.USAGE, `run: ${CLI} lessons`);
  }
  const root = resolve(flags.root ?? process.cwd());
  await captureFromLedger(root);
  await captureRevertedCommits(root);

  const [{ candidates, errors }, promoted] = await Promise.all([
    readLessonCandidates(root),
    listPromotedLessons(root),
  ]);

  const payload = {
    ok: errors.length === 0,
    command: 'lessons list',
    root,
    ledgerFile: LESSONS_FILE,
    lessonsDir: LESSONS_DIR,
    candidateCount: candidates.length,
    promotedCount: promoted.length,
    candidates,
    promoted,
    errors,
  };

  if (isJson(flags)) {
    emitJson(payload, { pretty: flags.pretty === true, maxBytes: flags.maxBytes ?? 0 });
    return errors.length === 0 ? EXIT.OK : EXIT.FAIL;
  }

  const lines = [
    `candidates  ${candidates.length} (${LESSONS_FILE})`,
    `promoted    ${promoted.length} (${LESSONS_DIR})`,
  ];

  if (candidates.length > 0) {
    lines.push('', 'CANDIDATES');
    for (const c of candidates) {
      const sigShort = c.signature.slice(0, 19);
      const state = c.status === 'promoted' ? `promoted -> ${c.promotedTo}` : 'candidate';
      lines.push(`  ${c.id}  ${c.kind.padEnd(14)}  ${sigShort}  ${state}  ${c.summary}`);
    }
  }

  if (promoted.length > 0) {
    lines.push('', 'LESSONS');
    for (const l of promoted) {
      lines.push(`  ${l.id.padEnd(28)}  ${(l.signature ?? 'no-signature').slice(0, 19)}  ${l.title}`);
    }
  }

  for (const err of errors) lines.push(`error       ${err}`);

  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return errors.length === 0 ? EXIT.OK : EXIT.FAIL;
}

export async function lessonsReviewCommand(args, flags) {
  if (args.length > 1) {
    return fail(`unknown lessons review argument ${args[1]}`, EXIT.USAGE, `run: ${CLI} lessons review [<id>] [--yes]`);
  }
  const root = resolve(flags.root ?? process.cwd());
  const mode = writeMode(flags);
  const paths = parsePathsFlag(flags.paths);
  const title = flags.task ? String(flags.task) : undefined;

  const result = await promoteLesson(root, {
    id: args[0],
    apply: mode.apply,
    paths,
    title,
  });

  if (!result.ok) {
    return fail(result.error, EXIT.FAIL, `record a session failure-then-fix or run: ${CLI} lessons`);
  }

  const payload = {
    ok: true,
    command: 'lessons review',
    root,
    dryRun: mode.dryRun,
    written: result.written,
    path: result.path,
    candidate: result.candidate,
    markdown: result.markdown,
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
  if (!mode.apply) {
    note(`note    dry-run  nothing written; apply with: ${CLI} lessons review --yes`);
  }
  return EXIT.OK;
}
