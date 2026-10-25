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
import { provenanceDigest } from '../projection/project.mjs';
import { GATES } from '../hooks/gates.mjs';
import { buildRow, summarise } from '../compare/row.mjs';
import { discover } from '../compare/discover.mjs';
import { learnAcrossEstate, renderLearningLines } from '../compare/learn.mjs';
import { targetRoot, WORKSPACE_REMEDY } from '../workspace.mjs';

/** Gate kinds, so a row can tell a command gate with no command from a script gate. */
const GATE_KINDS = new Map(Object.entries(GATES).map(([name, g]) => [name, g.kind]));

export async function compareCommand(positional, flags) {
  // The estate root. `--root` is explicit and wins; otherwise it is the resolved
  // workspace, which may be none (ADR-014: a single repo is a first-class case, and
  // "no workspace" is a fact to report rather than a failure).
  //
  // A path that IS a repository is compared as itself, not scanned for children:
  // naming one repo almost certainly meant that repo. Discovery decides which,
  // rather than this command guessing.
  //
  // `targetRoot` owns the precedence so `compare` and `upgrade` cannot disagree about
  // which source named the directory.
  const target = await targetRoot(flags, positional);
  const root = resolve(target.root);
  const found = await discover(root);
  if (found.error) {
    return fail(`${root}: ${found.error}`, EXIT.CONFIG, 'pass --root <path>');
  }
  if (found.repos.length === 0) {
    return fail(
      `${root} contains no git repositories`,
      EXIT.CONFIG,
      `point --root at the directory holding the repos, or at one repo to see just it`,
    );
  }

  const expectedSha = await provenanceDigest();
  const context = { expectedSha, gates: new Set(Object.keys(GATES)), gateKinds: GATE_KINDS };

  // Sequential on purpose. 16 fingerprint+region computations each spawn a git
  // process; running them concurrently produces a burst of subprocesses and no
  // measurable speedup, because the work is process-spawn bound rather than CPU
  // bound. Determinism of the output matters more than wall clock on a dashboard.
  const rows = [];
  for (const repo of found.repos) rows.push(await buildRow(repo, context));
  const learning = await learnAcrossEstate(found.repos);

  const summary = summarise(rows, {
    root,
    shape: found.shape,
    source: target.source,
    expectedSha,
    worktrees: found.worktrees.length,
    directories: found.directories.length,
  });

  if (isJson(flags)) {
    emitJson({
      ok: !rows.some((r) => r.problems.length > 0),
      command: 'compare',
      root: summary.root,
      shape: summary.shape,
      source: summary.source,
      expectedSha: summary.expectedSha,
      // Spread, not a hand-listed copy. A copy is a second place to forget: a field
      // added to `summarise` renders in the text output and silently vanishes from
      // `--json`, which is the combination automation trusts most. That is not
      // hypothetical — `withOwnHooks` and `staleRuleFiles` both did it, and both
      // were caught only because a test asserts the two shapes agree.
      summary: {
        repos: summary.repos,
        adopted: summary.adopted,
        unmanaged: summary.unmanaged,
        broken: summary.broken,
        drifted: summary.drifted,
        current: summary.current,
        noRegion: summary.noRegion,
        malformed: summary.malformed,
        staleRuleFiles: summary.staleRuleFiles,
        packageRegions: summary.packageRegions,
        stalePackages: summary.stalePackages,
        hooksRouted: summary.hooksRouted,
        withProblems: summary.withProblems,
        withOwnHooks: summary.withOwnHooks,
        shas: summary.shas,
      },
      rows,
      learning,
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

  emit(render(rows, summary, found, learning), { maxBytes: flags.maxBytes ?? 0 });
  if (summary.shape === 'repo') {
    note('note     one repository compared; pass --root at a workspace directory to compare its siblings');
  } else if (target.source === 'none') {
    note(`note     no workspace configured, so this compared the current directory; ${WORKSPACE_REMEDY}`);
  }
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
function render(rows, summary, found, learning = null) {
  const lines = [
    // `workspace` and `repo` are the same field with different names, and the name is the
    // honest one: a reader who sees "workspace" and gets one repo was told a lie. `root`
    // plus `shape` is the one reading that is true in both cases (ADR-014).
    `${summary.shape === 'repo' ? 'repo     ' : 'workspace'} ${summary.root}`,
    `shape    ${summary.shape}${summary.shape === 'workspace' ? ` (root from ${summary.source})` : ''}`,
    `simt-dev  ${summary.expectedSha}`,
    `repos     ${summary.repos} (${summary.adopted} adopted, ${summary.unmanaged} unmanaged${summary.broken > 0 ? `, ${summary.broken} broken` : ''})`,
    `region    ${summary.current} current, ${summary.drifted} drifted, ${summary.noRegion} with no region, ${summary.malformed} malformed`,
    `rules     ${summary.staleRuleFiles === 0 ? 'every rule file current' : `${summary.staleRuleFiles} rule file${summary.staleRuleFiles === 1 ? '' : 's'} not current`}`,
    // One line, and only when there is a package region to report. A workspace of
    // single-repository members is the common case and must not grow a line that
    // always reads "none".
    ...(summary.packageRegions > 0
      ? [
          `packages  ${summary.stalePackages === 0 ? `every package region current (${summary.packageRegions})` : `${summary.stalePackages} of ${summary.packageRegions} package region${summary.packageRegions === 1 ? '' : 's'} not current`}`,
        ]
      : []),
    `hooks     ${summary.hooksRouted}/${summary.adopted} adopted repos route the shared dispatcher`,
    `          ${summary.withOwnHooks} repo${summary.withOwnHooks === 1 ? '' : 's'} run their own hooks; adopting replaces them (a note, not a problem)`,
    `problems  ${summary.withProblems} repo${summary.withProblems === 1 ? '' : 's'}`,
    `pinned    ${summary.shas.map(([sha, n]) => `${sha} x${n}`).join(', ')}`,
    '',
  ];

  for (const r of rows) {
    lines.push(`repo      ${r.name}`);
    lines.push(`          adoption ${r.adoption}${r.id && r.id !== r.name ? ` (id ${r.id})` : ''}`);
    lines.push(`          stack   ${r.stack.length > 0 ? r.stack.join(', ') : '(none)'}${r.declaredStack.length > 0 ? ` (manifest declares ${r.declaredStack.join(', ')})` : ''}`);
    if (r.facts.length > 0) lines.push(`          facts   ${r.facts.join(', ')}`);
    // Per package, and only for a repository that has packages: a single-repository
    // member must not print an empty list of packages on every line of every run.
    for (const p of r.packages) {
      lines.push(`          package ${p.path} ${p.status}${p.profiles.length > 0 ? ` (${p.profiles.join(', ')})` : ''}`);
    }
    lines.push(`          region  ${r.region}${r.regionDetail ? ` (${r.regionDetail})` : ''}`);
    // The rule files are the answer to "does every editor see the same rule?".
    lines.push(
      `          rules   ${r.ruleFiles.total === 0 ? '(none)' : `${r.ruleFiles.current}/${r.ruleFiles.total} current`}${r.ruleFiles.stale.length > 0 ? ` - ${r.ruleFiles.stale.join(', ')}` : ''}`,
    );
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
    if (r.notes.length > 0) {
      for (const n of r.notes) lines.push(`          note ${n}`);
    }
    lines.push('');
  }

  const learningLines = renderLearningLines(learning);
  if (learningLines.length > 0) {
    lines.push(...learningLines, '');
  }

  return lines.join('\n').trimEnd();
}

export { discover };