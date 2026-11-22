// The studio's live event feed: replay a bounded tail, then follow appended lines.
//
// The log is already append-only and every line carries a ULID, so the feed needs no
// second index. The offset is the whole state: a new connection replays the last complete
// lines before that offset, and every poll reads only bytes appended after it. A missing,
// truncated or replaced file cannot be distinguished from "nothing new" by size alone, so
// the inode and size are both tracked; when either says the file was rotated, the client
// gets a resync event rather than a silent gap.

import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { EVENTS_FILE } from '../state/events.mjs';

export const EVENT_REPLAY_LIMIT = 100;
export const EVENT_REPLAY_BYTES = 64 * 1024;
export const EVENT_POLL_MS = 100;
export const EVENT_HEARTBEAT_MS = 15000;

const EVENT_PATH = (root) => join(root, EVENTS_FILE);

/** Parse one complete log line, keeping the envelope fields the feed may render. */
export function parseEventLine(line) {
  if (line.trim() === '') return null;
  try {
    const event = JSON.parse(line);
    if (typeof event?.id !== 'string' || typeof event?.kind !== 'string') return null;
    return event;
  } catch {
    return null;
  }
}

/** Read bytes without asking for the whole file. */
async function readRange(path, offset, length) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Split a byte range into complete lines.
 *
 * `base` is the file offset where `text` began. A replay may start in the middle of a
 * line (the byte window is bounded, not line-aligned), so the first partial line is
 * discarded. A trailing partial line is left for the next read: its bytes are not an
 * event yet, and advancing past it would lose the line once the writer finishes it.
 */
function completeLines(text, base, { discardFirst = false } = {}) {
  let offset = base;
  if (discardFirst) {
    const first = text.indexOf('\n');
    if (first === -1) return { events: [], offset };
    offset += Buffer.byteLength(text.slice(0, first + 1));
    text = text.slice(first + 1);
  }
  const last = text.lastIndexOf('\n');
  if (last === -1) return { events: [], offset };
  const complete = text.slice(0, last + 1);
  const events = complete
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(parseEventLine)
    .filter(Boolean);
  return { events, offset: offset + Buffer.byteLength(complete) };
}

/**
 * The replay window for a new connection.
 *
 * The last `limit` parseable events within the last `bytes` bytes, oldest first, and the
 * offset after the last complete line read. A missing log is an empty window at offset 0;
 * the caller keeps polling so a log created later still becomes live.
 */
export async function replayWindow(path, { limit = EVENT_REPLAY_LIMIT, bytes = EVENT_REPLAY_BYTES } = {}) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return { events: [], offset: 0, exists: false, ino: null };
    throw error;
  }
  const start = Math.max(0, info.size - bytes);
  const text = await readRange(path, start, info.size - start);
  const { events, offset } = completeLines(text, start, { discardFirst: start > 0 });
  // A rotation can keep the inode and grow back past the old offset before the next
  // poll. The first bytes survive every normal append, so a changed prefix is the
  // evidence that the file was replaced rather than extended.
  const prefix = info.size > 0 ? await readRange(path, 0, Math.min(64, info.size)) : '';
  return {
    events: events.slice(-limit),
    offset,
    exists: true,
    ino: info.ino,
    prefix,
  };
}

function write(res, chunk) {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(chunk);
    return true;
  } catch {
    return false;
  }
}

function sendEvent(res, event) {
  // SSE data is line-oriented. JSON.stringify never emits a raw newline, but the id is
  // checked too so a hand-edited log line cannot inject a second field.
  const id = String(event.id).replace(/[\r\n]/g, '');
  return write(res, `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`);
}

function sendResync(res, reason) {
  return write(res, `event: resync\ndata: ${JSON.stringify({ reason })}\n\n`);
}

/**
 * Serve one authenticated GET as an SSE stream.
 *
 * The caller owns authentication and headers; this function owns only the feed body and
 * its lifetime. It never writes the log and never reads a file named by an event: the
 * payload is the event envelope already appended by the tool.
 *
 * @returns {() => void} stop the timers and detach listeners
 */
export function streamEvents({
  root,
  req,
  res,
  headers,
  replayLimit = EVENT_REPLAY_LIMIT,
  replayBytes = EVENT_REPLAY_BYTES,
  pollMs = EVENT_POLL_MS,
  heartbeatMs = EVENT_HEARTBEAT_MS,
} = {}) {
  const path = EVENT_PATH(root);
  let stopped = false;
  let timer = null;
  let heartbeat = null;
  let state = { exists: false, offset: 0, ino: null, prefix: '' };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    timer = null;
    heartbeat = null;
    res?.removeListener?.('close', stop);
  };

  res.writeHead(200, headers);
  if (req?.method === 'HEAD') {
    res.end();
    return stop;
  }
  res.flushHeaders?.();
  write(res, 'retry: 2000\n\n');

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(poll, pollMs);
    timer.unref?.();
  };

  const accept = (events) => {
    for (const event of events) {
      if (!sendEvent(res, event)) {
        stop();
        return false;
      }
    }
    return true;
  };

  async function poll() {
    timer = null;
    if (stopped) return;
    try {
      const info = await stat(path);
      if (stopped) return;
      if (!state.exists) {
        const window = await replayWindow(path, { limit: replayLimit, bytes: replayBytes });
        if (stopped) return;
        if (!accept(window.events)) return;
        state = { exists: window.exists, offset: window.offset, ino: info.ino, prefix: window.prefix };
      } else if (
        info.ino !== state.ino ||
        info.size < state.offset ||
        (state.offset > 0 && (await readRange(path, 0, Math.min(64, info.size))) !== state.prefix)
      ) {
        // A rotation can reuse the same size, so inode is the stronger signal; a
        // truncation keeps the inode but moves the offset backwards.
        if (!sendResync(res, 'the event log was rotated or truncated; replay from the new file')) {
          stop();
          return;
        }
        state = { exists: false, offset: 0, ino: null, prefix: '' };
      } else if (info.size > state.offset) {
        const text = await readRange(path, state.offset, info.size - state.offset);
        if (stopped) return;
        const { events, offset } = completeLines(text, state.offset, { discardFirst: false });
        if (!accept(events)) return;
        state = { exists: true, offset, ino: info.ino, prefix: state.prefix };
      }
    } catch (error) {
      if (stopped) return;
      if (error.code === 'ENOENT') {
        if (state.exists) {
          if (!sendResync(res, 'the event log was removed; replay when it returns')) {
            stop();
            return;
          }
          state = { exists: false, offset: 0, ino: null, prefix: '' };
        }
      } else if (!sendResync(res, `the event log could not be read: ${error.message}`)) {
        stop();
        return;
      }
    }
    schedule();
  }

  res?.on?.('close', stop);
  heartbeat = setInterval(() => {
    if (!stopped) write(res, ': heartbeat\n\n');
  }, heartbeatMs);
  heartbeat.unref?.();

  // Replay before the first poll, so the connecting client sees the recent past without
  // waiting a poll interval. The poll still runs even when the file is absent.
  void (async () => {
    try {
      const window = await replayWindow(path, { limit: replayLimit, bytes: replayBytes });
      if (stopped) return;
      if (window.exists && !accept(window.events)) return;
      state = { exists: window.exists, offset: window.offset, ino: window.ino ?? null, prefix: window.prefix ?? '' };
      schedule();
    } catch (error) {
      if (stopped) return;
      sendResync(res, `the event log could not be read: ${error.message}`);
      schedule();
    }
  })();

  return stop;
}
