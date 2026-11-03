// Target identity and capability snapshots (W30).
//
// An operation can only be reviewed if the report says which environment and which actor it can
// affect. The failures this module is built around:
//
//   * a hostname was treated as an identity, so a target that was reset and rebuilt kept the same
//     name and every old observation looked current;
//   * an object id was treated as unique, so the same numeric id in two tenants collided;
//   * an expired session was renewed by switching to whatever credential was at hand, which is a
//     privilege change wearing a re-authentication's clothes;
//   * a target whose identity was unknown was guessed at, and a mutation went somewhere real;
//   * a read-only report carried the token it used to read.
//
// Identity is the pair (namespace, incarnation). A hostname, a display name and a session token
// are none of them identity: the first two are labels a human writes, the third is a capability
// that expires. Capabilities are what the target declares it supports, and a declared capability
// is not a granted one - this module reports, it does not authorize.

import { digestOf } from '../knowledge/observations.mjs';
import { canonicalJson } from '../util/canonical.mjs';

export const TARGET_SCHEMA = 'simt.target/1';

/** What an inspection can conclude. */
export const TARGET_STATES = Object.freeze(['ready', 'unknown-identity', 'reauth-required', 'unsupported-operation']);

const isText = (value) => typeof value === 'string' && value.length > 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The identity of a target: namespace and incarnation, together or not at all.
 *
 * @param {{namespace?: string, incarnation?: string}} target
 * @returns {string|null}
 */
export function targetIdentity({ namespace, incarnation } = {}) {
  if (!isText(namespace) || !isText(incarnation)) return null;
  return `${namespace}#${incarnation}`;
}

/**
 * The identity of an object inside a target.
 *
 * The namespace is part of the key, so the same object id in two tenants is two objects, which is
 * the only reading that cannot write to the wrong one.
 *
 * @param {{namespace?: string, type?: string, id?: string}} object
 * @returns {string|null}
 */
export function objectKey({ namespace, type, id } = {}) {
  if (!isText(namespace) || !isText(type) || !isText(id)) return null;
  return `${namespace}:${type}:${id}`;
}

/**
 * Resolve an alias locally. No network, no credential, no display-name fallback.
 *
 * @param {object[]} targets
 * @param {string} alias
 */
export function resolveTargetAlias(targets = [], alias) {
  if (!isText(alias)) return { error: 'unknown-alias', reason: 'no alias was given' };
  const matches = (Array.isArray(targets) ? targets : []).filter(
    (target) => isObject(target) && (target.alias === alias || (Array.isArray(target.aliases) && target.aliases.includes(alias))),
  );
  if (matches.length === 0) return { error: 'unknown-alias', reason: `${alias} matches no configured target` };
  if (matches.length > 1) {
    return { error: 'ambiguous-alias', reason: `${alias} matches ${matches.length} targets`, candidates: matches.map((target) => target.name).sort() };
  }
  return { target: matches[0], identity: targetIdentity(matches[0]) };
}

/**
 * Build the snapshot an observation produced.
 *
 * The session is recorded as a state and an expiry, never as a token: a snapshot is read by
 * reports, diffed in review and pasted into issues.
 *
 * @param {object} input
 */
export function buildTargetSnapshot({
  name,
  hostname = null,
  namespace = null,
  incarnation = null,
  platform = null,
  actor = null,
  capabilities = [],
  aliases = [],
  session = null,
  observedAt = null,
} = {}) {
  const snapshot = {
    schema: TARGET_SCHEMA,
    name: isText(name) ? name : null,
    hostname: isText(hostname) ? hostname : null,
    namespace: isText(namespace) ? namespace : null,
    incarnation: isText(incarnation) ? incarnation : null,
    identity: targetIdentity({ namespace, incarnation }),
    platform: isObject(platform) ? { name: platform.name ?? null, revision: platform.revision ?? null } : null,
    actor: isObject(actor) ? { id: actor.id ?? null, role: actor.role ?? null } : null,
    capabilities: (Array.isArray(capabilities) ? capabilities : []).filter(isText).sort(),
    aliases: (Array.isArray(aliases) ? aliases : []).filter(isText).sort(),
    session: isObject(session) ? { state: session.state ?? 'valid', expiresAt: session.expiresAt ?? null } : null,
    observedAt: isText(observedAt) ? observedAt : null,
  };
  snapshot.digest = digestOf(canonicalJson(snapshot));
  return snapshot;
}

/**
 * Decide whether a snapshot permits a mutation by this actor.
 *
 * @param {object} snapshot
 * @param {{actor?: object, session?: object, operation?: string}} context
 */
export function inspectTarget(snapshot, { actor = null, session = null, operation = null } = {}) {
  const fail = (state, reason) => ({ state, mayMutate: false, reasons: [reason], identity: snapshot?.identity ?? null });

  if (!isObject(snapshot) || !isText(snapshot.identity)) {
    return fail('unknown-identity', 'the target has no namespace and incarnation; a hostname or display name is not an identity');
  }
  const current = session ?? snapshot.session;
  if (isObject(current) && current.state === 'expired') {
    return fail('reauth-required', 'the session expired: re-authenticate and re-observe the target, because a renewed session is not a verified identity');
  }
  if (isObject(actor) && snapshot.actor?.id !== actor.id) {
    return fail('reauth-required', `the snapshot was observed as ${snapshot.actor?.id ?? 'another actor'}; switching actor is a new authorization, not a session refresh`);
  }
  if (isText(operation) && !snapshot.capabilities.includes(operation)) {
    return fail('unsupported-operation', `the target does not declare ${operation}`);
  }
  return { state: 'ready', mayMutate: true, reasons: [], identity: snapshot.identity };
}

/**
 * The snapshot as a report may show it.
 *
 * Only declared fields leave this function. A token or cookie that a caller put on the snapshot
 * is not copied, so a report cannot leak one by accident.
 *
 * @param {object} snapshot
 */
export function redactedTarget(snapshot) {
  if (!isObject(snapshot)) return null;
  return {
    schema: TARGET_SCHEMA,
    name: snapshot.name ?? null,
    hostname: snapshot.hostname ?? null,
    identity: snapshot.identity ?? null,
    platform: snapshot.platform ?? null,
    actor: snapshot.actor ? { id: snapshot.actor.id ?? null, role: snapshot.actor.role ?? null } : null,
    capabilities: Array.isArray(snapshot.capabilities) ? [...snapshot.capabilities] : [],
    session: snapshot.session ? { state: snapshot.session.state ?? 'valid', expiresAt: snapshot.session.expiresAt ?? null } : null,
    observedAt: snapshot.observedAt ?? null,
    digest: snapshot.digest ?? null,
  };
}
