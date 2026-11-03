// Bounded external executor and event state machine (W33).
//
// The core never executes anything: it records what was decided, what was dispatched and what was
// observed, so a crash leaves a journal that says which of those actually happened. The failures
// this shape is built around:
//
//   * a dispatch with no write-ahead record, so after a crash nobody could tell whether the
//     request left the process;
//   * a cancellation during dispatch recorded as cancelled, when the request may already have
//     changed something;
//   * a disconnected process assumed stopped, so its in-flight effect was forgotten;
//   * "exactly once" claimed without server-side deduplication;
//   * a shell string handed to the executor, which is not a command but a program;
//   * a side-effecting adapter enabled because it was installed.
//
// Event ids deduplicate local recording only. They never imply the remote effect was deduplicated;
// that requires the server-side support W34 classifies.

import { digestOf } from '../knowledge/observations.mjs';
import { canonicalJson } from '../util/canonical.mjs';

export const MACHINE_SCHEMA = 'simt.machine/1';

/** The happy path. */
export const STATES = Object.freeze(['planned', 'ready', 'executing', 'observing', 'verified']);

/** The states a run can end in, or pass through, when something goes wrong. */
export const SIDE_STATES = Object.freeze(['blocked', 'failed', 'outcome-unknown', 'compensating', 'compensated']);

/** States with no outgoing transition. */
export const TERMINAL_STATES = Object.freeze(['verified', 'failed', 'compensated']);

/** Every transition the machine allows, and the journal never learns a new one at runtime. */
const TRANSITIONS = Object.freeze({
  planned: ['ready', 'blocked', 'failed'],
  ready: ['executing', 'blocked', 'failed'],
  executing: ['observing', 'failed', 'outcome-unknown'],
  observing: ['verified', 'failed', 'outcome-unknown'],
  'outcome-unknown': ['observing', 'verified', 'failed'],
  failed: ['compensating'],
  compensating: ['compensated', 'failed'],
  blocked: ['ready', 'failed'],
  verified: [],
  compensated: [],
});

const isText = (value) => typeof value === 'string' && value.length > 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The write-ahead record. It is written before dispatch, with the operation id and the intent
 * digest, so a journal read after a crash can name the operation that may be in flight.
 */
export function beginOperation({ operationId, intentDigest, step = 0, now = null, correlation = null, adapter = null } = {}) {
  if (!isText(operationId)) throw new Error('a write-ahead record needs an operation id');
  if (!isText(intentDigest)) throw new Error('a write-ahead record needs the intent digest it executes');
  const event = { state: 'planned', at: now, reason: null };
  return {
    schema: MACHINE_SCHEMA,
    operationId,
    intentDigest,
    step,
    adapter: isText(adapter) ? adapter : null,
    correlation: isObject(correlation) ? { local: correlation.local ?? null, remote: correlation.remote ?? null, verify: correlation.verify ?? null } : null,
    state: 'planned',
    history: [event],
  };
}

/**
 * Advance a record. An illegal transition is an error, not a silent no-op: a journal that
 * describes an impossible path is worse than no journal.
 */
export function transition(record, to, { now = null, reason = null } = {}) {
  const from = record?.state;
  const allowed = TRANSITIONS[from];
  if (!allowed) throw new Error(`unknown state ${JSON.stringify(from)}`);
  if (!allowed.includes(to)) throw new Error(`the machine cannot go from ${from} to ${to}`);
  return { ...record, state: to, history: [...record.history, { from, to, at: now, reason }] };
}

/** Mark the dispatch. Before this point nothing has left the process. */
export const dispatch = (record, options = {}) => transition(record, 'ready', options);

/**
 * Cancel. During dispatch the effect may already be in flight, so the only honest state is
 * `outcome-unknown` until something reconciles it.
 */
export function cancel(record, { now = null } = {}) {
  if (record?.state === 'executing') {
    return transition(record, 'outcome-unknown', { now, reason: 'cancelled during dispatch: the request may already have taken effect' });
  }
  return transition(record, 'failed', { now, reason: 'cancelled before dispatch; nothing left the process' });
}

/**
 * Rebuild a record from its journal, which is what a resumed process does instead of assuming it
 * was the only one running.
 */
export function replay(journal = []) {
  // A transition event records where it went in `to`; only the opening event carries `state`.
  // Reading only `state` silently discarded every transition after the first.
  const events = (Array.isArray(journal) ? journal : []).filter((event) => isObject(event) && (isText(event.state) || isText(event.to)));
  if (events.length === 0) return { state: null, resumable: false, reason: 'the journal is empty, so nothing is known about this operation' };
  const last = events[events.length - 1];
  const state = last.to ?? last.state;
  return {
    state,
    resumable: !TERMINAL_STATES.includes(state),
    inFlight: state === 'executing' || state === 'outcome-unknown',
    reason: state === 'executing' ? 'the process stopped during dispatch; the effect may be in flight and a live process cannot be assumed stopped' : null,
  };
}

/**
 * Record a local event, once.
 *
 * A duplicate id means the local log already holds this event. It says nothing about the remote
 * effect, which is why `remoteEffectsChanged` is always false here.
 */
export function recordEvent(events = [], event = {}) {
  const list = Array.isArray(events) ? events : [];
  if (!isObject(event) || !isText(event.id)) return { events: list, recorded: false, reason: 'an event needs an id', remoteEffectsChanged: false };
  if (list.some((existing) => existing?.id === event.id)) return { events: list, recorded: false, reason: `event ${event.id} was already recorded`, remoteEffectsChanged: false };
  return { events: [...list, event], recorded: true, reason: null, remoteEffectsChanged: false };
}

/**
 * Check a command the executor was asked to run.
 *
 * A shell string is refused outright: `npm test && rm -rf build` is a program, and the executor
 * runs registered runners with validated argv and a restricted environment.
 */
export function checkCommand({ command = null, argv = [], registered = [] } = {}) {
  if (!isText(command)) return { allowed: false, reason: 'no runner was named' };
  if (/[\s;&|><$`\\]/.test(command)) {
    return { allowed: false, reason: 'a shell string is not a command; name a registered runner and pass argv' };
  }
  if (!(Array.isArray(registered) ? registered : []).includes(command)) {
    return { allowed: false, reason: `${command} is not a registered runner` };
  }
  if (!Array.isArray(argv) || argv.some((entry) => typeof entry !== 'string' || /[\n\0]/.test(entry))) {
    return { allowed: false, reason: 'argv must be strings without control characters' };
  }
  return { allowed: true, reason: null, env: 'restricted' };
}

/**
 * Whether a side-effecting adapter may run. Installed is not enabled.
 */
export function adapterEnabled(config = {}, name) {
  return isObject(config?.adapters) && config.adapters[name] === true;
}

/**
 * Whether the machine can promise exactly once for this adapter.
 */
export function executionGuarantee({ serverDeduplication = false, atomicPrecondition = false } = {}) {
  if (serverDeduplication || atomicPrecondition) return { promise: 'at-most-once-per-effect', reason: 'the target deduplicates or enforces the precondition' };
  return { promise: 'at-least-once', reason: 'no exactly-once claim without server-side deduplication or an atomic precondition' };
}

/** The digest a reviewer can compare across the journal, the request and the verifier. */
export const recordDigest = (record) => digestOf(canonicalJson({ operationId: record?.operationId ?? null, intentDigest: record?.intentDigest ?? null, step: record?.step ?? null }));
