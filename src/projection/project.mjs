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

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');
const RULES_DIR = join(ROOT, 'rules');

/** Repo-local profile directory, relative to a repo root (ADR-013 section 2). */
export const LOCAL_PROFILE_DIR = '.simt-dev/profiles';

/** The one file every repo gets. Chosen deliberately: AGENTS.md is read by the
 *  most agents, including ones that ignore .cursor/ entirely. */
export const PRIMARY_TARGET = 'AGENTS.md';

/**
 * @param {string} root repo root
 * @returns {Promise<{root:string, stack:string[], facts:string[], profiles:string[],
 *                    rules:object[], targets:object[], notes:string[]}>}
 */
export async function plan(root) {
  const desired = await desiredRegion(root);
  const { stack, facts, profiles, fallback, notes, body, meta, all } = desired;
  const target = await targetFor(root, body, meta);

  return {
    root,
    stack,
    facts,
    profiles,
    fallback,
    rules: all,
    targets: [target],
    notes,
  };
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
export async function checkTarget(root) {
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