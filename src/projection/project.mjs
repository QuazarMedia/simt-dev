// Decide what a repo's generated region should contain.
//
// Two jobs, deliberately separate from writing (markers.mjs) and from the gate
// (commands/check):
//   1. plan(root) -> { targets: [{file, action, body, ...}], stack, rules }
//   2. Nothing here touches the filesystem. A plan is pure, so it can be
//      inspected, diffed and asserted on without a scratch directory.
//
// The core rule set is always included. Stack profiles are selected by
// intersection with the repo's fingerprint - platform tags *and* emitted facts,
// which are interchangeable in a profile (ADR-013) - plus one fallback profile
// so a JS/TS repo is never left with core rules and nothing else.
//
// Profiles may live in the repo, not only here. `.simt/profiles/*.md` uses
// the same frontmatter contract as `rules/stacks/*.md` and is selected by the
// same matcher, so supporting an ecosystem nobody here has heard of requires no
// code change and no release.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { baselineTargets, misplaced } from './baselines.mjs';
import { planWorkflow } from '../ci/workflow.mjs';
import { planDependabot } from '../ci/dependabot.mjs';
import { checkTsconfig } from '../tsconfig.mjs';
import { checkToolchain } from '../toolchain.mjs';
import { diff, parse, inject, BEGIN, END } from './markers.mjs';
import { budgetFinding, readManifest } from './manifest.mjs';
import { budgetCutFinding } from '../kernel/budget.mjs';
import { measureRoot } from '../measure/context.mjs';
import { loadMdcRules, renderMdc } from './mdc.mjs';
import { foldsRules, resolveSurfaces, SURFACES, SURFACE_IDS } from './surfaces.mjs';
import { pointerState, pointerTargets, ruleTargets, scopedTargets } from './targets.mjs';
import { CLI } from '../name.mjs';
import { MANIFEST_FILE } from '../name.mjs';
import {
  desiredRegion,
  provenanceDigest,
  isEligible,
  loadRules,
  packageRegions,
  LOCAL_PROFILE_DIR,
  mdcTargets,
  readDeclared,
  ruleValues,
  render,
  ROOT,
  select,
  SUBSTITUTIONS_KEY,
} from './rules.mjs';

/** The one file every repo gets. Chosen deliberately: AGENTS.md is read by the
 *  most agents, including ones that ignore .cursor/ entirely. */
export const PRIMARY_TARGET = 'AGENTS.md';


/**
 * @param {string} root repo root
 * @returns {Promise<{root:string, stack:string[], facts:string[], profiles:string[],
 *                    rules:object[], targets:object[], notes:string[]}>}
 */
export async function plan(root, flags = {}) {
  const desired = await desiredRegion(root, flags);
  const { stack, facts, profiles, fallback, notes, body, meta, all, manifest } = desired;
  const target = await targetFor(root, body, meta);

  // Per-rule content projects to every editor the repo selected, not only Cursor. The
  // body is identical on each; only the frontmatter the editor reads before any rule
  // text differs. `rule.file` names the canonical source, not a destination — the
  // destination belongs to the surface.
  const mdc = await mdcTargets(root, meta.sha, manifest, flags);

  const surfaces = resolveSurfaces(manifest, flags);

  // Profiles that narrowed out of the region, written as files for the surfaces whose
  // scoping key was read in the vendor's own documentation. Only when EVERY selected
  // surface can scope: a profile that left the region while a reader could not narrow
  // would be a rule that reader never loads, and `desiredRegion` already kept it in the
  // region in that case, which is why `narrowing` is the gate here too.
  const scoped =
    desired.narrowing === true
      ? await scopedTargets(root, desired.scoped ?? [], meta.sha, surfaces, notes)
      : { targets: [] };

  // The baselines are the same list shape as every other target, so `sync` writes
  // them and reports them in the same plan it prints for AGENTS.md and the rule
  // files. A file the reader was not shown is a file they approve by reading the diff
  // afterwards, which is the one review step this tool exists to make unnecessary.
  const baselines = await baselineTargets(root, meta.sha);

  // A monorepo projects once per package as well as once at the root. The nested
  // regions come after the root's and before the rule files, because the root is
  // what a reader meets first and a plan that listed a package's region before the
  // root's would read as though the packages were the repository.
  const packages = await packageRegions(root, flags, profiles);
  const nested = await Promise.all(
    packages.regions.map((r) => targetFor(join(root, r.path), r.body, r.meta, `${r.path}/${PRIMARY_TARGET}`)),
  );

  return {
    root,
    stack,
    facts,
    profiles,
    fallback,
    surfaces: surfaces.ids,
    surfaceSource: surfaces.source,
    surfaceProblems: surfaces.problems,
    rules: all,
    targets: [target, ...nested, ...mdc.targets, ...scoped.targets, ...baselines.targets],
    packages: packages.regions.map((r) => ({ path: r.path, profiles: r.profiles })),
    mdcProblems: mdc.problems,
    notes: [...notes, ...mdc.notes, ...packages.notes],
  };
}

