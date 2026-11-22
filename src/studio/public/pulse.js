// The Pulse's view-model: a deterministic ribbon over event envelopes.
//
// Events arrive as the same metadata the log carries; this module never reads a path an
// event names. The gate pairing is by subject, because that is the key the gate dispatch
// writes, and it keeps an unfinished start visible instead of letting a later finish
// silently close the wrong bracket.

import { badge, card, emptyState, escapeHtml, table } from './components.js';

const GLYPHS = Object.freeze({
  'gate.started': '▶',
  'gate.finished': '■',
  'policy.decided': '⚖',
  'lease.acquired': '⚑',
  'lease.released': '⚐',
  'lease.expired': '⌛',
  'slice.transitioned': '⇥',
  'write.committed': '✎',
  'write.undone': '↶',
  'write.undo-refused': '⊘',
  'lesson.captured': '✦',
});

const TONES = Object.freeze({
  'gate.started': 'accent',
  'gate.finished': 'ok',
  'policy.decided': 'warn',
  'lease.acquired': 'accent',
  'lease.released': 'neutral',
  'lease.expired': 'bad',
  'slice.transitioned': 'accent',
  'write.committed': 'ok',
  'write.undone': 'warn',
  'write.undo-refused': 'bad',
  'lesson.captured': 'accent',
});

const ROUTES = Object.freeze({
  'gate.started': '#/custody',
  'gate.finished': '#/custody',
  'policy.decided': '#/harness',
  'lease.acquired': '#/board',
  'lease.released': '#/board',
  'lease.expired': '#/board',
  'slice.transitioned': '#/board',
  'write.committed': '#/custody',
  'write.undone': '#/custody',
  'write.undo-refused': '#/custody',
  'lesson.captured': '#/library',
});

export function glyph(kind) {
  return GLYPHS[kind] ?? '·';
}

export function tone(kind) {
  return TONES[kind] ?? 'neutral';
}

/** The room that explains the event's subject. */
function viewFor(kind) {
  return ROUTES[kind] ?? '#/overview';
}

/** All events, or only one kind; `all` and an empty value mean no filter. */
export function filterEvents(events, kind = 'all') {
  if (!kind || kind === 'all') return events;
  return events.filter((event) => event.kind === kind);
}

/**
 * Pair gate starts with their finishes in event order.
 *
 * A finish without a start is an orphan, and a start without a finish stays open; neither
 * is hidden behind a green summary. The returned list is ordered by the start (or orphan
 * finish) position, so a ribbon can draw the bracket from the two indexes.
 */
export function gateBrackets(events) {
  const open = new Map();
  const pairs = [];
  for (const [index, event] of events.entries()) {
    const subject = String(event.subject ?? event.id);
    if (event.kind === 'gate.started') {
      if (!open.has(subject)) open.set(subject, []);
      open.get(subject).push({ event, index });
    } else if (event.kind === 'gate.finished') {
      const queue = open.get(subject) ?? [];
      const start = queue.shift();
      if (start) {
        pairs.push({ subject, start, finish: { event, index }, state: 'closed' });
      } else {
        pairs.push({ subject, start: null, finish: { event, index }, state: 'orphan' });
      }
    }
  }
  for (const [subject, queue] of open) {
    for (const start of queue) pairs.push({ subject, start, finish: null, state: 'open' });
  }
  return pairs.sort((a, b) => {
    const left = a.start?.index ?? a.finish.index;
    const right = b.start?.index ?? b.finish.index;
    return left - right;
  });
}

function stamp(event) {
  const value = event.ts ?? '';
  return escapeHtml(value);
}

function eventItem(event) {
  const href = viewFor(event.kind);
  const subject = event.subject ?? event.id;
  const detail = event.harness ? ` ${badge(event.harness, 'neutral')}` : '';
  return `<li class="pulse-event pulse-${tone(event.kind)}" data-kind="${escapeHtml(event.kind)}">
    <a class="pulse-link" href="${href}" title="${escapeHtml(`${event.kind}: ${subject}`)}">
      <span class="pulse-glyph" aria-hidden="true">${escapeHtml(glyph(event.kind))}</span>
      <span class="pulse-kind">${escapeHtml(event.kind)}</span>
      <span class="pulse-subject">${escapeHtml(subject)}</span>
    </a>
    <time class="pulse-time" datetime="${stamp(event)}">${stamp(event)}</time>${detail}
  </li>`;
}

function bracketRows(brackets) {
  return brackets.map(({ subject, start, finish, state }) => {
    const duration =
      start && finish && start.event.ts && finish.event.ts
        ? Math.max(0, Date.parse(finish.event.ts) - Date.parse(start.event.ts))
        : null;
    return [
      subject,
      state,
      start ? start.event.kind : '—',
      finish ? finish.event.kind : '—',
      duration === null ? '—' : `${duration} ms`,
    ];
  });
}

/**
 * Render the room's shell. `events` is already the live list; the caller replaces the
 * returned `#pulse-feed` on each event so a stream can append without owning the markup.
 */
export function pulse(events = [], { kind = 'all', connected = true } = {}) {
  const shown = filterEvents(events, kind);
  const brackets = gateBrackets(events);
  const kinds = [...new Set(events.map((event) => event.kind))].sort();
  const filters = [
    `<option value="all"${kind === 'all' ? ' selected' : ''}>all kinds</option>`,
    ...kinds.map(
      (value) =>
        `<option value="${escapeHtml(value)}"${value === kind ? ' selected' : ''}>${escapeHtml(value)}</option>`,
    ),
  ].join('');
  const ribbon = shown.length
    ? `<ol class="pulse-ribbon" aria-label="event ribbon">${shown.map(eventItem).join('')}</ol>`
    : emptyState({ title: 'No events yet', hint: 'Start a gate, claim a lease or write through simt to see it here.' });
  const feed = `<div id="pulse-feed" class="pulse-feed" role="log" aria-live="polite" aria-relevant="additions">${ribbon}</div>`;
  const bracketTable = brackets.length
    ? `<div class="pulse-brackets" role="region" aria-label="Gate brackets" tabindex="0">${table({
        columns: ['gate', 'state', 'start', 'finish', 'duration'],
        rows: bracketRows(brackets),
      })}</div>`
    : '<p class="empty-hint">No gate brackets in this window.</p>';
  const status = connected ? badge('live', 'ok') : badge('reconnecting', 'warn');
  return `${card({
    title: 'The Pulse',
    body: `<p class="pulse-intro">The repository's heartbeat, replayed from <code>.simt/local/events.jsonl</code> and then followed live. Event metadata only.</p>
      <div class="pulse-controls"><label for="pulse-kind">show</label><select id="pulse-kind">${filters}</select>${status}</div>
      ${feed}`,
  })}${card({
    title: 'Gate brackets',
    body: bracketTable,
    footer: badge(`${brackets.filter((b) => b.state === 'closed').length} closed`, 'ok') +
      badge(`${brackets.filter((b) => b.state === 'open').length} open`, 'warn') +
      badge(`${brackets.filter((b) => b.state === 'orphan').length} orphan`, 'bad'),
  })}${card({
    title: 'How this was computed',
    body: '<p class="computed">read <code>.simt/local/events.jsonl</code> through <code>GET /api/events</code>; replay is bounded to the latest complete lines, and the payload is event metadata only.</p>',
  })}`;
}
