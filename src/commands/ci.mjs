// simt-dev ci — the .github files, in the one repository whose copies are refreshed.
//
// Why this exists rather than a flag on `init`: the write-once rule is about a
// repository's own file, and simt-dev's own repository has no file of its own here —
// its copies are the templates. Something has to be able to write them without
// adopting the repository, and `init` cannot: adopting this repo would pin its own
// SHA into its own AGENTS.md, which is precisely why AGENTS.md says it is not
// self-adopted. A refresh reachable only through `init` would be an exception that
// never fires, and an exception that never fires is the "permanently red check
// nothing can fix" failure in another costume.
//
// Everywhere else this command refuses rather than creating either file. There, the
// file belongs to the repository, `init` writes it once, and a second writer would be
// a second answer to who owns it (ADR-023, ADR-024, ADR-026).
//
// Both files are handled here rather than in two commands because they answer the
// same question with the same answer. A reader who had to learn which of two
// commands owns which file would be learning about ownership twice to learn nothing
// new, and the next .github file would arrive with a third command to remember.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { EXIT, emit, emitJson, isJson, note } from '../output/index.mjs';
import { planWorkflow, renderWorkflow, WORKFLOW_FILE } from '../ci/workflow.mjs';
import { planDependabot, renderDependabot, DEPENDABOT_FILE } from '../ci/dependabot.mjs';

/**
 * The two plans, with the render and the plan-time data each needs kept attached.
 *
 * A table rather than two call sites so that adding a third `.github` file is one
 * row and not a second copy of the write path — the divergence risk this command
 * already had once, when the workflow's own rendering lived inline here.
 */
function targets() {
  return [
    { key: 'workflow', file: WORKFLOW_FILE, plan: planWorkflow, render: () => renderWorkflow({ own: true }) },
    { key: 'dependabot', file: DEPENDABOT_FILE, plan: planDependabot, render: (plan) => renderDependabot(plan.facts ?? [], { stack: plan.stack ?? [], own: true }) },
  ];
}

export async function ciCommand(positional, flags) {
  const root = flags.root ?? positional[0] ?? process.cwd();

  const plans = [];
  for (const { key, file, plan } of targets()) {
    plans.push({ key, file, ...(await plan(root)) });
  }

  // Refuse once, on the first non-own plan, and say which file. One refusal that
  // names a file is answerable; two refusals is a list the reader has to reconcile
  // against a rule they cannot see from here.
  const foreign = plans.find((p) => !p.own);
  if (foreign) {
    return failOutside(root, foreign, flags);
  }

  const todo = plans.filter((p) => p.action !== 'unchanged');

  if (todo.length === 0) {
    if (isJson(flags)) {
      emitJson(
        {
          ok: true,
          command: 'ci',
          root,
          action: 'unchanged',
          files: plans.map((p) => ({ file: p.file, bytes: p.bytes })),
          written: false,
        },
        {},
      );
    } else {
      emit(plans.map((p) => `current  ${p.file}  ${p.bytes} bytes`).join('\n'));
    }
    return EXIT.OK;
  }

  // Same shape as every other write in this tool: show it, change it only when told.
  // The plan is printed from the same call `check` reads, so a reader who is shown
  // these lines is shown the lines that produced them.
  const lines = [`repo      ${root}`];
  for (const p of todo) {
    lines.push(
      `file      ${p.file}`,
      `action    ${p.action}`,
      `why       ${p.reason ?? (p.action === 'create' ? `this repository is simt-dev's own` : '')}`,
    );
    if (p.ecosystems) lines.push(`watching  ${p.ecosystems.join(', ') || '(github actions only)'}`);
  }
  if (isJson(flags)) {
    if (flags.yes !== true && flags.dryRun !== true) {
      emitJson({ ok: true, command: 'ci', root, files: todo, written: false }, {});
    }
  } else {
    emit(lines.join('\n'));
  }

  if (flags.yes !== true || flags.dryRun === true) {
    note('');
    note(flags.dryRun === true ? 'dry-run  nothing written' : 'dry-run  nothing written; apply with: simt-dev ci --yes');
    return EXIT.OK;
  }

  for (const { key, plan, render } of targets()) {
    const p = plans.find((x) => x.key === key);
    if (p.action === 'unchanged') continue;
    await mkdir(dirname(p.path), { recursive: true });
    // The renderer takes the plan because detection-driven content is a function of
    // this repo's facts: a dependabot config rendered without them would watch
    // nothing, which is the same silent-nothing the detection ruling exists to stop.
    await writeFile(p.path, render(p));
    note(`wrote    ${p.file} (${p.action}; the template and this copy now agree)`);
  }
  if (isJson(flags)) {
    emitJson(
      {
        ok: true,
        command: 'ci',
        root,
        files: plans.map((p) => ({ file: p.file, action: p.action, bytes: p.bytes })),
        written: true,
      },
      {},
    );
  }
  return EXIT.OK;
}

/**
 * The refusal, which is a report rather than a wall: a reader who ran this in a
 * repository that adopted simt-dev has almost certainly just been told to run
 * something that does not exist, and the useful answer is which command does exist.
 */
function failOutside(root, plan, flags) {
  const remedy = `simt-dev init --yes   (a repository's .github files are written once, by init, and then left alone)`;
  if (isJson(flags)) {
    emitJson({ ok: true, command: 'ci', root, file: plan.file, action: plan.action, own: false, remedy, written: false }, {});
  } else {
    emit(
      [
        `file      ${plan.file}`,
        `state     ${plan.exists ? 'present' : 'absent'}`,
        `owner     this repository, not simt-dev`,
        '',
        'simt-dev refreshes its own .github files and no one else\'s. This command is not',
        'how a repository that adopted simt-dev gets one; `init` is, and it writes the',
        'file once.',
      ].join('\n'),
    );
    note('');
    note(`remedy:   ${remedy}`);
  }
  return EXIT.OK;
}