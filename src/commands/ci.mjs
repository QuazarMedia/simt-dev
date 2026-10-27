// simt ci — the .github files, in the one repository whose copies are refreshed.
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

import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { commitJournal, journaledWriteFile } from '../journal.mjs';
import { diffField, emitDiffs, readBefore } from '../diff.mjs';

import { EXIT, emit, emitJson, isJson, note, writeMode } from '../output/index.mjs';
import { planWorkflow, renderWorkflow, WORKFLOW_FILE } from '../ci/workflow.mjs';
import { planDependabot, renderDependabot, DEPENDABOT_FILE } from '../ci/dependabot.mjs';
import { CLI } from '../name.mjs';

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
  const mode = writeMode(flags);
  const checkOnly = flags.check === true;

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
    // A check that names the drift without showing it makes the reader open two files
    // to answer a question this command already knows the answer to.
    if (checkOnly && p.source) {
      const d = unified(p.file, p.source.text, p.source.desired);
      if (d !== '') lines.push(d);
    }
  }

  // `ci --check` is the form the own workflow runs, and the whole point of it is the
  // exit code. It printed the plan and returned 0, so the step whose own comment says
  // it exists to catch this drift let through exactly the drift it was written for.
  if (checkOnly) {
    if (isJson(flags)) {
      emitJson(
        {
          ok: false,
          command: 'ci --check',
          root,
          files: todo.map(publicPlan),
          written: false,
          error: `${todo.length} of ${plans.length} .github file(s) in this repo are stale`,
          remedy: `run: ${CLI} ci --yes`,
        },
        {},
      );
    } else {
      emit(lines.join('\n'));
    }
    return EXIT.FAIL;
  }

  // The `--diff` pairs, read before anything is written so the before side is
  // true in preview and in apply alike (R50).
  const renders = new Map(targets().map(({ key, render }) => [key, render]));
  const diffs =
    flags.diff === true
      ? await Promise.all(
        plans
          .filter((p) => p.action !== 'unchanged')
          .map(async (p) => ({ path: p.file, before: await readBefore(p.path), after: renders.get(p.key)(p) })),
      )
      : [];

  if (isJson(flags)) {
    emitJson(
      { ok: true, command: 'ci', root, files: todo.map(publicPlan), written: false, dryRun: !mode.apply, ...diffField(diffs, flags) },
      {},
    );
  } else {
    emit(lines.join('\n'));
  }

  if (!mode.apply) {
    // After the report: the report says what, the diff shows it (R50).
    emitDiffs(diffs, flags);
    note('');
    note(mode.dryRun ? 'dry-run  nothing written' : `dry-run  nothing written; apply with: ${CLI} ci --yes`);
    return EXIT.OK;
  }

  // Journaled so `undo` restores this run (R49).
  const journal = [];
  for (const { key, plan, render } of targets()) {
    const p = plans.find((x) => x.key === key);
    if (p.action === 'unchanged') continue;
    await mkdir(dirname(p.path), { recursive: true });
    // The renderer takes the plan because detection-driven content is a function of
    // this repo's facts: a dependabot config rendered without them would watch
    // nothing, which is the same silent-nothing the detection ruling exists to stop.
    await journaledWriteFile(root, journal, p.path, render(p));
    note(`wrote    ${p.file} (${p.action}; the template and this copy now agree)`);
  }
  await commitJournal(root, 'ci', journal);
  if (isJson(flags)) {
    emitJson(
      {
        ok: true,
        command: 'ci',
        root,
        files: plans.map((p) => ({ file: p.file, action: p.action, bytes: p.bytes })),
        written: true,
        ...diffField(diffs, flags),
      },
      {},
    );
  }
  // After the report: the report says what, the diff shows it (R50).
  emitDiffs(diffs, flags);
  return EXIT.OK;
}

/**
 * The refusal, which is a report rather than a wall: a reader who ran this in a
 * repository that adopted simt-dev has almost certainly just been told to run
 * something that does not exist, and the useful answer is which command does exist.
 */
function failOutside(root, plan, flags) {
  const remedy = `${CLI} init --yes   (a repository's .github files are written once, by init, and then left alone)`;
  if (isJson(flags)) {
    emitJson(
      {
        // `ok: true` with a refusal in it was the shape this whole command had: the
        // document said the request succeeded while the text said it was refused, and
        // a caller reading `ok` had no way to know which one the writer meant. It is
        // also `EXIT.UNSUPPORTED` rather than 0 for the same reason — the request
        // cannot be satisfied in this repository, and that is a fact about the
        // repository, not a successful no-op.
        ok: false,
        command: 'ci',
        root,
        file: plan.file,
        action: plan.action,
        own: false,
        error: `simt-dev refreshes its own .github files; ${plan.file} belongs to this repository`,
        remedy,
        written: false,
      },
      {},
    );
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
  return EXIT.UNSUPPORTED;
}

/**
 * A plan without the file bodies. Both sides of the comparison travel on the plan so
 * the verdict and the diff cannot disagree, and a JSON payload is not the place for
 * two copies of a workflow file.
 */
function publicPlan({ source, ...plan }) {
  return plan;
}

/**
 * A unified diff of the two, or `''` when they are identical.
 *
 * Small on purpose: the reader is the author of the template change that made the
 * copy stale, and the question is "what did I change". Line-level LCS rather than a
 * character diff, because a workflow's drift is a moved step, not a typo — and a
 * table over tens of lines is smaller to read and harder to get wrong than a Myers
 * scan. No dependency, per ADR-012.
 */
function unified(file, current, desired) {
  const a = (current ?? '').split('\n');
  const b = (desired ?? '').split('\n');
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      rows.push({ mark: ' ', line: a[i] });
      i += 1;
      j += 1;
    } else if (j < b.length && (i === a.length || table[i][j + 1] >= table[i + 1][j])) {
      rows.push({ mark: '+', line: b[j] });
      j += 1;
    } else {
      rows.push({ mark: '-', line: a[i] });
      i += 1;
    }
  }
  // A diff of nothing is not a diff. Returning '' is what lets the caller decide,
  // rather than printing a header over an empty body.
  if (rows.every((r) => r.mark === ' ')) return '';

  // Three lines of context, then `...` for whatever was elided. Printing all fifty
  // lines of a workflow to report one changed step buries the answer in context, and
  // the answer is the only reason this exists.
  const CONTEXT = 3;
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, at) => {
    if (r.mark === ' ') return;
    for (let k = Math.max(0, at - CONTEXT); k <= Math.min(rows.length - 1, at + CONTEXT); k += 1) {
      keep[k] = true;
    }
  });
  const out = [];
  let elided = 0;
  for (const [at, r] of rows.entries()) {
    if (!keep[at]) {
      elided += 1;
      continue;
    }
    if (elided > 0) {
      out.push(`@@ ${elided} unchanged line(s) elided`);
      elided = 0;
    }
    out.push(`${r.mark}${r.line}`);
  }
  const changed = rows.filter((r) => r.mark !== ' ').length;
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ ${changed} changed line(s); apply with: ${CLI} ci --yes @@`,
    ...out,
  ].join('\n');
}