// simt-dev init - adopt a repo into the ecosystem, or scaffold a new one.
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
//   5. branch and tag      a named escape hatch, before the first write
//   6. write               only with --yes
// Never commits, never pushes (ADR-001).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { EXIT, emit, fail, isJson, note } from '../output/index.mjs';
import { fingerprint } from '../resolve/fingerprint.mjs';
import { rulePaths, scanDocument, summarise } from '../projection/conflicts.mjs';
import { MANIFEST, buildManifest, readManifest, writeManifest, planGates } from '../projection/manifest.mjs';
import { readCapability } from '../hooks/capability.mjs';
import { readHooksState } from '../compare/hooksstate.mjs';
import { planWorkflow, renderWorkflow, WORKFLOWS_DIR } from '../ci/workflow.mjs';
import { planDependabot, renderDependabot } from '../ci/dependabot.mjs';
import { planTsconfigBase, renderTsconfigBase, TSCONFIG_BASE_FILE } from '../tsconfig.mjs';
import { pointerState, pointerTargets } from '../projection/project.mjs';
import { surfacesLine } from '../projection/surfaces.mjs';
import { plan, headSha, PRIMARY_TARGET, LOCAL_PROFILE_DIR } from '../projection/project.mjs';
import { parse as parseRegion } from '../projection/markers.mjs';

const run = promisify(execFile);

const BACKUP_TAG = 'backup-before-simt-dev';
const ADOPT_BRANCH = 'simt-dev/adopt';

