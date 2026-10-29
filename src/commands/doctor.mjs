// `simt doctor [--fix] [--yes] [--json]`
//
// Step 3 of the implementation sequence: classify a repo from marker files alone.
// Deliberately shipped early — it needs no registry, no rules and no projection,
// and it makes the tool useful before any content exists.
//
// Plan 0003 R47 adds the findings table and `--fix`. Every finding carries its
// remedy and whether that remedy is flagged safe, and `--fix` applies only the
// safe ones while listing the rest with the reason each needs a human:
//
//   - safe means local, idempotent and journaled (the R49 journal is the undo).
//     `sync`'s manifest repair, a hooks install over routing this tool already
//     owns, and the journal's own .gitignore entry all qualify.
//   - safe is necessary but not sufficient: the fix must also be a REPAIR, not
//     an ADOPTION. `init` on a manifest-less repo is local, idempotent and
//     journaled, and still flagged unsafe — adopting a repo chooses its rules,
//     regions and CI, and the preview of that choice is what the operator must
//     read before approving it. So is taking over hooks git did not route here:
//     the bytes are journaled but the decision belongs to a human.
//
// Unsafe findings are never applied, under any flag combination. `--fix` without
// `--yes` previews: it names what it would apply and lists the rest.

import { join } from 'node:path';
import { EXIT, emit, emitJson, fail, isJson, note, writeMode } from '../output/index.mjs';
import { CLI, MANIFEST_FILE } from '../name.mjs';
import { fingerprint } from '../resolve/fingerprint.mjs';
import { resolveWorkspace } from '../workspace.mjs';
import { sharedWarning } from './shared.mjs';
import { diffField, emitDiffs, readBefore } from '../diff.mjs';
import { manifestPath, readManifest, writeManifest } from '../projection/manifest.mjs';
import { planManifestRepair } from './sync.mjs';
import { provenanceDigest } from '../projection/project.mjs';
import { applyHooksInstall, plannedDiffs, planHooksInstall } from './hooks.mjs';
import { fileFor } from '../hooks/shim.mjs';
import { commitJournal, ignoreJournal, journalHygiene, journalIgnoreNext } from '../journal.mjs';

/**
 * One config-health finding: what is wrong, how to fix it, and whether
 * `doctor --fix` may apply that fix on its own.
 *
 * `apply`, when present, performs the repair into the caller's journal. Only
 * findings with `safe: true` carry one; an unsafe finding is a report and a
 * manual remedy, never a function waiting for a flag.
 */
