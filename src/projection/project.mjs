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

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { fingerprint } from '../resolve/fingerprint.mjs';
import { diff, parse, inject, BEGIN, END } from './markers.mjs';
import { loadMdcRules, renderMdc, mdcFrontmatter } from './mdc.mjs';
import { MANIFEST } from './manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');
const RULES_DIR = join(ROOT, 'rules');

/** Repo-local profile directory, relative to a repo root (ADR-013 section 2). */
export const LOCAL_PROFILE_DIR = '.simt-dev/profiles';

/** The one file every repo gets. Chosen deliberately: AGENTS.md is read by the
 *  most agents, including ones that ignore .cursor/ entirely. */
export const PRIMARY_TARGET = 'AGENTS.md';

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

/**
 * @param {string} root repo root
 * @returns {Promise<{root:string, stack:string[], facts:string[], profiles:string[],
 *                    rules:object[], targets:object[], notes:string[]}>}
 */
export async function plan(root) {
  const desired = await desiredRegion(root);
  const { stack, facts, profiles, fallback, notes, body, meta, all } = desired;
  const target = await targetFor(root, body, meta);

  // `.mdc` rules are separate generated regions in separate files, each keeping
  // its own frontmatter OUTSIDE the region because the editor reads
  // `description` and `alwaysApply` before any rule text. They are returned as
  // additional targets rather than folded into the AGENTS.md body: a Cursor rule
  // file that contains the whole region would be read by Cursor and ignored by
  // everything else, which is the split the estate already had.
  const mdc = await mdcTargets(root, meta.sha);

  return {
    root,
    stack,
    facts,
    profiles,
    fallback,
    rules: all,
    targets: [target, ...mdc.targets],
    mdcProblems: mdc.problems,
    notes: [...notes, ...mdc.notes],
  };
}

/** The existing frontmatter block, or null when the file has none. */
function extractFrontmatter(text) {
  const m = /^---\n[\s\S]*?\n---\n?/.exec(text);
  return m ? m[0].trimEnd() : null;
}

function bodyAfterFrontmatter(text) {
  return text.replace(/^---\n[\s\S]*?\n---\n*/, '');
}

/**
 * Would this repo receive this `.mdc` rule? Shared by `plan` (which writes) and
 * `checkTargets` (which gates) for the same reason `desiredRegion` is shared: if
 * the two disagreed, the gate would demand a file `sync` refuses to produce.
 */