async function targetFor(root, body, meta, label = PRIMARY_TARGET) {
  const path = join(root, PRIMARY_TARGET);
  let existing = '';
  let exists = true;
  try {
    existing = await readFile(path, 'utf8');
  } catch {
    exists = false;
  }

  const result = inject(existing, body, meta, await regionOpts(root));
  return {
    // The repo-relative path, and not the basename: a monorepo writes the same
    // document once per package, and a plan that printed `AGENTS.md` twice with no
    // directory on either line would leave the reader unable to tell which is which.
    file: label,
    path,
    exists,
    action: result.action,
    // The state the file was in, rather than the action taken on it. `upgrade` needs to
    // know whether this repository ever had a region (ADR-049's sibling defect, filed as
    // S26) and whether the change it is about to make is a change to the *rules* or only
    // to the seam around them, and neither is readable off `action` or `previousBytes`.
    region: result.region,
    previousBody: result.previousBody,
    reason: result.reason,
    line: result.line,
    bytes: Buffer.byteLength(result.text),
    previousBytes: Buffer.byteLength(existing),
    sha: meta.sha,
    body,
    text: result.text,
    previous: existing,
  };
}

/** Check one repo without writing. Returns findings rather than an exit code,
 *  so commands/check decides severity and commands/sync decides whether to act. */