// `withDiffs` previews the safe fixes as `--diff` pairs (plan 0003 R50). Read at
// finding creation, before any fix is applied, so the before side is true in
// preview and in apply alike. Only safe findings carry pairs: an unsafe finding
// is never applied, so there is no write to preview.
async function collectFindings(root, { result, ws, shared, withDiffs = false }) {
  const findings = [];
  if (result.error) {
    // Nothing else can be asked: classification failed, so every check built on
    // it would be a guess. The run fails upstream; this entry is for the JSON.
    findings.push({
      id: 'fingerprint',
      severity: 'error',
      detail: result.error,
      remedy: null,
      why: null,
      safe: false,
    });
    return findings;
  }

  const { manifest, exists, error: manifestError } = await readManifest(root);
  if (manifestError !== null) {
    // An unreadable manifest is a hand-edit, not a repair: re-rendering it
    // would destroy whatever the other tool was saying.
    findings.push({
      id: 'manifest-unreadable',
      severity: 'warning',
      detail: `${MANIFEST_FILE}: ${manifestError}`,
      remedy: `fix ${MANIFEST_FILE} by hand, or restore it from version control`,
      why: 'only a human knows which bytes were intended',
      safe: false,
    });
  } else if (!exists) {
    // A repair restores intended state; an adoption chooses it. See the module
    // header: `init` qualifies mechanically and is still listed, not applied.
    findings.push({
      id: 'manifest-absent',
      severity: 'warning',
      detail: `no ${MANIFEST_FILE}; this repository was never adopted`,
      remedy: `run: ${CLI} init --root ${root} --yes`,
      why: 'adoption chooses the rules; a fix only restores them',
      safe: false,
    });
  } else {
    const sha = await provenanceDigest();
    const repair = await planManifestRepair(root, result.stack, sha);    if (repair !== null) {
        const staleBefore = withDiffs ? await readBefore(await manifestPath(root)) : null;
        findings.push({
          id: 'manifest-stale',
          severity: 'warning',
          detail: `generated field(s) ${repair.stale.join(', ')} do not match what this simt-dev writes`,
          remedy: `run: ${CLI} sync --root ${root} --yes`,
          why: null,
          safe: true,
          diffs: withDiffs ? [{ path: MANIFEST_FILE, before: staleBefore, after: repair.text }] : [],
          apply: async (rt, journal) => {
            await writeManifest(rt, repair.manifest, journal);
          },
        });
      }

    const planned = await planHooksInstall(root, { manifest, exists });
    if (planned.takeover) {
      const foreign = planned.state.foreign
        .map((f) => `${f.event} runs ${f.path} (${f.bytes} bytes)`)
        .join('; ');
      findings.push({
        id: 'hooks-takeover',
        severity: 'warning',
        detail:
          foreign !== ''
            ? `git runs hooks this tool did not write: ${foreign}`
            : `git routes hooks at ${planned.current}, not at the hooks directory`,
        remedy: `inspect the existing hooks, then run: ${CLI} hooks install --root ${root} --yes`,
        why: 'replacing live hooks needs a human who read them first',
        safe: false,
      });
    } else {
      const bits = [...planned.state.problems];
      for (const h of planned.obsolete) {
        bits.push(`${fileFor(h.event)} enforces nothing and is still routed; reinstall removes it`);
      }
      const evidenceMismatch =
        planned.evidenceDeclared && planned.evidenceSource !== planned.evidenceExisting;
      if (evidenceMismatch) bits.push('commit-msg claim check differs from this simt-dev; reinstall refreshes it');
      if (bits.length > 0) {
        const hooksPairs = withDiffs ? await plannedDiffs(root, planned) : [];
        findings.push({
          id: 'hooks-incomplete',
          severity: 'warning',
          detail: bits.join('; '),
          remedy: `run: ${CLI} hooks install --root ${root} --yes`,
          why: null,
          safe: true,
          diffs: hooksPairs,
          apply: async (rt, journal) => {
            await applyHooksInstall(rt, planned, journal);
          },
        });
      }
    }

    const hygiene = await journalHygiene(root);
    if (!hygiene.ignored) {
      const ignoreBefore = withDiffs ? await readBefore(join(root, '.gitignore')) : null;
      const ignoreAfter = withDiffs ? journalIgnoreNext(ignoreBefore ?? '') : null;
      findings.push({
        id: 'journal-unignored',
        severity: 'warning',
        detail: `${hygiene.sets.length} journal set(s) on disk, but .gitignore does not ignore them; the next commit would share local undo state`,
        remedy: 'ignore the journal directory (what --fix applies)',
        why: null,
        safe: true,
        diffs: ignoreAfter === null ? [] : [{ path: '.gitignore', before: ignoreBefore, after: ignoreAfter }],
        apply: async (rt, journal) => {
          await ignoreJournal(rt, journal);
        },
      });
    }
  }

  if (shared.declared && shared.state !== 'current') {
    // The copy lives outside the repository (a reader's home directory), which
    // R49 deliberately leaves unjournaled: `undo` must never reach past the
    // repo root, so a fix with no undo path is listed, never applied.
    findings.push({
      id: 'shared-copy',
      severity: 'warning',
      detail: shared.detail,
      remedy: shared.state === 'absent' || shared.state === 'stale' ? `run: ${CLI} shared install --yes` : null,
      why: 'the copy lives outside this repository, past what undo can restore',
      safe: false,
    });
  }

  if (ws.error) {
    findings.push({
      id: 'workspace-config',
      severity: 'error',
      detail: `workspace config ${ws.detail}: ${ws.error}`,
      remedy: 'fix the JSON, or remove the file',
      why: 'only a human knows which workspace was intended',
      safe: false,
    });
  }
  return findings;
}

