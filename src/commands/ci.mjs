// simt-dev ci — the gate file, in the one repository whose gate file is refreshed.
//
// Why this exists rather than a flag on `init`: the write-once rule is about a
// repository's own file, and simt-dev's own repository has no file of its own here —
// its copy is the template. Something has to be able to write that copy without
// adopting the repository, and `init` cannot: adopting this repo would pin its own
// SHA into its own AGENTS.md, which is precisely why AGENTS.md says it is not
// self-adopted. A refresh reachable only through `init` would be an exception that
// never fires, and an exception that never fires is the "permanently red check
// nothing can fix" failure in another costume.
//
// Everywhere else this command refuses rather than creating the file. There, the
// file belongs to the repository, `init` writes it once, and a second writer would be
// a second answer to who owns it (ADR-023, ADR-024).

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { EXIT, emit, emitJson, isJson, note } from '../output/index.mjs';
import { planWorkflow, renderWorkflow, WORKFLOW_FILE } from '../ci/workflow.mjs';

export async function ciCommand(positional, flags) {
  const root = flags.root ?? positional[0] ?? process.cwd();
  const plan = await planWorkflow(root);

  if (!plan.own) {
    return failOutside(root, plan, flags);
  }

  if (plan.action === 'unchanged') {
    if (isJson(flags)) {
      emitJson({ ok: true, command: 'ci', root, file: plan.file, action: 'unchanged', bytes: plan.bytes, written: false }, {});
    } else {
      emit(`current  ${plan.file}  ${plan.bytes} bytes`);
    }
    return EXIT.OK;
  }

  // Same shape as every other write in this tool: show it, change it only when told.
  // The plan is printed from the same call `check` reads, so a reader who is shown
  // this line is shown the line that produced it.
  const lines = [
    `repo      ${root}`,
    `file      ${plan.file}`,
    `action    ${plan.action}`,
    `why       ${plan.reason ?? (plan.action === 'create' ? `this repository is simt-dev's own` : '')}`,
  ];
  if (isJson(flags)) {
    if (flags.yes !== true && flags.dryRun !== true) {
      emitJson({ ok: true, command: 'ci', root, file: plan.file, action: plan.action, reason: plan.reason, written: false }, {});
    }
  } else {
    emit(lines.join('\n'));
  }

  if (flags.yes !== true || flags.dryRun === true) {
    note('');
    note(flags.dryRun === true ? 'dry-run  nothing written' : 'dry-run  nothing written; apply with: simt-dev ci --yes');
    return EXIT.OK;
  }

  await mkdir(dirname(plan.path), { recursive: true });
  await writeFile(plan.path, renderWorkflow({ own: true }));
  note(`wrote    ${plan.file} (${plan.action}; the gate template and this copy now agree)`);
  if (isJson(flags)) {
    emitJson({ ok: true, command: 'ci', root, file: plan.file, action: plan.action, bytes: plan.bytes, written: true }, {});
  }
  return EXIT.OK;
}

/**
 * The refusal, which is a report rather than a wall: a reader who ran this in a
 * repository that adopted simt-dev has almost certainly just been told to run
 * something that does not exist, and the useful answer is which command does exist.
 */
function failOutside(root, plan, flags) {
  const remedy = `simt-dev init --yes   (that repository's gate file is written once, by init, and then left alone)`;
  if (isJson(flags)) {
    emitJson({ ok: true, command: 'ci', root, file: plan.file, action: plan.action, own: false, remedy, written: false }, {});
  } else {
    emit(
      [
        `file      ${plan.file}`,
        `state     ${plan.exists ? 'present' : 'absent'}`,
        `owner     this repository, not simt-dev`,
        '',
        'simt-dev refreshes its own gate file and no one else\'s. This command is not',
        'how a repository that adopted simt-dev gets one; `init` is, and it writes the',
        'file once.',
      ].join('\n'),
    );
    note('');
    note(`remedy:   ${remedy}`);
  }
  return EXIT.OK;
}
