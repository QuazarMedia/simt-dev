// simt sync — write the generated region.
// simt check — the gate.
//
// They share plan/project.mjs so they can never disagree about what the region
// should contain. sync decides whether to act; check decides severity and exit
// code. sync never pushes and never commits (ADR-001).

import { writeFile } from 'node:fs/promises';

import { EXIT, emit, emitJson, fail, isJson, note } from '../output/index.mjs';
import { plan, checkTarget, loadRules, select } from '../projection/project.mjs';

export async function syncCommand(positional, flags) {
  const root = flags.root ?? positional[0] ?? process.cwd();
  const checkOnly = flags.check === true;

  const result = await plan(root);
  const target = result.targets[0];

  // A malformed region is refused, never overwritten. Appending a second region
  // would duplicate every rule while reporting success.
  if (target.action === 'malformed') {
    if (isJson(flags)) {
      emitJson({ ok: false, command: 'sync', root, error: target.reason, file: target.file, line: target.line });
    }
    return fail(
      `${target.file} has a malformed generated region (${target.reason})`,
      EXIT.FAIL,
      `fix the markers at ${target.file}:${target.line}, then: simt sync`,
    );
  }

  for (const n of result.notes) note(`note ${n}`);

  if (isJson(flags)) {
    emitJson(
      {
        ok: true,
        command: checkOnly ? 'sync --check' : 'sync',
        root,
        stack: result.stack,
        profiles: result.profiles,
        sha: target.sha,
        targets: [
          {
            file: target.file,
            action: target.action,
            bytes: target.bytes,
            previousBytes: target.previousBytes,
          },
        ],
        written: false,
      },
      {},
    );
  } else {
    emit(
      [
        `repo      ${root}`,
        `stack     ${result.stack.length > 0 ? result.stack.join(', ') : '(undetected)'}`,
        `profiles  ${result.profiles.join(', ')}${result.fallback ? ' (fallback)' : ''}`,
        `sha       ${target.sha}`,
        '',
        `${target.file}  ${target.action}  ${target.previousBytes} -> ${target.bytes} bytes`,
        target.action === 'unchanged' ? 'already current; nothing written' : '',
        checkOnly && target.action !== 'unchanged' ? 'would write; rerun without --check' : '',
      ]
        .filter((l) => l !== '')
        .join('\n'),
      { maxBytes: flags.maxBytes ?? 0 },
    );
  }

  if (target.action === 'unchanged') return EXIT.OK;
  if (checkOnly) return EXIT.FAIL;
  if (flags.dryRun === true) {
    note('dry-run  no files written');
    return EXIT.OK;
  }

  await writeFile(target.path, target.text);
  note(`wrote    ${target.file}`);
  return EXIT.OK;
}

export async function checkCommand(positional, flags) {
  const root = flags.root ?? positional[0] ?? process.cwd();
  const findings = [await checkTarget(root)];
  const rules = await loadRules();

  // A rule file with no id would be projected without a traceable source, so it
  // is a gate failure rather than a warning: `rules why` could not resolve it.
  for (const r of rules) {
    if (r.error) {
      findings.push({ file: `rules/${r.file}`, status: 'invalid', detail: r.error });
    }
  }

  const bad = findings.filter((f) => f.status !== 'current');
  const payload = {
    ok: bad.length === 0,
    command: 'check',
    root,
    findings,
  };

  if (isJson(flags)) {
    emitJson(payload, {});
    return bad.length === 0 ? EXIT.OK : EXIT.FAIL;
  }

  emit(
    findings
      .map((f) => `${f.status.toUpperCase().padEnd(9)} ${f.file}${f.detail ? `  ${f.detail}` : ''}`)
      .join('\n'),
    { maxBytes: flags.maxBytes ?? 0 },
  );
  return bad.length === 0 ? EXIT.OK : EXIT.FAIL;
}

export { plan, checkTarget, select };