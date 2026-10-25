// simt sync --yes — write the generated regions.
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

import { mkdir, readFile, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { EXIT, emit, emitJson, fail, isJson, note, writeMode } from '../output/index.mjs';
import { plan, checkTargets, checkTarget, provenanceDigest, loadRules, select, pointerTargets, pointerState } from '../projection/project.mjs';
import { fingerprint } from '../resolve/fingerprint.mjs';
import { manifestDrift, readManifest, unrunnableGates, buildManifest, writeManifest, withGenerated, manifestText } from '../projection/manifest.mjs';
import { readCapability } from '../hooks/capability.mjs';
import { surfacesLine } from '../projection/surfaces.mjs';
import { CLI } from '../name.mjs';
import { MANIFEST_FILE, MANIFEST_LEGACY } from '../name.mjs';
import { assertVersionPin, packageVersion } from '../package-version.mjs';
import { resolvePacks } from '../packs.mjs';
import { computeLock, readLock, LOCK_FILE } from '../projection/lock.mjs';
import { runDeclaredChecks } from '../kernel/checks.mjs';
import { DECISIONS_DIR } from '../decisions/index.mjs';
import { lintDecisions } from '../memory/decide.mjs';

/** Findings `sync` reports and does not fail on.
 *
 *  `pointer-unread` is a misaimed pointer whose reader this repository serves. `sync`
 *  must not refuse on it: the remedy is `simt sync --yes`, so a `sync` that blocked
 *  would be a gate whose remedy is the command being run — ADR-025 ruling 6's hazard, and
 *  worse than a noisy gate. `check` disagrees, and the reason is the whole of ADR-051.
 *
 *  `orphaned` is here for a stronger version of the same reason. A generated rule file
 *  whose surface now folds the rule into `AGENTS.md` cannot be repaired by any
 *  command: `sync` will not write it again, and ADR-021 ruling 6 forbids deleting
 *  it. Blocking on it would put every commit in every migrated repo behind a file
 *  only a human may remove, which is a gate nothing can satisfy and therefore worse
 *  than a gate that is merely noisy. It is reported, with the delete command in the
 *  remedy, and it does not fail.
 *
 *  A *missing* pointer is not reported at all: every editor that matters already reads
 *  `AGENTS.md`, and the pointer saves one symlink. A gate that goes red for it is a gate
 *  people learn to ignore. A *foreign* one — a real file or a real directory where the
 *  pointer belongs — is reported loudly with what is in the way, because that one is a
 *  decision somebody has to make. */
export const SYNC_NON_BLOCKING = new Set([
  'pointer-unread',
  'orphaned',
  'pack-unpinned',
  'budget',
  'budget-cut',
  'file-lines-warn',
  'check-unbuilt',
]);

/**
 * Findings `check` reports and does not fail on.
 *
 *  A subset of `SYNC_NON_BLOCKING`, and the difference between the two sets is the whole
 *  of ADR-051. The same finding answers different questions in the two commands: `sync`
 *  writes the pointer, so refusing there names the command being run as the cure, while
 *  `check` is the gate CI runs and the one whose exit code a repository acts on — and a
 *  repository whose `CLAUDE.md` points at `README.md` has a reader reading nothing.
 *  Thirteen rule citations unread, `check` green, `compare` clean.
 *
 *  One set covering both commands is how the defect survived: the rule was written to
 *  keep `sync` quiet, and it quietly quieted `check` too — the writer's correct
 *  non-blocking finding silencing the gate's exit code. The first version of this fix
 *  reproduced that exactly, and a test asserting `check` exited 1 passed on a
 *  repository that was red for a missing `AGENTS.md`.
 *
 *  `orphaned` stays non-blocking in both. Nothing can satisfy it, in either command.
 */
// `pack-unpinned` is here and `pack-digest-mismatch` is not, which is the whole
// judgement. An unpinned pack still renders its rules correctly; what is missing
// is the record of which bytes were declared, and failing a gate over a field the
// tool does not require would fail every repository that vendored a pack and
// pinned it later. A pack whose bytes do not match its pin renders a region
// nobody can account for, so that one blocks.
//
// `budget` is here for the opposite reason, and it is a ruling rather than a patch
// (ADR-072). An over-budget finding says the projection is bigger than this repository
// said it would be, and the remedy is a decision about which rules to narrow — not a
// missing file. Nothing is cut: the projection is still in full mode, so a gate that
// failed here would be failing a repository for exceeding a ceiling it set itself,
// with no way to fix it except lowering the number it wrote down.
// `budget-cut` is here for the same reason and is the second half of the same ruling
// (ADR-083). It says the projection was cut to fit a ceiling this repository set, so the
// remedy is a decision about the number — and a cut the repository asked for by declaring
// a budget is the tool working, not a repository in need of a file.
export const CHECK_NON_BLOCKING = new Set(['orphaned', 'pack-unpinned', 'budget', 'budget-cut', 'file-lines-warn', 'check-unbuilt']);

export async function syncCommand(positional, flags) {
  const root = flags.root ?? positional[0] ?? process.cwd();
  const checkOnly = flags.check === true;
  const mode = writeMode(flags);

  const result = await plan(root, flags);

  // Before the rule branch, and named for what it is. An unknown surface id is a
  // misspelling in the manifest's `surfaces` list; reporting it as an unprojectable
  // `.mdc` rule sent the reader to a `simt-substitutions` block that has nothing to do
  // with the thing they typed. `check` reported the same problem correctly the whole
  // time, so this was a writer disagreeing with the gate about the same manifest.
  if (result.surfaceProblems.length > 0) {
    if (isJson(flags)) {
      emitJson({
        ok: false,
        command: 'sync',
        root,
        error: result.surfaceProblems[0],
        problems: result.surfaceProblems,
      });
    }
    for (const p of result.surfaceProblems) note(`PROBLEM ${p}`);
    return fail(
      `${result.surfaceProblems.length} surface(s) cannot be resolved (${result.surfaceProblems[0]})`,
      EXIT.FAIL,
      `fix the surface ids in the "surfaces" list of ${MANIFEST_FILE}, or remove the unknown one`,
    );
  }

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
      `fix the reported substitution keys in ${MANIFEST_FILE}`,
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
      `fix the markers at ${first.file}:${first.line}, then: ${CLI} sync --yes`,
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
      // The measure is what is in the way, and it differs by kind: a file is destroyed by
      // the byte, a directory by the entry. Printing `undefined bytes` for the second
      // is how a directory went unreported for as long as it did.
      const size =
        st.entries === undefined
          ? `${st.bytes} bytes`
          : `${st.entries} ${st.entries === 1 ? 'entry' : 'entries'}`;
      note(`POINTER ${p.file}: ${st.detail} (${size}); left untouched, not replaced`);
      continue;
    }
    if (st.state === 'current') continue;
    // A *mispointed* pointer is one this tool wrote and this tool may repair: it is a
    // symlink, so it has no content, and the remedy printed by `check` for this exact
    // finding is `simt sync --yes`. Reporting a plan and then calling `symlink()` at
    // an existing path is `EEXIST` — which is what this did, and the remedy it offered
    // was `simt doctor`, which reports nothing about it. A command whose own remedy
    // crashes on the state it names has no remedy at all.
    //
    // Only a symlink is replaced. A regular file or a directory is somebody's work and
    // was `continue`d above, which is why the distinction is `state` and not a test of
    // existence.
    pointerPlan.push({ ...p, replace: st.state === 'mispointed' });
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

  // The manifest is the second file this tool writes into a repository it does not own,
  // and for two releases it was the only generated file with no path back to correct:
  // `check` refused on a stale generated field and named `init --yes`, while `sync` -
  // the command whose whole job is regenerating what this tool owns - reported
  // "already current; nothing written". Both statements were true of the same
  // repository, and all fourteen adopted repositories were in that state at once.
  //
  // One reason and one place, so `check`'s remedy and this plan cannot drift: the
  // field set is `GENERATED_KEYS`, and the values come from the same `buildManifest`
  // call `manifestDrift` compares against. A repair built from a second copy of
  // either would pass its own test and leave the gate still red.
  //
  // `reformatted` is repaired too, and only when the repository has said the file is
  // not prose: `simt.json` listed in `.prettierignore` is the repo stating that no
  // formatter will take these bytes back.
  //
  // Without that condition there are two wrong answers. Repairing unconditionally
  // means every `format` run rewrites a file the commit just wrote - a permanently
  // dirty working tree. Never repairing means `init --yes` is the only way to put the
  // bytes back, and `init` re-runs adoption: it tags, it switches branch, it asks every
  // question again, to fix one file's formatting (ADR-050). The first repo routed in
  // the estate roll-out hit this on its first commit, so both answers were live.
  const manifestPlan = await planManifestRepair(root, result.stack, result.targets[0].sha);
  if (manifestPlan) {
    targets.push({
      file: manifestPlan.file,
      surface: 'manifest',
      action: 'updated',
      bytes: Buffer.byteLength(manifestPlan.text),
      previousBytes: manifestPlan.previousBytes,
    });
  }
  const manifestChanged = manifestPlan !== null;

  // Writes happen BEFORE output in every mode. An earlier build emitted `--json`
  // first and returned, so `upgrade --yes --json` reported a plan and changed
  // nothing — the exact combination automation reaches for.
  //
  // `sync` used to be the one writer that wrote by default, which made it the odd
  // one out among six: `init`, `upgrade`, `ci`, `hooks install` and `skills install`
  // all preview unless told otherwise. An agent that learned the other five
  // pattern-matched onto `sync` and got a write instead of a plan, so the preview
  // the whole interface is built on was opt-in by command line and opt-out by habit.
  // The rule is one function's, not this file's (ADR-035).
  //
  // The list above was itself wrong: `hooks install` was writing by default too,
  // so it was the sixth writer in name only. Measured, not assumed - see ADR-040.
  // A comment that enumerates which commands follow a rule is a claim about code
  // this file does not own, and it was one commit out of date before anyone ran it.
  if (mode.apply) {
    // The manifest first, with the rest: a gate that refuses on a stale stamp should
    // not be able to read a half-finished write, and the manifest is the file every
    // other write in this run is described by.
    if (manifestPlan) {
      await writeManifest(root, manifestPlan.manifest);
      note(`wrote    ${manifestPlan.file} (generated field(s) ${manifestPlan.stale.join(', ')})`);
    }
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
    const lock = await computeLock(root, flags);
    const lockText = `${JSON.stringify(lock, null, 2)}\n`;
    let previousLock = null;
    try {
      previousLock = await readFile(join(root, LOCK_FILE), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (previousLock !== lockText) {
      await writeFile(join(root, LOCK_FILE), lockText);
      note(`wrote    ${LOCK_FILE}`);
    }
    for (const p of pointerPlan) {
      await mkdir(dirname(p.path), { recursive: true });
      // Only a symlink this tool wrote is replaced, and only because it has no content:
      // `unlink` on a symlink removes the link, never what it pointed at. A regular file
      // or a directory never reaches here — the loop above `continue`s on both — so this
      // cannot delete anything a person wrote.
      if (p.replace) {
        await unlink(p.path);
        note(`unlinked ${p.file} (was misaimed)`);
      }
      await symlink(p.to, p.path);
      note(`linked   ${p.file} -> ${p.to}`);
    }
  }

  if (isJson(flags)) {
    emitJson(
      {
        // `ok` follows the exit code, which now reports drift for a previewing run
        // too. Leaving it `true` here would break the invariant ADR-035 sets for
        // every command, and the contract table asserts it for this one.
        ok: changed.length === 0 && pointersAdded.length === 0 && !manifestChanged ? true : mode.apply,
        command: checkOnly ? 'sync --check' : 'sync',
        root,
        stack: result.stack,
        profiles: result.profiles,
        surfaces: result.surfaces,
        surfaceSource: result.surfaceSource,
        sha: result.targets[0].sha,
        targets,
        pointers: pointersAdded,
        written: mode.apply ? changed.length + pointersAdded.length + (manifestChanged ? 1 : 0) : 0,
        dryRun: !mode.apply,
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
      // `targets`, not `result.targets`: the plan is the thing being reported, and a
      // line the JSON payload carries but the text one drops is the reader of the
      // terminal output finding out from the exit code what they were already told.
      ...targets.map(
        (t) => `${t.file}  ${t.action}  ${t.previousBytes} -> ${t.bytes} bytes`,
      ),
      ...pointerPlan.map((p) => `${p.file}  added  pointer -> ${p.to}`),
    ];
    if (changed.length === 0 && pointerPlan.length === 0 && !manifestChanged) lines.push('already current; nothing written');
    else if (checkOnly) lines.push('would write; rerun without --check');
    else if (!mode.apply) {
      // The preview names the command that writes it. A preview that reports what
      // would change and then exits without saying how to make it happen leaves the
      // reader to guess between three spellings of the same verb.
      lines.push(
        flags.dryRun === true
          ? 'dry-run; nothing written'
          : `would write ${changed.length + pointersAdded.length + (manifestChanged ? 1 : 0)} file(s); apply with: ${CLI} sync --yes`,
      );
    }
    emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  }

  const idle = changed.length === 0 && pointerPlan.length === 0 && !manifestChanged;
  if (checkOnly) return idle ? EXIT.OK : EXIT.FAIL;
  // A preview that found work is not a success: `simt sync --yes` with no flags is a
  // check that also prints the plan, and a check that exits 0 while reporting drift
  // is the one-question-two-answers shape ADR-035 rules out. This is what lets a
  // caller run `sync` in place of `sync --check` and get the same verdict.
  if (!mode.apply) {
    if (flags.dryRun === true) note('dry-run  no files written');
    return idle ? EXIT.OK : EXIT.FAIL;
  }
  return EXIT.OK;
}

/**
 * The manifest repair `sync` would make, or null when there is nothing to repair.
 *
 * Returns the parsed manifest to hand to `writeManifest` as well as the bytes, so the
 * writer keeps owning the legacy-name move and the preview keeps showing the real
 * count. `sha` is the same digest the regions were rendered from: the stamp and the
 * text it describes have to agree, or the next `check` finds a region carrying a pin
 * the manifest does not claim.
 *
 * @returns {Promise<{file: string, manifest: object, text: string,
 *                    stale: string[], previousBytes: number}|null>}
 */
async function planManifestRepair(root, stack, sha) {
  const drift = await manifestDrift(root, stack, sha);
  if (drift === null) return null;
  // A `reformatted` manifest is repaired only once the repository has declared that no
  // formatter will take these bytes back. The declaration is read rather than assumed
  // because a repo that runs no formatter should not need a `.prettierignore` to repair
  // a manifest some other tool rewrote, and one that does must be believed only when it
  // has said so.
  if (drift.status === 'reformatted' && !(await formatterIgnoresManifest(root))) return null;

  const { manifest } = await readManifest(root);
  if (manifest === null) return null;
  const expected = buildManifest({ root, stack, sha, version: packageVersion(), existing: manifest });
  const patched = withGenerated(manifest, expected);
  const stale = Object.keys(expected).filter(
    (key) => JSON.stringify(manifest[key]) !== JSON.stringify(patched[key]),
  );
  return {
    file: MANIFEST_FILE,
    manifest: patched,
    text: manifestText(patched),
    stale,
    previousBytes: Buffer.byteLength(manifestText(manifest)),
  };
}

/**
 * Whether this repository's `.prettierignore` excludes the manifest.
 *
 * Lines, `#` comments and blanks only. A glob is not evaluated: the question this
 * answers is "did somebody deliberately write this file's name down", and an exact
 * match is the only reading of that which cannot be wrong. A repository that ignores
 * `*.json` has said something broader, and the honest answer there is that this tool
 * cannot tell - so it declines to repair, which is the state that was already correct.
 */
async function formatterIgnoresManifest(root) {
  // ENOENT only. A catch that answers "no" to every error is a catch that turns a
  // typo in this function into a repository silently keeping its pre-commit gate's
  // formatting — which is how the first version of it failed: `join` was not imported,
  // the ReferenceError was swallowed, and every repository read as having declared
  // nothing. Absence is absence; anything else is a fault worth seeing.
  let text;
  try {
    text = await readFile(join(root, '.prettierignore'), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
  return text
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line !== '' && !line.startsWith('#') && (line === MANIFEST_FILE || line === MANIFEST_LEGACY));
}

/**
 * `gates.cwd` entries that do not resolve to a directory inside the repository.
 *
 * Reported here, not only where the gate runs: the dispatcher fails closed on the same
 * condition, so a reader finds out on their next commit — after writing a commit, which
 * is the wrong order. The finding names the gate and the path, and says which of the two
 * things is wrong, because "no such directory" and "outside the repository" are repaired
 * by different edits.
 *
 * @returns {Promise<{file: string, status: string, gate: string, detail: string, remedy: string}[]>}
 */
async function gateCwdFindings(root, manifest) {
  const cwds = manifest?.gates?.cwd;
  if (!cwds || typeof cwds !== 'object' || Array.isArray(cwds)) return [];
  const declared = [...(manifest?.gates?.preCommit ?? []), ...(manifest?.gates?.prePush ?? [])];
  const findings = [];
  for (const name of Object.keys(cwds).sort()) {
    if (!declared.includes(name)) continue;
    const dir = String(cwds[name]);
    const resolved = resolve(root, dir);
    const inside = resolved === root || resolved.startsWith(`${root}${sep}`);
    const isDir = inside && ((await stat(resolved).catch(() => null))?.isDirectory() ?? false);
    if (isDir) continue;
    findings.push({
      file: MANIFEST_FILE,
      status: inside ? 'gate-cwd-missing' : 'gate-cwd-outside',
      gate: name,
      detail: inside
        ? `gates.cwd["${name}"] is ${dir}, which is not a directory in this repository`
        : `gates.cwd["${name}"] is ${dir}, which resolves outside the repository`,
      remedy: `point gates.cwd["${name}"] at a directory in this repository, or remove it to run the gate at the root`,
    });
  }
  return findings;
}

export async function checkCommand(positional, flags) {  const root = flags.root ?? positional[0] ?? process.cwd();
  const findings = await checkTargets(root, flags);
  const rules = await loadRules(root);

  // A rule file with no id would be projected without a traceable source, so it
  // is a gate failure rather than a warning: `rules why` could not resolve it.
  //
  // Read for `root` and named by `source`, because the rule most likely to be
  // broken is the one nobody in this source tree can see: with no root this loop
  // read central rules only, so a repo-local profile could carry a misspelled key,
  // project nothing at all, and still leave the gate green.
  for (const r of rules) {
    if (r.error) {
      findings.push({ file: r.source, status: 'invalid', detail: r.error });
    }
  }

  // A declared gate this repo cannot run fails closed on every commit once hooks are
  // installed. Reported here rather than left to `hooks status`, so the repo is red
  // before anyone installs anything rather than after.
  const { manifest } = await readManifest(root);
  if (manifest) {
    // The gate runs from whatever binary resolved it. For a repository without npm that
    // is a global install, and the only thing that knows which version it should be is
    // the pin the repo recorded at adoption. A stale binary would run a different gate
    // than CI does, so the mismatch fails the gate rather than warning.
    const mismatch = assertVersionPin(manifest);
    if (mismatch) {
      findings.push({ file: MANIFEST_FILE, status: 'version-mismatch', detail: mismatch, remedy: `run: ${CLI} upgrade --yes` });
    }
    findings.push(...unrunnableGates(manifest, await readCapability(root)));
    findings.push(...(await gateCwdFindings(root, manifest)));
    // A pack the repository declares but cannot produce is reported here rather
    // than when a rule happens to be missing, because that is the failure mode
    // this guards: the region still renders, it renders SHORT, and `check` would
    // pass. A reader whose rules were quietly halved is worse off than one whose
    // gate is red, so this is a blocking finding, not a note.
    findings.push(...(await resolvePacks(root)).findings);
    // A manifest a formatter has rewritten is not wrong, and not editable-away by
    // hand either: the next `init` puts simt-dev's own bytes back and the formatter
    // takes them away again. Reporting it here is what stops that being a surprise
    // discovered at upgrade time.
    const { stack } = await fingerprint(root);
    const drift = await manifestDrift(root, stack, await provenanceDigest());
    if (drift) findings.push(drift);
  }
  if (flags.frozen) findings.push(...(await frozenFindings(root, flags)));
  // The checkers a selected rule declared (ADR-088). They read the rule source,
  // not the folded region, so a line that left the prompt is still the line that runs.
  const fp = await fingerprint(root);
  const { selected } = select(rules.filter((r) => r.error === null), fp.stack ?? [], fp.facts ?? []);
  findings.push(...(await runDeclaredChecks(root, selected, manifest ?? null)));

  const decisionsDir = join(root, 'docs', 'decisions');
  const decisionLint = await lintDecisions(decisionsDir, {
    allowHistorical: resolve(decisionsDir) === DECISIONS_DIR,
  });
  findings.push(
    ...decisionLint.findings.map((f) => ({
      file: ['docs', 'decisions', f.file].join('/'),
      status: f.status,
      detail: f.detail,
      remedy: f.remedy,
    })),
  );

  // `CHECK_NON_BLOCKING`, not the union. This is the gate whose exit code a repository
  // acts on, so a finding it reports and does not fail on is a decision recorded in a
  // set — not one inherited from the writer that shares this file (ADR-051).
  const bad = findings.filter((f) => f.status !== 'current' && !CHECK_NON_BLOCKING.has(f.status));
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

/**
 * What `--frozen` adds to the gate. Nothing, when the lock matches. One finding
 * otherwise, and the wording says which of the two failures it was (ADR-086).
 */
async function frozenFindings(root, flags) {
  const { lock, error } = await readLock(root);
  if (error) {
    return [{ file: LOCK_FILE, status: 'lock-unreadable', detail: error, remedy: `run: ${CLI} sync --yes` }];
  }
  if (lock === null) {
    return [{
      file: LOCK_FILE,
      status: 'lock-absent',
      detail: 'no lock is recorded',
      remedy: `run: ${CLI} sync --yes`,
    }];
  }
  const next = await computeLock(root, flags);
  if (next.inputs !== lock.inputs) {
    return [{
      file: LOCK_FILE,
      status: 'lock-stale',
      detail: 'the inputs changed and the lock was not rewritten',
      remedy: `run: ${CLI} sync --yes`,
    }];
  }
  if (next.outputs !== lock.outputs) {
    return [{
      file: LOCK_FILE,
      status: 'lock-unexplained',
      detail: 'the projection changed and the inputs did not',
      remedy: `run: ${CLI} sync --yes`,
    }];
  }
  return [];
}

export { plan, checkTargets, checkTarget, select, frozenFindings };