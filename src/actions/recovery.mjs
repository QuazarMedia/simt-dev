// Recovery and protocol fallback equivalence (W36).
//
// Recovery is not rollback. The failures this module is built around:
//
//   * a crash after a verified step replaying that step, duplicating its effect;
//   * a partial batch reported as complete, or as failed, when half of it is unknown;
//   * a compensation presented as a guarantee that can succeed, when it can fail like any other
//     operation and needs its own actor, precondition and verifier;
//   * a UI fallback clicked blindly on an unexpected form, or accepted a snapshot it had never
//     checked;
//   * a protocol fallback treated as the same intent when it changes the effect;
//   * `simt undo` described as restoring remote state it never touched;
//   * a destructive compensation inferred from a failed create.

import { digestOf } from '../knowledge/observations.mjs';
import { canonicalJson } from '../util/canonical.mjs';

export const RECOVERY_SCHEMA = 'simt.recovery/1';

/** What may be done after a failure. `none` means the operation verified. */
export const RECOVERY_CHOICES = Object.freeze(['none', 'retry-after-reconciliation', 'forward-repair', 'compensation', 'manual']);

/** The only scope `simt undo` has. */
export const UNDO_SCOPE = Object.freeze({ scope: 'local-files', remote: false, reason: 'simt undo restores journaled local files only; a remote effect needs its declared recovery procedure' });

const isText = (value) => typeof value === 'string' && value.length > 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Choose a recovery for a failed or unknown operation.
 *
 * A compensation is only ever the one that was declared: inferring one from a failure would
 * invent a destructive effect nobody authorized.
 *
 * @param {{state?: string, reconcilable?: boolean, compensation?: object|null}} input
 */
export function chooseRecovery({ state = 'failed', reconcilable = false, compensation = null } = {}) {
  if (state === 'verified') return { choice: 'none', reasons: ['the operation verified; there is nothing to recover'] };
  if (state === 'outcome-unknown') {
    return reconcilable
      ? { choice: 'retry-after-reconciliation', reasons: ['the outcome is unknown: read it back by operation id before deciding anything'] }
      : { choice: 'manual', reasons: ['the outcome is unknown and the target cannot reconcile it; a person must look'] };
  }
  if (isObject(compensation)) {
    return { choice: 'compensation', contract: compensation, reasons: ['a declared compensation covers this effect; it has its own contract and can fail'] };
  }
  return { choice: 'manual', reasons: [`${state}: no compensation was declared, and none is inferred`] };
}

/**
 * A compensation's own contract: actor, effects, precondition and verifier.
 *
 * @param {object} input
 */
export function compensationContract({ actor = null, effects = [], precondition = null, verifier = null } = {}) {
  if (!isObject(actor) || !isText(actor.id)) throw new Error('a compensation needs the actor that performs it');
  if (!Array.isArray(effects) || effects.length === 0) throw new Error('a compensation needs an explicit effect set');
  if (!isObject(verifier) || !Array.isArray(verifier.obligations) || verifier.obligations.length === 0) throw new Error('a compensation needs a verifier');
  const contract = {
    schema: RECOVERY_SCHEMA,
    kind: 'compensation',
    actor: { id: actor.id },
    effects: effects.map((effect) => ({ scope: effect?.scope ?? 'local', operation: effect?.operation ?? null })),
    precondition: isObject(precondition) ? { type: precondition.type ?? null, value: precondition.value ?? null } : null,
    verifier: { obligations: [...verifier.obligations].sort() },
    canFail: true,
  };
  contract.digest = digestOf(canonicalJson(contract));
  return contract;
}

/**
 * A partial batch, stated exactly: done, remaining, and what is unknown.
 *
 * @param {{steps?: number, journal?: object[]}} input
 */
export function partialBatch({ steps = 0, journal = [] } = {}) {
  const done = [];
  const unknown = [];
  for (const entry of Array.isArray(journal) ? journal : []) {
    if (!isObject(entry) || !Number.isInteger(entry.step)) continue;
    if (entry.state === 'verified') done.push(entry.step);
    if (entry.state === 'outcome-unknown') unknown.push(entry.step);
  }
  const remaining = Array.from({ length: Math.max(0, steps) }, (_, index) => index + 1).filter((step) => !done.includes(step) && !unknown.includes(step));
  return { done: done.sort((a, b) => a - b), remaining, unknown: unknown.sort((a, b) => a - b), complete: remaining.length === 0 && unknown.length === 0 };
}

