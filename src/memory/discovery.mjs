// Discovery, corrections and scoped memory (W43).
//
// Memory has so far learned from failed commands. The failures this module is built around:
//
//   * useful discoveries only becoming recallable after something failed, so they were never
//     recalled when they were needed;
//   * a repeated false assertion gaining authority by repetition;
//   * expired or target-specific facts leaking into generic packets;
//   * an unverified fix, or a compensation that failed, offered as a known successful remedy.
//
// Authority is a property of how a candidate was established, never of how often it was repeated.
// Deduplication merges repetition into a count and leaves authority where it was.

export const CANDIDATE_KINDS = Object.freeze(['discovery', 'contradiction', 'repair', 'correction', 'unknown-outcome']);

/** What a candidate may be used for, once it is established. */
export const AUTHORITIES = Object.freeze(['lesson', 'warning', 'candidate']);

const isText = (value) => typeof value === 'string' && value.length > 0;

/**
 * A candidate memory, before any promotion.
 *
 * @param {object} input
 */
export function candidate({
  kind = 'discovery',
  proposition = null,
  scope = 'generic',
  support = [],
  contradict = [],
  observedAt = null,
  expiresAt = null,
  capability = null,
  verified = false,
} = {}) {
  if (!isText(proposition)) throw new Error('a candidate needs a proposition');
  if (!CANDIDATE_KINDS.includes(kind)) throw new Error(`${kind} is not a candidate kind`);
  const entry = {
    kind,
    proposition,
    normalised: normaliseProposition(proposition),
    scope: isText(scope) ? scope : 'generic',
    support: (Array.isArray(support) ? support : []).filter(isText).sort(),
    contradict: (Array.isArray(contradict) ? contradict : []).filter(isText).sort(),
    observedAt: isText(observedAt) ? observedAt : null,
    expiresAt: isText(expiresAt) ? expiresAt : null,
    capability: isText(capability) ? capability : null,
    verified: verified === true,
    count: 1,
  };
  entry.authority = authorityOf(entry);
  return entry;
}

/** The key repetition is counted against: the proposition and the scope it was established in. */
export function normaliseProposition(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * How much a candidate may be relied on.
 *
 * Repetition is not an input here: two identical candidates produce two candidates, not a lesson.
 */
export function authorityOf({ kind = 'discovery', verified = false } = {}) {
  if (kind === 'unknown-outcome') return 'candidate';
  if (kind === 'repair' && verified !== true) return 'warning';
  return verified === true ? 'lesson' : 'candidate';
}

/**
 * Merge repetitions by proposition and scope.
 *
 * @param {object[]} entries
 */
export function dedupeCandidates(entries = []) {
  const byKey = new Map();
  const merged = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isText(entry?.normalised) && !isText(entry?.proposition)) continue;
    const normalised = entry.normalised ?? normaliseProposition(entry.proposition);
    const key = `${normalised}|${entry.scope ?? 'generic'}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, { ...entry, normalised, count: entry.count ?? 1 });
      continue;
    }
    const order = { lesson: 2, warning: 1, candidate: 0 };
    const authority = (order[existing.authority] ?? 0) >= (order[entry.authority] ?? 0) ? existing.authority : entry.authority;
    byKey.set(key, {
      ...existing,
      authority,
      // Merge only authority that was already established: repetition of a candidate stays a
      // candidate, which is what keeps a repeated false assertion from becoming a lesson.
      verified: existing.verified === true || entry.verified === true,
      support: [...new Set([...(existing.support ?? []), ...(entry.support ?? [])])].sort(),
      contradict: [...new Set([...(existing.contradict ?? []), ...(entry.contradict ?? [])])].sort(),
      count: (existing.count ?? 1) + (entry.count ?? 1),
    });
    merged.push(key);
  }
  return {
    kept: [...byKey.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, entry]) => entry),
    merged: [...new Set(merged)].sort(),
  };
}

/**
 * Whether a remembered entry may be used for a question.
 *
 * @param {object} entry
 * @param {{now?: string|null, scope?: string|null}} context
 */
export function recallable(entry, { now = null, scope = null } = {}) {
  if (entry?.authority === 'candidate') return { usable: false, reason: 'unverified: this is a candidate, not a lesson' };
  if (isText(entry?.expiresAt) && isText(now) && now >= entry.expiresAt) return { usable: false, reason: `expired at ${entry.expiresAt}` };
  if (isText(scope) && entry?.scope !== 'generic' && entry.scope !== scope) return { usable: false, reason: `scoped to ${entry.scope}, not ${scope}` };
  return { usable: true, reason: null };
}

/**
 * The entries a packet may carry, with the excluded ones named rather than dropped silently.
 *
 * @param {object[]} entries
 * @param {{now?: string|null, scope?: string|null}} context
 */
export function packetEntries(entries = [], context = {}) {
  const usable = [];
  const excluded = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const check = recallable(entry, context);
    if (check.usable) usable.push(entry);
    else excluded.push({ proposition: entry?.proposition ?? null, reason: check.reason });
  }
  return { usable, excluded };
}