async function applySafeFixes(root, findings) {
  const journal = [];
  const fixed = [];
  const failed = [];
  for (const finding of findings) {
    if (!finding.safe) continue;
    try {
      await finding.apply(root, journal);
      finding.fixed = true;
      fixed.push(finding.id);
    } catch (error) {
      failed.push({ id: finding.id, error: error.message ?? String(error) });
    }
  }
  if (fixed.length > 0) await commitJournal(root, 'doctor --fix', journal);
  return { applied: true, fixed, failed };
}

function findingLines(findings, { fixMode, applying }) {
  return findings.flatMap((finding) => {
    const head = `finding  ${finding.id}  ${finding.detail}`;
    if (finding.fixed === true) return [head, `         fixed  ${finding.remedy ?? 'applied'}`];
    if (finding.remedy === null) return [head, '         manual: no command repairs this; read the detail above'];
    if (!finding.safe) {
      return [head, `         remedy: ${finding.remedy}`, `         manual: not applied by --fix (${finding.why})`];
    }
    if (!fixMode) return [head, `         remedy: ${finding.remedy}`, '         safe: apply with --fix --yes'];
    if (!applying) return [head, `         remedy: ${finding.remedy}`, '         would fix; re-run with --yes to apply'];
    return [head, `         remedy: ${finding.remedy}`];
  });
}

// --- core: the config health both the CLI and the MCP `doctor` tool answer from (Q15)
//
// The MCP tool returned the fingerprint alone: stack, facts and manifest, and none
// of the findings the command reports. The command below renders these facts for
// terminals; the tool returns them as JSON. The CLI keeps its field names; the
// tool adopts them.
//
// See the module header: classification first, because everything else is a guess without it.
export async function diagnose(root, args = {}) {
  const result = await fingerprint(root);
  // Which source answered the workspace question, and where it looked. A tool
  // that silently fell back to the wrong directory would make every downstream
  // answer confidently wrong, so the answer is reported rather than inferred
  // (ADR-014).
  const ws = await resolveWorkspace(args);
  // The shared file this repository hands rules to (ADR-084). Asked here and nowhere else
  // because it is the one thing about a repository that is true of the reader's machine
  // rather than of the tree: `check` must not read `$HOME`, so `doctor` is the only command
  // that can notice a region that dropped rules into a file nobody has. Reported, never
  // blocking — the region is correct either way, and what is wrong is the reader's machine.
  const shared = await sharedWarning(root, result.manifest ?? null, args);

  const withDiffs = args.fix === true && args.diff === true;
  const findings = await collectFindings(root, { result, ws, shared, withDiffs });
  // Under `--json` the document is the whole report, so it has to carry both
  // failures the text path reports AND the workspace answer the text prints.
  const failure = result.error
    ? { error: `${root}: ${result.error}`, remedy: null }
    : ws.error
      ? {
          error: `workspace config ${ws.detail}: ${ws.error}`,
          remedy: 'fix the JSON, or remove the file',
        }
      : null;
  const code = failure ? EXIT.CONFIG : EXIT.OK;
  return { result, ws, shared, findings, failure, code };
}

/** The findings as JSON-safe data: drops the `apply` closures only `--fix` uses. */
export function serialisedFindings(findings) {
  return findings.map(({ id, severity, detail, remedy, why, safe, fixed }) => ({
    id,
    severity,
    detail,
    remedy,
    // Null for safe findings: there is no human needed to explain.
    why: why ?? null,
    safe,
    fixed: fixed === true,
  }));
}