export async function checkTargets(root, flags = {}) {
  const findings = [];
  const primary = await checkPrimary(root, flags);
  findings.push(primary);
  if (primary.status !== 'absent' && primary.status !== 'unreadable' && primary.status !== 'malformed') {
    let text = '';
    try {
      text = await readFile(join(root, PRIMARY_TARGET), 'utf8');
    } catch {
      text = '';
    }
    findings.push(...readLimitFindings(text, PRIMARY_TARGET));
  }

  // Every package of a monorepo is a projection root in its own right, so the gate
  // covers it the way it covers the root. A nested region that drifts is as stale as
  // the root's region, and the reader working in that package reads only that file.
  //
  // Gated on the root having a region at all: a monorepo that has not adopted has no
  // nested regions either, and reporting one as absent would describe a half-adoption
  // that nobody performed.
  const { regions: packageBodies } = await packageRegions(root, flags);
  for (const region of packageBodies) {
    const file = `${region.path}/${PRIMARY_TARGET}`;
    findings.push({ ...(await checkRegion(root, join(root, region.path), region.body, region.meta)), file, profiles: region.profiles });
  }

  // The gate has to run where the merge happens, not only on the machine of whoever
  // remembers to run it. A repo that already runs GitHub Actions and has no simt-dev
  // job is ungated at its front door, and that is the one finding here that no amount
  // of reading the local rules would surface.
  // Two `.github` files, one ownership rule, so one loop over both. The gate and the
  // dependency-updates config fail for the same reason and are fixed the same way,
  // and listing them separately is how the second copy of this rule gets written.
  for (const [plan, what] of [
    [await planWorkflow(root), 'nothing gates it'],
    [await planDependabot(root), 'nothing watches its dependencies'],
  ]) {
    if (plan.action === 'create') {
      findings.push({
        file: plan.file,
        status: 'absent',
        detail: `this repo runs GitHub Actions but ${what}`,
        remedy: `${CLI} init --yes`,
      });
    } else if (plan.action === 'refresh') {
      // Only reachable in simt-dev's own repository, and only because these plans
      // compare content there and nowhere else. A copy of the template that is
      // allowed to drift stops being the template, so the drift is reported here
      // rather than left for whoever next changes the template to notice by reading
      // a diff.
      findings.push({
        file: plan.file,
        status: 'drift',
        detail: plan.reason,
        remedy: `${CLI} ci --yes`,
      });
    }
  }

  // TypeScript is the one baseline whose content a base file cannot enforce, because
  // `extends` lets a child override every key it sets. So absence is reported from the
  // plan like the `.github` files, and the two things a base file structurally cannot
  // fix come from `checkTsconfig` with their own remedies.
  findings.push(...(await checkTsconfig(root)));

  // What the repository pins, read and never written: the version floor, the package
  // manager and the `.nvmrc` are the repository's decisions, so every finding here names
  // the command that records one rather than a value this tool would have had to invent.
  findings.push(...(await checkToolchain(root)));

  // A rule with a defect is a gate failure even when its files happen to be
  // correct, because the next `sync` will not reproduce it.
  // Selection must match `plan` exactly, or the gate reports a rule absent that
  // `sync` was never going to write — a permanently red check nothing can fix.
  const all = await loadMdcRules();
  const desired = await desiredRegion(root, flags);
  const { stack, facts, manifest } = desired;

  // The budget, both halves of it, and in that order: what this repository agreed to
  // carry against what it carries, then what was cut to get there.
  //
  // The total comes from the meter rather than from a sum this file could do itself,
  // because a gate and a meter that each counted their own set would report two different
  // numbers for one repository and the reader would have no way to tell which was the
  // budget (ADR-072). The cut comes from the projection itself for the same reason — the
  // packer wrote it, so the packer's own record of it is the one that cannot disagree with
  // what `sync` would write.
  //
  // Both are non-blocking, for the reason ADR-072 gave for the first and ADR-083 for the
  // second: the remedy is a decision about the number, not a missing file.
  const budgetTotal = await alwaysOnBytes(root);
  if (budgetTotal !== null) {
    const over = budgetFinding(budgetTotal.bytes, manifest?.budget, manifest?.mode);
    if (over) findings.push({ ...over, file: MANIFEST_FILE, detail: over.detail });
  }
  const packed = desired.budget;
  if (packed !== null && packed.cuts.length > 0) {
    findings.push(budgetCutFinding({ file: PRIMARY_TARGET, ...packed }));
  }

  const declared = await readDeclared(root);
  const resolved = resolveSurfaces(manifest, flags);
  for (const p of resolved.problems) {
    findings.push({ file: `${MANIFEST_FILE}`, status: 'invalid', detail: p, remedy: `known surfaces: ${SURFACE_IDS.join(', ')}` });
  }
  const rules = all.filter((r) => isEligible(r, new Set([...stack, ...facts]), declared.optIn));

  const sha = await provenanceDigest();
  const notes = [];

  // The profiles that left the region, gated through the same construction that wrote
  // them. Without this loop a scoped file is planned and written but never checked, so a
  // repository that edits or deletes one shows a clean `check` and a stale reader — the
  // exact asymmetry the region-versus-file gate exists to prevent.
  const scopedRules = desired.scoped ?? [];
  if (desired.narrowing === true) {
    for (const target of (await scopedTargets(root, scopedRules, sha, resolved, notes)).targets) {
      if (!target.exists) {
        findings.push({
          file: target.file,
          surface: target.surface,
          status: 'absent',
          detail: `no ${target.surface} rule here; run: ${CLI} sync --yes`,
        });
        continue;
      }
      // The writer's own verdict, from the same inject call `plan` will make. A second
      // construction here would be a third place computing the same file, which is the
      // defect this whole function exists to avoid.
      const action = target.action;
      findings.push({
        file: target.file,
        surface: target.surface,
        status: action === 'unchanged' ? 'current' : 'drift',
        detail: action === 'unchanged' ? undefined : `region is ${action}; run: ${CLI} sync --yes`,
        recordedSha: parse(target.previous).sha ?? null,
      });
    }
  }

  for (const rule of rules) {
    if (rule.error !== null) {
      findings.push({
        file: rule.id ?? rule.file,
        status: 'invalid',
        detail: rule.error,
      });
      continue;
    }
    // The writer's own construction, not a second one: a body rendered without the
    // surface-agreed substitutions would make `check` report drift on a tree that
    // `init` just wrote (S45's askTool).
    const { body, problems } = renderMdc(
      rule,
      ruleValues(rule, declared.values[rule.id] ?? {}, resolved.surfaces),
    );
    if (problems.length > 0) {
      findings.push({
        file: rule.target,
        status: 'invalid',
        detail: problems[0],
      });
      continue;
    }

    for (const target of (await ruleTargets(root, rule, body, sha, resolved, notes)).targets) {
      const rel = target.file;
      if (!target.exists) {
        findings.push({
          file: rel,
          surface: target.surface,
          status: 'absent',
          detail: `no ${target.surface} rule here; run: ${CLI} sync --yes`,
        });
        continue;
      }
      const state = parse(target.previous);
      if (state.status === 'malformed') {
        findings.push({
          file: rel,
          surface: target.surface,
          status: 'malformed',
          detail: state.reason,
          line: state.line,
        });
        continue;
      }
      if (state.status === 'absent') {
        findings.push({
          file: rel,
          surface: target.surface,
          status: 'unmanaged',
          detail: `no generated region; run: ${CLI} sync --yes`,
        });
        continue;
      }
      // `target.action` is `ruleTargets`' own verdict, produced by the same inject
      // call `plan` will make. This used to reconstruct a reference here — existing
      // frontmatter plus a fresh inject — which was a THIRD construction of the same
      // file inside the one function whose entire job is to say whether the other two
      // agree. It happened to agree, which is what makes this duplication dangerous:
      // it is only detectable by the disagreement some future edit produces.
      const action = target.action;
      findings.push({
        file: rel,
        surface: target.surface,
        status: action === 'unchanged' ? 'current' : 'drift',
        detail: action === 'unchanged' ? undefined : `region is ${action}; run: ${CLI} sync --yes`,
        recordedSha: state.sha ?? null,
      });
    }
  }

  // Baselines are checked against the same construction `sync` writes from, and they
  // block for the same reason the rule files block: an adopting repo whose baseline was
  // deleted or reverted is a repo whose editors have quietly stopped agreeing.
  for (const t of (await baselineTargets(root, await provenanceDigest())).targets) {
    if (t.action === 'malformed') {
      findings.push({ file: t.file, status: 'malformed', detail: t.reason, line: t.line });
      continue;
    }
    if (!t.exists) {
      findings.push({
        file: t.file,
        status: 'absent',
        detail: `no baseline file; run: ${CLI} sync --yes`,
        remedy: `${CLI} sync --yes`,
      });
      continue;
    }
    const state = parse(t.previous, t.style);
    if (state.status === 'absent') {
      findings.push({
        file: t.file,
        status: 'unmanaged',
        detail: `the file exists with no simt-dev region; run: ${CLI} sync --yes`,
        remedy: `${CLI} sync --yes`,
      });
      continue;
    }
    findings.push({
      file: t.file,
      status: t.action === 'unchanged' ? 'current' : 'drift',
      detail: t.action === 'unchanged' ? undefined : `region is ${t.action}; run: ${CLI} sync --yes`,
      recordedSha: state.sha ?? null,
    });
    const off = misplaced(state, t.style);
    if (off) findings.push({ file: t.file, status: 'misplaced', ...off });
  }

  // Managed rule files this run would NOT write, found by scanning the rule
  // directories rather than by planning them. Without this, narrowing a surface's
  // output makes the files it already wrote invisible: measured on the estate, 17
  // files across five repos that carry a simt-dev region and were counted as stale
  // the moment the skip landed. A tool that stops looking at a file it generated has
  // not cleaned up - it has lost track of it.
  //
  // Reported as `orphaned`, never `drift`. ADR-021 ruling 6: `sync` does not delete a
  // file it once generated, so there is nothing for the reader to repair and a
  // `run: simt sync --yes` remedy would be a lie. Removal is a human decision.
  findings.push(...(await orphanedRuleFiles(root, resolved)));

  // Pointers are checked last, and whether one blocks depends on who reads it.
  //
  // The rule as it stood was "never block", and it was right for the case it was written
  // for: a repository on `opencode` that happens to have a `CLAUDE.md` nobody asked for
  // gains nothing from being told about it, and a red gate on every commit trains people
  // to ignore gates. But the pointer is not decoration for the reader it serves —
  // `POINTERS[0]` cites Claude Code's own documentation for the behaviour that makes it
  // load-bearing: **"Claude reads CLAUDE.md by default and AGENTS.md only as a
  // fallback."** So on a repo that selected the `claude` surface, a `CLAUDE.md` aimed
  // anywhere else means Claude Code reads that somewhere else. Measured: the pointer
  // moved to `README.md`, `check` exited 0, `compare` reported no problems, and thirteen
  // rule citations went unread by the reader they were written for.
  //
  // Blocking is therefore scoped to a pointer whose surface this repo selected. An
  // unselected one stays a note, because the reader it serves is not reading this repo.
  for (const pointer of pointerTargets(root, resolved.surfaces)) {
    const st = await pointerState(root, pointer);
    if (st.state === 'foreign') {
      findings.push({
        file: st.file,
        surface: st.surface,
        status: 'pointer-blocked',
        // A file reports its bytes because that is what the refusal would have
        // destroyed; a directory reports what is inside it, which is the same question
        // asked of the only thing a reader would lose. Neither is replaced — this tool
        // does not delete what a person wrote — so both name the same remedy.
        detail:
          st.entries === undefined
            ? `${st.detail} (${st.bytes} bytes); simt-dev will not replace it`
            : `${st.detail} (${st.entries} ${st.entries === 1 ? 'entry' : 'entries'}); simt-dev will not replace it`,
        remedy: `move it aside, or delete the ${st.entries === undefined ? 'file' : 'directory'} and re-run: ${CLI} sync --yes`,
      });
    } else if (st.state === 'mispointed') {
      // Whether this blocks is the reader's business, not the file's. `pointer-drift` is
      // non-blocking because a reader who does not use this pointer gains nothing from a
      // red gate; a reader who does gains a repository where its rules are one file away
      // from being invisible, and `check` reporting nothing is what made that invisible.
      //
      // Every pointer reaching this loop belongs to a selected surface —
      // `pointerTargets` filters on it — so the status is chosen from whether the
      // pointer's own reader is one this repository serves, which `pointerTargets` has
      // already answered by including it.
      findings.push({
        file: st.file,
        surface: st.surface,
        status: 'pointer-unread',
        detail: `${st.detail}; should point at ${pointer.to}`,
        remedy: `run: ${CLI} sync --yes (${pointer.readers} reads ${pointer.file}, not ${pointer.to})`,
      });
    }
  }

  return findings;
}

