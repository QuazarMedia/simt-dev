// The human-readable plan `init` prints, extracted from the command so the command file
// stays about deciding what to write. Every line is a decision with a reason.

import { adapters } from '../agents/render.mjs';
import { renderDependabot } from '../ci/dependabot.mjs';
import { renderWorkflow, WORKFLOWS_DIR } from '../ci/workflow.mjs';
import { IDENTITY_FILE, INCLUDE_KEY } from '../identity.mjs';
import { CLI, MANIFEST_FILE, PACKAGE_NAME } from '../name.mjs';
import { LOCAL_PROFILE_DIR, PRIMARY_TARGET } from '../projection/project.mjs';
import { surfacesLine } from '../projection/surfaces.mjs';

// The harness ids `--harness` accepts, from the table the renderers read: a second list
// in this file is the one that would go stale the day a reader is added.
function harnessIds() {
  return adapters().map((row) => row.id);
}

/** Scan whichever rule files exist, named or globbed. A missing file is not a
 *  finding. Generated regions are skipped: quoting a ruling is not a conflict with
 *  it, and the region is rewritten by `sync` anyway. */
/** Every line is a decision with a reason. Nothing is silent. */
function render(payload, manifest, { npm = true, manager = null, version } = {}) {
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
    // The two side writes of the same action, each with its own line: a dry run that
    // says `created git.config` and stops is a plan missing two of its three writes
    //. The include line mirrors the apply note byte for byte, so
    // preview and run cannot tell the reader two different stories.
    if (id.gitignore !== null) {
      lines.push(
        `  ${id.gitignore.padEnd(9)} .gitignore  ${IDENTITY_FILE} is per-developer, and committing it publishes one identity to everyone`,
      );
    }
    if (id.include === false) {
      lines.push(`  set        ${INCLUDE_KEY} = ../${IDENTITY_FILE}  this repository's own identity file`);
    }
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
          : target.kind === 'lock'
            ? 'the two digests a frozen check compares (ADR-086)'
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

  // ADR-111. The agent files, one per harness that documents an agents directory.
  // Printed as their own kind: the file is owned whole by the tool, so the action is
  // created, unchanged or updated and there is no byte delta to show.
  for (const a of payload.agents ?? []) {
    lines.push(`  ${a.action.padEnd(9)} ${a.path}  agent (ADR-111)`);
  }

  // The agent-hooks entry, absorbed into the run so the adoption enforces its own
  // projection while the agent works. Printed with the same shape the standalone command
  // uses: one line per config the tool writes, the shim, and the readers it narrows past.
  // `--no-agents` suppresses the section and says so, because a line that appears after
  // the run without being in the plan is the same silent write as any other.
  if (payload.agentHooks === null && payload.agentScope === 'none') {
    // The remedy is the flag the reader did not pass, and the ids it accepts: "no harness
    // was given" without either sends them to the help page for a flag this line can name.
    lines.push(`  ${'skip'.padEnd(9)} agent files and agent-hooks  no --harness given, so no harness is selected`);
    lines.push(`            remedy: ${CLI} init --harness <id>, one of: ${harnessIds().join(', ')}`);
  } else if (payload.agentHooks === null) {
    lines.push(`  ${'skip'.padEnd(9)} agent-hooks  opted out with --no-agents; the agent files are skipped with it`);
  } else {
    for (const p of payload.agentHooks.plan) {
      lines.push(`  ${p.action.padEnd(9)} ${p.path}  agent-hooks${p.error ? `  (${p.error})` : ''}`);
    }
    const shim = payload.agentHooks.shim;
    lines.push(`  ${shim.action.padEnd(9)} ${shim.path}  agent-hooks shim`);
    for (const o of payload.agentHooks.notWritten ?? []) {
      if (o.state === 'skipped') {
        lines.push(`  ${'skip'.padEnd(9)} ${o.id}  ${o.note}`);
      }
    }
  }

  // The CI gate is listed as its own kind because it is the one plan entry whose
  // absence is a decision rather than a default. Skipped states its reason inline so
  // a reader can tell "this repo does not use GitHub Actions" from "this repo was
  // not offered the gate".
  if (payload.ci.action === 'create') {
    lines.push(`  ${'create'.padEnd(9)} ${payload.ci.file}  ${renderWorkflow({ own: payload.ci.own, npm, manager, version }).length} bytes`);
    lines.push(
      payload.ci.own
        ? `            this repository is simt-dev's own; node scripts/ci.mjs --yes refreshes this copy when the gate changes`
        : `            runs ${CLI} check where a pull request is merged; yours to edit after this`,
    );
    // the workflow installs simt-dev as a devDependency, so the plan states
    // the install the reader must run — `<pm> add -D`, never a bare npm guess.
    if (!payload.ci.own && manager) {
      const addDev = { npm: `npm i -D ${PACKAGE_NAME}`, pnpm: `pnpm add -D ${PACKAGE_NAME}`, yarn: `yarn add -D ${PACKAGE_NAME}`, bun: `bun add -d ${PACKAGE_NAME}` }[manager];
      if (addDev) lines.push(`  ${'needs'.padEnd(9)} ${addDev}   (CI installs the pinned devDependency before it can run ${CLI} check)`);
    }
  } else if (payload.ci.action === 'refresh') {
    // init does not write it. `node scripts/ci.mjs` owns the template's own copy, and
    // a second writer would be a second answer to who owns it.
    lines.push(`  ${'refresh'.padEnd(9)} ${payload.ci.file}  ${payload.ci.reason}`);
    lines.push(`            remedy: node scripts/ci.mjs --yes   (init does not write simt-dev's own copy)`);
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
    lines.push(`  ${'create'.padEnd(9)} ${db.file}  ${renderDependabot(db.facts, { stack: db.stack, own: db.own, root: db.root }).length} bytes`);
    lines.push(
      db.own
        ? `            watches ${db.ecosystems.join(', ')}; node scripts/ci.mjs --yes refreshes this copy when the template changes`
        : `            watches ${db.ecosystems.join(', ') || 'github actions'} - one per manifest this repo has; yours to edit after this`,
    );
  } else if (db && db.action === 'refresh') {
    lines.push(`  ${'refresh'.padEnd(9)} ${db.file}  ${db.reason}`);
    lines.push(`            remedy: node scripts/ci.mjs --yes   (init does not write simt-dev's own copy)`);
  } else if (db && db.action === 'skip') {
    lines.push(`  ${'skip'.padEnd(9)} ${db.file}  ${db.reason}`);
    lines.push(`            create ${WORKFLOWS_DIR}/ first if this repo is on GitHub Actions, then rerun init`);
  }

  // One state, and it is the point: init no longer creates the file,
  // so the plan line says what it will not write and why, instead of a floor appearing
  // after the run without being in the plan. An existing base file is repo-owned and
  // left exactly as it is, which needs no line because nothing changes.
  const tb = payload.tsconfigBase;
  if (tb && tb.action === 'skip') {
    lines.push(`  ${'skip'.padEnd(9)} ${tb.file}  ${tb.reason}`);
  }

  // The index is local state, not a repository file: gitignored and rebuildable, so the
  // plan line describes what apply does rather than a file written into the tree.
  lines.push(
    `  ${'build'.padEnd(9)} ${payload.index.file}  gitignored cache of the git index; built on apply, refreshed on read by ${CLI} map, brief and slice (ADR-089)`,
  );

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

export { render };
