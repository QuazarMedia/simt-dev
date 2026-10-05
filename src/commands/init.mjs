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
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { EXIT, emit, fail, isJson, note } from '../output/index.mjs';
import { fingerprint } from '../resolve/fingerprint.mjs';
import { RULE_FILES, scanDocument, summarise } from '../projection/conflicts.mjs';
import { MANIFEST, buildManifest, readManifest, writeManifest } from '../projection/manifest.mjs';
import { plan, headSha } from '../projection/project.mjs';

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
    findings,
    summary,
    dryRun,
    written: false,
    git: null,
  };

  // Step 3: block on a real conflict before doing anything else. A duplicate is
  // reported but never blocks - restating a ruling is a hygiene problem, while
  // instructing an agent to do the forbidden thing is a correctness problem.
  if (summary.conflicts > 0 && flags.acceptConflicts !== true) {
    payload.ok = false;
    payload.blockedBy = 'conflict';
    if (isJson(flags)) {
      emit(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      emit(render(payload, manifest, region));
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

  if (region?.action === 'malformed') {
    payload.ok = false;
    payload.blockedBy = 'malformed-region';
    if (isJson(flags)) emit(`${JSON.stringify(payload, null, 2)}\n`);
    else emit(render(payload, manifest, region));
    return fail(
      `${region.file}: ${region.reason}`,
      EXIT.FAIL,
      `fix the markers at ${region.file}:${region.line}, then rerun: simt init --yes`,
    );
  }

  // Step 4/5: report everything, then make changes only when told to.
  if (isJson(flags)) {
    if (!apply) emit(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    emit(render(payload, manifest, region));
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

  if (region && region.action !== 'unchanged') {
    await writeFile(region.path, region.text);
    note(`wrote    ${region.file} (${region.action})`);
  } else if (region) {
    note(`current  ${region.file} (already up to date)`);
  }
  payload.written = true;

  if (isJson(flags)) emit(`${JSON.stringify(payload, null, 2)}\n`);

  note('');
  note('next     simt sync, then simt check in CI. Commit when you are happy with the diff.');
  return EXIT.OK;
}

/** Scan whichever of RULE_FILES exist. A missing file is not a finding. */
async function scanRepo(root) {
  const findings = [];
  for (const file of RULE_FILES) {
    let text;
    try {
      text = await readFile(join(root, file), 'utf8');
    } catch {
      continue;
    }
    findings.push(...scanDocument(text, file));
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
function render(payload, manifest, region) {
  const lines = [
    `repo        ${payload.root}`,
    `stack       ${payload.stack.length > 0 ? payload.stack.join(', ') : '(undetected)'}`,
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
  if (region) {
    lines.push(
      `  ${region.action.padEnd(9)} ${region.file}  ${region.previousBytes} -> ${region.bytes} bytes`,
    );
  }
  lines.push('            hand-written content outside the markers is never modified');

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