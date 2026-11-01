// One append-only event log for everything this tool observes about itself (Q73).
//
// The stores that record what happened - the evidence ledger, the lessons file, the lease
// file, the check cache - were five files with three version keys and no shared shape, so
// nothing could tail them and no UI could show a run. An event is one line with one
// envelope, appended with `O_APPEND` so two writers never rewrite each other's history.
//
// The log is the record; the ledger and the lessons file are projections of it. A reader
// that still reads the old file gets the same answer, because the projection is written to
// the same place it always was - but a line lost to rotation is recoverable here, and a
// consumer that wants to watch a run live has one file to follow.
//
// `O_APPEND` matters more than it looks: a lease write and a gate run in two processes can
// land at the same moment, and a read-modify-write of a shared log would drop one of them.
// That is the same defect the lease lock exists for, and an append does not need the lock.

import { randomBytes } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { localRel, readStateFile } from '../state.mjs';

/** Where the log lives: machine-local state, so no run changes the tree it describes. */
export const EVENTS_FILE = localRel('events.jsonl');
const EVENTS_LEGACY = '.simt/events.jsonl';

/**
 * The closed set of kinds. A kind that is not here is a typo that would otherwise sit in
 * the log forever, unread by every consumer and silently meaningless.
 */
export const EVENT_KINDS = Object.freeze([
  'gate.started',
  'gate.finished',
  'policy.decided',
  'lease.acquired',
  'lease.released',
  'lease.expired',
  'slice.transitioned',
  'write.committed',
  'write.undone',
  'lesson.captured',
]);

/** Crockford base32, the alphabet ULID uses: no I, L, O or U, so a hand-copied id is unambiguous. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A ULID: 48 bits of milliseconds, then 80 bits of randomness.
 *
 * Chosen over a UUID because it sorts by time as bytes, which is what makes a log
 * appendable and a tail read meaningful without parsing timestamps.
 */
export function ulid(now = Date.now()) {
  let time = '';
  let left = now;
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[left % 32] + time;
    left = Math.floor(left / 32);
  }
  const bytes = randomBytes(16);
  let random = '';
  for (let i = 0; i < 16; i += 1) random += CROCKFORD[bytes[i] % 32];
  return `${time}${random}`;
}

/**
 * Append one event, or throw.
 *
 * A caller that cannot record what it did has to hear about it: a swallowed failure here
 * is a gate that ran and left no evidence, which is the state the ledger exists to make
 * impossible.
 */
export async function appendEvent(root, { kind, session = null, harness = null, tree = null, subject = null, data = {} }) {
  if (!EVENT_KINDS.includes(kind)) {
    throw new Error(`unknown event kind: ${kind}`);
  }
  const event = {
    v: 1,
    id: ulid(),
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    kind,
    session,
    harness,
    tree,
    subject,
    data,
  };
  const path = join(root, EVENTS_FILE);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`);
  return event;
}

/**
 * Best-effort append for a caller whose primary job must not fail on a log write.
 *
 * Used by `undo` and by lesson capture: the work those commands do is already done, and
 * throwing afterwards would report a failure the user cannot act on. The error is returned
 * rather than swallowed so a caller that wants to surface it can.
 */
export async function noteEvent(root, event) {
  try {
    return { event: await appendEvent(root, event), error: null };
  } catch (error) {
    return { event: null, error: error.message };
  }
}

/** Every well-formed event, oldest first; damaged lines are reported, never hidden. */
export async function readEvents(root, { limit = 0 } = {}) {
  const { text } = await readStateFile(root, EVENTS_FILE, [EVENTS_LEGACY]);
  if (text === null) return { events: [], errors: [] };
  const events = [];
  const errors = [];
  for (const [i, raw] of text.split('\n').entries()) {
    if (raw.trim() === '') continue;
    try {
      const event = JSON.parse(raw);
      if (typeof event?.id !== 'string' || typeof event?.kind !== 'string') {
        errors.push(`line ${i + 1} has no id or kind`);
        continue;
      }
      events.push(event);
    } catch (error) {
      errors.push(`line ${i + 1} does not parse (${error.message})`);
    }
  }
  return { events: limit > 0 ? events.slice(-limit) : events, errors };
}
