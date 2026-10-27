// simt init - adopt a repo into the ecosystem, or scaffold a new one.
//
// The governing idea: init never destroys hand-written work. It writes a manifest
// and a generated region, reports every conflict it found BEFORE writing anything,
// and requires an explicit --yes to change a file at all. An agent that ran init
// without --yes learns exactly what would happen and nothing has changed - which
// is the only safe default for a tool whose first action is to touch someone's repo.
//
// Ordering is deliberate and is the whole safety story:
//   1. fingerprint         what is this repo
//   2. scan for conflicts  does it contradict a ruling
//   3. block on conflicts  unless --accept-conflicts
//   4. plan everything     manifest + region, dry
//   5. branch and tag      an opt-in escape hatch (--backup), before the first write
//   6. write               only with --yes
// Never commits, never pushes (ADR-001).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, symlink } from 'node:fs/promises';
import { commitJournal, journaledWriteFile } from '../journal.mjs';
import { invalidateCheckCache } from '../status.mjs';
import { dirname, join } from 'node:path';

import { EXIT, emit, emitJson, fail, isJson, note } from '../output/index.mjs';
import { fingerprint } from '../resolve/fingerprint.mjs';
import { rulePaths, scanDocument, summarise } from '../projection/conflicts.mjs';
import { MANIFEST, buildManifest, manifestPath, manifestText, readManifest, writeManifest, planGates } from '../projection/manifest.mjs';
import { diffField, emitDiffs, readBefore } from '../diff.mjs';
import { readCapability } from '../hooks/capability.mjs';
import { readHooksState } from '../compare/hooksstate.mjs';
import { planWorkflow, renderWorkflow, WORKFLOWS_DIR } from '../ci/workflow.mjs';
import { planDependabot, renderDependabot } from '../ci/dependabot.mjs';
import { planTsconfigBase, renderTsconfigBase, TSCONFIG_BASE_FILE } from '../tsconfig.mjs';
import {
  IDENTITY_FILE,
  INCLUDE_KEY,
  ignoreIdentity,
  includeOwnIdentity,
  includesOwnIdentity,
  renderIdentityFile,
  resolveIdentity,
} from '../identity.mjs';
import { pointerState, pointerTargets } from '../projection/project.mjs';
import { surfacesLine } from '../projection/surfaces.mjs';
import { plan, provenanceDigest, PRIMARY_TARGET, LOCAL_PROFILE_DIR } from '../projection/project.mjs';
import { parse as parseRegion } from '../projection/markers.mjs';
import { CLI } from '../name.mjs';
import { MANIFEST_FILE } from '../name.mjs';
import { packageVersion, hasNpm } from '../package-version.mjs';

const run = promisify(execFile);

const BACKUP_TAG = 'backup-before-simt-dev';
const ADOPT_BRANCH = 'simt-dev/adopt';

