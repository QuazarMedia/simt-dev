// The shell entry: theme, navigation state, and the route table. Rooms whose views
// ship in later slices render an honest empty state, not a broken link. The home
// room reads /api/status through the same client every later view uses, so the
// fetch path and the refusal rendering are exercised from the first load.

import { readDoor } from './client.js';
import { badge, card, emptyState, escapeHtml } from './components.js';
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

const routes = new Map([
  ['/', { view: home }],
  ['/overview', { view: later('Overview') }],
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