/**
 * Resume a run without replaying a verified step whose evidence is still current.
 *
 * @param {{journal?: object[], evidence?: object}} input
 */
export function resumePlan({ journal = [], evidence = {} } = {}) {
  const replay = [];
  const skip = [];
  const unknown = [];
  for (const entry of Array.isArray(journal) ? journal : []) {
    if (!isObject(entry) || !Number.isInteger(entry.step)) continue;
    if (entry.state === 'outcome-unknown') {
      unknown.push(entry.step);
      continue;
    }
    if (entry.state !== 'verified') continue;
    if (evidence?.[entry.step]?.current === false) replay.push(entry.step);
    else skip.push(entry.step);
  }
  return {
    replay: replay.sort((a, b) => a - b),
    skip: skip.sort((a, b) => a - b),
    unknown: unknown.sort((a, b) => a - b),
    reasons: replay.length > 0 ? ['a verified step\'s evidence expired, so it is replayed'] : [],
  };
}

/**
 * Choose a protocol for an intent from candidates that can prove they can do it.
 *
 * @param {{required?: string[], candidates?: object[]}} input
 */
export function selectProtocol({ required = [], candidates = [] } = {}) {
  const needed = (Array.isArray(required) ? required : []).filter(isText);
  const usable = (Array.isArray(candidates) ? candidates : []).filter((candidate) => {
    const capabilities = Array.isArray(candidate?.capabilities) ? candidate.capabilities : [];
    return needed.every((capability) => capabilities.includes(capability));
  });
  if (usable.length === 0) {
    return { chosen: null, refused: (Array.isArray(candidates) ? candidates : []).map((candidate) => ({ name: candidate?.name ?? null, reason: `does not declare ${needed.filter((capability) => !(candidate?.capabilities ?? []).includes(capability)).join(', ') || 'the required capability'}` })) };
  }
  const ranked = [...usable].sort((a, b) => (b.reliability ?? 0) - (a.reliability ?? 0) || String(a.name).localeCompare(String(b.name)));
  return { chosen: ranked[0].name ?? null, refused: [] };
}

/**
 * Bind a UI target before submitting anything: form identity, semantic locators and structure.
 *
 * @param {{form?: string, fields?: object, signature?: string}} input
 */
export function bindUiTarget({ form = null, fields = null, signature = null } = {}) {
  const missing = [];
  if (!isText(form)) missing.push('form-identity');
  if (!isObject(fields) || Object.keys(fields).length === 0) missing.push('semantic-field-locators');
  if (!isText(signature)) missing.push('widget-structure');
  return { bound: missing.length === 0, missing, form: isText(form) ? form : null, fields: isObject(fields) ? { ...fields } : null, signature: isText(signature) ? signature : null };
}

/**
 * What to do when the observed page differs from the bound one.
 *
 * @param {object} bound
 * @param {{signature?: string, attempts?: number, limit?: number}} observed
 */
export function checkUiStructure(bound, { signature = null, attempts = 0, limit = 2 } = {}) {
  if (!isObject(bound) || bound.bound !== true) return { action: 'refuse', reason: 'the target was never bound; submitting would be a blind click' };
  if (signature === bound.signature) return { action: 'submit', reason: null };
  if (attempts < limit) return { action: 'rediscover', reason: 'the page structure changed; rediscover within the declared attempt limit rather than clicking through' };
  return { action: 'refuse', reason: `the page structure still differs after ${attempts} rediscovery attempt(s)` };
}

/**
 * Whether a fallback keeps the intent.
 *
 * A fallback that changes the effect is a new intent, with its own authorization.
 */
export function fallbackIntent({ effects = [], fallbackEffects = [] } = {}) {
  const key = (effect) => `${effect?.scope ?? 'local'}:${effect?.operation ?? null}`;
  const before = new Set((effects ?? []).map(key));
  const after = new Set((fallbackEffects ?? []).map(key));
  const added = [...after].filter((entry) => !before.has(entry)).sort();
  const removed = [...before].filter((entry) => !after.has(entry)).sort();
  if (added.length === 0 && removed.length === 0) return { sameIntent: true, added, removed, reason: 'the fallback performs the same effects' };
  return { sameIntent: false, added, removed, reason: 'the fallback changes the effect set, so it is a new intent and needs its own authorization' };
}
