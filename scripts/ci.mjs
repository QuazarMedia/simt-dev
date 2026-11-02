#!/usr/bin/env node
// Refresh simt-dev's own two `.github` files, as a script rather than a command.
//
// The renderers stay shipped in `src/ci/`, because `init` writes the same bytes once
// into a repository that adopts simt-dev and then leaves the file alone (ADR-023,
// ADR-024, ADR-026). What is not shipped is the authoring loop for those templates:
// edit `src/ci/workflow.mjs`, run this, commit both copies. It only ever runs in this
// checkout, so shipping a command for it put a simt-dev-only writer on the surface of
// every adopter's tool — review 0003 Q84, ADR-133.
//
// Usage: node scripts/ci.mjs [--check] [--diff] [--json] [--yes] [--dry-run] [--root <path>]

import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readBefore, renderDiffs, unifiedDiff } from '../src/diff.mjs';
import { EXIT } from '../src/output/index.mjs';
import { applyPlan, change } from '../src/write/plan.mjs';
import { planDependabot, renderDependabot, DEPENDABOT_FILE } from '../src/ci/dependabot.mjs';
import { planWorkflow, renderWorkflow, WORKFLOW_FILE } from '../src/ci/workflow.mjs';

const SCRIPT = 'node scripts/ci.mjs';
const USAGE = `${SCRIPT} [--check] [--diff] [--json] [--yes] [--dry-run] [--root <path>]`;

/**
 * The two plans, with the render and the plan-time data each needs kept attached.
 *
 * A table rather than two call sites so that adding a third `.github` file is one row
 * and not a second copy of the write path — the divergence this writer already had
 * once, when the workflow's rendering lived inline in the command.
 */
function targets() {
  return [
    { key: 'workflow', file: WORKFLOW_FILE, plan: planWorkflow, render: () => renderWorkflow({ own: true }) },
    {
      key: 'dependabot',
      file: DEPENDABOT_FILE,
      plan: planDependabot,
      render: (plan) => renderDependabot(plan.facts ?? [], { stack: plan.stack ?? [], own: true, root: plan.root }),
    },
  ];
}

function parseArgs(argv) {
  const flags = { check: false, diff: false, json: false, yes: false, dryRun: false, root: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') flags.check = true;
    else if (arg === '--diff') flags.diff = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--yes') flags.yes = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--root') {
      flags.root = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--root=')) flags.root = arg.slice('--root='.length);
    else throw new Error(`unknown argument \`${arg}\`\n${USAGE}`);
  }
  if (flags.root === '') throw new Error(`--root needs a path\n${USAGE}`);
  return flags;
}

const out = (text) => process.stdout.write(`${text}\n`);
const err = (text) => process.stderr.write(`${text}\n`);
const doc = (payload) => out(JSON.stringify(payload, null, 2));

/** A plan without the file bodies: both sides travelled on the plan, and a JSON
 *  payload is not the place for two copies of a workflow file. */
function publicPlan({ source, text, desired, ...plan }) {
  return plan;
}

