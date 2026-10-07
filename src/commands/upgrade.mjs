// simt-dev upgrade - move every consumer to this simt-dev, as one reviewable set.
//
// Why this command exists, and why it is shaped the way it is:
//
// A simt-dev commit changes the RULES, not the mechanism. 16 repos project those rules
// into a generated region, and each carries a stamp of the simt-dev that produced it. So
// one commit makes every consumer behind at once, and the naive fix - "go run sync in
// each repo" - is 16 commands, 16 diffs, 16 reviews, and no way to see the set as a set.
// Plan 0001 named this exact risk ("simt-dev churn cascades into 16 repos") and answered
// it with `upgrade --all`: one operation, one reviewable diff.
//
// Four commitments:
//
//   1. It moves a PIN. It does not adopt a repo, repair a broken one, or add a region to
//      one that never had one. Those are `init` and `sync`, with different reviews. Every
//      such repo is a skip with its own remedy (src/upgrade/plan.mjs).
//   2. Dry-run unless `--yes`. It writes to N repositories; an agent that runs it to see
//      what would change must not change it.
//   3. It never commits and never pushes (ADR-001). One commit in the consumer's own repo
//      is the human's, with a message they chose.
//   4. A repo it could not upgrade is reported loudly and fails the run. A repo left
//      silently behind is the failure `compare` exists to surface, and this command must
//      not be the thing that creates it.

import { mkdir, writeFile } from 'node:fs/promises';

import { basename, dirname, resolve } from 'node:path';

import { EXIT, emit, emitJson, fail, isJson, note } from '../output/index.mjs';
import { provenanceDigest, plan } from '../projection/project.mjs';
import { MANIFEST, MANIFEST_COMMENT, readManifest, writeManifest } from '../projection/manifest.mjs';
import { FAULT_STATES, planUpgrade, summariseUpgrade } from '../upgrade/plan.mjs';
import { discover } from '../compare/discover.mjs';
import { resolveWorkspace, targetRoot, WORKSPACE_REMEDY } from '../workspace.mjs';