/**
 * Rule files carrying a simt-dev region that this run would not write.
 *
 * "Would not write" rather than "is not wanted": a repo that never adopted these
 * surfaces has its own hand-written `.mdc` files, and those carry no region, so they
 * are not ours to report. Only a file simt-dev generated qualifies.
 */
async function orphanedRuleFiles(root, resolved) {
  const out = [];
  if (!foldsRules(resolved)) return out;
  const seen = new Set();
  // Every surface that reads the primary, whether or not it is selected now.
  // A file becomes orphaned precisely when the repo stops asking for the surface
  // that used to write it, so restricting this to the SELECTED set finds nothing:
  // the one repo that needs the note is the one that dropped the surface. Measured,
  // that was every surface in the estate after the change.
  for (const s of SURFACES.filter((x) => x.readsPrimary === true && x.rule)) {
    const dir = s.rule.slice(0, s.rule.lastIndexOf('/'));
    if (seen.has(dir)) continue;
    seen.add(dir);
    let entries;
    try {
      entries = await readdir(join(root, dir));
    } catch {
      continue;
    }
    for (const name of entries.sort()) {
      const rel = `${dir}/${name}`;
      let text;
      try {
        text = await readFile(join(root, rel), 'utf8');
      } catch {
        continue;
      }
      // Only a file this tool wrote. `parse` reports `absent` for anything without the
      // marker, which is precisely the hand-written case that must stay untouched.
      if (parse(text).status === 'absent') continue;
      out.push({
        file: rel,
        surface: s.id,
        status: 'orphaned',
        detail: `${s.label} reads AGENTS.md, where this rule is already folded; this file repeats it`,
        remedy: `delete ${rel}; simt-dev will not remove a file it wrote`,
      });
    }
  }
  return out;
}

