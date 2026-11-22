// ST05: the Pulse replays a bounded window, then follows the append-only event log.
//
// The SSE connection is a long-lived response, so this file uses raw node:http the way
// the server tests do. The view-model is pure and is asserted without a browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { appendEvent, EVENTS_FILE } from '../src/state/events.mjs';
import { EVENT_REPLAY_LIMIT } from '../src/studio/events.mjs';
import { filterEvents, gateBrackets, glyph, pulse } from '../src/studio/public/pulse.js';
import { fixtureRepo, session, startStudio } from './studio-fixture.mjs';

function parseBlock(block) {
  let id = null;
  let event = 'message';
  const data = [];
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const at = line.indexOf(':');
    const field = at === -1 ? line : line.slice(0, at);
    const value = at === -1 ? '' : line.slice(at + 1).replace(/^ /, '');
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  const parsed = { id, event, data: data.join('\n') };
  // `retry:` and comment-only blocks are transport directives, not events.
  if (parsed.id === null && parsed.event === 'message' && parsed.data === '') return null;
  return parsed;
}

/** Open the SSE route and expose the parsed messages as they arrive. */
function openEvents(studio, cookie) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: studio.port,
      path: '/api/events',
      headers: { cookie, accept: 'text/event-stream' },
    });
    req.on('error', reject);
    req.end();
    req.on('response', (res) => {
      const messages = [];
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const message = block.trim() === '' ? null : parseBlock(block);
          if (message) messages.push(message);
        }
      });
      const waitFor = (predicate, timeout = 3000) =>
        new Promise((done, fail) => {
          const started = Date.now();
          const poll = () => {
            if (predicate(messages)) return done(messages);
            if (Date.now() - started > timeout) return fail(new Error(`SSE timed out: ${JSON.stringify(messages)}`));
            setTimeout(poll, 10);
          };
          poll();
        });
      resolve({
        status: res.statusCode,
        headers: res.headers,
        messages,
        waitFor,
        close: () => req.destroy(),
      });
    });
  });
}

async function openStudio(t) {
  const root = await fixtureRepo();
  const studio = await startStudio(root);
  t.after(() => studio.stop());
  const cookie = await session(studio);
  const events = await openEvents(studio, cookie);
  t.after(() => events.close());
  return { root, studio, events };
}

test('a late connector receives the replay window in order with ULIDs', async (t) => {
  const root = await fixtureRepo();
  const appended = [];
  for (const subject of ['first', 'second', 'third']) {
    appended.push(await appendEvent(root, { kind: 'gate.started', subject }));
  }
  const studio = await startStudio(root);
  t.after(() => studio.stop());
  const cookie = await session(studio);
  const events = await openEvents(studio, cookie);
  t.after(() => events.close());

  assert.equal(events.status, 200);
  assert.match(events.headers['content-type'], /text\/event-stream/);
  const got = await events.waitFor((messages) => messages.length >= 3);
  assert.deepEqual(got.slice(0, 3).map((message) => message.id), appended.map((event) => event.id));
  assert.deepEqual(
    got.slice(0, 3).map((message) => JSON.parse(message.data).subject),
    ['first', 'second', 'third'],
  );
});

test('events appended while connected arrive after the replay', async (t) => {
  const { root, events } = await openStudio(t);
  const before = await appendEvent(root, { kind: 'gate.started', subject: 'before' });
  await events.waitFor((messages) => messages.some((message) => message.id === before.id));
  const after = await appendEvent(root, { kind: 'gate.finished', subject: 'after', data: { exit: 0 } });
  const got = await events.waitFor((messages) => messages.some((message) => message.id === after.id));
  const ids = got.map((message) => message.id).filter(Boolean);
  assert.deepEqual(ids.slice(-2), [before.id, after.id]);
  assert.equal(JSON.parse(got.find((message) => message.id === after.id).data).data.exit, 0);
});

test('the replay is bounded to the newest events', async (t) => {
  const root = await fixtureRepo();
  const appended = [];
  for (let i = 0; i < EVENT_REPLAY_LIMIT + 3; i += 1) {
    appended.push(await appendEvent(root, { kind: 'lesson.captured', subject: `event ${i}` }));
  }
  const studio = await startStudio(root);
  t.after(() => studio.stop());
  const cookie = await session(studio);
  const events = await openEvents(studio, cookie);
  t.after(() => events.close());
  const got = await events.waitFor((messages) => messages.length >= EVENT_REPLAY_LIMIT);
  assert.equal(got.length, EVENT_REPLAY_LIMIT);
  assert.deepEqual(
    got.map((message) => message.id),
    appended.slice(-EVENT_REPLAY_LIMIT).map((event) => event.id),
  );
});