export async function initCommand(positional, flags) {
  const root = flags.root ?? positional[0] ?? process.cwd();

  const detected = await fingerprint(root);
  if (detected.error) {
    return fail(`${root}: ${detected.error}`, EXIT.CONFIG, `run: ${CLI} init <path>`);
  }

  const sha = await provenanceDigest();
  // The release this adoption records, and the kind of repository it is adopting: the
  // version goes into the manifest pin and the rendered gate, and the kind decides how
  // a repository without node_modules obtains the binary in CI.
  const version = packageVersion();
  const npm = await hasNpm(root);
  const existing = await readManifest(root);
  const { manifest: current, exists, error } = existing;
  if (error) {
    return fail(`${await manifestPath(root)}: ${error}`, EXIT.CONFIG, `fix the JSON in ${MANIFEST_FILE}`);
  }

  // What this repo can demonstrably run, not what its stack suggests. Without this the
  // stack table proposes gates the repo has no way to execute — the adoption of
  // a repository declared five and could run two, which would have blocked every
  // commit once hooks were installed.
  const capability = await readCapability(root);
  // `facts` carries the ecosystem rows (has-cargo-toml, ...) — the same signal set that
  // selects this repo's profiles, so one marker file reaches both the region the reader
  // gets and the gates its commits run. Without it the ecosystem rows never fire here
  // and a fresh Rust repo is adopted with gates it cannot run.
  const { dropped, commands } = planGates(detected.stack, capability, detected.facts);
  const manifest = buildManifest({ root, stack: detected.stack, sha, version, existing: current, capability, facts: detected.facts });
  const findings = await scanRepo(root);
  const summary = summarise(findings);
  const projected = await plan(root, flags);
  const region = projected.targets[0];
  const mdcProblems = projected.mdcProblems ?? [];

  // Which editors this repo's rules reach. `--surfaces` wins for this run and is
  // recorded in the manifest so the choice survives; with nothing declared the
  // global standard applies, and the choice is printed because an invisible
  // configuration is one nobody can debug (the same ruling as ADR-014).
  const pointerPlan = [];
  const pointerBlocked = [];
  for (const p of pointerTargets(root, projected.surfaces)) {
    const st = await pointerState(root, p);
    if (st.state === 'foreign') pointerBlocked.push(st);
    // An already-current pointer is still reported. It is the file the reader will
    // open in a Claude Code session, so "already right" is an answer they are owed,
    // not a line to save.
    else pointerPlan.push({ ...p, state: st.state });
  }
  manifest.surfaces = projected.surfaces;

  const adoption = exists || Boolean(region?.exists);
  const dryRun = flags.dryRun === true;
  const approved = flags.yes === true;
  const apply = approved && !dryRun;

  const manifestAction = exists ? 'update' : 'create';
  const manifestFile = await manifestPath(root);
  // Planned here, written below with everything else. A file the reader was not shown
  // in the plan is a file they approve by reading the diff afterwards, which is the
  // one review step this tool exists to make unnecessary.
  const ci = await planWorkflow(root);
  const dependabot = await planDependabot(root);
  const tsconfigBase = await planTsconfigBase(root);
  // Per-developer, and planned with the rest so the operator sees it in the same
  // preview that lists everything else. `exists` short-circuits the write: a
  // repository that already has one keeps it exactly as it is.
  const identity = await resolveIdentity(root);
  const identityPlan = {
    file: IDENTITY_FILE,
    action: identity.exists ? 'unchanged' : identity.from === null ? 'skip' : 'created',
    from: identity.from,
    name: identity.name,
    email: identity.email,
    reason: identity.exists
      ? `${IDENTITY_FILE} already exists and is left exactly as it is`
      : identity.from === null
        ? 'no identity is configured anywhere, and this tool does not invent one'
        : null,
    // Only worth fixing when this repository is the one being routed: an include
    // pointing at another repository's identity file works here and breaks for the
    // next person who clones without that sibling checkout.
    include: await includesOwnIdentity(root),
  };

  const payload = {
    ok: summary.conflicts === 0 || flags.acceptConflicts === true,
    command: 'init',
    root,
    stack: detected.stack,
    facts: detected.facts,
    profiles: projected.profiles,
    fallback: projected.fallback,
    notes: projected.notes,
    // Gates the stack suggested and this repo cannot run. Only meaningful on a fresh
    // adoption: an existing manifest keeps its gates on purpose, so its drops would
    // describe proposals that were never made.
    droppedGates: exists ? [] : dropped,
    // Commands a FRESH manifest declares under gates.commands. The plan must show them:
    // a command that lands in the manifest without appearing here is a silent write,
    // and the reader would approve it by reading the diff afterwards — the review step
    // this tool exists to make unnecessary. On an existing manifest nothing is seeded
    // (the repo's declaration owns that field), so the empty list is deliberate.
    seededCommands: exists ? [] : Object.entries(commands).map(([gate, command]) => ({ gate, command })),
    surfaces: projected.surfaces,
    surfaceSource: projected.surfaceSource,
    pointers: pointerPlan.map((p) => ({ file: p.file, to: p.to, readers: p.readers, state: p.state })),
    pointersBlocked: pointerBlocked,
    ci: { file: ci.file, action: ci.action, bytes: ci.bytes, own: ci.own, reason: ci.reason },
    identity: identityPlan,
    dependabot: {
      file: dependabot.file,
      action: dependabot.action,
      bytes: dependabot.bytes,
      own: dependabot.own,
      reason: dependabot.reason,
      ecosystems: dependabot.ecosystems,
      facts: dependabot.facts,
      stack: dependabot.stack,
    },
    tsconfigBase: {
      file: tsconfigBase.file,
      action: tsconfigBase.action,
      bytes: tsconfigBase.bytes,
      reason: tsconfigBase.reason,
    },
    adoption,
    manifest: { file: MANIFEST, action: manifestAction, path: manifestFile },
    region: region && {
      file: region.file,
      action: region.action,
      previousBytes: region.previousBytes,
      bytes: region.bytes,
      malformed: region.action === 'malformed',
    },
    // Every planned target, not just AGENTS.md. The plan is rendered before anything is
    // written, so a dry run and a real run describe the same set of files.
    targets: projected.targets.map((t) => ({
      file: t.file,
      // `kind` and `surface` are carried so the plan can say what edit each file is
      // about to receive. A reader approving "frontmatter kept, body replaced" for a
      // file that keeps everything outside a region has been told the wrong thing,
      // and this is the one place they would learn it.
      kind: t.kind,
      surface: t.surface,
      action: t.action,
      previousBytes: t.previousBytes,
      bytes: t.bytes,
    })),
    findings,
    summary,
    dryRun,
    written: false,
    git: null,
  };

  // A surface this build does not know cannot be written to. Checked before the rule
  // branch, and named for what it is: `init --surfaces` accepts a list, a reader
  // mistypes one, and the misspelling used to be reported as an unprojectable rule with
  // a remedy about substitution keys — the one problem on this path that had no
  // substitution keys anywhere near it.
  const surfaceProblems = projected.surfaceProblems ?? [];
  if (surfaceProblems.length > 0) {
    payload.ok = false;
    payload.blockedBy = 'surface-problem';
    for (const p of surfaceProblems) note(`PROBLEM  ${p}`);
    if (isJson(flags)) emitJson(payload);
    return fail(
      `${surfaceProblems.length} surface(s) cannot be resolved (${surfaceProblems[0]})`,
      EXIT.FAIL,
      `pass a known surface id to --surfaces, or omit it to take the default`,
    );
  }

  // A `.mdc` rule that cannot render is a defect in this build. Adopting a repo
  // without it would leave the family half-retired, and the user would have no way
  // to tell which half from the diff.
  if (mdcProblems.length > 0) {
    payload.ok = false;
    payload.blockedBy = 'mdc-problem';
    for (const p of mdcProblems) note(`PROBLEM  ${p}`);
    if (isJson(flags)) emitJson(payload);
    return fail(
      `${mdcProblems.length} canonical .mdc rule(s) cannot be projected (${mdcProblems[0]})`,
      EXIT.FAIL,
      `fix the reported substitution keys in ${MANIFEST_FILE}`,
    );
  }

  // Step 3: block on a real conflict before doing anything else. A duplicate is
  // reported but never blocks - restating a ruling is a hygiene problem, while
  // instructing an agent to do the forbidden thing is a correctness problem.
  if (summary.conflicts > 0 && flags.acceptConflicts !== true) {
    payload.ok = false;
    payload.blockedBy = 'conflict';
    if (isJson(flags)) {
      emitJson(payload);
    } else {
      emit(render(payload, manifest, { npm, version }));
      note('');
      note(
        `blocked  ${summary.conflicts} conflict${summary.conflicts === 1 ? '' : 's'}; nothing written`,
      );
    }
    return fail(
      `${root} contradicts ${summary.byAdr.join(', ')}`,
      EXIT.FAIL,
      `edit the quoted lines, then rerun: ${CLI} init --yes | or accept: ${CLI} init --accept-conflicts --yes`,
    );
  }

  // One malformed target refuses the whole adoption, not just that file. Writing the
  // others first would leave the repo half-adopted with the half that failed having
  // produced no change at all — indistinguishable, in the diff, from never running.
  const malformed = projected.targets.filter((t) => t.action === 'malformed');
  if (malformed.length > 0) {
    payload.ok = false;
    payload.blockedBy = 'malformed-region';
    if (isJson(flags)) emitJson(payload);
    else emit(render(payload, manifest, { npm, version }));
    return fail(
      `${malformed.length} target(s) have a malformed generated region (${malformed[0].file}: ${malformed[0].reason})`,
      EXIT.FAIL,
      `fix the markers at ${malformed[0].file}:${malformed[0].line}, then rerun: ${CLI} init --yes`,
    );
  }

  // The `--diff` pairs, read before anything is written so the before side is
  // true in preview and in apply alike (R50). The after-bytes reuse the exact
  // render calls the apply path below writes, so the diff shows the write
  // rather than a second opinion about it. Pointers carry no bytes, so the
  // plan lines naming the link targets are already their whole story.
  let diffs = [];
  if (flags.diff === true) {
    diffs = [
      {
        path: MANIFEST_FILE,
        before: await readBefore(manifestFile),
        after: manifestText(manifest),
      },
    ];
    if (payload.identity.action === 'created') {
      diffs.push({
        path: IDENTITY_FILE,
        before: null,
        after: renderIdentityFile(identity),
      });
    }
    if (payload.ci.action === 'create') {
      diffs.push({
        path: payload.ci.file,
        before: await readBefore(join(root, payload.ci.file)),
        after: renderWorkflow({ own: payload.ci.own, npm, version }),
      });
    }
    if (payload.dependabot.action === 'create') {
      diffs.push({
        path: payload.dependabot.file,
        before: await readBefore(join(root, payload.dependabot.file)),
        after: renderDependabot(payload.dependabot.facts, {
          stack: payload.dependabot.stack,
          own: payload.dependabot.own,
        }),
      });
    }
    if (payload.tsconfigBase.action === 'create') {
      diffs.push({
        path: payload.tsconfigBase.file,
        before: await readBefore(join(root, payload.tsconfigBase.file)),
        after: renderTsconfigBase(),
      });
    }
    for (const target of projected.targets) {
      if (target.action === 'unchanged' || target.action === 'malformed') continue;
      diffs.push({
        path: target.file,
        before: await readBefore(target.path),
        after: target.text,
      });
    }
    Object.assign(payload, diffField(diffs, flags));
  }

  // Step 4/5: report everything, then make changes only when told to.
  if (isJson(flags)) {
    if (!apply) emitJson(payload);
  } else {
    emit(render(payload, manifest, { npm, version }));
    // After the report: the report says what, the diff shows it (R50).
    emitDiffs(diffs, flags);
  }
  if (!apply) {
    note('');
    note(
      dryRun
        ? 'dry-run  nothing written'
        : `dry-run  nothing written; apply with: ${CLI} init --yes${adoption ? ' (add --accept-conflicts to proceed despite conflicts)' : ''}`,
    );
    return EXIT.OK;
  }

  // The escape hatch is opt-in (ADR-063): plan 0002 §8.2 item 3 said "always", and the
  // tool complied, but consumers kept reporting the branch switch as a surprise. The
  // default now writes in place on the branch the reader already has — `git diff` still
  // shows the full adoption, and nothing is tagged or branched. `--backup` restores the
  // tag and the branch for readers who want the named undo path.
  const git = flags.backup
    ? await establishEscapeHatch(root)
    : { branch: null, tag: null, from: null, notes: [] };
  payload.git = git;
  for (const message of git.notes) note(`note     ${message}`);
  if (!flags.backup) {
    note(
      'in place   no backup tag or adopt branch created; the adoption is written on your current branch - git diff shows it and git checkout -- . discards it; re-run with --backup for the tag and the branch',
    );
  }
  // The operations that succeeded, not just the ones that failed.
  //
  // With --backup, `init` moves the reader onto a different branch and writes a tag
  // into their repository. Both were once reported only under `--json`, so the run —
  // the one almost everybody reads — did not say that the branch under them had
  // changed. A reader who ran the documented escape hatch and then committed would be
  // committing to a branch they had not chosen, and nothing in the output told them
  // that had happened.
  //
  // The plan's heading is "Nothing is silent", so whatever the run does to git state —
  // or deliberately does not — the output names it and the command that undoes it.
  // `notes` carried the failures because a failure is the kind of thing an operator
  // notices; a success is not.
  if (git.tag !== null) {
    note(`tagged   ${git.tag} at the pre-adoption commit; \`git reset --hard ${git.tag}\` returns this repository to what it was`);
  }
  if (git.branch !== null && git.from !== null) {
    note(`branch   switched to ${git.branch}; ${git.from} is untouched and \`git checkout ${git.from}\` returns to it`);
  }

  // Every repo-file write below is journaled, so `undo` can restore this run
  // (R49). Pointer symlinks carry no bytes and are not journaled.
  const journal = [];
  await writeManifest(root, manifest, journal);
  note(`wrote    ${MANIFEST_FILE} (${manifestAction})`);

  // Identity last, and for the same reason the gate is written after the manifest:
  // the things that change what this repository does come first, and the one that
  // only records who is doing them comes once there is something to be committing.
  //
  // Three separate refusals, each of which is the correct answer rather than a
  // failure to try harder. An existing file is not this tool's to rewrite. An
  // unconfigured identity is not one to invent - a placeholder is an identity git
  // would use. And the include is only repointed when it is missing or wrong,
  // because replacing it when it is already right would be a no-op that reads as
  // a change.
  if (payload.identity.action === 'created') {
    await journaledWriteFile(root, journal, join(root, IDENTITY_FILE), renderIdentityFile(identity));
    await ignoreIdentity(root);
    note(`wrote    ${IDENTITY_FILE} (${identity.from === 'last-commit' ? 'from the last commit in this repository' : 'from the identity configured on this machine'}); gitignored, because it is yours and not the repository's`);
  } else if (payload.identity.action === 'unchanged') {
    note(`kept     ${IDENTITY_FILE} (${payload.identity.reason})`);
  } else {
    note(`skipped  ${IDENTITY_FILE}  ${payload.identity.reason}`);
  }
  if (!payload.identity.include) {
    await includeOwnIdentity(root);
    note(`set      ${INCLUDE_KEY} = ../${IDENTITY_FILE}  this repository's own identity file`);
  }

  // Written after the manifest so the gate exists in the same adoption that declares
  // what the gates are. Skipped with its reason printed rather than silently: a repo
  // with no `.github/workflows` has no CI surface to attach to, and inventing one
  // starts running jobs on pull requests nobody asked for.
  //
  // `own` is passed through because the two kinds of repository get different bytes:
  // simt-dev's own copy says so in its own header, and writing the adopting repo's
  // text into the template's own repository would be the one place a reader is
  // guaranteed to be misled.
  if (payload.ci.action === 'create') {
    await mkdir(dirname(join(root, payload.ci.file)), { recursive: true });
    await journaledWriteFile(root, journal, join(root, payload.ci.file), renderWorkflow({ own: payload.ci.own, npm, version }));
    note(`wrote    ${payload.ci.file} (create; yours to edit from here, simt-dev will not rewrite it)`);
  }
  if (payload.dependabot.action === 'create') {
    await mkdir(dirname(join(root, payload.dependabot.file)), { recursive: true });
    // Rendered from the plan's facts, not from a fresh detection: the bytes printed
    // in the plan below are the bytes written here, and re-detecting would make the
    // printed entry list and the written one disagree the moment a manifest appears
    // between the two calls.
    await journaledWriteFile(
      root,
      journal,
      join(root, payload.dependabot.file),
      renderDependabot(payload.dependabot.facts, {
        stack: payload.dependabot.stack,
        own: payload.dependabot.own,
      }),
    );
    note(
      `wrote    ${payload.dependabot.file} (create; watches ${payload.dependabot.ecosystems.join(', ') || 'github actions'} — yours to edit, simt-dev will not rewrite it)`,
    );
  }
  if (payload.tsconfigBase.action === 'create') {
    await journaledWriteFile(root, journal, join(root, payload.tsconfigBase.file), renderTsconfigBase());
    note(
      `wrote    ${payload.tsconfigBase.file} (create; ${TSCONFIG_BASE_FILE} is JSON, so it cannot say this itself — add "extends": "./${TSCONFIG_BASE_FILE}" to your tsconfig.json or nothing reads it)`,
    );
  }

  // Every planned target is written, not just the AGENTS.md region. An adoption that
  // scaffolds the manifest and one region but leaves the `.mdc` rules for a later
  // `sync` produces a repo whose `check` fails on files the user was never told
  // about — which reads as a broken adoption rather than an unfinished one.
  for (const target of projected.targets) {
    if (target.action === 'unchanged') {
      note(`current  ${target.file} (already up to date)`);
      continue;
    }
    if (target.action === 'malformed') {
      // Checked before any write above; reaching here means the guard moved.
      return fail(
        `${target.file}: ${target.reason}`,
        EXIT.FAIL,
        `fix the markers at ${target.file}:${target.line}, then rerun: ${CLI} init --yes`,
      );
    }
    // A per-rule target lives in `.cursor/rules/`, `.claude/rules/`,
    // `.agents/rules/` or `.github/instructions/` — four directories a repo that had
    // no such configuration at all will not have. Creating them is part of adopting,
    // not a detail of writing the file.
    await mkdir(dirname(target.path), { recursive: true });
    await journaledWriteFile(root, journal, target.path, target.text);
    note(`wrote    ${target.file} (${target.action})`);
  }

  // Pointers, after the file they point at exists. A regular file already at one of
  // these paths is reported and left alone: `CLAUDE.md` is exactly the path the
  // estate's one byte-identical duplicate lives at, and replacing it silently during
  // an adoption would destroy hand-written prose in a file the user was not shown.
  for (const p of pointerPlan) {
    // `pointerPlan` carries current pointers too, for the report. Only the ones that
    // are actually missing get a link written; calling `symlink` on a link that
    // already exists is EEXIST, which is what a re-init hit the first time the report
    // and the writer were reading the same list.
    if (p.state === 'current') {
      note(`pointer  ${p.file} -> ${p.to}  already correct`);
      continue;
    }
    await symlink(p.to, p.path);
    note(`linked   ${p.file} -> ${p.to}`);
  }
  for (const p of pointerBlocked) {
    note(`BLOCKED ${p.file}: ${p.detail} (${p.bytes} bytes); left as it is`);
  }
  await commitJournal(root, 'init', journal);
  // The tree changed, so the last `check` no longer describes it: the line
  // goes back to "no cache" rather than reporting the tree as it was (R48).
  await invalidateCheckCache(root);
  payload.written = true;

  if (isJson(flags)) emitJson(payload);

  note('');
  note(`next     ${CLI} sync --yes, then ${CLI} check in CI. Commit when you are happy with the diff.`);
  // The manifest declares what the repo promises to enforce. Nothing enforces it until
  // the dispatcher is installed, and `init` used to finish without saying so — so a
  // fully adopted, `check`-green repo could enforce nothing at all, which is the state
  // the first adoption reached.
  const gates = [...(manifest.gates.preCommit ?? []), ...(manifest.gates.prePush ?? [])];
  if (gates.length === 0) {
    note('hooks    this repo declares no gate it can run, so there is nothing to install. Run it in CI instead.');
  } else {
    const state = await readHooksState(root);
    // Singular and plural, because "test are declared" is the kind of small wrongness
    // that makes a reader stop trusting the rest of the line.
    const verb = gates.length === 1 ? 'is declared' : 'are declared';
    note(
      state.complete
        ? `hooks    installed and current: ${gates.join(', ')}`
        : `hooks    NOT ENFORCED yet - ${gates.join(', ')} ${verb} but no hook runs them. Install with: ${CLI} hooks install --root ${root} --yes`,
    );
  }
  return EXIT.OK;
}

