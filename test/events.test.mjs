// One append-only event log (review 0003 Q73).
//
// The properties a consumer depends on: the envelope is the same for every kind, an id
// sorts by time, a damaged line is reported rather than making the log look empty, and the
// commands that coordinate agents write to it - because a log that only the gate writes to
// is a log no one would build a UI on.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EVENT_KINDS, EVENTS_FILE, appendEvent, readEvents, ulid } from '../src/state/events.mjs';
import { commitJournal, journaledWriteFile } from '../src/journal.mjs';
import { git } from './fixture.mjs';

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'simt-events-'));
  await git(['init', '-q', root]);
  return root;
}

test('a ulid sorts by time as bytes and uses the Crockford alphabet', () => {
  const early = ulid(1_700_000_000_000);
  const late = ulid(1_700_000_000_001);
  assert.ok(early < late, `${early} should sort before ${late}`);
  assert.equal(early.length, 26);
  assert.match(early, /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('every event carries one envelope, and an unknown kind is refused', async () => {
  const root = await repo();
  try {
    const event = await appendEvent(root, { kind: 'gate.finished', tree: 'abc', subject: 'npm test', data: { exit: 0 } });
    assert.equal(event.v, 1);
    assert.match(event.id, /^[0-9A-Z]{26}$/);
    assert.match(event.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    for (const key of ['v', 'id', 'ts', 'kind', 'session', 'harness', 'tree', 'subject', 'data']) {
      assert.ok(key in event, `the envelope is missing ${key}`);
    }
    await assert.rejects(() => appendEvent(root, { kind: 'nope' }), /unknown event kind/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the log reads back oldest first and reports a damaged line', async () => {
  const root = await repo();
  try {
    await appendEvent(root, { kind: 'gate.started', subject: 'first' });
    await appendEvent(root, { kind: 'gate.finished', subject: 'second' });
    await writeFile(join(root, EVENTS_FILE), 'not json\n', { flag: 'a' });
    const { events, errors } = await readEvents(root);
    assert.deepEqual(events.map((e) => e.subject), ['first', 'second']);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /does not parse/);
    assert.deepEqual((await readEvents(root, { limit: 1 })).events.map((e) => e.subject), ['second']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a journal commit writes one write.committed event', async () => {
  const root = await repo();
  try {
    const acc = [];
    await journaledWriteFile(root, acc, join(root, 'a.txt'), 'a\n');
    await commitJournal(root, 'test-run', acc);
    const { events } = await readEvents(root);
    const committed = events.filter((e) => e.kind === 'write.committed');
    assert.equal(committed.length, 1);
    assert.equal(committed[0].subject, 'test-run');
    assert.deepEqual(committed[0].data.paths, ['a.txt']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the kinds are a closed set a consumer can enumerate', () => {
  assert.ok(EVENT_KINDS.includes('gate.finished'));
  assert.ok(EVENT_KINDS.includes('lease.acquired'));
  assert.ok(EVENT_KINDS.includes('lesson.captured'));
  assert.equal(new Set(EVENT_KINDS).size, EVENT_KINDS.length);
});
