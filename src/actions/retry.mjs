// Idempotency, preconditions and retry decisions (W34).
//
// A timeout does not mean the write failed; it means nobody knows. The failures this module
// exists to prevent:
//
//   * a retry after a lost response creating a second object;
//   * a stale ETag retried with a blind overwrite, discarding someone else's edit;
//   * an ambiguous name match resolved by picking the first result;
//   * a duplicate callback causing a second effect;
//   * backoff with no cap, deadline or jitter, so every client retried in step;
//   * a hidden retry layer exceeding the intent's action budget;
//   * an exit code or a UI submit treated as proof of idempotency.
//
// The decision order is deliberate: reconcile before retry, precondition before overwrite, and
// stop when the budget or the deadline is reached. Everything here is pure, so a simulated
// schedule is deterministic (RFC 9110 method semantics; Temporal's documented retry edges).

import { digestOf } from '../knowledge/observations.mjs';
import { canonicalJson } from '../util/canonical.mjs';

/** How an operation may be retried, which depends on what the target can guarantee. */
export const OPERATION_CLASSES = Object.freeze(['read', 'server-deduplicated', 'conditional-mutation', 'reconcilable-create', 'non-retryable']);

/** What a retry decision can be. `reconcile` means query the outcome before doing anything else. */
export const DECISIONS = Object.freeze(['retry', 'reconcile', 'halt', 'stop']);

const isText = (value) => typeof value === 'string' && value.length > 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Classify an operation by what the target guarantees, never by the surface it was invoked from.
 *
 * @param {{method?: string, serverDedup?: boolean, precondition?: object|null, reconcilable?: boolean, effect?: string}} input
 */
export function classifyOperation({ method = 'GET', serverDedup = false, precondition = null, reconcilable = false, effect = 'none' } = {}) {
  const upper = String(method).toUpperCase();
  if (upper === 'GET' || upper === 'HEAD' || effect === 'read') return 'read';
  if (serverDedup === true) return 'server-deduplicated';
  if (isObject(precondition) && isText(precondition.value)) return 'conditional-mutation';
  if (reconcilable === true) return 'reconcilable-create';
  // An unspecified write is not assumed safe to retry: guessing 'read' here would repeat a
  // mutation on the strength of a default.
  return 'non-retryable';
}

/**
 * A stable idempotency key, scoped to the intent, the step and the target.
 *
 * The same step of the same intent on the same target gets the same key on every attempt, which
 * is what lets a lost response be reconciled instead of repeated.
 */
export function idempotencyKey({ intentDigest, step, target } = {}) {
  if (!isText(intentDigest) || !isText(target)) return null;
  return `simt-${digestOf(canonicalJson({ intentDigest, step: step ?? 0, target }))}`;
}

/** The precondition a conditional mutation carries. */
export function precondition({ revision = null, etag = null } = {}) {
  const value = isText(etag) ? etag : isText(revision) ? revision : null;
  return value === null ? null : { type: isText(etag) ? 'if-match' : 'if-revision', value };
}

/** Deterministic jitter: the same schedule for the same inputs, which is what a test can diff. */
export function backoff({ attempt = 1, baseMs = 100, capMs = 5000, seed = 'simt' } = {}) {
  let hash = 0;
  for (const char of `${seed}:${attempt}`) hash = (hash * 31 + char.charCodeAt(0)) % 1000003;
  const jitter = baseMs * 0.25 * ((hash % 1000) / 1000);
  return Math.min(capMs, Math.round(baseMs * 2 ** Math.max(0, attempt - 1) + jitter));
}

/**
 * Decide what to do after an attempt.
 *
 * @param {{operation?: string, attempt?: number, status?: number|null, error?: string|null, retryAfterMs?: number|null, elapsedMs?: number, budget?: object}} input
 */
export function planRetry({ operation = 'read', attempt = 1, status = null, error = null, retryAfterMs = null, elapsedMs = 0, budget = {} } = {}) {
  const className = OPERATION_CLASSES.includes(operation) ? operation : classifyOperation({ effect: 'write' });
  const attempts = Number.isInteger(budget.attempts) ? budget.attempts : 3;
  const deadlineMs = Number.isInteger(budget.deadlineMs) ? budget.deadlineMs : 30000;
  const halt = (reason) => ({ decision: 'halt', delayMs: 0, halted: true, reason, className });
  const stop = (reason) => ({ decision: 'stop', delayMs: 0, halted: true, reason, className });

  if (className === 'non-retryable') return halt('the operation cannot be retried: the target offers no deduplication, precondition or reconciliation');
  if (status === 412 || error === 'stale-precondition') return halt('the precondition no longer holds: the object moved, and retrying would overwrite it');
  if (error === 'ambiguous-match') return halt('the name matches more than one object; reconcile by identity before acting');
  if (className === 'reconcilable-create' && (error === 'lost-response' || error === 'timeout' || (status !== null && status >= 500))) {
    return { decision: 'reconcile', delayMs: 0, halted: false, reason: 'the response was lost: query the outcome by idempotency key before any retry', className };
  }
  if (attempt >= attempts) return stop(`the attempt budget (${attempts}) is exhausted; the operation state is preserved, not reclassified as success`);
  if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) return halt(`the target rejected the request (${status}); retrying repeats a decision, not a transient failure`);
  if (status === 429 && retryAfterMs !== null) {
    const wait = Math.min(deadlineMs, Math.max(0, retryAfterMs));
    return elapsedMs + wait > deadlineMs ? stop('the deadline would pass while waiting for the rate limit to clear') : { decision: 'retry', delayMs: wait, halted: false, reason: 'rate limited; the target declared when to try again', className };
  }
  const delay = backoff({ attempt, baseMs: budget.baseMs ?? 100, capMs: budget.capMs ?? 5000, seed: budget.seed ?? 'simt' });
  if (elapsedMs + delay > deadlineMs) return stop(`the deadline (${deadlineMs}ms) would pass before the next attempt`);
  return { decision: 'retry', delayMs: delay, halted: false, reason: 'a transient failure with budget remaining', className };
}

/**
 * Whether a callback is a repeat of one already applied.
 *
 * A duplicate callback never causes another effect; this answers the local question and says
 * nothing about the target's own deduplication.
 */
export function duplicateCallback(seen = [], callback = {}) {
  const key = isObject(callback) ? idempotencyKey(callback) : null;
  if (key === null) return { duplicate: false, key: null, reason: 'the callback carries no intent, step and target' };
  const known = (Array.isArray(seen) ? seen : []).map((entry) => (isObject(entry) ? idempotencyKey(entry) : null)).filter(Boolean);
  return { duplicate: known.includes(key), key, reason: known.includes(key) ? 'this callback was already applied' : null };
}

/**
 * A simulated schedule, for tests and for showing a reviewer the shape before running it.
 */
export function simulateSchedule({ attempts = 3, baseMs = 100, capMs = 5000, seed = 'simt' } = {}) {
  return Array.from({ length: Math.max(0, attempts) }, (_, index) => backoff({ attempt: index + 1, baseMs, capMs, seed }));
}

/** Whether a surface's success signal proves idempotency. It never does. */
export function surfaceProvesIdempotency(surface) {
  return { proves: false, reason: `${surface ?? 'this surface'} reports that it accepted the action, not that the target applied it once` };
}
