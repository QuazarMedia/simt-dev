
import { badge, card, emptyState, escapeHtml, refusalPanel } from './components.js';

const pct = (v) => (v === null || v === undefined ? '—' : `${(Number(v) * 100).toFixed(1)}%`);

/** A horizontal 0..1 bar chart; the label and value are always beside the bar. */
export function barChart(title, rows) {
  const height = Math.max(rows.length * 24, 24);
  const bars = rows.map((row, i) => {
    const v = Math.max(0, Math.min(1, Number(row.value ?? 0)));
    const y = i * 24 + 4;
    return `<text x="0" y="${y + 11}" class="bench-bar-label">${escapeHtml(row.label)}</text><rect x="118" y="${y}" width="${v * 190}" height="14" rx="2" class="bench-bar"></rect><text x="${118 + v * 190 + 4}" y="${y + 11}" class="bench-bar-value">${escapeHtml(pct(v))}</text>`;
  }).join('');
  return `<figure class="bench-chart"><figcaption>${escapeHtml(title)}</figcaption><svg viewBox="0 0 420 ${height}" role="img" aria-label="${escapeHtml(title)}">${bars}</svg></figure>`;
}

function failures(payload, arm) {
  const rows = (payload?.failures ?? []).filter((r) => r.arm === arm);
  return rows.length ? `<ul class="bench-failures" aria-label="Failing tasks for ${escapeHtml(arm)}">${rows.map((r) => `<li data-failing-task="${escapeHtml(r.task)}"><code>${escapeHtml(r.task)}</code></li>`).join('')}</ul>` : '';
}

function armTable(payload) {
  const arms = payload?.arms ?? [];
  if (!arms.length) return emptyState({ title: 'No measured arms', hint: 'Run a benchmark arm, then reload the room.' });
  return `<table class="table bench-arms"><thead><tr><th scope="col">arm</th><th scope="col">harness</th><th scope="col">tasks</th><th scope="col">resolved</th><th scope="col">quality</th><th scope="col">cost</th></tr></thead><tbody>${arms.map((a) => `<tr data-arm="${escapeHtml(a.arm)}"><td>${escapeHtml(a.arm)}</td><td>${escapeHtml(a.harness ?? '—')}</td><td>${escapeHtml(String(a.tasks ?? 0))}</td><td>${escapeHtml(pct(a.R))}</td><td>${escapeHtml(pct(a.Q))}</td><td>${escapeHtml(a.C == null ? '—' : `$${Number(a.C).toFixed(4)}`)}</td></tr>${failures(payload, a.arm)}`).join('')}</tbody></table>`;
}

function comparisonPanel(c) {
  if (!c) return '';
  const rows = [['resolved', c.deltas?.R, c.ci95?.R], ['quality', c.deltas?.Q, c.ci95?.Q], ['cost', c.deltas?.C, c.ci95?.C], ['CPI', c.deltas?.CPI, c.ci95?.CPI]].filter(([, v]) => v != null);
  const bars = rows.map(([label, delta, ci]) => `<div class="paired-bar" data-delta="${escapeHtml(label)}"><span>${escapeHtml(label)}</span><span class="paired-track"><span class="paired-fill ${Number(delta) >= 0 ? 'positive' : 'negative'}" style="width:${Math.min(90, Math.abs(Number(delta)) * 100)}%"></span></span><strong>${escapeHtml(Number(delta).toFixed(3))}</strong><span class="computed">${ci ? `CI ${Number(ci[0]).toFixed(3)} … ${Number(ci[1]).toFixed(3)}` : ''}</span></div>`).join('');
  return card({ title: `Comparison: ${c.candidate} vs ${c.baseline}`, body: `<p>${badge(c.verdict ?? 'unreported', c.verdict === 'non-inferior' ? 'ok' : c.verdict === 'inferior' ? 'bad' : 'warn')} <span class="computed">${escapeHtml(String(c.pairedTasks ?? 0))} paired tasks</span></p>${bars}` });
}

