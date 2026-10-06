// Which rules apply to a repo.
//
// Split from project.mjs, which crossed the 400-line review trigger (ADR-005)
// twice while gaining two unrelated concerns. The rule is that a module answers
// one question: this one answers *which rules*, project.mjs answers *what files
// that produces*, targets.mjs answers *how a rule is rendered per surface*.
//
// Selection is a pure function of the repo's signals plus the manifest, with no
// filesystem beyond reading the rule files themselves. That purity is what makes
// the profile-selection test possible at all, and it is why `select` takes a
// pre-read rule list rather than a path.
//
// The core rule set is always included. Stack profiles are selected by
// intersection with the repo's fingerprint - platform tags *and* emitted facts,
// which are interchangeable in a profile (ADR-013) - plus one fallback profile so
// a JS/TS repo is never left with core rules and nothing else.
//
// Profiles may live in the repo, not only here. `.simt-dev/profiles/*.md` uses the
// same frontmatter contract as `rules/stacks/*.md` and is selected by the same
// matcher, so supporting an ecosystem nobody here has heard of requires no code
// change and no release.

import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { fingerprint } from '../resolve/fingerprint.mjs';
import { loadMdcRules, renderMdc } from './mdc.mjs';
import { foldsRules, frontmatterBlock, resolveSurfaces } from './surfaces.mjs';
import { ruleTargets } from './targets.mjs';
import { MANIFEST } from './manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');
const RULES_DIR = join(ROOT, 'rules');
const exec = promisify(execFile);

/** The simt-dev SHA recorded in generated regions. Falls back to a sentinel when
 *  git cannot answer, because a region stamped with an honest "unknown" is
 *  visibly unverified while one stamped with a wrong answer is not. */
