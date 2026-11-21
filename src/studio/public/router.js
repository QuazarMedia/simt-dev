// The hash router: one container, a route table, and a loading state that a refusal
// always replaces. Hashes that do not start with '/' are in-page anchors (the skip
// link), not routes - rendering them would navigate away from the room you are in.
// innerHTML is safe here by construction: every mounted string is composed by
// components.js, which escapes every repository-sourced value before interpolation.

import { emptyState, loading, refusalPanel } from './components.js';

export function createRouter({ container, routes, fallback }) {
  let seq = 0;
  const path = () => location.hash.slice(1) || '/';

  async function render() {
    const target = path();
    if (!target.startsWith('/')) return;
    const ticket = ++seq;
    const route = routes.get(target);
    container.setAttribute('aria-busy', 'true');
    container.innerHTML = loading();
    let html;
    try {
      html = route ? await route.view() : (fallback ?? defaultFallback)(target);
    } catch (error) {
      html = refusalPanel(error?.payload ?? {
        ok: false,
        error: String(error?.message ?? error),
        remedy: 'reload the page; if it persists, restart the studio',
      });
    }
    // A newer navigation won the race while this view was reading; drop the stale answer.
    if (ticket !== seq) return;
    container.innerHTML = html;
    container.setAttribute('aria-busy', 'false');
    for (const link of document.querySelectorAll('nav a')) {
      if (link.getAttribute('href') === `#${target}`) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  }

  window.addEventListener('hashchange', render);
  return { start: render, path };
}

function defaultFallback(target) {
  return emptyState({ title: 'No such room', hint: `${target} is not a route in this shell` });
}