async function main(argv) {
  let flags;
  try {
    flags = parseArgs(argv);
  } catch (error) {
    err(error.message);
    return EXIT.USAGE;
  }

  const root = flags.root ? (isAbsolute(flags.root) ? flags.root : resolve(flags.root)) : process.cwd();

  const plans = [];
  for (const { key, file, plan } of targets()) plans.push({ key, file, ...(await plan(root)) });

  // Refuse once, on the first non-own plan, and name the file: one refusal a reader
  // can answer, two is a list they reconcile against a rule they cannot see.
  const foreign = plans.find((p) => !p.own);
  if (foreign) {
    if (flags.json) {
      doc({
        ok: false,
        command: 'ci',
        root,
        file: foreign.file,
        action: foreign.action,
        own: false,
        error: `simt-dev refreshes its own .github files; ${foreign.file} belongs to this repository`,
        remedy: 'run: simt init --yes   (a repository that adopted simt-dev got its copy from init, which writes it once)',
        written: false,
      });
    } else {
      out(
        [
          `file      ${foreign.file}`,
          `state     ${foreign.exists ? 'present' : 'absent'}`,
          'owner     this repository, not simt-dev',
          '',
          "simt-dev refreshes its own .github files and no one else's. A repository that",
          'adopted simt-dev got its copy from `simt init`, which writes it once.',
        ].join('\n'),
      );
      err('remedy:   simt init --yes   (an adopting repository got its copy from init, which writes it once)');
    }
    return EXIT.UNSUPPORTED;
  }

  const todo = plans.filter((p) => p.action !== 'unchanged');
  if (todo.length === 0) {
    if (flags.json) {
      doc({ ok: true, command: 'ci', root, action: 'unchanged', files: plans.map((p) => ({ file: p.file, bytes: p.bytes })), written: false });
    } else {
      out(plans.map((p) => `current  ${p.file}  ${p.bytes} bytes`).join('\n'));
    }
    return EXIT.OK;
  }

  const lines = [`repo      ${root}`];
  for (const p of todo) {
    lines.push(
      `file      ${p.file}`,
      `action    ${p.action}`,
      `why       ${p.reason ?? (p.action === 'create' ? "this repository is simt-dev's own" : '')}`,
    );
    if (p.ecosystems) lines.push(`watching  ${p.ecosystems.join(', ') || '(github actions only)'}`);
  }

  // `--check` is the form the own workflow runs, and the only reason it exists is the
  // exit code: it printed the plan and returned 0, so the step that exists to catch
  // drift let through exactly the drift it was written for.
  if (flags.check) {
    if (flags.json) {
      doc({
        ok: false,
        command: 'ci --check',
        root,
        files: todo.map(publicPlan),
        written: false,
        error: `${todo.length} of ${plans.length} .github file(s) in this repo are stale`,
        remedy: `run: ${SCRIPT} --yes`,
      });
    } else {
      const diffs = todo.map((p) => unifiedDiff(p.file, p.source?.text ?? null, p.source?.desired ?? null)).filter((d) => d !== '');
      out([...lines, ...diffs, `apply with: ${SCRIPT} --yes`].join('\n'));
    }
    return EXIT.FAIL;
  }

  const mode = { dryRun: flags.dryRun === true, apply: flags.yes === true && flags.dryRun !== true };
  // Read the before side before anything is written, so preview and apply describe the
  // same change.
  const diffs =
    flags.diff === true
      ? await Promise.all(
        todo.map(async (p) => ({
          path: p.file,
          before: await readBefore(p.path),
          after: targets().find((t) => t.key === p.key).render(p),
        })),
      )
      : [];

  const payload = {
    ok: true,
    command: 'ci',
    root,
    files: todo.map(publicPlan),
    written: mode.apply,
    ...(flags.diff === true ? { diff: renderDiffs(diffs) } : {}),
  };
  if (flags.json) doc(payload);
  else {
    out(lines.join('\n'));
    if (diffs.length > 0) out(renderDiffs(diffs));
  }

  if (!mode.apply) {
    if (!flags.json) err(mode.dryRun ? 'dry-run  nothing written' : `dry-run  nothing written; apply with: ${SCRIPT} --yes`);
    return EXIT.OK;
  }

  const changes = [];
  for (const { key, plan, render } of targets()) {
    const p = plans.find((x) => x.key === key);
    if (p.action === 'unchanged') continue;
    changes.push(change({ path: p.path, before: await readBefore(p.path), after: render(p), owner: 'ci', reason: 'the template and this copy now agree' }));
  }
  await applyPlan(root, changes, { mode, label: 'ci' });
  for (const c of changes) err(`wrote    ${c.path.replace(`${root}/`, '')} (${c.action}; ${c.reason})`);
  return EXIT.OK;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      err(`ERROR ${error.message}`);
      process.exitCode = EXIT.FAIL;
    });
}

export { main, parseArgs };
