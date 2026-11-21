// Shared view components: pure string builders, so a node test can assert what a
// refusal renders without a DOM. Every dynamic value goes through escapeHtml - the
// shell mounts these strings with innerHTML, and a door's error text is repository
// data, not markup. `body` and `footer` slots take HTML composed from these builders.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const TONES = new Set(['neutral', 'ok', 'warn', 'bad', 'accent']);

export function badge(label, tone = 'neutral') {
  const safe = TONES.has(tone) ? tone : 'neutral';
  return `<span class="badge badge-${safe}">${escapeHtml(label)}</span>`;
}

export function card({ title = '', body = '', footer = '' }) {
  const head = title ? `<h2 class="card-title">${escapeHtml(title)}</h2>` : '';
  const foot = footer ? `<footer class="card-footer">${footer}</footer>` : '';
  return `<section class="card">${head}<div class="card-body">${body}</div>${foot}</section>`;
}

export function table({ columns, rows }) {
  const head = columns.map((c) => `<th scope="col">${escapeHtml(c)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('');
  return `<table class="table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function emptyState({ title, hint = '' }) {
  const rest = hint ? `<p class="empty-hint">${escapeHtml(hint)}</p>` : '';
  return `<div class="empty" role="status"><h2>${escapeHtml(title)}</h2>${rest}</div>`;
}

export function loading(label = 'reading the repository') {
  return `<div class="loading" role="status">${escapeHtml(label)}…</div>`;
}

/** The door-shaped refusal: error and remedy, never hidden behind a spinner. */
export function refusalPanel(payload) {
  const raw = payload?.error;
  const error = typeof raw === 'string' ? raw : (raw?.message ?? 'the door refused without a reason');
  const remedy = payload?.remedy ?? 'rerun the command in a terminal to read its refusal';
  const code = typeof payload?.exitCode === 'number' ? `<p class="refusal-code">exit ${payload.exitCode}</p>` : '';
  return `<section class="refusal" role="alert"><h2>Refused</h2><p class="refusal-error">${escapeHtml(error)}</p><p class="refusal-remedy"><span class="refusal-label">remedy</span> ${escapeHtml(remedy)}</p>${code}</section>`;
}