test('a truncated log sends resync and the replacement events, without duplicates', async (t) => {
  const { root, events } = await openStudio(t);
  const old = await appendEvent(root, { kind: 'gate.started', subject: 'old' });
  await events.waitFor((messages) => messages.some((message) => message.id === old.id));

  await writeFile(join(root, EVENTS_FILE), '');
  const replacement = await appendEvent(root, { kind: 'gate.finished', subject: 'replacement' });
  const got = await events.waitFor(
    (messages) => messages.some((message) => message.event === 'resync') &&
      messages.some((message) => message.id === replacement.id),
  );
  const reset = got.findIndex((message) => message.event === 'resync');
  assert.ok(reset >= 0, 'no resync signal');
  assert.match(JSON.parse(got[reset].data).reason, /rotated or truncated/);
  assert.equal(
    got.slice(reset + 1).filter((message) => message.id === old.id).length,
    0,
    'the old event was replayed after truncation',
  );
  assert.equal(got.slice(reset + 1).filter((message) => message.id === replacement.id).length, 1);
});

test('the feed carries event metadata, never a file body', async (t) => {
  const { root, events } = await openStudio(t);
  await writeFile(join(root, 'secret.txt'), 'TOP SECRET FILE BODY\n');
  const event = await appendEvent(root, {
    kind: 'lesson.captured',
    subject: 'secret.txt',
    data: { paths: ['secret.txt'] },
  });
  const got = await events.waitFor((messages) => messages.some((message) => message.id === event.id));
  const message = got.find((entry) => entry.id === event.id);
  assert.ok(message.data.includes('secret.txt'));
  assert.ok(!message.data.includes('TOP SECRET FILE BODY'), 'the feed read the file body');
});

test('gate brackets pair by subject and keep open and orphan runs visible', () => {
  const events = [
    { id: '1', kind: 'gate.started', subject: 'npm test', ts: '2026-11-22T10:00:00Z' },
    { id: '2', kind: 'policy.decided', subject: 'bash', ts: '2026-11-22T10:00:01Z' },
    { id: '3', kind: 'gate.finished', subject: 'npm test', ts: '2026-11-22T10:00:02Z' },
    { id: '4', kind: 'gate.finished', subject: 'orphan', ts: '2026-11-22T10:00:03Z' },
    { id: '5', kind: 'gate.started', subject: 'open', ts: '2026-11-22T10:00:04Z' },
  ];
  const brackets = gateBrackets(events);
  assert.deepEqual(brackets.map((bracket) => [bracket.subject, bracket.state]), [
    ['npm test', 'closed'],
    ['orphan', 'orphan'],
    ['open', 'open'],
  ]);
  assert.equal(brackets[0].start.index, 0);
  assert.equal(brackets[0].finish.index, 2);
  assert.deepEqual(filterEvents(events, 'gate.finished').map((event) => event.id), ['3', '4']);
  assert.equal(filterEvents(events, 'all').length, events.length);
  assert.equal(glyph('gate.finished'), '■');
});

test('the Gate brackets table is a labelled narrow scroll region', () => {
  const html = pulse([
    { id: '1', kind: 'gate.started', subject: 'npm test', ts: '2026-11-22T10:00:00Z' },
    { id: '2', kind: 'gate.finished', subject: 'npm test', ts: '2026-11-22T10:00:02Z' },
  ]);
  assert.match(html, /<div class="pulse-brackets" role="region" aria-label="Gate brackets" tabindex="0">/);
  assert.match(html, /<table class="table">/);
  assert.match(html, /npm test/);
});

test('the rendered pulse is an ARIA live feed with click-through and escaped values', () => {
  const html = pulse([
    { id: '1', kind: 'policy.decided', subject: '<img src=x onerror=alert(1)>', harness: 'claude', ts: '2026-11-22T10:00:00Z' },
  ]);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /href="#\/harness"/);
  assert.match(html, /policy\.decided/);
  assert.ok(!html.includes('<img'));
  assert.match(html, /&lt;img/);
  assert.match(html, /how this was computed/i);
});