export async function initCommand(positional, flags) {
  const root = flags.root ?? positional[0] ?? process.cwd();

  const detected = await fingerprint(root);
  if (detected.error) {
    return fail(`${root}: ${detected.error}`, EXIT.CONFIG, 'run: simt-dev init <path>');
  }

  const sha = await headSha();
  const existing = await readManifest(root);
  const { manifest: current, exists, error } = existing;
  if (error) {
    return fail(`${join(root, MANIFEST)}: ${error}`, EXIT.CONFIG, `fix the JSON in ${MANIFEST}`);
  }

  // What this repo can demonstrably run, not what its stack suggests. Without this the
  // stack table proposes gates the repo has no way to execute — the adoption of
  // simt-social-media declared five and could run two, which would have blocked every
  // commit once hooks were installed.
  const capability = await readCapability(root);
  const { dropped } = planGates(detected.stack, capability);
  const manifest = buildManifest({ root, stack: detected.stack, sha, existing: current, capability });
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
  const manifestPath = join(root, MANIFEST);
  // Planned here, written below with everything else. A file the reader was not shown
  // in the plan is a file they approve by reading the diff afterwards, which is the
  // one review step this tool exists to make unnecessary.
  const ci = await planWorkflow(root);
  const dependabot = await planDependabot(root);
  const tsconfigBase = await planTsconfigBase(root);

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
    surfaces: projected.surfaces,
    surfaceSource: projected.surfaceSource,
    pointers: pointerPlan.map((p) => ({ file: p.file, to: p.to, readers: p.readers, state: p.state })),
    pointersBlocked: pointerBlocked,
    ci: { file: ci.file, action: ci.action, bytes: ci.bytes, own: ci.own, reason: ci.reason },
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
    manifest: { file: MANIFEST, action: manifestAction, path: manifestPath },
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

  // A `.mdc` rule that cannot render is a defect in this build. Adopting a repo
  // without it would leave the family half-retired, and the user would have no way
  // to tell which half from the diff.
  if (mdcProblems.length > 0) {
    payload.ok = false;
    payload.blockedBy = 'mdc-problem';
    for (const p of mdcProblems) note(`PROBLEM  ${p}`);
    if (isJson(flags)) emit(`${JSON.stringify(payload, null, 2)}\n`);
    return fail(
      `${mdcProblems.length} canonical .mdc rule(s) cannot be projected (${mdcProblems[0]})`,
      EXIT.FAIL,
      'fix the reported substitution keys in simt-dev.json, or add the key to the rule in rules/mdc/',
    );
  }

  // Step 3: block on a real conflict before doing anything else. A duplicate is
  // reported but never blocks - restating a ruling is a hygiene problem, while
  // instructing an agent to do the forbidden thing is a correctness problem.
  if (summary.conflicts > 0 && flags.acceptConflicts !== true) {
    payload.ok = false;
    payload.blockedBy = 'conflict';
    if (isJson(flags)) {
      emit(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      emit(render(payload, manifest));
      note('');
      note(
        `blocked  ${summary.conflicts} conflict${summary.conflicts === 1 ? '' : 's'}; nothing written`,
      );
    }
    return fail(
      `${root} contradicts ${summary.byAdr.join(', ')}`,
      EXIT.FAIL,
      'edit the quoted lines, then rerun: simt-dev init --yes | or accept: simt-dev init --accept-conflicts --yes',
    );
  }

  // One malformed target refuses the whole adoption, not just that file. Writing the
  // others first would leave the repo half-adopted with the half that failed having
  // produced no change at all — indistinguishable, in the diff, from never running.
  const malformed = projected.targets.filter((t) => t.action === 'malformed');
  if (malformed.length > 0) {
    payload.ok = false;
    payload.blockedBy = 'malformed-region';
    if (isJson(flags)) emit(`${JSON.stringify(payload, null, 2)}\n`);
    else emit(render(payload, manifest));
    return fail(
      `${malformed.length} target(s) have a malformed generated region (${malformed[0].file}: ${malformed[0].reason})`,
      EXIT.FAIL,
      `fix the markers at ${malformed[0].file}:${malformed[0].line}, then rerun: simt-dev init --yes`,
    );
  }

  // Step 4/5: report everything, then make changes only when told to.
  if (isJson(flags)) {
    if (!apply) emit(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    emit(render(payload, manifest));
  }
  if (!apply) {
    note('');
    note(
      dryRun
        ? 'dry-run  nothing written'
        : `dry-run  nothing written; apply with: simt-dev init --yes${adoption ? ' (add --accept-conflicts to proceed despite conflicts)' : ''}`,
    );
    return EXIT.OK;
  }

  const git = await establishEscapeHatch(root);
  payload.git = git;
  for (const message of git.notes) note(`note     ${message}`);

  await writeManifest(root, manifest);
  note(`wrote    ${MANIFEST} (${manifestAction})`);

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
    await writeFile(join(root, payload.ci.file), renderWorkflow({ own: payload.ci.own }));
    note(`wrote    ${payload.ci.file} (create; yours to edit from here, simt-dev will not rewrite it)`);
  }
  if (payload.dependabot.action === 'create') {
    await mkdir(dirname(join(root, payload.dependabot.file)), { recursive: true });
    // Rendered from the plan's facts, not from a fresh detection: the bytes printed
    // in the plan below are the bytes written here, and re-detecting would make the
    // printed entry list and the written one disagree the moment a manifest appears
    // between the two calls.
    await writeFile(
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
    await writeFile(join(root, payload.tsconfigBase.file), renderTsconfigBase());
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
        `fix the markers at ${target.file}:${target.line}, then rerun: simt-dev init --yes`,
      );
    }
    // A per-rule target lives in `.cursor/rules/`, `.claude/rules/`,
    // `.agents/rules/` or `.github/instructions/` — four directories a repo that had
    // no such configuration at all will not have. Creating them is part of adopting,
    // not a detail of writing the file.
    await mkdir(dirname(target.path), { recursive: true });
    await writeFile(target.path, target.text);
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
  payload.written = true;

  if (isJson(flags)) emit(`${JSON.stringify(payload, null, 2)}\n`);

  note('');
  note(`next     simt-dev sync, then simt-dev check in CI. Commit when you are happy with the diff.`);
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
        : `hooks    NOT ENFORCED yet - ${gates.join(', ')} ${verb} but no hook runs them. Install with: simt-dev hooks install --root ${root}`,
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
 * A named escape hatch before the first write, per plan 0001. Both operations are
 * best-effort: a repo that is not a git repo, or has no commits yet, must still be
 * adoptable. Failure is reported as a note rather than blocking, because refusing
 * to initialise an unborn repo would be worse than proceeding without a backup.
 */
async function establishEscapeHatch(root) {
  const result = { branch: null, tag: null, notes: [] };
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
function render(payload, manifest) {
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
  lines.push(`  ${payload.manifest.action.padEnd(9)} ${MANIFEST}`);
  lines.push(
    `            id=${manifest.id} stack=${manifest.stack.join(',') || '(none)'} ` +
      `preCommit=${manifest.gates.preCommit.join(',') || '(none)'} ` +
      `prePush=${manifest.gates.prePush.join(',') || '(none)'} ` +
      `coverage=${manifest.limits.coverage ?? 'undeclared (ADR-006)'} ` +
      `fileLines=${manifest.limits.fileLines.warn}/${manifest.limits.fileLines.error} (ADR-005)`,
  );
  // Every gate the stack suggested and this repo cannot run is named, with the reason.
  // A silently shorter gate list reads as "this repo needs no formatting check", when
  // the truth is "declaring one would block every commit". The remedy is stated because
  // the fix is a real choice: install the tool, add the script, or declare the command.
  for (const d of payload.droppedGates ?? []) {
    lines.push(`  ${'dropped'.padEnd(9)} gate ${d.gate}: ${d.why}`);
    lines.push(`            remedy: ${d.remedy}`);
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
    const caption =
      target.file === PRIMARY_TARGET
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
    lines.push(`  ${'create'.padEnd(9)} ${payload.ci.file}  ${renderWorkflow({ own: payload.ci.own }).length} bytes`);
    lines.push(
      payload.ci.own
        ? `            this repository is simt-dev's own; simt-dev ci --yes refreshes this copy when the gate changes`
        : `            runs simt-dev check where a pull request is merged; yours to edit after this`,
    );
  } else if (payload.ci.action === 'refresh') {
    // init does not write it. `simt-dev ci` owns the template's own copy, and a
    // second writer would be a second answer to who owns it.
    lines.push(`  ${'refresh'.padEnd(9)} ${payload.ci.file}  ${payload.ci.reason}`);
    lines.push(`            remedy: simt-dev ci --yes   (init does not write simt-dev's own copy)`);
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
        ? `            watches ${db.ecosystems.join(', ')}; simt-dev ci --yes refreshes this copy when the template changes`
        : `            watches ${db.ecosystems.join(', ') || 'github actions'} - one per manifest this repo has; yours to edit after this`,
    );
  } else if (db && db.action === 'refresh') {
    lines.push(`  ${'refresh'.padEnd(9)} ${db.file}  ${db.reason}`);
    lines.push(`            remedy: simt-dev ci --yes   (init does not write simt-dev's own copy)`);
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