/** Scan whichever rule files exist, named or globbed. A missing file is not a
 *  finding. Generated regions are skipped: quoting a ruling is not a conflict with
 *  it, and the region is rewritten by `sync` anyway. */
async function scanRepo(root) {
  const findings = [];
  for (const path of await rulePaths(root)) {
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    const region = parseRegion(text);
    const handWritten = region.status === 'ok' ? `${region.before}\n${region.after}` : text;
    findings.push(...scanDocument(handWritten, path));
  }
  return findings;
}

/**
 * The opt-in escape hatch before the first write, taken when --backup is passed
 * (ADR-063 amended plan 0002 §8.2 item 3 from "always" to on request). Both operations
 * are best-effort: a repo that is not a git repo, or has no commits yet, must still be
 * adoptable. Failure is reported as a note rather than blocking, because refusing
 * to initialise an unborn repo would be worse than proceeding without a backup.
 */
async function establishEscapeHatch(root) {
  const result = { branch: null, tag: null, from: null, notes: [] };
  const isRepo = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (!isRepo.ok) {
    result.notes.push('not a git work tree; no backup branch or tag created');
    return result;
  }

  const dirty = await git(root, ['status', '--porcelain']);
  if (dirty.ok && dirty.stdout.trim() !== '') {
    result.notes.push('worktree already dirty; left untouched, existing changes are not staged');
  }

  const head = await git(root, ['rev-parse', '--verify', 'HEAD']);
  if (!head.ok) {
    result.notes.push('no commits yet; nothing to tag');
  } else {
    const hasTag = await git(root, ['rev-parse', '--verify', `refs/tags/${BACKUP_TAG}`]);
    if (hasTag.ok) {
      result.tag = BACKUP_TAG;
    } else {
      const tag = await git(root, ['tag', BACKUP_TAG]);
      if (tag.ok) result.tag = BACKUP_TAG;
      else result.notes.push(`could not create tag ${BACKUP_TAG}: ${tag.stderr.trim()}`);
    }
  }

  const current = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current.ok && current.stdout.trim() !== ADOPT_BRANCH) {
    // Recorded rather than re-read by the caller: only this function knows what the
    // branch was before it moved it, and a second `rev-parse` would answer with the new
    // value and make every "you were on X" line read as "you were on Y".
    result.from = current.stdout.trim();
    const branch = await git(root, ['checkout', '-b', ADOPT_BRANCH]);
    if (branch.ok) result.branch = ADOPT_BRANCH;
    else result.notes.push(`could not create branch ${ADOPT_BRANCH}: ${branch.stderr.trim()}`);
  } else if (current.ok) {
    result.branch = ADOPT_BRANCH;
  }

  return result;
}

