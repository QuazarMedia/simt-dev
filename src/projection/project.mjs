// Decide what a repo's generated region should contain.
//
// Two jobs, deliberately separate from writing (markers.mjs) and from the gate
// (commands/check):
//   1. plan(root) -> { targets: [{file, action, body, ...}], stack, rules }
//   2. Nothing here touches the filesystem. A plan is pure, so it can be
//      inspected, diffed and asserted on without a scratch directory.
//
// The core rule set is always included. Stack profiles are selected by
// intersection with the repo's fingerprint, plus one fallback profile so a JS/TS
// repo is never left with core rules and nothing else.

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { fingerprint } from '../resolve/fingerprint.mjs';
import { diff, parse, inject, BEGIN, END } from './markers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');
const RULES_DIR = join(ROOT, 'rules');

/** The one file every repo gets. Chosen deliberately: AGENTS.md is read by the
 *  most agents, including ones that ignore .cursor/ entirely. */
export const PRIMARY_TARGET = 'AGENTS.md';

/**
 * @param {string} root repo root
 * @returns {Promise<{root:string, stack:string[], profiles:object[], rules:object,
 *                    targets:object[], notes:string[]}>}
 */
export async function plan(root) {
  const desired = await desiredRegion(root);
  const { stack, profiles, fallback, notes, body, meta, all } = desired;
  const target = await targetFor(root, body, meta);

  return {
    root,
    stack,
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
  const { stack } = await fingerprint(root);
  const all = await loadRules();
  const { selected, fallback, notes } = select(all, stack);
  const body = render(selected);
  const meta = { sha: await headSha(), sources: selected.map((r) => `rules/${r.file}`) };
  return {
    stack,
    all,
    profiles: selected.map((r) => r.id),
    fallback,
    notes,
    body,
    meta,
  };
}

/**
 * Read every rule file once, with its frontmatter parsed.
 * A rule without an `id` is a defect, not a default: ids are what `rules why`
 * and the generated region's source list refer to.
 */
export async function loadRules() {
  const entries = await readdir(RULES_DIR, { withFileTypes: true });
  const files = [
    ...entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name),
    ...entries
      .filter((e) => e.isDirectory() && e.name === 'stacks')
      .flatMap(() => []),
  ];
  const stackFiles = entries.some((e) => e.isDirectory() && e.name === 'stacks')
    ? (await readdir(join(RULES_DIR, 'stacks')))
        .filter((n) => n.endsWith('.md'))
        .map((n) => `stacks/${n}`)
    : [];

  const out = [];
  for (const file of [...files, ...stackFiles].sort()) {
    const text = await readFile(join(RULES_DIR, file), 'utf8');
    const meta = parseFrontmatter(text);
    out.push({
      file,
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
 * `applies` intersects the repo's stack tags. `node` is the fallback, so it is
 * only chosen when nothing more specific matched — otherwise every JS repo
 * would receive both node and react-web.
 */
export function select(rules, stack) {
  const notes = [];
  const core = rules.filter((r) => r.applies === 'always');
  const profiles = rules.filter((r) => Array.isArray(r.applies) && !r.fallback);
  const fallbacks = rules.filter((r) => r.fallback);

  const tags = new Set(stack);
  const matched = profiles.filter((r) => r.applies.some((tag) => tags.has(tag)));

  let usedFallback = false;
  const selected = [...core, ...matched];
  if (matched.length === 0) {
    for (const f of fallbacks) {
      if (f.applies.some((tag) => tags.has(tag))) {
        selected.push(f);
        usedFallback = true;
        notes.push(`no specific stack profile matched ${stack.join(', ') || '(no tags)'}; using fallback ${f.id}`);
      }
    }
  }
  if (matched.length === 0 && usedFallback === false) {
    notes.push(
      `no stack profile matched ${stack.length > 0 ? stack.join(', ') : '(no detected stack tags)'}; projecting shared rules only`,
    );
  }
  return { selected, fallback: usedFallback, notes };
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