/** The report room; an absent optional package keeps its own labelled card. */
export function bench(payload) {
  if (!payload || typeof payload !== 'object') return refusalPanel({ ok: false, error: 'the bench returned no payload', remedy: 'reload the room' });
  if (payload.absent) return card({ title: 'The bench is not installed', body: `<p>This installation has no <code>@simt-dev/bench</code> package, so there is no report to draw. The default studio is intact; the optional bench adds measurement, not a requirement.</p><p class="library-command"><code>npm install simt-dev @simt-dev/bench</code></p><p class="computed">${escapeHtml(payload.error ?? '')}</p>`, footer: escapeHtml(payload.remedy ?? 'install the optional bench package, then reload') });
  if (payload.ok === false) return refusalPanel(payload);
  const arms = payload.arms ?? [];
  const recall = payload.mapRecall ?? {};
  return `<section class="bench">
    ${card({ title: 'Compare two arms', body: '<form id="bench-compare" class="bench-form"><label>baseline<input name="baseline" autocomplete="off" placeholder="bare"></label><label>candidate<input name="candidate" autocomplete="off" placeholder="current"></label><button type="submit">compare</button></form>' })}
    ${card({ title: 'Offline document door', body: '<form id="bench-input" class="bench-form"><label>door<select name="kind"><option value="calibrate">calibrate</option><option value="replay">replay</option></select></label><label>input path<input name="input" autocomplete="off" placeholder="bench-input.json"></label><button type="submit">read document</button></form><div id="bench-input-result" aria-live="polite"></div>' })}
    ${card({ title: 'Report', body: `<dl class="facts"><dt>runs</dt><dd>${escapeHtml(String(payload.runCount ?? 0))}</dd><dt>prices</dt><dd>${payload.pricesLoaded ? 'loaded' : 'none'}</dd><dt>arms</dt><dd>${escapeHtml(String(arms.length))}</dd></dl>` })}
    ${card({ title: 'Outcome distribution', body: arms.length ? barChart('resolved share by arm', arms.map((a) => ({ label: a.arm, value: a.R }))) + armTable(payload) : emptyState({ title: 'No measured arms', hint: 'Run a benchmark arm, then reload the room.' }) })}
    ${card({ title: 'Recall', body: recall.measured ? barChart(`recall@10 · ${recall.tasks} mined tasks`, [{ label: 'gold files found', value: recall.recall }]) + `<p class="computed">tree ${escapeHtml(recall.tree?.commit?.slice(0, 8) ?? 'uncommitted')}</p>` : emptyState({ title: 'Unmeasured', hint: String(recall.reason ?? 'not run') }) })}
    ${comparisonPanel(payload.comparison)}
  </section>`;
}

/** `bench calibrate`: the measured rate, decision and bound, verbatim. */
export function calibrationView(payload) {
  if (!payload || payload.ok === false) return refusalPanel(payload ?? { ok: false });
  const m = payload.measured ?? {};
  const d = payload.decision ?? {};
  return card({ title: 'Calibration', body: `<dl class="facts"><dt>samples</dt><dd>${escapeHtml(String(m.samples ?? 0))}</dd><dt>false accepts</dt><dd>${escapeHtml(String(m.falseAccepts ?? 0))}</dd><dt>rate</dt><dd>${escapeHtml(String(m.falseAcceptRate ?? '—'))}</dd><dt>disagreement</dt><dd>${escapeHtml(String(m.disagreement ?? '—'))}</dd><dt>decision</dt><dd>${badge(d.decision ?? 'unreported', d.decision === 'blocked' ? 'bad' : 'ok')}</dd><dt>bound</dt><dd>${escapeHtml(d.bound == null ? 'none' : String(d.bound))}</dd></dl><p>${escapeHtml(d.reason ?? '')}</p>` });
}

/** `bench replay`: replayability and the relation verdicts. */
export function replayView(payload) {
  if (!payload || payload.ok === false) return refusalPanel(payload ?? { ok: false });
  const rows = payload.metamorphic?.results ?? [];
  return card({ title: 'Replay', body: `<p>${badge(payload.trace?.replayable ? 'replayable' : 'not replayable', payload.trace?.replayable ? 'ok' : 'bad')} ${escapeHtml((payload.trace?.missing ?? []).join(', '))}</p><ul class="bench-relations">${rows.map((e) => `<li data-holds="${e.holds}"><strong>${escapeHtml(e.holds ? 'HOLDS' : 'FAILS')}</strong> ${escapeHtml(e.relation ?? '')} ${escapeHtml(e.reason ?? '')}</li>`).join('')}</ul>` });
}