async function git(cwd, args) {
  try {
    const { stdout, stderr } = await run('git', args, { cwd });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/** Every line is a decision with a reason. Nothing is silent. */
function render(payload, manifest, { npm = true, version } = {}) {
  const lines = [
    `repo        ${payload.root}`,
    `stack       ${payload.stack.length > 0 ? payload.stack.join(', ') : '(undetected)'}`,
    `facts       ${payload.facts.length > 0 ? payload.facts.join(' ') : '(none)'}`,
    `profiles    ${payload.profiles.join(', ')}${payload.fallback ? ' (fallback)' : ''}`,
    `mode        ${payload.adoption ? 'adopt existing repo' : 'scaffold new repo'}`,
    surfacesLine({ ids: payload.surfaces, source: payload.surfaceSource }),
    `sha         ${manifest.projection.simtDevSha}`,
  ];
  for (const n of payload.notes) lines.push(`note        ${n}`);

  lines.push('', 'PLAN');
  lines.push(`  ${payload.manifest.action.padEnd(9)} ${MANIFEST_FILE}`);
  lines.push(
    `            id=${manifest.id} stack=${manifest.stack.join(',') || '(none)'} ` +
      `preCommit=${manifest.gates.preCommit.join(',') || '(none)'} ` +
      `prePush=${manifest.gates.prePush.join(',') || '(none)'} ` +
      `coverage=${manifest.limits.coverage ?? 'undeclared (ADR-006)'} ` +
      `fileLines=${manifest.limits.fileLines.warn}/${manifest.limits.fileLines.error} (ADR-005)`,
  );
  // The identity line, with its source named. "Created" is a statement about somebody's
  // name landing in a file, so where the name came from is not a detail of the line.
  const id = payload.identity;
  if (id) {
    const verb = id.action === 'skip' ? 'skip' : id.action;
    const detail = id.action === 'unchanged'
      ? id.reason
      : id.action === 'skip'
        ? id.reason
        : `${id.name} <${id.email}>  from ${id.from === 'last-commit' ? "this repository's last commit" : 'the identity configured on this machine'}`;
    lines.push(`  ${verb.padEnd(9)} ${id.file}${detail ? `\n            ${detail}` : ''}`);
  }
  // Every gate the stack suggested and this repo cannot run is named, with the reason.
  // A silently shorter gate list reads as "this repo needs no formatting check", when
  // the truth is "declaring one would block every commit". The remedy is stated because
  // the fix is a real choice: install the tool, add the script, or declare the command.
  for (const d of payload.droppedGates ?? []) {
    lines.push(`  ${'dropped'.padEnd(9)} gate ${d.gate}: ${d.why}`);
    lines.push(`            remedy: ${d.remedy}`);
  }
  // A seed is a write, and the same rule as for dropped gates applies: the reader must
  // see the line or they approve it from the diff afterwards. Naming the manifest field
  // keeps the line actionable — this is where the reader edits it if the default is wrong.
  for (const s of payload.seededCommands ?? []) {
    lines.push(`  ${'seeded'.padEnd(9)} gates.commands["${s.gate}"] = ${s.command}`);
  }
  lines.push(
    `  ${'profiles'.padEnd(9)} ${LOCAL_PROFILE_DIR}/*.md  ` +
      `repo-local profiles are selected by the same matcher (ADR-013)`,
  );
  // Every planned target is listed, not just AGENTS.md. A plan that omits the files it
  // will write is the same defect as writing only the first target: the reader is told
  // about one file and four change.
  for (const target of payload.targets) {
    // The containment guarantee is a property of a region inside a file the repo owns,
    // and NOT of a managed `.mdc`. A managed rule file is a generated file: its
    // frontmatter survives, its body is replaced, and printing the containment caveat
    // on it would understate the edit the reader is approving. A baseline is the
    // opposite case to AGENTS.md in the one way that matters here — it is placed FIRST,
    // so the repo's own settings below it keep winning (ADR-025).
    // A nested `apps/web/AGENTS.md` is the same kind of target as the root's, so the
    // test is the suffix and not the exact path: a monorepo's package region holds
    // hand-written content too, and describing it as a generated rule file would be
    // the wrong contract for a reader who has prose above the markers.
    const caption =
      target.file.endsWith(PRIMARY_TARGET)
        ? 'hand-written content outside the markers is never modified'
        : target.kind === 'baseline'
          ? 'a region placed first, so your own settings below it still win (ADR-025)'
          : 'generated file: frontmatter kept, body replaced (ADR-016)';
    lines.push(
      `  ${target.action.padEnd(9)} ${target.file}  ${target.previousBytes} -> ${target.bytes} bytes  ${caption}`,
    );
  }

  // Pointers are printed as their own kind because they are the one target that
  // carries no content, and a reader who sees a file listed with no byte count
  // cannot tell whether it is a copy, a stub or a link.
  for (const p of payload.pointers ?? []) {
    lines.push(`  ${'link'.padEnd(9)} ${p.file} -> ${p.to}  ${p.state ?? 'absent'}`);
    lines.push(`            readers: ${p.readers}; carries no content of its own (ADR-020)`);
  }
  for (const p of payload.pointersBlocked ?? []) {
    lines.push(`  ${'blocked'.padEnd(9)} ${p.file}  ${p.detail} (${p.bytes} bytes), left as it is`);
    lines.push(`            remedy: move it aside, or delete it and rerun init`);
  }

  // The CI gate is listed as its own kind because it is the one plan entry whose
  // absence is a decision rather than a default. Skipped states its reason inline so
  // a reader can tell "this repo does not use GitHub Actions" from "this repo was
  // not offered the gate".
  if (payload.ci.action === 'create') {
    lines.push(`  ${'create'.padEnd(9)} ${payload.ci.file}  ${renderWorkflow({ own: payload.ci.own, npm, version }).length} bytes`);
    lines.push(
      payload.ci.own
        ? `            this repository is simt-dev's own; ${CLI} ci --yes refreshes this copy when the gate changes`
        : `            runs ${CLI} check where a pull request is merged; yours to edit after this`,
    );
  } else if (payload.ci.action === 'refresh') {
    // init does not write it. `simt ci` owns the template's own copy, and a
    // second writer would be a second answer to who owns it.
    lines.push(`  ${'refresh'.padEnd(9)} ${payload.ci.file}  ${payload.ci.reason}`);
    lines.push(`            remedy: ${CLI} ci --yes   (init does not write simt-dev's own copy)`);
  } else if (payload.ci.action === 'skip') {
    lines.push(`  ${'skip'.padEnd(9)} ${payload.ci.file}  ${payload.ci.reason}`);
    lines.push(`            create ${WORKFLOWS_DIR}/ first if this repo is on GitHub Actions, then rerun init`);
  }

  // Same three states as the gate, and deliberately the same shape rather than a
  // second formatting: both files exist for the same reason and a reader comparing
  // the two plan rows is checking for a difference that means something, not one
  // produced by two hand-written renderers.
  const db = payload.dependabot;
  if (db && db.action === 'create') {
    lines.push(`  ${'create'.padEnd(9)} ${db.file}  ${renderDependabot(db.facts, { stack: db.stack, own: db.own }).length} bytes`);
    lines.push(
      db.own
        ? `            watches ${db.ecosystems.join(', ')}; ${CLI} ci --yes refreshes this copy when the template changes`
        : `            watches ${db.ecosystems.join(', ') || 'github actions'} - one per manifest this repo has; yours to edit after this`,
    );
  } else if (db && db.action === 'refresh') {
    lines.push(`  ${'refresh'.padEnd(9)} ${db.file}  ${db.reason}`);
    lines.push(`            remedy: ${CLI} ci --yes   (init does not write simt-dev's own copy)`);
  } else if (db && db.action === 'skip') {
    lines.push(`  ${'skip'.padEnd(9)} ${db.file}  ${db.reason}`);
    lines.push(`            create ${WORKFLOWS_DIR}/ first if this repo is on GitHub Actions, then rerun init`);
  }

  // Two states rather than three: there is no refresh, because `init` writes this file once
  // and there is no repository in this estate that owns the template. A third state here
  // would be a mechanism for keeping a copy current that nobody has asked for.
  const tb = payload.tsconfigBase;
  if (tb && tb.action === 'create') {
    lines.push(`  ${'create'.padEnd(9)} ${tb.file}  ${renderTsconfigBase().length} bytes`);
    lines.push(
      `            the strictness flags these repositories already agree on; add "extends": "./${tb.file}" to your tsconfig.json to use it`,
    );
  } else if (tb && tb.action === 'skip') {
    lines.push(`  ${'skip'.padEnd(9)} ${tb.file}  ${tb.reason}`);
  }

  const { findings, summary } = payload;
  if (summary.conflicts > 0) {
    lines.push('', `CONFLICTS ${summary.conflicts} - blocking without --accept-conflicts`);
    for (const f of findings.filter((x) => x.severity === 'conflict')) {
      lines.push(`  ${f.file}:${f.line}  ${f.adr}  ${f.id}`);
      lines.push(`    found    ${f.quote}`);
      lines.push(`    ruling   ${f.canonical}`);
      lines.push(`    action   edit the line above, then rerun init`);
    }
  }
  if (summary.duplicates > 0) {
    lines.push('', `DUPLICATES ${summary.duplicates} - reported, not blocking`);
    lines.push('  these restate a ruling outside the generated region (anti-duplication doctrine)');
    for (const f of findings.filter((x) => x.severity === 'duplicate')) {
      lines.push(`  ${f.file}:${f.line}  ${f.adr}  ${f.id}`);
      lines.push(`    ruling   ${f.canonical}`);
    }
  }
  if (summary.total === 0) lines.push('', 'CONFLICTS none detected');
  return lines.filter((l) => l !== undefined).join('\n');
}