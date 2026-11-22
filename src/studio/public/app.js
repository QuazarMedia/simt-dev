// The shell entry: theme, navigation state, and the route table. Rooms whose views
// ship in later slices render an honest empty state, not a broken link. The home
// room reads /api/status through the same client every later view uses, so the
// fetch path and the refusal rendering are exercised from the first load.

import { readDoor } from './client.js';
import { badge, card, emptyState, escapeHtml, refusalPanel } from './components.js';
import { board } from './board.js';
import { custody } from './custody.js';
import { overview } from './overview.js';
import { pulse } from './pulse.js';
import { createRouter } from './router.js';

const THEME_KEY = 'simt-studio-theme';

function bootTheme() {
  const root = document.documentElement;
  const button = document.getElementById('theme-toggle');
  const stored = localStorage.getItem(THEME_KEY);
  const system = matchMedia('(prefers-color-scheme: light)');
  const initial = stored === 'light' || stored === 'dark' ? stored : (system.matches ? 'light' : 'dark');

  const apply = (theme) => {
    root.dataset.theme = theme;
    button.textContent = theme === 'dark' ? 'light mode' : 'dark mode';
    button.setAttribute('aria-label', `switch to ${theme === 'dark' ? 'light' : 'dark'} mode`);
  };
  apply(initial);
  button.addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, next);
    apply(next);
  });
}

async function home() {
  const doc = await readDoor('/api/status');
  const facts = `<dl class="facts"><dt>root</dt><dd>${escapeHtml(doc.root)}</dd><dt>head</dt><dd>${escapeHtml(doc.head ?? 'unborn')}</dd></dl>`;
  const verdict = doc.ok ? badge('gate green', 'ok') : badge('gate red', 'bad');
  return (
    card({ title: 'This repository', body: facts, footer: `${verdict} ${badge('read-only', 'neutral')}` }) +
    card({
      title: 'The studio',
      body: '<p>One loopback socket, opened by <code>simt studio</code> and guarded by a one-time token. Every room reads the same facts the CLI and MCP doors serve; nothing is written, and nothing leaves this machine.</p><p>Stop the studio with <kbd>Ctrl-C</kbd> in the terminal that started it.</p>',
    })
  );
}

const later = (name) => () => emptyState({ title: name, hint: 'This room is not part of this build yet.' });

let pulseSource = null;
function closePulse() {
  if (pulseSource) {
    pulseSource.close();
    pulseSource = null;
  }
}

// The Pulse is the one room that keeps a socket open after its first render. The stream
// is replaced on every return to the room, and a resync clears the ribbon before the
// server's replay arrives; nothing else in the shell owns an EventSource.
function pulseRoom() {
  closePulse();
  const state = { events: [], kind: 'all', connected: true };
  const markup = () => `<div id="pulse-room">${pulse(state.events, { kind: state.kind, connected: state.connected })}</div>`;
  const bindFilter = () => {
    const select = document.getElementById('pulse-kind');
    select?.addEventListener('change', () => {
      state.kind = select.value;
      draw();
    });
  };
  const draw = () => {
    const view = document.getElementById('view');
    if (!view || !document.getElementById('pulse-room')) return;
    view.innerHTML = markup();
    bindFilter();
  };

  setTimeout(() => {
    if (location.hash !== '#/pulse' || !document.getElementById('pulse-room')) return;
    bindFilter();
    const source = new EventSource('/api/events');
    pulseSource = source;
    source.onopen = () => {
      state.connected = true;
    };
    source.onerror = () => {
      state.connected = false;
      draw();
    };
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data);
        state.events = [...state.events.slice(-199), event];
        state.connected = true;
        draw();
      } catch {
        // A malformed line is already reported by the log reader; the feed keeps its
        // last good state rather than replacing the room with an exception.
      }
    };
    source.addEventListener('resync', () => {
      state.events = [];
      draw();
    });
  }, 0);

  return markup();
}

window.addEventListener('hashchange', () => {
  if (location.hash !== '#/pulse') closePulse();
});

// The snapshot is the view's spine: its refusal refuses the room. The check and work
// reads fail alone, each confined to its own card, the way the snapshot's slots do.
const alone = (path) => readDoor(path).catch((error) => error.payload ?? {
  ok: false,
  error: String(error?.message ?? error),
  remedy: 'reload the page; if it persists, restart the studio',
});

async function overviewRoom() {
  const [snapshot, check, work] = await Promise.all([
    readDoor('/api/status'),
    alone('/api/check'),
    alone('/api/work'),
  ]);
  return overview(snapshot, check, work);
}

async function boardRoom() {
  return board(await readDoor('/api/board'));
}

async function custodyRoom() {
  const draw = (payload) => {
    document.getElementById('view').innerHTML = custody(payload);
    bindClaim();
  };
  const bindClaim = () => {
    const form = document.getElementById('custody-claim');
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const claim = new FormData(form).get('claim') ?? '';
      try {
        draw(await readDoor(`/api/evidence/chains?claim=${encodeURIComponent(String(claim))}`));
      } catch (error) {
        document.getElementById('view').innerHTML = refusalPanel(error.payload ?? {
          ok: false,
          error: String(error?.message ?? error),
          remedy: 'reload the page; if it persists, restart the studio',
        });
      }
    });
  };
  const payload = await readDoor('/api/evidence/chains');
  setTimeout(bindClaim, 0);
  return custody(payload);
}

const routes = new Map([
  ['/', { view: home }],
  ['/overview', { view: overviewRoom }],
  ['/pulse', { view: pulseRoom }],
  ['/board', { view: boardRoom }],
  ['/custody', { view: custodyRoom }],
  ['/constellation', { view: later('Constellation') }],
  ['/harness', { view: later('Harness wall') }],
  ['/budget', { view: later('Budget') }],
  ['/helm', { view: later('Helm') }],
  ['/library', { view: later('Library') }],
  ['/bench', { view: later('Bench') }],
]);

bootTheme();
const router = createRouter({ container: document.getElementById('view'), routes });
router.start();