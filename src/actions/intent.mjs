// Intent manifests and authorization binding (W32).
//
// An authorization is a decision about a specific intent. The failures this module prevents:
//
//   * an approval survived a change of target, actor, effect set or semantic delta, because what
//     was compared was a description rather than the intent;
//   * a cosmetic re-render invalidated an approval, so people re-approved without reading;
//   * `--yes` on a local writer plan was read as permission to act on a remote system;
//   * text retrieved from a document, or a resumed agent's summary, minted an authorization.
//
// The intent is canonicalised into the fields an authorization is *about*; rendering, labels and
// prose are deliberately outside that projection, so changing them neither grants nor revokes
// anything. Authorization sources are named, and only a user or a policy may be one.

import { digestOf } from '../knowledge/observations.mjs';
import { canonicalJson } from '../util/canonical.mjs';

export const INTENT_SCHEMA = 'simt.intent/1';

/** Who may authorize. A document, a model or a resumed agent is none of these. */
export const AUTHORIZATION_SOURCES = Object.freeze(['user', 'policy']);

/** What an authorization check can conclude. */
export const AUTHORIZATION_STATES = Object.freeze(['authorized', 'reauthorization-required', 'unauthorized']);

/** Where an effect lands, which is what a local writer plan cannot cover. */
export const EFFECT_SCOPES = Object.freeze(['local', 'remote']);

const isText = (value) => typeof value === 'string' && value.length > 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const effectKey = (effect) => `${effect.scope ?? 'local'}:${effect.operation ?? effect.kind ?? 'unknown'}`;

/**
 * Build an intent manifest.
 *
 * `dryRun` empties the effect set rather than marking it: an inspectable dry run has no external
 * effects, and a flag beside a full effect list would still read as one.
 *
 * @param {object} input
 */
export function buildIntent({
  goal = null,
  target = null,
  actor = null,
  selectors = [],
  beforeRevisions = {},
  delta = null,
  effects = [],
  verifier = null,
  contract = null,
  limits = {},
  recovery = null,
  dryRun = false,
  label = null,
  description = null,
} = {}) {
  const intent = {
    schema: INTENT_SCHEMA,
    goal: isText(goal) ? goal : null,
    target: isObject(target) ? { identity: target.identity ?? null, namespace: target.namespace ?? null, incarnation: target.incarnation ?? null } : null,
    actor: isObject(actor) ? { id: actor.id ?? null } : null,
    selectors: (Array.isArray(selectors) ? selectors : []).filter(isText).sort(),
    beforeRevisions: isObject(beforeRevisions) ? { ...beforeRevisions } : {},
    delta: isObject(delta) ? { digest: delta.digest ?? null, changes: (delta.changes ?? []).length } : null,
    effects: dryRun ? [] : (Array.isArray(effects) ? effects : []).filter(isObject).map((effect) => ({
      scope: EFFECT_SCOPES.includes(effect.scope) ? effect.scope : 'local',
      operation: effect.operation ?? effect.kind ?? null,
    })).sort((a, b) => effectKey(a).localeCompare(effectKey(b))),
    verifier: isObject(verifier) ? { obligations: [...(verifier.obligations ?? [])].sort() } : null,
    contract: isObject(contract) ? { digest: contract.digest ?? null } : null,
    limits: {
      actions: limits.actions ?? null,
      cost: limits.cost ?? null,
      seconds: limits.seconds ?? null,
    },
    recovery: isText(recovery) ? recovery : null,
    dryRun: dryRun === true,
    label: isText(label) ? label : null,
    description: isText(description) ? description : null,
  };
  intent.digest = intentDigest(intent);
  return intent;
}

/**
 * The part of an intent an authorization is about.
 *
 * Every field here changes what could happen. Nothing cosmetic is here, which is why a re-render
 * does not invalidate an approval and a target change does.
 *
 * @param {object} intent
 */
export function scopeOf(intent) {
  return {
    goal: intent?.goal ?? null,
    target: intent?.target ?? null,
    actor: intent?.actor ?? null,
    selectors: [...(intent?.selectors ?? [])],
    beforeRevisions: intent?.beforeRevisions ?? {},
    delta: intent?.delta ?? null,
    effects: [...(intent?.effects ?? [])].map(effectKey).sort(),
    verifier: intent?.verifier ?? null,
    contract: intent?.contract ?? null,
    limits: intent?.limits ?? null,
    recovery: intent?.recovery ?? null,
  };
}

/**
 * @param {object} intent
 * @returns {string}
 */
export function intentDigest(intent) {
  return digestOf(canonicalJson(scopeOf(intent)));
}

/**
 * Record an authorization against the intent it approves.
 *
 * @param {object} intent
 * @param {{source?: string, scope?: string, effects?: string[]}} authorization
 */
export function bindAuthorization(intent, authorization = {}) {
  if (!AUTHORIZATION_SOURCES.includes(authorization.source)) {
    return { bound: false, digest: null, reasons: ['the authorization has no recognized source; retrieved text or a resumed summary cannot mint one'] };
  }
  const digest = intentDigest(intent);
  const declared = isText(authorization.digest) ? authorization.digest : digest;
  const reasons = declared === digest ? [] : ['the intent changed after this authorization was recorded'];
  const effects = Array.isArray(authorization.effects) ? [...authorization.effects] : [];
  return { bound: reasons.length === 0, digest, scope: authorization.scope ?? null, effects, reasons };
}

/**
 * Decide whether an intent may proceed.
 *
 * @param {object} intent
 * @param {object|null} authorization
 */
export function checkAuthorization(intent, authorization = null) {
  const deny = (reason) => ({ state: 'unauthorized', mayProceed: false, prompt: true, reasons: [reason], expanded: [] });

  if (!isObject(authorization)) return deny('no authorization was recorded for this intent');
  if (!AUTHORIZATION_SOURCES.includes(authorization.source)) {
    return deny(`${authorization.source ?? 'an unidentified source'} cannot authorize an intent; only a user decision or a repository policy can`);
  }

  const remote = (intent?.effects ?? []).filter((effect) => effect.scope === 'remote');
  if (authorization.kind === 'writer-plan' || authorization.kind === 'yes') {
    if (remote.length > 0) {
      return deny('a local writer plan (--yes) is not a remote permission token; this intent has remote effects');
    }
    return { state: 'authorized', mayProceed: true, prompt: false, reasons: ['the local writer plan covers the local effects only'], expanded: [] };
  }

  const digest = intentDigest(intent);
  if (isText(authorization.digest) && authorization.digest !== digest) {
    return {
      state: 'reauthorization-required',
      mayProceed: false,
      prompt: true,
      reasons: ['the intent differs from what was authorized: a target, actor, effect, contract or delta change is a new decision'],
      expanded: [],
    };
  }

  const allowed = new Set((authorization.effects ?? []).map(String));
  const expanded = (intent?.effects ?? []).map(effectKey).filter((key) => allowed.size > 0 && !allowed.has(key)).sort();
  if (expanded.length > 0) {
    return {
      state: 'reauthorization-required',
      mayProceed: false,
      prompt: true,
      reasons: [`the intent expands the authorized effect set: ${expanded.join(', ')}`],
      expanded,
    };
  }

  return { state: 'authorized', mayProceed: true, prompt: false, reasons: [], expanded: [] };
}
