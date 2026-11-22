// Guarded control's view: a preview diff, its digest, and an explicit apply. There is no
// default action, no auto-apply and no batch; the reader confirms the bytes they saw.

import { badge, card, escapeHtml, refusalPanel } from './components.js';

function diffBlock(plan) {
  const files = plan?.files ?? [];
  if (files.length === 0) return '<p class="empty-hint">The preview named no files; nothing would be written.</p>';
  const rows = (plan.diff ?? []).map((entry) => entry.patch
    ? `<tr><td><code>${escapeHtml(entry.path)}</code></td><td colspan="2"><pre class="control-side">${escapeHtml(entry.patch)}</pre></td></tr>`
    : `<tr><td><code>${escapeHtml(entry.path)}</code></td><td><pre class="control-side">${escapeHtml(entry.before ?? '(absent)')}</pre></td><td><pre class="control-side">${escapeHtml(entry.after ?? '(removed)')}</pre></td></tr>`).join('');
  return `<p>${badge(`${files.length} file(s)`, files.length > 0 ? 'warn' : 'neutral')}</p><p class="computed">${files.map((path) => `<code>${escapeHtml(path)}</code>`).join(' ')}</p>${rows ? `<table class="table"><thead><tr><th scope="col">file</th><th scope="col">before</th><th scope="col">after</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="computed">The writer named paths without a diff; run the CLI with --diff to read the exact bytes.</p>'}`;
}

/** A preview result: the write plan, its digest, and the only action that can apply it. */
export function controlPreview(payload) {
  if (!payload?.ok) return refusalPanel(payload ?? { ok: false });
  return `<section class="card"><h3>Preview</h3><p>digest <code>${escapeHtml(payload.digest ?? '')}</code></p>${diffBlock(payload.plan)}<p class="slot-error">Confirming writes exactly this plan. Any edit to these files after this preview makes the apply refuse.</p><button type="button" id="control-apply" data-action="apply" data-digest="${escapeHtml(payload.digest ?? '')}">Apply this exact plan</button></section>`;
}

/** The apply result, including the journal set the CLI can undo. */
export function controlApplied(payload) {
  if (!payload?.ok) return refusalPanel(payload ?? { ok: false });
  const written = payload.written ?? [];
  return `<section class="card"><h3>Applied</h3><p>${badge(`${written.length} path(s)`, 'ok')} ${payload.journal ? `journal <code>${escapeHtml(payload.journal)}</code>` : 'no journal set was created'}</p><ul>${written.map((path) => `<li><code>${escapeHtml(path)}</code></li>`).join('')}</ul><button type="button" id="control-undo-preview" data-action="undo-preview">Preview undo from this journal</button></section>`;
}

export function control(payload) {
  if (!payload?.ok) return refusalPanel(payload ?? { ok: false });
  const commands = Array.isArray(payload.commands) ? payload.commands : [];
  return `${card({
    title: 'Guarded control',
    body: `<p>The writers the studio may run, one at a time. Preview first; the apply carries the digest of the previewed plan and is refused if the repository moved.</p><form id="control-form" class="control-form"><label for="control-command">command <select id="control-command" name="command">${commands.map((command) => `<option value="${escapeHtml(command)}">${escapeHtml(command)}</option>`).join('')}</select></label><label for="control-args">args (JSON array) <textarea id="control-args" name="args" rows="2">[]</textarea></label><label for="control-flags">flags (JSON object) <textarea id="control-flags" name="flags" rows="3">{}</textarea></label><button type="button" id="control-preview" data-action="preview">Preview</button></form><div id="control-result" role="status" aria-live="polite"></div>`,
  })}${card({
    title: 'How this was computed',
    body: '<p class="computed">the allowlist is the CLI\'s writers; preview runs each without <code>--yes</code>, apply re-runs the preview and compares its digest, and the writer journals exactly as the CLI does.</p>',
  })}`;
}
