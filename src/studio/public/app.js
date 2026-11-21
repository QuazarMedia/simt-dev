// The shell entry: theme, navigation state, and the route table. Rooms whose views
// ship in later slices render an honest empty state, not a broken link. The home
// room reads /api/status through the same client every later view uses, so the
// fetch path and the refusal rendering are exercised from the first load.

import { readDoor } from './client.js';
import { badge, card, emptyState, escapeHtml } from './components.js';
import { overview } from './overview.js';
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

const routes = new Map([
  ['/', { view: home }],
  ['/overview', { view: overviewRoom }],
  ['/pulse', { view: later('Pulse') }],
  ['/board', { view: later('Board') }],
  ['/custody', { view: later('Custody') }],
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