export async function checkTarget(root, flags = {}) {
  const findings = await checkPrimary(root, flags);
  return findings;
}

async function checkPrimary(root, flags = {}) {
  const { body, meta } = await desiredRegion(root, flags);
  return checkRegion(root, root, body, meta);
}

/**
 * One region, compared against what this simt-dev would write for it.
 *
 * `dir` is the projection root that owns the document: the repository for the root
 * region, a package for a nested one. `regionOpts` is read from the repository
 * either way, because placement is a repository-level decision.
 */
async function checkRegion(root, dir, body, meta) {
  const path = join(dir, PRIMARY_TARGET);
  let existing = '';
  try {
    existing = await readFile(path, 'utf8');
  } catch (e) {
    // Only ENOENT is absence. A bare `catch` here once reported "no AGENTS.md" for a
    // repo that has one, because the failure was a ReferenceError from a missing
    // import — the gate answered confidently about a file it had never read. A check
    // that is wrong about existence is worse than one that crashes.
    if (e.code !== 'ENOENT') {
      return { file: PRIMARY_TARGET, status: 'unreadable', detail: e.code ?? String(e) };
    }
    return { file: PRIMARY_TARGET, status: 'absent', detail: `no AGENTS.md; run: ${CLI} sync --yes` };
  }
  const state = parse(existing);
  if (state.status === 'malformed') {
    return {
      file: PRIMARY_TARGET,
      status: 'malformed',
      detail: state.reason,
      line: state.line,
    };
  }
  if (state.status === 'absent') {
    return { file: PRIMARY_TARGET, status: 'unmanaged', detail: `no generated region; run: ${CLI} sync --yes` };
  }
  const d = diff(existing, body, meta, await regionOpts(root));
  return {
    file: PRIMARY_TARGET,
    status: d.action === 'unchanged' ? 'current' : 'drift',
    detail: d.action === 'unchanged' ? undefined : `region is ${d.action}; run: ${CLI} sync --yes`,
    recordedSha: state.sha ?? null,
    expectedSha: meta.sha,
  };
}
/**
 * The bytes of always-on projection this repository carries, or null if it has not
 * adopted at all.
 *
 * Delegates to the meter rather than counting here, and that is the whole of the
 * design. A first version summed the region plus the rule files this function already
 * compares, which sounds cheaper and is wrong: the meter also counts the managed skills
 * and the `.mdc` files a reader loads, so the gate and the report came to different
 * totals for one repository. Two definitions of one budget is the defect ADR-034 was
 * filed about, rebuilt one layer up. The meter is the definition; the gate quotes it.
 *
 * The cost is that `check` now reads the documents the meter reads, which it did not
 * do before. That is a real cost, paid knowingly: the alternative is a gate that fails
 * on a number the report does not print, which is worse than a slower gate.
 */