export async function runDoctor(positional, flags) {
  const root = flags.root ?? positional[0] ?? process.cwd();
  const { result, ws, shared, findings, failure, code: diagnosisCode } = await diagnose(root, flags);

  const fixMode = flags.fix === true;
  const mode = writeMode(flags);
  let fix = { requested: fixMode, applied: false, fixed: [], failed: [] };
  if (fixMode && mode.apply) {
    fix = { requested: true, ...(await applySafeFixes(root, findings)) };
  }
  const failedFix = fix.failed.length > 0;

  // A scripted consumer has only this document to go on, so `ok` is derived from
  // the exit code rather than written as a constant (S10). A failed fix is a
  // failure of this run on top of the diagnosis.
  const code = failedFix ? EXIT.FAIL : diagnosisCode;

  // The findings travel in both modes: a script reads the array, a terminal
  // reads the lines, and neither may learn about a different set of problems.
  const serialised = serialisedFindings(findings);

  if (isJson(flags)) {
    emitJson({
      ok: code === EXIT.OK,
      command: 'doctor',
      root,
      ...result,
      // The workspace answer is a fact about which directory the tool would
      // act on next (ADR-014). It is printed in the text report; leaving it
      // out of the JSON meant a machine-readable caller could not see it at
      // all, which is the one-question-two-answers defect again.
      workspace: {
        root: ws.root ?? null,
        source: ws.source,
        detail: ws.detail,
        error: ws.error ?? null,
      },
      shared,
      findings: serialised,
      fix,
      ...diffField(fixMode && flags.diff === true ? findings.flatMap((f) => f.diffs ?? []) : [], flags),
      ...(failure ?? {}),
    });
    return code;
  }
  if (result.error) {
    return fail(`${root}: ${result.error}`, EXIT.CONFIG);
  }
  emit(
    [
      `root     ${root}`,
      `stack    ${result.stack.length > 0 ? result.stack.join(', ') : '(undetected)'}`,
      `evidence ${result.evidence.length > 0 ? result.evidence.join(' ') : '(none)'}`,
      // Facts are what a profile selects on when it wants to survive the
      // framework being replaced, so they are reported with the path that proved
      // each one rather than as a bare list (ADR-013).
      `facts    ${
        result.facts.length > 0
          ? result.facts.map((f) => `${f}(${result.factEvidence[f] ?? '?'})`).join(' ')
          : '(none)'
      }`,
      `manifest ${result.manifest ? (result.manifest.error ?? result.manifest.id ?? 'present') : '(absent)'}`,
      `workspace ${ws.root ?? '(none)'}  (${ws.source}: ${ws.detail})`,
      // Printed only when this repository declares shared rules to a workspace copy: a line in
      // every `doctor` is a line in every reader's terminal, and the reader who has
      // nothing to install is not served by one (ADR-084).
      ...(shared.declared ? [`shared    ${shared.state}  ${shared.detail}`] : []),
      ...findingLines(findings, { fixMode, applying: mode.apply }),
    ].join('\n'),
    { maxBytes: flags.maxBytes ?? 0 },
  );
  // After the report: the report says what, the diff shows it (R50). Only the
  // fix plan is diffed, so without --fix there is nothing to show.
  if (fixMode && flags.diff === true) emitDiffs(findings.flatMap((f) => f.diffs ?? []), flags);
  if (failedFix) {
    return fail(
      `doctor --fix applied ${fix.fixed.length} remedie(s) and ${fix.failed.length} failed: ${fix.failed.map((f) => `${f.id} (${f.error})`).join('; ')}`,
      EXIT.FAIL,
    );
  }
  // An unconfigured workspace is a fact, not a failure: a single repo with no
  // workspace around it is a normal, supported case. A config file that EXISTS and
  // does not parse is a real mistake, and that does fail - with the parse error,
  // because naming the file without saying what is wrong with it sends the reader
  // to the file and gives them nothing to look for.
  if (ws.error) {
    return fail(`workspace config ${ws.detail}: ${ws.error}`, EXIT.CONFIG, 'fix the JSON, or remove the file');
  }
  return EXIT.OK;
}
