// The Bench: report bars, a paired comparison, offline verdicts and the two input forms.
// Native progress elements carry the bars, so the room adds no stylesheet.

import { readDoor } from './client.js';
import { badge, card, emptyState, escapeHtml, loading, refusalPanel } from './components.js';

const pct = (v) => (v == null ? '—' : `${(Number(v) * 100).toFixed(1)}%`);

export function barChart(title, rows) {
  const bars = rows.map((row) => {
    const value = Math.max(0, Math.min(1, Number(row.value ?? 0)));
    return `<div><span>${escapeHtml(row.label)}</span> <progress max="1" value="${value}"></progress> ${escapeHtml(pct(value))}</div>`;
  }).join('');
  return `<figure><figcaption>${escapeHtml(title)}</figcaption>${bars}</figure>`;
}

function failures(payload) {
  const rows = payload?.failures ?? [];
  return rows.length ? `<ul>${rows.map((row) => `<li data-failing-task="${escapeHtml(row.task)}"><code>${escapeHtml(row.arm)}</code> ${escapeHtml(row.task)}</li>`).join('')}</ul>` : '';
}

function comparisonPanel(comparison) {
  if (!comparison) return '';
  const rows = [['resolved', comparison.deltas?.R], ['quality', comparison.deltas?.Q]].filter(([, value]) => value != null);
  const bars = rows.map(([label, delta]) => `<div data-delta="${escapeHtml(label)}"><span>${escapeHtml(label)}</span> <progress max="1" value="${Math.min(1, Math.abs(Number(delta)))}"></progress> <strong>${escapeHtml(Number(delta).toFixed(3))}</strong></div>`).join('');
  return card({ title: `Comparison: ${comparison.candidate} vs ${comparison.baseline}`, body: `<p>${badge(comparison.verdict ?? 'unreported', comparison.verdict === 'non-inferior' ? 'ok' : comparison.verdict === 'inferior' ? 'bad' : 'warn')} ${escapeHtml(String(comparison.pairedTasks ?? 0))} paired tasks</p>${bars}` });
}

export function bench(payload) {
  if (!payload || typeof payload !== 'object') return refusalPanel({ ok: false, error: 'the bench returned no payload', remedy: 'reload the room' });
  if (payload.absent) return card({ title: 'The bench is not installed', body: `<p>This installation has no <code>@simt-dev/bench</code> package. The default studio is intact; the optional bench adds measurement, not a requirement.</p><p><code>npm install simt-dev @simt-dev/bench</code></p>`, footer: escapeHtml(payload.remedy ?? 'install the optional bench package, then reload') });
  if (payload.ok === false) return refusalPanel(payload);
  const recall = payload.mapRecall ?? {};
  const forms = `<form id="bench-compare"><label>baseline <input name="baseline" autocomplete="off"></label><label>candidate <input name="candidate" autocomplete="off"></label><button type="submit">compare</button></form><form id="bench-doc"><label>door <select name="kind"><option value="calibrate">calibrate</option><option value="replay">replay</option></select></label><label>input <input name="input" autocomplete="off"></label><button type="submit">read document</button></form><div id="bench-doc-result" aria-live="polite"></div>`;
  const arms = payload.arms ?? [];
  return `<section class="bench">${card({ title: 'Compare arms', body: forms })}${card({ title: `Outcome distribution · ${payload.runCount ?? 0} runs`, body: arms.length ? barChart('resolved share by arm', arms.map((arm) => ({ label: arm.arm, value: arm.R }))) + failures(payload) : emptyState({ title: 'No measured arms', hint: 'Run a benchmark arm, then reload the room.' }) })}${card({ title: 'Recall', body: recall.measured ? barChart(`recall@10 · ${recall.tasks} tasks`, [{ label: 'gold files found', value: recall.recall }]) : emptyState({ title: 'Unmeasured', hint: String(recall.reason ?? 'not run') }) })}${comparisonPanel(payload.comparison)}</section>`;
}

export function calibrationView(payload) {
  if (!payload || payload.ok === false) return refusalPanel(payload ?? { ok: false });
  const m = payload.measured ?? {};
  const d = payload.decision ?? {};
  return card({ title: 'Calibration', body: `<dl class="facts"><dt>samples</dt><dd>${escapeHtml(String(m.samples ?? 0))}</dd><dt>rate</dt><dd>${escapeHtml(String(m.falseAcceptRate ?? '—'))}</dd><dt>decision</dt><dd>${badge(d.decision ?? 'unreported', d.decision === 'blocked' ? 'bad' : 'ok')}</dd><dt>bound</dt><dd>${escapeHtml(d.bound == null ? 'none' : String(d.bound))}</dd></dl><p>${escapeHtml(d.reason ?? '')}</p>` });
}

export function replayView(payload) {
  if (!payload || payload.ok === false) return refusalPanel(payload ?? { ok: false });
  const rows = payload.metamorphic?.results ?? [];
  return card({ title: 'Replay', body: `<p>${badge(payload.trace?.replayable ? 'replayable' : 'not replayable', payload.trace?.replayable ? 'ok' : 'bad')} ${escapeHtml((payload.trace?.missing ?? []).join(', '))}</p><ul>${rows.map((row) => `<li data-holds="${row.holds}"><strong>${escapeHtml(row.holds ? 'HOLDS' : 'FAILS')}</strong> ${escapeHtml(row.relation ?? '')} ${escapeHtml(row.reason ?? '')}</li>`).join('')}</ul>` });
}

function bind() {
  const view = document.getElementById('view');
  document.getElementById('bench-compare')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const baseline = String(data.get('baseline') ?? '').trim();
    const candidate = String(data.get('candidate') ?? '').trim();
    if (!baseline || !candidate) return;
    view.innerHTML = loading('comparing the two arms');
    try {
      view.innerHTML = bench(await readDoor(`/api/bench?compare=${encodeURIComponent(`${baseline},${candidate}`)}`));
      bind();
    } catch (error) {
      view.innerHTML = refusalPanel(error.payload ?? { ok: false, error: String(error?.message ?? error), remedy: 'compare two measured arms' });
    }
  });
  document.getElementById('bench-doc')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const kind = String(data.get('kind') ?? 'calibrate');
    const input = String(data.get('input') ?? '').trim();
    if (!input) return;
    const result = document.getElementById('bench-doc-result');
    result.innerHTML = loading(`reading ${kind}`);
    try {
      const answer = await readDoor(`/api/bench/${kind}?input=${encodeURIComponent(input)}`);
      result.innerHTML = kind === 'replay' ? replayView(answer) : calibrationView(answer);
    } catch (error) {
      result.innerHTML = refusalPanel(error.payload ?? { ok: false, error: String(error?.message ?? error), remedy: 'keep the input inside the repository, then try again' });
    }
  });
}

export async function benchRoom() {
  const payload = await readDoor('/api/bench');
  setTimeout(bind, 0);
  return bench(payload);
}
