// simt-dev sync — write the generated regions.
// simt-dev check — the gate.
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

import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EXIT, emit, emitJson, fail, isJson, note } from '../output/index.mjs';
import { plan, checkTargets, checkTarget, loadRules, select, pointerTargets, pointerState } from '../projection/project.mjs';
import { readManifest, unrunnableGates } from '../projection/manifest.mjs';
import { readCapability } from '../hooks/capability.mjs';
import { surfacesLine } from '../projection/surfaces.mjs';

/** Pointer findings are reported but never fail the gate.
 *
 *  A missing `CLAUDE.md` does not mean a broken repo: every editor that matters
 *  already reads `AGENTS.md`, and the pointer is a convenience that saves one
 *  symlink. A gate that goes red for it is a gate people learn to ignore, which
 *  is the failure this whole gate exists to prevent. `pointer-blocked` — a real
 *  file sitting where the pointer wants to be — is reported loudly instead, with
 *  the byte count of what is in the way, because that one is a decision somebody
 *  has to make. */
const NON_BLOCKING = new Set(['pointer-drift']);

export async function syncCommand(positional, flags) {
  const root = flags.root ?? positional[0] ?? process.cwd();
  const checkOnly = flags.check === true;

  const result = await plan(root, flags);


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
      `fix the markers at ${first.file}:${first.line}, then: simt-dev sync`,
    );
  }

  for (const n of result.notes) note(`note ${n}`);

  // Pointers are written after the rule files, and only when the target they point
  // at was actually produced. A `CLAUDE.md` pointing at an `AGENTS.md` that does not
  // exist yet is a broken symlink, and a broken symlink reads to Claude Code as a
  // missing CLAUDE.md with an error nobody sees.
  const pointerPlan = [];
  for (const p of pointerTargets(root, result.surfaces)) {
    const st = await pointerState(root, p);
    if (st.state === 'foreign') {
      note(
        `POINTER ${p.file}: ${st.detail} (${st.bytes} bytes); left untouched, not replaced`,
      );
      continue;
    }
    if (st.state === 'current') continue;
    pointerPlan.push(p);
  }

  const targets = result.targets.map((t) => ({
    file: t.file,
    surface: t.surface ?? 'agents',
    action: t.action,
    bytes: t.bytes,
    previousBytes: t.previousBytes,
  }));
  const changed = result.targets.filter((t) => t.action !== 'unchanged');
  const pointersAdded = pointerPlan.map((p) => p.path);

  // Writes happen BEFORE output in every mode. An earlier build emitted `--json`
  // first and returned, so `upgrade --yes --json` reported a plan and changed
  // nothing — the exact combination automation reaches for.
  if (checkOnly !== true && flags.dryRun !== true) {
    for (const t of changed) {
      // Three of the four rule surfaces live in directories that do not exist yet in a
      // repository that has only ever been written to by hand. `init` grew its own
      // mkdir; `sync` did not, so the first `sync` after a surface was added failed with
      // ENOENT on the second target and had already written the first. The parent is
      // derived from the target, never from the surface table, so a future surface with a
      // deeper path needs no change here.
      await mkdir(dirname(t.path), { recursive: true });
      await writeFile(t.path, t.text);
      note(`wrote    ${t.file}`);
    }
    for (const p of pointerPlan) {
      await mkdir(dirname(p.path), { recursive: true });
      await symlink(p.to, p.path);
      note(`linked   ${p.file} -> ${p.to}`);
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
        surfaces: result.surfaces,
        surfaceSource: result.surfaceSource,
        sha: result.targets[0].sha,
        targets,
        pointers: pointersAdded,
        written: checkOnly || flags.dryRun === true ? false : changed.length + pointersAdded.length,
      },
      {},
    );
  } else {
    const lines = [
      `repo      ${root}`,
      `stack     ${result.stack.length > 0 ? result.stack.join(', ') : '(undetected)'}`,
      `profiles  ${result.profiles.join(', ')}${result.fallback ? ' (fallback)' : ''}`,
      surfacesLine({ ids: result.surfaces, source: result.surfaceSource }, 10),
      `sha       ${result.targets[0].sha}`,
      '',
      ...result.targets.map(
        (t) => `${t.file}  ${t.action}  ${t.previousBytes} -> ${t.bytes} bytes`,
      ),
      ...pointerPlan.map((p) => `${p.file}  added  pointer -> ${p.to}`),
    ];
    if (changed.length === 0 && pointerPlan.length === 0) lines.push('already current; nothing written');
    else if (checkOnly) lines.push('would write; rerun without --check');
    emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  }

  if (checkOnly) return changed.length === 0 && pointerPlan.length === 0 ? EXIT.OK : EXIT.FAIL;
  if (flags.dryRun === true) {
    note('dry-run  no files written');
    return EXIT.OK;
  }
  return EXIT.OK;
}

export async function checkCommand(positional, flags) {
  const root = flags.root ?? positional[0] ?? process.cwd();
  const findings = await checkTargets(root, flags);
  const rules = await loadRules();

  // A rule file with no id would be projected without a traceable source, so it
  // is a gate failure rather than a warning: `rules why` could not resolve it.
  for (const r of rules) {
    if (r.error) {
      findings.push({ file: `rules/${r.file}`, status: 'invalid', detail: r.error });
    }
  }

  // A declared gate this repo cannot run fails closed on every commit once hooks are
  // installed. Reported here rather than left to `hooks status`, so the repo is red
  // before anyone installs anything rather than after.
  const { manifest } = await readManifest(root);
  if (manifest) {
    findings.push(...unrunnableGates(manifest, await readCapability(root)));
  }

  const bad = findings.filter((f) => f.status !== 'current' && !NON_BLOCKING.has(f.status));
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

  // Every finding that carries a remedy prints it. A finding with a fix the reader
  // has to guess at is a finding that gets skipped.
  emit(
    findings
      .flatMap((f) => {
        const head = `${f.status.toUpperCase().padEnd(10)} ${f.file}${f.detail ? `  ${f.detail}` : ''}`;
        return f.remedy ? [head, `${' '.repeat(11)}remedy: ${f.remedy}`] : [head];
      })
      .join('\n'),
    { maxBytes: flags.maxBytes ?? 0 },
  );
  return bad.length === 0 ? EXIT.OK : EXIT.FAIL;
}

export { plan, checkTargets, checkTarget, select };