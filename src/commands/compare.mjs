// simt compare - the org-wide matrix.
//
// This command exists because the 2026-10-05 audit had to be reconstructed by
// hand, from 16 repositories, into 40 KB of prose. Everything it found is a fact
// this command computes: which repos are adopted, which have drifted, which route
// hooks, which declare gates the dispatcher cannot run.
//
// Two decisions make it useful rather than decorative:
//
//   1. It is a READ of the workspace, never a write. No `sync`, no `upgrade`, no
//      tag. A dashboard that can change state is not a dashboard; an agent running
//      `compare` to orient itself must not be able to mutate 16 repositories.
//   2. The exit code is a SIGNAL, not a score. It fails when something is wrong
//      (drift, malformed region, a gate that cannot run), and succeeds when repos
//      are merely not adopted yet - an unadopted repo is the expected mid-migration
//      state, not a defect, and a command that went red for it would train people
//      to ignore it.
//
// Output is one fact per line in fixed field order (plan 0002 section 6): a
// human can read the table, an agent can grep it, and two runs diff cleanly.

import { basename, resolve } from 'node:path';

import { EXIT, emit, emitJson, fail, isJson, note } from '../output/index.mjs';
import { headSha } from '../projection/project.mjs';
import { GATES } from '../hooks/gates.mjs';
import { buildRow, summarise } from '../compare/row.mjs';
import { discover } from '../compare/discover.mjs';

/** Gate kinds, so a row can tell a command gate with no command from a script gate. */
const GATE_KINDS = new Map(Object.entries(GATES).map(([name, g]) => [name, g.kind]));

export async function compareCommand(positional, flags) {
  // The workspace is the PARENT of simt-dev by default, not simt-dev itself: the
  // siblings are the consumers. `--root` overrides it, and a user who names a repo
  // gets that repo's siblings compared, which is the intuitive reading.
  const root = resolve(flags.root ?? positional[0] ?? '..');
  const found = await discover(root);
  if (found.error) {
    return fail(`${root}: ${found.error}`, EXIT.CONFIG, 'pass --root <workspace>');
  }
  if (found.repos.length === 0) {
    return fail(
      `${root} contains no git repositories`,
      EXIT.CONFIG,
      'point --root at the directory holding the repos',
    );
  }

  const expectedSha = await headSha();
  const context = { expectedSha, gates: new Set(Object.keys(GATES)), gateKinds: GATE_KINDS };

  // Sequential on purpose. 16 fingerprint+region computations each spawn a git
  // process; running them concurrently produces a burst of subprocesses and no
  // measurable speedup, because the work is process-spawn bound rather than CPU
  // bound. Determinism of the output matters more than wall clock on a dashboard.
  const rows = [];
  for (const repo of found.repos) rows.push(await buildRow(repo, context));

  const summary = summarise(rows, {
    workspace: root,
    expectedSha,
    worktrees: found.worktrees.length,
    directories: found.directories.length,
  });

  if (isJson(flags)) {
    emitJson({
      ok: !rows.some((r) => r.problems.length > 0),
      command: 'compare',
      summary,
      rows,
      worktrees: found.worktrees.map((w) => ({
        name: w.name,
        path: w.path,
        owner: w.ownerName,
        ownerMatchesDirName: w.ownerMatches,
      })),
      directories: found.directories.map((d) => basename(d)),
    });
    return rows.some((r) => r.problems.length > 0) ? EXIT.FAIL : EXIT.OK;
  }

  emit(render(rows, summary, found), { maxBytes: flags.maxBytes ?? 0 });
  for (const w of found.worktrees) {
    // A worktree is reported, not compared. Its files are the parent repo's HEAD
    // checked out elsewhere, so its projection state is the parent's - reporting
    // it as an independent consumer would double-count one repo's drift.
    note(`note     ${w.name} is a worktree of ${w.ownerName ?? '(unknown)'}, not compared separately`);
    if (!w.ownerMatches) {
      note(`note     ${w.name}: git slug does not match its directory name; owner inferred from the gitdir path`);
    }
  }
  if (found.directories.length > 0) {
    note(
      `note     ${found.directories.length} non-repo director${found.directories.length === 1 ? 'y' : 'ies'}: ${found.directories.map((d) => basename(d)).join(', ')}`,
    );
  }
  return rows.some((r) => r.problems.length > 0) ? EXIT.FAIL : EXIT.OK;
}

/**
 * Fixed field order, one repo per block. A single aligned table would be prettier
 * and worse: variable-length stacks and gate lists force padding that breaks on
 * the longest value, and an agent cannot tell which column is which without
 * counting spaces.
 */
function render(rows, summary, found) {
  const lines = [
    `workspace ${summary.workspace}`,
    `simt-dev  ${summary.expectedSha}`,
    `repos     ${summary.repos} (${summary.adopted} adopted, ${summary.unmanaged} unmanaged${summary.broken > 0 ? `, ${summary.broken} broken` : ''})`,
    `region    ${summary.current} current, ${summary.drifted} drifted, ${summary.noRegion} with no region, ${summary.malformed} malformed`,
    `hooks     ${summary.hooksRouted}/${summary.adopted} adopted repos route the shared dispatcher`,
    `problems  ${summary.withProblems} repo${summary.withProblems === 1 ? '' : 's'}`,
    `pinned    ${summary.shas.map(([sha, n]) => `${sha} x${n}`).join(', ')}`,
    '',
  ];

  for (const r of rows) {
    lines.push(`repo      ${r.name}`);
    lines.push(`          adoption ${r.adoption}${r.id && r.id !== r.name ? ` (id ${r.id})` : ''}`);
    lines.push(`          stack   ${r.stack.length > 0 ? r.stack.join(', ') : '(none)'}${r.declaredStack.length > 0 ? ` (manifest declares ${r.declaredStack.join(', ')})` : ''}`);
    if (r.facts.length > 0) lines.push(`          facts   ${r.facts.join(', ')}`);
    lines.push(`          region  ${r.region}${r.regionDetail ? ` (${r.regionDetail})` : ''}`);
    lines.push(`          sha     pinned ${r.pinnedSha ?? '(none)'} region ${r.recordedSha ?? '(none)'}`);
    lines.push(
      `          hooks   ${r.hooksRouted ? 'shared dispatcher' : r.adoption === 'adopted' ? 'NOT ROUTED' : '(n/a)'}${r.hooksRouted && !r.hooksComplete ? ' (incomplete)' : ''}`,
    );
    lines.push(
      `          gates   ${r.gatesDeclared.length > 0 ? r.gatesDeclared.join(', ') : r.adoption === 'adopted' ? '(none declared)' : '(n/a)'}`,
    );
    if (r.problems.length > 0) {
      lines.push('          PROBLEMS');
      for (const p of r.problems) lines.push(`            ${p}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export { discover };