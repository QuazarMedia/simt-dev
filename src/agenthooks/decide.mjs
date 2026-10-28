// What a policy decides, given facts and one session's overrides.
//
// Pure, so the whole decision is testable without a harness: hand it the facts a
// renderer would extract and an environment, and it answers. The filesystem is
// consulted in `factsFor` for exactly the facts a payload cannot carry — whether a
// file holds bytes this tool generates, and who has leased it (ADR-101) — and nothing
// else decides from disk.
//
// Two properties are deliberate and both are about an author standing still:
//
// Every matching policy is reported, not the first. `git push --force` is a push and a
// rewrite; a build that stopped at the first match would let `SIMT_ALLOW=push` lift the
// approval rule and carry a force-push through, because the rewrite rule was never
// consulted. Lifting a policy lifts that policy.
//
// No fact is not a violation. A payload whose shape we did not read — a harness that
// renamed a tool, an agent writing through some tool we have never seen — yields no
// command and no path, and the decision is to say nothing. Turning "we do not
// understand this" into "blocked" makes the hook a false-positive machine, and a hook
// that blocks real work is uninstalled the same afternoon.

import { readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import { parse } from '../projection/markers.mjs';
import { activeLeases, leasePathFor, readLeases } from '../lease.mjs';
import { ALLOW_ENV, EVENTS, POLICY_IDS, SESSION_ENV, policiesFor } from './policy.mjs';

/**
 * The policies this session has lifted, and the names in `SIMT_ALLOW` that are not
 * policies at all.
 *
 * An unknown name is reported rather than ignored: `SIMT_ALLOW=push,rewrit` typed once
 * and relied on would otherwise look like a lift that did nothing, and the author would
 * conclude the hook was broken rather than the spelling.
 */
export function overrides(env = {}) {
  const raw = env[ALLOW_ENV];
  const named = typeof raw === 'string' ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  return {
    ids: new Set(named.filter((n) => POLICY_IDS.includes(n))),
    unknown: named.filter((n) => !POLICY_IDS.includes(n)),
  };
}

/**
 * Whether one row applies to the facts. A row with no matcher reads the facts itself.
 *
 * `env` is only consulted by `lease`, which is the one row asking who is doing this
 * rather than what is being done — and the one row with a fact the payload never
 * carries: an unreadable claim file denies a write, but a shell command with no file
 * fact is not an edit (ADR-101 ruling 4).
 */
function applies(row, facts, env) {
  if (row.inspects === 'command') {
    return typeof facts.command === 'string' && row.match !== null && row.match.test(facts.command);
  }
  if (row.inspects === 'write') {
    return (facts.writes ?? []).some((w) => w.generated !== null && w.generated !== undefined);
  }
  if (row.inspects === 'lease') {
    const writes = facts.writes ?? [];
    if (writes.length === 0) return false;
    if (facts.leaseError) return true;
    const session = typeof env[SESSION_ENV] === 'string' ? env[SESSION_ENV] : '';
    return writes.some((w) => w.lease && w.lease.session !== session);
  }
  return false;
}

/**
 * The decision for one event.
 *
 * `blocked` and `lifted` are ids, not rows, because the caller prints them and an id is
 * what a reader types into `SIMT_ALLOW`. The messages carry their own override hint, so
 * a denial is actionable without the reader knowing the variable exists.
 */
export function decide({ event = EVENTS[0], facts = {}, env = {} } = {}) {
  const { ids: lifted, unknown } = overrides(env);
  const matched = policiesFor(event).filter((p) => applies(p, facts, env));
  const blocked = matched.filter((p) => !lifted.has(p.id));
  return {
    event,
    decision: blocked.length > 0 ? 'deny' : 'allow',
    blocked: blocked.map((p) => p.id),
    lifted: matched.filter((p) => lifted.has(p.id)).map((p) => p.id),
    unknown,
    // A row may carry a `detail` for the parts of its message that are only knowable
    // at decision time (the lease holder's name and expiry, ADR-101 ruling 5). Every
    // row without one renders exactly as before, override hint included.
    messages: blocked.map((p) => {
      const detail = typeof p.detail === 'function' ? p.detail(facts, env) : null;
      const body = detail ? `${p.message} ${detail}` : p.message;
      return `${body} (override: ${ALLOW_ENV}=${p.id})`;
    }),
    adrs: blocked.map((p) => p.adr),
  };
}

/** Whether this file's bytes are generated: a region this tool writes, or a submodule. */
function holdsRegion(text) {
  // Both marker styles, because the region is written in whichever one the file's own
  // syntax allows — `<!-- simt:begin -->` in markdown, `# simt:begin` in an
  // .editorconfig. A malformed region is still a region: a begin marker with no end is
  // the file somebody has already been editing by hand.
  return parse(text).status !== 'absent' || parse(text, 'hash').status !== 'absent';
}

/** The submodule paths `.gitmodules` declares, as repository-relative directories. */
async function submodules(root) {
  const text = await readFile(join(root, '.gitmodules'), 'utf8').catch(() => null);
  if (text === null) return [];
  return text
    .split('\n')
    .map((line) => /^\s*path\s*=\s*(.+?)\s*$/.exec(line))
    .filter(Boolean)
    .map((m) => m[1].replace(/\/+$/, ''));
}

/**
 * Why this path is not the author's to write, or null when it is.
 *
 * The reason is returned rather than a boolean because the two answers are different
 * facts and the author of a fix needs to know which one applies: a region is repaired by
 * editing its source, a submodule by committing in the other repository.
 */
export async function generatedBytes(root, file) {
  const abs = resolve(root, file);
  const text = await readFile(abs, 'utf8').catch(() => null);
  if (text !== null && holdsRegion(text)) return 'region';
  const rel = relative(resolve(root), abs);
  if (!rel.startsWith('..')) {
    const inside = await submodules(root);
    if (inside.some((dir) => rel === dir || rel.startsWith(`${dir}/`))) return 'submodule';
  }
  return null;
}

/** Turn a renderer's extraction into the facts the table asks about. */
export async function factsFor(root, { command = null, writes = [] } = {}) {
  const resolved = await Promise.all(
    writes.filter(Boolean).map(async (path) => ({ path, generated: await generatedBytes(root, path) })),
  );
  // Lease facts, read only when the payload named a file to write: the claim file is
  // irrelevant to a shell command, and a payload with no file pays nothing for a
  // feature it cannot touch. Expired claims are dropped here because the hook runs
  // now, so a TTL needs no sweeper; ownership is left whole because `decide` is the
  // one that knows which session is asking (ADR-101 ruling 3).
  if (resolved.length === 0) return { command, writes: resolved, leaseError: null };
  const read = await readLeases(root);
  if (read.error !== null) return { command, writes: resolved, leaseError: read.error };
  const live = new Map(activeLeases(read).map((l) => [l.path, l]));
  for (const w of resolved) {
    const rel = leasePathFor(root, w.path);
    w.lease = rel === null ? null : live.get(rel) ?? null;
  }
  return { command, writes: resolved, leaseError: null };
}
