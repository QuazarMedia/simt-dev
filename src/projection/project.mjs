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
// Profiles may live in the repo, not only here. `.simt-dev/profiles/*.md` uses
// the same frontmatter contract as `rules/stacks/*.md` and is selected by the
// same matcher, so supporting an ecosystem nobody here has heard of requires no
// code change and no release.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { diff, parse, inject, BEGIN, END } from './markers.mjs';
import { loadMdcRules, renderMdc } from './mdc.mjs';
import { resolveSurfaces, SURFACE_IDS } from './surfaces.mjs';
import { pointerState, pointerTargets, ruleTargets } from './targets.mjs';
import {
  desiredRegion,
  headSha,
  isEligible,
  loadRules,
  LOCAL_PROFILE_DIR,
  mdcTargets,
  readDeclared,
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
    targets: [target, ...mdc.targets],
    mdcProblems: mdc.problems,
    notes: [...notes, ...mdc.notes],
  };
}

async function targetFor(root, body, meta) {
  const path = join(root, PRIMARY_TARGET);
  let existing = '';
  let exists = true;
  try {
    existing = await readFile(path, 'utf8');
  } catch {
    exists = false;
  }

  const result = inject(existing, body, meta);
  return {
    file: PRIMARY_TARGET,
    path,
    exists,
    action: result.action,
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

  // A rule with a defect is a gate failure even when its files happen to be
  // correct, because the next `sync` will not reproduce it.
  // Selection must match `plan` exactly, or the gate reports a rule absent that
  // `sync` was never going to write — a permanently red check nothing can fix.
  const all = await loadMdcRules();
  const { stack, facts, manifest } = await desiredRegion(root, flags);
  const declared = await readDeclared(root);
  const resolved = resolveSurfaces(manifest, flags);
  for (const p of resolved.problems) {
    findings.push({ file: 'simt-dev.json', status: 'invalid', detail: p, remedy: `known surfaces: ${SURFACE_IDS.join(', ')}` });
  }
  const rules = all.filter((r) => isEligible(r, new Set([...stack, ...facts]), declared.optIn));

  const sha = await headSha();
  const notes = [];

  for (const rule of rules) {
    if (rule.error !== null) {
      findings.push({
        file: `rules/mdc/${rule.file}`,
        status: 'invalid',
        detail: rule.error,
      });
      continue;
    }
    const { body, problems } = renderMdc(rule, declared.values[rule.id] ?? {});
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
          detail: `no ${target.surface} rule here; run: simt-dev sync`,
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
          detail: 'no generated region; run: simt-dev sync',
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
        detail: action === 'unchanged' ? undefined : `region is ${action}; run: simt-dev sync`,
        recordedSha: state.sha ?? null,
      });
    }
  }

  // Pointers are checked last and never block. A missing or misaimed `CLAUDE.md`
  // is a smaller problem than a red gate on every commit: the editors that matter
  // already read AGENTS.md, and the pointer is a convenience. Reporting it as a
  // finding would train people to ignore findings, which is the failure mode the
  // whole gate exists to prevent.
  for (const pointer of pointerTargets(root, resolved.surfaces)) {
    const st = await pointerState(root, pointer);
    if (st.state === 'foreign') {
      findings.push({
        file: st.file,
        surface: st.surface,
        status: 'pointer-blocked',
        detail: `${st.detail} (${st.bytes} bytes); simt-dev will not replace it`,
        remedy: 'move it aside, or delete the file and re-run: simt-dev sync',
      });
    } else if (st.state === 'mispointed') {
      findings.push({
        file: st.file,
        surface: st.surface,
        status: 'pointer-drift',
        detail: `${st.detail}; should point at ${pointer.to}`,
        remedy: 'run: simt-dev sync',
      });
    }
  }

  return findings;
}

export async function checkTarget(root, flags = {}) {
  const findings = await checkPrimary(root, flags);
  return findings;
}

async function checkPrimary(root, flags = {}) {
  const { body, meta } = await desiredRegion(root, flags);
  const path = join(root, PRIMARY_TARGET);
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
    return { file: PRIMARY_TARGET, status: 'absent', detail: 'no AGENTS.md; run: simt-dev sync' };
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
    return { file: PRIMARY_TARGET, status: 'unmanaged', detail: 'no generated region; run: simt-dev sync' };
  }
  const d = diff(existing, body, meta);
  return {
    file: PRIMARY_TARGET,
    status: d.action === 'unchanged' ? 'current' : 'drift',
    detail: d.action === 'unchanged' ? undefined : `region is ${d.action}; run: simt-dev sync`,
    recordedSha: state.sha ?? null,
    expectedSha: meta.sha,
  };
}
export { BEGIN, END };
// Re-exported so callers import the projection surface from one place; the pointer
// helpers now live in targets.mjs and two commands already reach for them here.
export { pointerTargets, pointerState };
export { headSha, LOCAL_PROFILE_DIR, loadRules, render, select, SUBSTITUTIONS_KEY };