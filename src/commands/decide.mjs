// `simt decide` — scaffold an ADR with the next free number, a Status: line,
// a rulings skeleton, and structured `simt-affects` + `simt-supersedes` frontmatter
// (plan 0003 R34).

import { join, resolve } from 'node:path';
import { EXIT, emit, emitJson, fail, isJson, note, writeMode } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { DECISIONS_DIR } from '../decisions/index.mjs';
import { lintDecisions, scaffoldDecision } from '../memory/decide.mjs';
import { parsePathList } from '../argv.mjs';

export async function decideCommand(args, flags) {
  const root = flags.root ?? process.cwd();

  if (flags.check === true) {
    const decisionsDir = join(root, 'docs', 'decisions');
    const allowHistorical = resolve(decisionsDir) === DECISIONS_DIR;
    const res = await lintDecisions(decisionsDir, { allowHistorical });

    if (isJson(flags)) {
      emitJson({
        ok: res.ok,
        command: 'decide --check',
        root,
        findings: res.findings,
      });
      return res.ok ? EXIT.OK : EXIT.FAIL;
    }

    if (res.findings.length === 0) {
      emit('decisions  ok', { maxBytes: flags.maxBytes ?? 0 });
      return EXIT.OK;
    }

    emit(
      res.findings
        .flatMap((f) => [
          `${f.status.toUpperCase()}  ${f.file}  ${f.detail}`,
          ...(f.remedy ? [`  remedy: ${f.remedy}`] : []),
        ])
        .join('\n'),
      { maxBytes: flags.maxBytes ?? 0 },
    );
    return EXIT.FAIL;
  }

  const mode = writeMode(flags);
  const title = args.join(' ').trim() || flags.task || 'Untitled decision';
  const parsedPaths = parsePathList(flags.paths);
  const explicitPaths = flags.paths !== undefined ? parsedPaths : undefined;

  const res = await scaffoldDecision(root, {
    title,
    affects: explicitPaths,
    supersedes: flags.supersedes,
    write: mode.apply,
  });

  if (!res.ok) {
    return fail(
      res.errors[0],
      EXIT.USAGE,
      `usage: ${CLI} decide "<title>" [--supersedes ADR-NNN:<ruling>] [--yes]`,
    );
  }

  if (mode.apply) {
    note(`wrote    ${res.relPath}`);
  } else if (flags.dryRun === true) {
    note('dry-run  no files written');
  }

  if (isJson(flags)) {
    emitJson({
      ok: true,
      command: 'decide',
      root,
      id: res.id,
      number: res.number,
      title: res.title,
      file: res.file,
      path: res.relPath,
      affects: res.affects,
      supersedes: res.supersedes,
      written: res.written,
      dryRun: !mode.apply,
    });
    return EXIT.OK;
  }

  const supersedesLabel =
    res.supersedes.length > 0
      ? res.supersedes
          .map((s) => (s.ruling !== null ? `${s.adr} ruling ${s.ruling} (${s.kind})` : s.adr))
          .join('; ')
      : '(none)';

  const lines = [
    `id          ${res.id}`,
    `title       ${res.title}`,
    `file        ${res.relPath}`,
    `affects     ${res.affects.length > 0 ? res.affects.join(', ') : '(none)'}`,
    `supersedes  ${supersedesLabel}`,
    '',
    res.text.trimEnd(),
    '',
    mode.apply
      ? `wrote ${res.relPath}`
      : flags.dryRun === true
        ? 'dry-run; nothing written'
        : `would write ${res.relPath}; apply with: ${CLI} decide ${JSON.stringify(res.title)} --yes`,
  ];

  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}