export async function headSha() {
  try {
    const { stdout } = await exec('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: ROOT });
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}

/** Repo-local profile directory, relative to a repo root (ADR-013 section 2). */
export const LOCAL_PROFILE_DIR = '.simt-dev/profiles';

/**
 * Manifest key holding per-rule substitution values, keyed by rule id.
 *
 * Substitutions live in the manifest rather than in the rule file because they are
 * facts about the repo — which glob holds its plans, which domains are production
 * — while a rule is shared by every repo that adopts it. Putting them in the rule
 * either hard-codes one repo's paths for everyone or pushes the decision back
 * into prose, which is the drift this mechanism exists to remove.
 */
export const SUBSTITUTIONS_KEY = 'substitutions';

export function isEligible(rule, signals, optedIn) {
  if (rule.optIn === true) return optedIn.has(rule.id);
  if (rule.applies === 'always') return true;
  return Array.isArray(rule.applies) && rule.applies.some((t) => signals.has(t));
}

/**
 * Read the repo's declared substitutions and opt-ins once.
 *
 * Both callers used to read and parse `simt-dev.json` separately — and `checkTargets`
 * did it inside its per-rule loop, so a repo with three projected `.mdc` rules read the
 * manifest three times to reach the same two values. A helper that answers once is also
 * the only way to be sure the writer and the gate cannot disagree about what was
 * declared.
 */
export async function readDeclared(root) {
  let parsed = {};
  try {
    parsed = JSON.parse(await readFile(join(root, MANIFEST), 'utf8')) ?? {};
  } catch {
    parsed = {};
  }
  const declarations = parsed[SUBSTITUTIONS_KEY] ?? {};
  const list = declarations.__optIn;
  return {
    values: declarations,
    optIn: new Set(Array.isArray(list) ? list : []),
  };
}



/**
 * Render every canonical `.mdc` rule into its own generated region.
 *
 * A rule with a defect (no id, no target) is reported and skipped rather than
 * written somewhere guessed: a rule file that silently stopped being projected
 * would look exactly like a rule file that had nothing to say.
 */
export async function mdcTargets(root, sha, manifest, flags) {
  const targets = [];

  const { resolved, bodies, problems, notes, skipped } = await ruleBodies(root, manifest, flags);

  // A surface that folds its rules into the primary document contributes no file;
  // `ruleTargets` skips it. Folding itself is `desiredRegion`'s job, and it reads the
  // same `bodies` from the same call, so the region and the files cannot disagree.
  if (foldsRules(resolved) && !resolved.surfaces.some((s) => s.rule)) {
    if (bodies.length > 0) {
      notes.push(
        `every rule is folded into ${resolved.surfaces[0].primary}; add a surface with its own rule path for a file per rule`,
      );
    }
    return { targets, problems, notes };
  }

  for (const { rule, body } of bodies) {
    const built = await ruleTargets(root, rule, body, sha, resolved, notes);
    targets.push(...built.targets);
  }

  if (skipped.length > 0) {
    notes.push(`no .mdc rule projected for ${skipped.join(', ')}; opt in with substitutions.__optIn`);
  }
  return { targets, problems, notes };
}

/**
 * Select the per-rule canonical rules and render each one, once.
 *
 * Extracted from `mdcTargets` because ADR-021 needs the SAME bodies for two
 * different destinations: folded into the primary region when the selected surface
 * has no per-rule path, and written as one file per surface when it does. Two
 * selection passes would be two answers to "which rules apply", which is the defect
 * that produced eight divergent `.mdc` files in the first place.
 */
async function ruleBodies(root, manifest, flags) {
  const problems = [];
  const notes = [];
  const skipped = [];
  const bodies = [];

  const { stack, facts } = await fingerprint(root);
  const signals = new Set([...stack, ...facts]);

  const rules = await loadMdcRules();
  if (rules.length === 0) {
    notes.push('no canonical .mdc rules shipped in this build');
    const resolved = resolveSurfaces(manifest, flags ?? {});
    return { resolved, bodies, problems, notes, skipped };
  }

  const declared = await readDeclared(root);

  const resolved = resolveSurfaces(manifest, flags ?? {});
  for (const p of resolved.problems) problems.push(p);

  // A manifest key that no shipped rule declares is a typo, or a leftover from a rule
  // that was renamed. Both read as "configured" in the one file a reviewer opens to
  // see what a repo has chosen, and neither has any effect — so one is reported rather
  // than ignored. `__optIn` is the one key with no rule of the same name.
  const knownKeys = new Set(['__optIn']);
  for (const rule of rules) for (const sub of rule.substitutions) knownKeys.add(sub.key);
  for (const ruleId of Object.keys(declared.values)) {
    if (ruleId === '__optIn') continue;
    if (!rules.some((r) => r.id === ruleId)) {
      notes.push(
        `manifest declares substitutions for "${ruleId}", which no canonical rule matches; ignored`,
      );
      continue;
    }
    for (const key of Object.keys(declared.values[ruleId] ?? {})) {
      if (!knownKeys.has(key)) {
        problems.push(`${ruleId}: manifest declares substitution "${key}", which the rule does not define`);
      }
    }
  }

  for (const rule of rules) {
    if (rule.error !== null) {
      problems.push(`${rule.file}: ${rule.error}`);
      continue;
    }
    // Selection mirrors the stack profiles: `applies: always` is unconditional, an
    // `applies` array intersects the repo's signals, and an opt-in rule waits for
    // the manifest to name it. A repo that matches nothing gets no `.mdc` rule
    // rather than a plausible-looking one it cannot act on.
    if (!isEligible(rule, signals, declared.optIn)) {
      skipped.push(rule.id);
      continue;
    }
    const values = declared.values[rule.id] ?? {};
    const { body, problems: renderProblems } = renderMdc(rule, values);
    for (const p of renderProblems) problems.push(`${rule.file}: ${p}`);
    if (renderProblems.length > 0) continue;

    // One canonical body, one target per selected surface. The body is identical
    // everywhere; only the frontmatter the editor reads before any rule text
    // differs. Without this loop a repo in a Claude Code session receives
    // AGENTS.md and none of the always-on process rules, because those lived only
    // in a directory only Cursor reads.
    bodies.push({ rule, body });
  }

  return { resolved, bodies, problems, notes, skipped };
}

/**
 * The one place the desired region is computed. `plan` (which writes) and
 * `checkTarget` (which gates) both go through this, so they cannot disagree
 * about what the region should contain — a divergence here would report drift
 * where none exists, and CI would flake on a clean tree.
 */
export async function desiredRegion(root, flags) {
  const { stack, facts, manifest } = await fingerprint(root);
  const all = await loadRules(root);
  const { selected, fallback, notes } = select(all, stack, facts);

  let body = render(selected);
  let sources = selected.map((r) => r.source);
  const folded = [];

  // When every selected surface carries its rules inside the primary document, the
  // per-rule bodies belong in the region too — otherwise a repo on the standard
  // surface receives AGENTS.md and none of the always-on process rules, because
  // those had nowhere else to live. One file, one region, one place a reader opens.
  const { resolved, bodies, problems, notes: ruleNotes } = await ruleBodies(
    root,
    manifest,
    flags ?? {},
  );
  notes.push(...ruleNotes);
  if (foldsRules(resolved)) {
    for (const { rule, body: ruleBody } of bodies) {
      body += `\n\n### ${rule.id}\n\n${ruleBody}`;
      sources.push(rule.source);
      folded.push(rule.id);
    }
  }

  const meta = {
    sha: await headSha(),
    sources,
  };
  return {
    stack,
    facts,
    manifest,
    all,
    profiles: selected.map((r) => r.id),
    folded,
    surfaces: resolved.ids,
    surfaceSource: resolved.source,
    problems,
    fallback,
    notes,
    body,
    meta,
  };
}

/**
 * Read every rule file once, with its frontmatter parsed, plus any repo-local
 * profile under `.simt-dev/profiles/`.
 *
 * A rule without an `id` is a defect, not a default: ids are what `rules why`
 * and the generated region's source list refer to.
 *
 * A local profile with the same id as a central one SHADOWS it — replaces it
 * rather than stacking with it. Two profiles claiming the same id would project
 * the same rules twice, and duplicated source-of-truth text is a review blocker,
 * not a style nit. The shadow is reported in `notes` so it is never silent.
 */
export async function loadRules(root = null) {
  const entries = await readdir(RULES_DIR, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name);
  const stackFiles = entries.some((e) => e.isDirectory() && e.name === 'stacks')
    ? (await readdir(join(RULES_DIR, 'stacks')))
        .filter((n) => n.endsWith('.md'))
        .map((n) => `stacks/${n}`)
    : [];

  const collected = [];

  for (const file of [...files, ...stackFiles].sort()) {
    collected.push({ file, dir: RULES_DIR, origin: 'central', source: `rules/${file}` });
  }

  if (root !== null) {
    const localDir = join(root, LOCAL_PROFILE_DIR);
    let localNames = [];
    try {
      localNames = (await readdir(localDir)).filter((n) => n.endsWith('.md')).sort();
    } catch {
      localNames = [];
    }
    for (const name of localNames) {
      collected.push({
        file: name,
        dir: localDir,
        origin: 'local',
        source: `${LOCAL_PROFILE_DIR}/${name}`,
      });
    }
  }

  const out = [];
  for (const item of collected) {
    const text = await readFile(join(item.dir, item.file), 'utf8');
    const meta = parseFrontmatter(text);
    out.push({
      file: item.file,
      origin: item.origin,
      source: item.source,
      id: meta.id ?? null,
      title: meta.title ?? null,
      applies: meta.applies ?? [],
      fallback: meta.fallback === true,
      bytes: Buffer.byteLength(text),
      body: stripFrontmatter(text),
      error: meta.id ? null : 'missing id in frontmatter',
    });
  }
  return out;
}

/**
 * Selection is pure set intersection: core always, then every profile whose
 * `applies` intersects the repo's signals. `node` is the fallback, so it is only
 * chosen when nothing more specific matched — otherwise every JS repo would
 * receive both node and react-web.
 *
 * `signals` is stack tags ∪ facts (ADR-013). A profile may name either, and a
 * fact is the more durable choice because it survives the framework being
 * replaced.
 *
 * `shadowed` lists local profiles that replaced a central one, so a caller can
 * report it rather than silently changing what a repo receives.
 */
export function select(rules, stack, facts = []) {
  const notes = [];
  const shadowed = [];
  const ids = new Map();
  for (const rule of rules) {
    if (rule.id === null) continue;
    const prior = ids.get(rule.id);
    if (prior === undefined) {
      ids.set(rule.id, rule);
      continue;
    }
    // A local profile is allowed to replace a central one; two of the same
    // origin are a defect the caller must be able to see.
    const localWins = rule.origin === 'local' && prior.origin !== 'local';
    if (localWins) {
      ids.set(rule.id, rule);
      shadowed.push({
        id: rule.id,
        winner: rule.source,
        replaced: prior.source,
        ok: true,
      });
    } else {
      shadowed.push({
        id: rule.id,
        winner: prior.source,
        replaced: rule.source,
        ok: false,
      });
    }
  }
  const keep = new Set(ids.values());

  const effective = rules.filter((r) => r.id === null || keep.has(r));
  const effCore = effective.filter((r) => r.applies === 'always');
  const effProfiles = effective.filter((r) => Array.isArray(r.applies) && !r.fallback);
  const effFallbacks = effective.filter((r) => r.fallback);

  const signals = [...new Set([...(stack ?? []), ...(facts ?? [])])];
  const tags = new Set(signals);
  const matched = effProfiles.filter((r) => r.applies.some((tag) => tags.has(tag)));

  let usedFallback = false;
  const selected = [...effCore, ...matched];
  if (matched.length === 0) {
    for (const f of effFallbacks) {
      if (f.applies.some((tag) => tags.has(tag))) {
        selected.push(f);
        usedFallback = true;
        notes.push(
          `no specific profile matched ${signals.join(', ') || '(no signals)'}; using fallback ${f.id}`,
        );
      }
    }
  }
  if (matched.length === 0 && usedFallback === false) {
    notes.push(
      `no profile matched ${signals.length > 0 ? signals.join(', ') : '(no detected signals)'}; projecting shared rules only`,
    );
  }
  for (const s of shadowed.filter((x) => x.ok)) {
    notes.push(`local profile ${s.id} shadows ${s.replaced}`);
  }
  for (const s of shadowed.filter((x) => !x.ok)) {
    notes.push(`duplicate profile id ${s.id}: ignored ${s.replaced}, kept ${s.winner}`);
  }
  return { selected, fallback: usedFallback, notes, shadowed };
}

/** The region body. Stack profiles come after core so the general rule wins a
 *  conflict: a stack profile refines the shared rule, it does not replace it. */
export function render(selected) {
  // Strip again here: loadRules already does it, but render is the boundary the
  // region bytes pass through, and a stray frontmatter or duplicated H1 in the
  // output would be projected verbatim.
  return selected
    .map((r) => stripFrontmatter(r.body).trim())
    .filter(Boolean)
    .join('\n\n');
}

function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-zA-Z-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, raw] = kv;
    if (raw === 'always') out[key] = 'always';
    else if (raw === 'true') out[key] = true;
    else if (raw === 'false') out[key] = false;
    else if (raw.startsWith('[')) {
      out[key] = raw
        .slice(1, raw.lastIndexOf(']'))
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else out[key] = raw.trim();
  }
  return out;
}

/** Frontmatter and the duplicated H1 are dropped: the region is embedded in a
 *  host document that already has a title, so repeating it wastes context. */
function stripFrontmatter(text) {
  // The frontmatter strip must also swallow the blank lines that follow it, or
  // the H1 strip's `^` anchor lands on a newline and silently matches nothing.
  return text
    .replace(/^---\n[\s\S]*?\n---\n*/, '')
    .replace(/^#\s+.*\n+/, '')
    .trim();
}

