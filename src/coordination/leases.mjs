// Resource leases with honest fencing (W37).
//
// A lease is a promise only where something can enforce it. The failures this module is built
// around:
//
//   * two sessions holding the same exclusive lease because each wrote its own copy of a JSON
//     file and neither read the other;
//   * an expired worker continuing to mutate, because nothing checked a fencing token;
//   * a local worktree believed to isolate shared remote state;
//   * a lease treated as a capability, granting what the actor did not have;
//   * resources acquired in two orders by two sessions, deadlocking.
//
// A local file can exclude within one host, under an atomic create or compare. Anything across
// hosts needs an explicitly configured coordinator or the target's own compare-and-set, and when
// that is missing the lease is advisory and says so, with its residual race.

export const LEASE_SCHEMA = 'simt.lease/1';

/** How much a lease is actually worth. */
export const ENFORCEMENT = Object.freeze(['enforced', 'advisory-local', 'advisory-cross-host']);

const isText = (value) => typeof value === 'string' && value.length > 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The key a lease is taken on.
 *
 * A remote resource key carries the target and its incarnation, so a reset target is a different
 * resource and a local worktree cannot stand in for one. A create is keyed by its logical create
 * key, which is what makes two attempts at the same create contend.
 *
 * @param {object} input
 */
export function resourceKey({ target = null, incarnation = null, type = 'file', object = null, collection = null, createKey = null, path = null } = {}) {
  if (type === 'file' || type === 'worktree') {
    if (!isText(path)) return null;
    return `local/${type}/${path}`;
  }
  if (!isText(target) || !isText(incarnation)) return null;
  const scope = isText(object) ? `object/${object}` : isText(collection) && isText(createKey) ? `collection/${collection}~${createKey}` : null;
  if (scope === null) return null;
  return `${target}#${incarnation}/${type}/${scope}`;
}

/** Acquire in one canonical order, so two sessions cannot deadlock on each other. */
export const orderResources = (keys = []) => [...new Set((Array.isArray(keys) ? keys : []).filter(isText))].sort();

/**
 * Acquire one lease.
 *
 * @param {{held?: object[], key?: string, owner?: string, ttl?: number, fencing?: number, now?: number}} input
 */
export function acquire({ held = [], key = null, owner = null, ttl = 60000, fencing = 1, now = 0 } = {}) {
  if (!isText(key)) return { granted: false, reason: 'a lease needs a resource key' };
  if (!isText(owner)) return { granted: false, reason: 'a lease needs an owner' };
  const history = (Array.isArray(held) ? held : []).filter((lease) => lease?.key === key);
  const current = history.find((lease) => (lease.expiresAt ?? 0) > now);
  if (current && current.owner !== owner) return { granted: false, reason: `held by ${current.owner} until ${current.expiresAt}`, holder: current.owner };
  // A token identifies a grant, so it only moves forward. Stamping the caller's value on
  // every grant made an expired takeover and a renewal both replay token 1, which
  // `checkFencing` then accepted from the worker that had already lost the resource.
  const highest = history.reduce((max, lease) => (Number.isInteger(lease?.fencing) ? Math.max(max, lease.fencing) : max), 0);
  const issued = Math.max(highest + 1, Number.isInteger(fencing) ? fencing : 1);
  const lease = { schema: LEASE_SCHEMA, key, owner, fencing: issued, acquiredAt: now, expiresAt: now + ttl, grants: [] };
  return { granted: true, lease, held: [...(Array.isArray(held) ? held : []).filter((entry) => entry?.key !== key), lease].sort((a, b) => a.key.localeCompare(b.key)) };
}

/** Release a lease the owner holds. */
export function release({ held = [], key = null, owner = null } = {}) {
  const list = (Array.isArray(held) ? held : []).filter((lease) => !(lease?.key === key && lease?.owner === owner));
  return { released: list.length !== (Array.isArray(held) ? held : []).length, held: list };
}

/**
 * Whether a fencing token is still the newest one the authority issued.
 *
 * A worker whose token is behind has lost the resource, whatever its TTL says.
 */
export function checkFencing({ lease = null, token = null } = {}) {
  if (!isObject(lease) || !Number.isInteger(token)) return { valid: false, reason: 'no lease or no token to check' };
  if (token < lease.fencing) return { valid: false, reason: `token ${token} is behind the lease's fencing token ${lease.fencing}` };
  return { valid: true, reason: null };
}

/**
 * What the lease is worth on this host.
 *
 * @param {{host?: string, leaseHost?: string, coordinator?: string|null, serverCas?: boolean}} input
 */
export function enforcementFor({ host = null, leaseHost = null, coordinator = null, serverCas = false } = {}) {
  if (isText(coordinator) || serverCas === true) {
    return { mode: 'enforced', residualRace: null, reason: 'an external authority or the target itself arbitrates' };
  }
  if (isText(host) && host === leaseHost) {
    return { mode: 'advisory-local', residualRace: 'another process on this host that does not honour the lease', reason: 'a local file excludes only the processes that read it' };
  }
  return { mode: 'advisory-cross-host', residualRace: 'any other host holding the same resource', reason: 'a local file is not a distributed lock; cross-host exclusion needs a coordinator or server CAS' };
}

/** A lease never grants a privilege. */
export const grantsOf = (lease) => [...(lease?.grants ?? [])];
