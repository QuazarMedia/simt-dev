
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