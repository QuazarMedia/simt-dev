// simt sync — write the generated regions.
// simt check — the gate.
//
// They share plan/project.mjs so they can never disagree about what the regions
// should contain. sync decides whether to act; check decides severity and exit
// code. sync never pushes and never commits (ADR-001).
//
// Two properties come from writing several targets rather than one:
//
//   - ALL-OR-NOTHING. A malformed region in any target refuses the whole run, and
//     the refusal happens before the first write. Appending a second region to a
//     document with a broken one would duplicate every rule while reporting
//     success; writing the good targets and skipping the bad one would leave the
//     repo half-adopted with no record of which half.
//   - EVERY WRITE IS REPORTED. Silently syncing AGENTS.md and not mentioning the
//     three `.mdc` rules would let a reader believe a repo is fully current when
//     only the file they happened to open is.

import { writeFile } from 'node:fs/promises';

import { EXIT, emit, emitJson, fail, isJson, note } from '../output/index.mjs';
import { plan, checkTargets, checkTarget, loadRules, select } from '../projection/project.mjs';

export async function syncCommand(positional, flags) {
  const root = flags.root ?? positional[0] ?? process.cwd();
  const checkOnly = flags.check === true;

  const result = await plan(root);

  // A `.mdc` rule that cannot render is a defect in this build, not in the repo,
  // and projecting the rest would leave a family half-retired.
  if (result.mdcProblems.length > 0) {
    if (isJson(flags)) {
      emitJson({
        ok: false,
        command: 'sync',
        root,
        error: result.mdcProblems[0],
        problems: result.mdcProblems,
      });
    }
    for (const p of result.mdcProblems) note(`PROBLEM ${p}`);
    return fail(
      `${result.mdcProblems.length} canonical .mdc rule(s) cannot be projected (${result.mdcProblems[0]})`,
      EXIT.FAIL,
      'fix the reported substitution keys in simt-dev.json, or add the key to the rule in rules/mdc/',
    );
  }

  const broken = result.targets.filter((t) => t.action === 'malformed');
  if (broken.length > 0) {
    const first = broken[0];
    if (isJson(flags)) {
      emitJson({
        ok: false,
        command: 'sync',
        root,
        error: first.reason,
        file: first.file,
        line: first.line,
        alsoBroken: broken.slice(1).map((t) => t.file),
      });
    }
    return fail(
      `${broken.length} file(s) have a malformed generated region (${first.file}: ${first.reason})`,
      EXIT.FAIL,
      `fix the markers at ${first.file}:${first.line}, then: simt sync`,
    );
  }

  for (const n of result.notes) note(`note ${n}`);

  const targets = result.targets.map((t) => ({
    file: t.file,
    action: t.action,
    bytes: t.bytes,
    previousBytes: t.previousBytes,
  }));
  const changed = result.targets.filter((t) => t.action !== 'unchanged');

  // Writes happen BEFORE output in every mode. An earlier build emitted `--json`
  // first and returned, so `upgrade --yes --json` reported a plan and changed
  // nothing — the exact combination automation reaches for.
  if (checkOnly !== true && flags.dryRun !== true) {
    for (const t of changed) {
      await writeFile(t.path, t.text);
      note(`wrote    ${t.file}`);
    }
  }

  if (isJson(flags)) {
    emitJson(
      {
        ok: checkOnly ? changed.length === 0 : true,
        command: checkOnly ? 'sync --check' : 'sync',
        root,
        stack: result.stack,
        profiles: result.profiles,
        sha: result.targets[0].sha,
        targets,
        written: checkOnly || flags.dryRun === true ? false : changed.length,
      },
      {},
    );
  } else {
    const lines = [
      `repo      ${root}`,
      `stack     ${result.stack.length > 0 ? result.stack.join(', ') : '(undetected)'}`,
      `profiles  ${result.profiles.join(', ')}${result.fallback ? ' (fallback)' : ''}`,
      `sha       ${result.targets[0].sha}`,
      '',
      ...result.targets.map(
        (t) => `${t.file}  ${t.action}  ${t.previousBytes} -> ${t.bytes} bytes`,
      ),
    ];
    if (changed.length === 0) lines.push('already current; nothing written');
    else if (checkOnly) lines.push('would write; rerun without --check');
    emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  }

  if (checkOnly) return changed.length === 0 ? EXIT.OK : EXIT.FAIL;
  if (flags.dryRun === true) {
    note('dry-run  no files written');
    return EXIT.OK;
  }
  return EXIT.OK;
}

export async function checkCommand(positional, flags) {
  const root = flags.root ?? positional[0] ?? process.cwd();
  const findings = await checkTargets(root);
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

export { plan, checkTargets, checkTarget, select };