function isEligible(rule, signals, optedIn) {
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
async function readDeclared(root) {
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
async function mdcTargets(root, sha) {
  const targets = [];
  const problems = [];
  const notes = [];
  const skipped = [];

  const { stack, facts } = await fingerprint(root);
  const signals = new Set([...stack, ...facts]);

  const rules = await loadMdcRules();
  if (rules.length === 0) {
    notes.push('no canonical .mdc rules shipped in this build');
    return { targets, problems, notes };
  }

  const declared = await readDeclared(root);

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

    const path = join(root, rule.target);
    let existing = '';
    let exists = true;
    try {
      existing = await readFile(path, 'utf8');
    } catch {
      exists = false;
    }

    // A managed `.mdc` rule is a GENERATED FILE, unlike AGENTS.md. The body after
    // the frontmatter is the region, full stop: there is no hand-owned prose to
    // preserve, because any prose that was there is exactly the divergent copy this
    // mechanism retires. Appending instead would leave two `## Requirements`
    // sections in one file — the duplication the estate's own review agent is
    // instructed to block, produced by the tool meant to remove it.
    //
    // So the existing frontmatter is kept (the editor reads it before any rule
    // text) and everything below it is replaced. That is a destructive edit to a
    // real file, which is why `init` reports it and `--yes` is required.
    const frontmatter = extractFrontmatter(existing) ?? mdcFrontmatter(rule);
    const state = exists ? parse(existing) : { status: 'absent' };
    const composed =
      state.status === 'ok'
        ? existing // already a region; inject keeps it idempotent and contained
        : `${frontmatter}\n`;
    const result = inject(composed, body, { sha, sources: [rule.source] });

    // Report the prose being retired rather than letting it vanish into a diff the
    // reader has to notice. Silent deletion is the one thing a reviewer cannot audit.
    const retired = exists && state.status !== 'ok' ? bodyAfterFrontmatter(existing).trim() : '';
    if (retired !== '') {
      notes.push(
        `${rule.target}: retiring ${Buffer.byteLength(retired)} bytes of divergent hand-written rule text`,
      );
    }

    targets.push({
      file: rule.target,
      path,
      exists,
      action: result.action,
      reason: result.reason,
      line: result.line,
      bytes: Buffer.byteLength(result.text),
      previousBytes: Buffer.byteLength(existing),
      sha,
      body,
      text: result.text,
      previous: existing,
    });
  }

  if (skipped.length > 0) {
    notes.push(`no .mdc rule projected for ${skipped.join(', ')}; opt in with substitutions.__optIn`);
  }
  return { targets, problems, notes };
}

/**
 * The one place the desired region is computed. `plan` (which writes) and
 * `checkTarget` (which gates) both go through this, so they cannot disagree
 * about what the region should contain — a divergence here would report drift
 * where none exists, and CI would flake on a clean tree.
 */
async function desiredRegion(root) {
  const { stack, facts } = await fingerprint(root);
  const all = await loadRules(root);
  const { selected, fallback, notes } = select(all, stack, facts);
  const body = render(selected);
  const meta = {
    sha: await headSha(),
    sources: selected.map((r) => r.source),
  };
  return {
    stack,
    facts,
    all,
    profiles: selected.map((r) => r.id),
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

async function targetFor(root, body, meta) {
  const { readFile: read, writeFile } = await import('node:fs/promises');
  const path = join(root, PRIMARY_TARGET);
  let existing = '';
  let exists = true;
  try {
    existing = await read(path, 'utf8');
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
export async function checkTargets(root) {
  const findings = [];
  const primary = await checkPrimary(root);
  findings.push(primary);

  // A `.mdc` rule with a defect is a gate failure even when its file happens to be
  // correct, because the next `sync` will not reproduce it.
  // Selection must match `plan` exactly, or the gate reports a rule absent that
  // `sync` was never going to write — a permanently red check nothing can fix.
  const all = await loadMdcRules();
  const { stack, facts } = await fingerprint(root);
  const declared = await readDeclared(root);
  const rules = all.filter((r) => isEligible(r, new Set([...stack, ...facts]), declared.optIn));

  for (const rule of rules) {
    if (rule.error !== null) {
      findings.push({
        file: `rules/mdc/${rule.file}`,
        status: 'invalid',
        detail: rule.error,
      });
      continue;
    }
    const path = join(root, rule.target);
    let existing = '';
    try {
      existing = await readFile(path, 'utf8');
    } catch {
      findings.push({
        file: rule.target,
        status: 'absent',
        detail: 'no canonical .mdc rule here; run: simt sync',
      });
      continue;
    }
    const state = parse(existing);
    if (state.status === 'malformed') {
      findings.push({
        file: rule.target,
        status: 'malformed',
        detail: state.reason,
        line: state.line,
      });
      continue;
    }
    if (state.status === 'absent') {
      findings.push({
        file: rule.target,
        status: 'unmanaged',
        detail: 'no generated region; run: simt sync',
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
    // Compared against the same reconstruction `plan` writes: frontmatter plus a
    // single region. Diffing against the raw file would demand the divergent
    // pre-adoption text still be present, which is the opposite of retiring it.
    const reference =
      state.status === 'ok'
        ? existing
        : `${extractFrontmatter(existing) ?? mdcFrontmatter(rule)}\n`;
    const d = diff(reference, body, { sha: await headSha(), sources: [rule.source] });
    findings.push({
      file: rule.target,
      status: d.action === 'unchanged' ? 'current' : 'drift',
      detail: d.action === 'unchanged' ? undefined : `region is ${d.action}; run: simt sync`,
      recordedSha: state.sha ?? null,
    });
  }

  return findings;
}

/** One repo's primary target only, for callers that report a repo as a single row
 *  (`compare`). The `.mdc` findings are reachable through `checkTargets`, which is
 *  what the gate uses — a dashboard row cannot represent four files, and the gate
 *  must not inherit the dashboard's coarser view. */
export async function checkTarget(root) {
  const findings = await checkPrimary(root);
  return findings;
}

async function checkPrimary(root) {
  const { body, meta } = await desiredRegion(root);
  const path = join(root, PRIMARY_TARGET);
  let existing = '';
  try {
    existing = await readFile(path, 'utf8');
  } catch {
    return { file: PRIMARY_TARGET, status: 'absent', detail: 'no AGENTS.md; run: simt sync' };
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
    return { file: PRIMARY_TARGET, status: 'unmanaged', detail: 'no generated region; run: simt sync' };
  }
  const d = diff(existing, body, meta);
  return {
    file: PRIMARY_TARGET,
    status: d.action === 'unchanged' ? 'current' : 'drift',
    detail: d.action === 'unchanged' ? undefined : `region is ${d.action}; run: simt sync`,
    recordedSha: state.sha ?? null,
    expectedSha: meta.sha,
  };
}

/** The simt-dev SHA recorded in generated regions. Falls back to a sentinel when
 *  git is unavailable so a region is never stamped with a misleading SHA. */
export async function headSha() {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const { stdout } = await run('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: ROOT });
    return stdout.trim();
  } catch {
    return 'unknown';
  }
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

export { BEGIN, END };