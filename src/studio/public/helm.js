
import { badge, card, emptyState, escapeHtml, refusalPanel } from './components.js';

/** The fields a row's usage and flag list imply, in the order a person fills them. */
export function fieldsFor(row) {
  const fields = [];
  const seen = new Set();
  const usage = String(row?.usage ?? '');
  const flagPattern = /--([a-z0-9-]+)(?:\s+["']?<([^>]+)>["']?)?/gi;
  const flags = [];
  for (const match of usage.matchAll(flagPattern)) {
    const name = match[1];
    if (seen.has(`flag:${name}`)) continue;
    seen.add(`flag:${name}`);
    const value = match[2] ?? '';
    flags.push({ kind: 'flag', name, label: name, value, boolean: value === '' });
  }
  const rest = usage.replace(flagPattern, ' ');
  for (const match of rest.matchAll(/<([^>]+)>/g)) {
    const name = match[1];
    if (seen.has(`arg:${name}`)) continue;
    seen.add(`arg:${name}`);
    fields.push({ kind: 'arg', name, label: name, value: '', boolean: false });
  }
  for (const name of row?.flags ?? []) {
    if (seen.has(`flag:${name}`)) continue;
    seen.add(`flag:${name}`);
    flags.push({ kind: 'flag', name, label: name, value: '', boolean: true });
  }
  return [...fields, ...flags];
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** The terminal invocation, built from the same field names the form submits. */
export function invocation(row, values = {}) {
  const read = (kind, name) => values[`${kind}:${name}`] ?? values[name] ?? '';
  const parts = ['simt', row.path];
  for (const field of fieldsFor(row)) {
    const value = read(field.kind, field.name);
    if (field.kind === 'arg') {
      if (String(value).trim() !== '') parts.push(shellQuote(value));
    } else if (field.boolean) {
      if (value === true || value === 'true' || value === '1' || value === 'on') parts.push(`--${field.name}`);
    } else if (String(value).trim() !== '') {
      parts.push(`--${field.name}`, shellQuote(value));
    }
  }
  return parts.join(' ');
}

export function commandForm(row) {
  if (!row) return '<p class="empty-hint">Choose a command.</p>';
  const fields = fieldsFor(row);
  const controls = fields.map((field) => {
    const id = `helm-${field.kind}-${field.name.replace(/[^a-z0-9-]/gi, '-')}`;
    const name = `${field.kind}:${field.name}`;
    if (field.boolean) {
      return `<label class="helm-flag" for="${id}"><input id="${id}" name="${name}" type="checkbox"> --${escapeHtml(field.name)}</label>`;
    }
    return `<label for="${id}">${escapeHtml(field.label)}${field.kind === 'arg' ? ' (argument)' : ''}<input id="${id}" name="${escapeHtml(name)}" type="text" autocomplete="off"></label>`;
  }).join('');
  return `<h3><code>${escapeHtml(row.path)}</code></h3><p class="computed">${escapeHtml(row.summary)}</p>${row.runnable === false ? '<p class="slot-error">This read has no document answer on the bridge; copy the command and run it in a terminal.</p>' : ''}<form id="helm-form" class="helm-form" data-command="${escapeHtml(row.path)}">${controls}<div class="helm-actions"><button type="submit">run read</button><button type="button" id="helm-copy">copy as CLI command</button></div><output id="helm-invocation" class="helm-invocation" aria-live="polite"></output></form>`;
}

function jsonTree(value, depth = 0) {
  if (value === null || typeof value !== 'object') return `<span class="helm-json-${typeof value}">${escapeHtml(JSON.stringify(value) ?? String(value))}</span>`;
  if (Array.isArray(value)) {
    return `<ul class="helm-json-list">${value.map((item) => `<li>${jsonTree(item, depth + 1)}</li>`).join('')}</ul>`;
  }
  return `<dl class="facts helm-json">${Object.entries(value).map(([key, item]) => `<dt>${escapeHtml(key)}</dt><dd>${jsonTree(item, depth + 1)}</dd>`).join('')}</dl>`;
}

function humanSummary(document) {
  if (!document || typeof document !== 'object') return '<p class="empty-hint">No document.</p>';
  return `<dl class="facts">${Object.entries(document).slice(0, 12).map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(typeof value === 'object' ? JSON.stringify(value) : String(value))}</dd>`).join('')}</dl>`;
}

/** A result is the JSON tree and the human rendering of the same document. */
export function resultPanel(payload) {
  if (!payload?.ok) return refusalPanel(payload ?? { ok: false });
  const document = payload.document ?? payload;
  return `${card({ title: 'Human reading', body: humanSummary(document) })}${card({
    title: 'JSON tree',
    body: `<div class="helm-tree">${jsonTree(document)}</div><details><summary>raw document</summary><pre class="helm-raw">${escapeHtml(JSON.stringify(document, null, 2))}</pre></details>`,
  })}`;
}

function commandItem(row) {
  return `<li><button type="button" class="helm-command" data-command="${escapeHtml(row.path)}"><code>${escapeHtml(row.path)}</code> <span>${escapeHtml(row.summary)}</span>${row.runnable === false ? badge('copy only', 'warn') : badge('read', 'neutral')}</button></li>`;
}

export function helm(payload) {
  if (!payload?.ok) return refusalPanel(payload ?? { ok: false });
  const commands = Array.isArray(payload.commands) ? payload.commands : [];
  if (commands.length === 0) return emptyState({ title: 'No read-only doors', hint: 'The spec published no rows without a write.' });
  return `${card({
    title: 'The Helm',
    body: `<p class="helm-intro">Every read-only row in the command spec, with a form derived from its usage. <kbd>Cmd/Ctrl-K</kbd> focuses the filter; choosing a row shows its form and the exact CLI spelling.</p><input id="helm-filter" class="helm-filter" type="search" placeholder="filter commands" aria-label="filter commands"><ul id="helm-commands" class="helm-list">${commands.map(commandItem).join('')}</ul>`,
  })}${card({ title: 'Command', body: '<div id="helm-form-panel"><p class="empty-hint">Choose a command.</p></div>' })}${card({ title: 'Result', body: '<div id="helm-result" role="status" aria-live="polite"></div><p class="computed">Results are the API bridge\'s sealed document; a refusal is rendered with the command\'s own remedy.</p>' })}`;
}
