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
//   5. branch and tag      a named escape hatch, before the first write
//   6. write               only with --yes
// Never commits, never pushes (ADR-001).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { EXIT, emit, fail, isJson, note } from '../output/index.mjs';
import { fingerprint } from '../resolve/fingerprint.mjs';
import { rulePaths, scanDocument, summarise } from '../projection/conflicts.mjs';
import { MANIFEST, buildManifest, readManifest, writeManifest } from '../projection/manifest.mjs';
import { plan, headSha, PRIMARY_TARGET, LOCAL_PROFILE_DIR } from '../projection/project.mjs';
import { parse as parseRegion } from '../projection/markers.mjs';

const run = promisify(execFile);

const BACKUP_TAG = 'backup-before-simt-dev';
const ADOPT_BRANCH = 'simt-dev/adopt';

export async function initCommand(positional, flags) {
  const root = flags.root ?? positional[0] ?? process.cwd();

  const detected = await fingerprint(root);
  if (detected.error) {
    return fail(`${root}: ${detected.error}`, EXIT.CONFIG, 'run: simt init <path>');
  }

  const sha = await headSha();
  const existing = await readManifest(root);
  const { manifest: current, exists, error } = existing;
  if (error) {
    return fail(`${join(root, MANIFEST)}: ${error}`, EXIT.CONFIG, `fix the JSON in ${MANIFEST}`);
  }

  const manifest = buildManifest({ root, stack: detected.stack, sha, existing: current });
  const findings = await scanRepo(root);
  const summary = summarise(findings);
  const projected = await plan(root);
  const region = projected.targets[0];
  const mdcProblems = projected.mdcProblems ?? [];

  const adoption = exists || Boolean(region?.exists);
  const dryRun = flags.dryRun === true;
  const approved = flags.yes === true;
  const apply = approved && !dryRun;

  const manifestAction = exists ? 'update' : 'create';
  const manifestPath = join(root, MANIFEST);

  const payload = {
    ok: summary.conflicts === 0 || flags.acceptConflicts === true,
    command: 'init',
    root,
    stack: detected.stack,
    facts: detected.facts,
    profiles: projected.profiles,
    fallback: projected.fallback,
    notes: projected.notes,
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
      'edit the quoted lines, then rerun: simt init --yes | or accept: simt init --accept-conflicts --yes',
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
      `fix the markers at ${malformed[0].file}:${malformed[0].line}, then rerun: simt init --yes`,
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
        : `dry-run  nothing written; apply with: simt init --yes${adoption ? ' (add --accept-conflicts to proceed despite conflicts)' : ''}`,
    );
    return EXIT.OK;
  }

  const git = await establishEscapeHatch(root);
  payload.git = git;
  for (const message of git.notes) note(`note     ${message}`);

  await writeManifest(root, manifest);
  note(`wrote    ${MANIFEST} (${manifestAction})`);

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
        `fix the markers at ${target.file}:${target.line}, then rerun: simt init --yes`,
      );
    }
    // A `.mdc` target lives in `.cursor/rules/`, which a repo that had no Cursor
    // configuration at all will not have. Creating the directory is part of
    // adopting, not a detail of writing the file.
    await mkdir(dirname(target.path), { recursive: true });
    await writeFile(target.path, target.text);
    note(`wrote    ${target.file} (${target.action})`);
  }
  payload.written = true;

  if (isJson(flags)) emit(`${JSON.stringify(payload, null, 2)}\n`);

  note('');
  note('next     simt sync, then simt check in CI. Commit when you are happy with the diff.');
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
  lines.push(
    `  ${'profiles'.padEnd(9)} ${LOCAL_PROFILE_DIR}/*.md  ` +
      `repo-local profiles are selected by the same matcher (ADR-013)`,
  );
  // Every planned target is listed, not just AGENTS.md. A plan that omits the files it
  // will write is the same defect as writing only the first target: the reader is told
  // about one file and four change.
  for (const target of payload.targets) {
    // The containment guarantee is a property of AGENTS.md ONLY. A managed `.mdc` is
    // a generated file: its frontmatter survives, its body is replaced, and printing
    // the containment caveat on it would understate the edit the reader is approving.
    const isPrimary = target.file === PRIMARY_TARGET;
    lines.push(
      `  ${target.action.padEnd(9)} ${target.file}  ${target.previousBytes} -> ${target.bytes} bytes` +
        (isPrimary
          ? '  hand-written content outside the markers is never modified'
          : '  generated file: frontmatter kept, body replaced (ADR-016)'),
    );
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