export async function upgradeCommand(positional, flags) {
  const explicit = flags.root ?? positional[0];

  // `--all` is a claim about SCOPE, so it is checked rather than inferred. "All" of
  // nothing is a contradiction, and defaulting it to the current directory would make
  // the flag mean nothing at all.
  if (flags.all === true && !explicit) {
    const ws = await resolveWorkspace(flags);
    if (!ws.root) {
      return fail(
        `--all needs a workspace and none is configured (${ws.detail})`,
        EXIT.CONFIG,
        WORKSPACE_REMEDY,
      );
    }
  }

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
      'point --root at the directory holding the repos, or at one repo to upgrade just it',
    );
  }

  const sha = await provenanceDigest();
  const plans = [];
  for (const repo of found.repos) {
    const { manifest, exists, error } = await readManifest(repo);
    const result = await plan(repo);
    plans.push(planUpgrade({ name: basename(repo), path: repo, manifest, manifestExists: exists, manifestError: error, targets: result.targets, sha }));
  }
  const summary = summariseUpgrade(plans);

  // Writes happen BEFORE the report, in every output mode. An earlier version emitted
  // the JSON payload and returned, which meant `--yes --json` reported a plan and
  // changed nothing - the exact combination a script uses for automation.
  // `written` in the payload is therefore a fact about the filesystem, not an echo of
  // the flags.
  const applied = [];
  const failed = [];
  // The exact files written, collected from the writes themselves. Reconstructing the
  // list afterwards from the plan would be a second source of truth for what happened.
  const writtenFiles = new Set();
  if (summary.updated > 0 && flags.yes === true) {
    for (const p of plans) {
      if (p.action !== 'updated') continue;
      try {
        // Region first, then the pin. The reverse order would leave a window in which the
        // manifest claims a simt-dev whose rules are not on disk yet - and `check` would
        // report CURRENT against a stamp that does not describe the bytes next to it.
        // Every planned target, not just AGENTS.md: a repo can have a current AGENTS.md
        // and three stale `.mdc` rules, and restamping only the first leaves `check` red
        // straight after a successful upgrade.
        const { targets } = await plan(p.path);
        for (const t of targets) {
          if (t.action === 'unchanged' || t.action === 'malformed') continue;
          await mkdir(dirname(t.path), { recursive: true });
          await writeFile(t.path, t.text);
          writtenFiles.add(t.file);
        }
        const { manifest } = await readManifest(p.path);
        // Preserve what the repo chose; refresh what simt-dev generates. $comment is
        // ours - it describes this file's provenance - so carrying the previous copy
        // forward left a stale, and in one version a false, description in place
        // forever, because `sync` does not own the manifest and nothing else rewrites
        // it. An adopted repo would never have corrected it.
        const { $comment, ...chosen } = manifest ?? {};
        await writeManifest(p.path, {
          ...MANIFEST_COMMENT,
          ...chosen,
          projection: { ...(manifest?.projection ?? {}), simtDevSha: sha },
        });
        applied.push(p.name);
      } catch (error) {
        // Reported per repo rather than thrown: one unwritable repo must not hide the
        // other fifteen, and the run must still fail so the partial set is not reviewed
        // as if it were complete.
        failed.push({ name: p.name, error: error.message });
      }
    }
  }

  const payload = {
    ok: summary.skipped === 0 && failed.length === 0,
    command: 'upgrade',
    root,
    shape: found.shape,
    source: target.source,
    sha,
    dryRun: flags.yes !== true,
    written: applied.length > 0,
    summary: { ...summary, applied, failed },
    plans,
  };

  if (isJson(flags)) {
    emitJson(payload);
    return exitFor(plans, failed);
  }

  emit(render(plans, summary, { root, shape: found.shape, source: target.source, sha, applied, failed }));

  for (const w of found.worktrees) {
    // The same reasoning as `compare`: a worktree is its parent's HEAD elsewhere, so
    // writing a pin into it would fork the owner's drift across two directories.
    note(`note     ${w.name} is a worktree of ${w.ownerName ?? '(unknown)'}, not upgraded separately`);
  }
  for (const f of failed) note(`FAILED   ${f.name}  ${f.error}`);

  if (applied.length > 0) {
    note(`wrote    ${applied.length} repo${applied.length === 1 ? '' : 's'}: ${applied.join(', ')}  (${[...writtenFiles].join(', ') || 'nothing'} + ${MANIFEST})`);
    note('next     review the diff, then commit in each repo; simt-dev never commits or pushes (ADR-001)');
  } else if (summary.updated > 0) {
    note(`dry-run  ${summary.updated} repo${summary.updated === 1 ? '' : 's'} would change; apply with: simt-dev upgrade --yes`);
  } else if (summary.skipped > 0) {
    note(`note     nothing to write; ${summary.skipped} repo${summary.skipped === 1 ? '' : 's'} skipped (see above)`);
  } else {
    note('note     every consumer already runs this simt-dev');
  }
  return exitFor(plans, failed);
}

/**
 * Exit non-zero for a repo that is BROKEN or mid-repair, not for one that never
 * adopted. An unadopted repo is the expected mid-migration state, and `compare` already
 * established that a command which goes red for it teaches people to ignore it.
 */
function exitFor(plans, failed = []) {
  if (failed.length > 0) return EXIT.FAIL;
  return plans.some((p) => p.action === 'skip' && FAULT_STATES.has(p.state)) ? EXIT.FAIL : EXIT.OK;
}

function render(plans, summary, ctx) {
  const lines = [
    `${ctx.shape === 'repo' ? 'repo      ' : 'workspace '} ${ctx.root}`,
    `shape     ${ctx.shape}${ctx.shape === 'workspace' ? ` (root from ${ctx.source})` : ''}`,
    `simt-dev  ${ctx.sha}`,
    `repos     ${summary.repos} (${summary.updated} to update, ${summary.unchanged} current, ${summary.skipped} skipped)`,
  ];
  if (summary.skippedStates.length > 0) {
    lines.push(`skipped   ${summary.skippedStates.join(', ')}`);
  }
  // Faults are counted separately from skips so "4 repos skipped, 0 of them broken" is
  // a readable sentence rather than a number the reader has to interpret.
  if (summary.faults > 0) lines.push(`faults    ${summary.faults} need repair before they can take a pin`);
  lines.push('');

  for (const p of plans) {
    lines.push(`repo      ${p.name}`);
    lines.push(`          state   ${p.state}`);
    lines.push(`          pin     ${p.pinnedSha ?? '(none)'}${p.pinnedSha === p.sha ? ' (unchanged)' : ` -> ${p.sha}`}`);
    lines.push(`          ${p.detail}`);
    if (p.remedy) lines.push(`          remedy  ${p.remedy}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