async function alwaysOnBytes(root) {
  const { exists } = await readManifest(root);
  if (!exists) return null;
  const measured = await measureRoot(root);
  return { bytes: measured.generatedBytes };
}

/** `projection.place: "top"` puts the AGENTS.md region above the hand-written prefix. */
async function regionOpts(root) {
  const { manifest } = await readManifest(root);
  return manifest?.projection?.place === 'top' ? { where: 'top' } : {};
}

/**
 * A reader that stops at a byte offset never sees a region that ends past it.
 * The finding names the reader, because "the file is long" does not say who stops.
 */
// Exported for the context meter (`simt tokens`), which answers the same question
// about a region rather than about a diff. It reads the structured fields instead of
// re-deriving the limit, because a second implementation of "which reader stops, and
// where" is a second thing to keep right - and a second thing to quote in a message.
export function readLimitFindings(text, file) {
  const state = parse(text);
  if (state.status !== 'ok' || typeof state.endByte !== 'number') return [];
  const findings = [];
  for (const surface of SURFACES) {
    if (surface.primary !== file) continue;
    for (const limit of surface.readLimits ?? []) {
      if (state.endByte <= limit.bytes) continue;
      findings.push({
        file,
        status: 'beyond-read-limit',
        // The numbers, not only the sentence. `check` prints the detail and the context
        // meter puts the reader, the limit and the offset in its JSON, and a consumer
        // that has to regex prose to get them is a consumer that breaks when the prose
        // is edited.
        reader: limit.reader,
        limitBytes: limit.bytes,
        endByte: state.endByte,
        overBy: state.endByte - limit.bytes,
        detail: `BEYOND-READ-LIMIT: the region ends at byte ${state.endByte}, past ${limit.reader}'s ${limit.bytes}-byte read of ${file}`,
        remedy: `set projection.place to "top" in ${MANIFEST_FILE} and run: ${CLI} sync --yes, or raise ${limit.reader}'s project_doc_max_bytes`,
      });
    }
  }
  return findings;
}

export { BEGIN, END };
// Re-exported so callers import the projection surface from one place; the pointer
// helpers now live in targets.mjs and two commands already reach for them here.
export { pointerTargets, pointerState };
export { provenanceDigest, LOCAL_PROFILE_DIR, loadRules, render, select, SUBSTITUTIONS_KEY };