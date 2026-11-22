// The Budget's view-model: token bytes as rectangles, grouped by repository and loader,
// against the always-on frame. Areas are proportional to measured bytes; overflow grows
// the picture rather than being clipped into a reassuring shape (ADR-064).

import { badge, card, emptyState, escapeHtml, refusalPanel, table } from './components.js';

const WIDTH = 100;
const TOP = 24;
const PER_BYTE = 100;

/** The same refusal the CLI gives before it touches a socket or a filesystem. */
export function sessionPathError(value) {
  const path = String(value ?? '').trim();
  if (path === '') {
    return { error: '--session requires a local transcript path', remedy: 'pass a local JSONL or JSON transcript path: simt tokens --session <path>' };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    return {
      error: `${path}: remote URLs are refused; session transcripts are read locally only (ADR-075)`,
      remedy: 'pass a local file path on this machine: simt tokens --session ./session.jsonl',
    };
  }
  return null;
}

function entriesOf(payload) {
  if (payload?.mode === 'session') {
    return [
      { repository: 'session', group: 'rules', bytes: payload.rules?.bytes ?? 0, readerBytes: payload.rules?.bytes ?? 0 },
      { repository: 'session', group: 'file reads', bytes: payload.fileReads?.bytes ?? 0, readerBytes: payload.fileReads?.bytes ?? 0 },
      { repository: 'session', group: 'tool output', bytes: payload.toolOutput?.bytes ?? 0, readerBytes: payload.toolOutput?.bytes ?? 0 },
    ];
  }
  const roots = Array.isArray(payload?.roots) ? payload.roots : [];
  return roots.flatMap((root) =>
    (root.channels ?? []).map((channel) => ({
      repository: root.name ?? root.path ?? 'repository',
      group: channel.channel,
      bytes: channel.generatedBytes ?? 0,
      readerBytes: channel.readerBytes ?? 0,
    })),
  );
}

/**
 * Lay out one rectangle per channel. The width is shared inside a group so each area is
 * bytes × a single scale; the budget frame uses the same scale, which is what makes an
 * over-budget picture visibly taller than its frame.
 */
export function layoutTreemap(payload) {
  const entries = entriesOf(payload);
  const budgetBytes = payload?.mode === 'session' ? null : (payload?.budget?.bytes ?? 0);
  const totalBytes = payload?.mode === 'session' ? (payload?.total?.bytes ?? 0) : (payload?.totals?.generatedBytes ?? 0);
  if (entries.length === 0) {
    return { width: WIDTH, height: TOP, totalBytes, budgetBytes, overflow: false, overBy: 0, groups: [], rectangles: [], frame: null };
  }
  const max = Math.max(...entries.map((entry) => entry.bytes), 1);
  const repositories = [...new Set(entries.map((entry) => entry.repository))].sort();
  const groups = repositories.map((repository, index) => {
    const members = entries.filter((entry) => entry.repository === repository).sort((a, b) => b.bytes - a.bytes || a.group.localeCompare(b.group));
    return { repository, x: index * WIDTH, entries: members };
  });
  const rectangles = [];
  for (const group of groups) {
    let y = TOP;
    for (const entry of group.entries) {
      const height = (entry.bytes / max) * PER_BYTE;
      rectangles.push({ ...entry, x: group.x, y, w: WIDTH, h: height, area: WIDTH * height });
      y += height;
    }
    group.height = y - TOP;
  }
  const overflow = budgetBytes !== null && totalBytes > budgetBytes;
  const overBy = overflow ? totalBytes - budgetBytes : 0;
  const budgetHeight = budgetBytes === null ? 0 : (budgetBytes / max) * PER_BYTE;
  const height = Math.max(TOP + Math.max(...groups.map((group) => group.height)), TOP + budgetHeight) + 8;
  return {
    width: groups.length * WIDTH,
    height,
    totalBytes,
    budgetBytes,
    overflow,
    overBy,
    groups,
    rectangles,
    frame: budgetBytes === null ? null : { x: 0, y: TOP, w: groups.length * WIDTH, h: budgetHeight, bytes: budgetBytes, over: overflow },
  };
}

export function sessionSplit(payload) {
  const parts = [
    ['rules', payload?.rules],
    ['file reads', payload?.fileReads],
    ['tool output', payload?.toolOutput],
  ].filter(([, part]) => part && typeof part === 'object');
  const total = parts.reduce((sum, [, part]) => sum + (part.bytes ?? 0), 0);
  return parts.map(([label, part]) => ({
    label,
    bytes: part.bytes ?? 0,
    share: total === 0 ? 0 : (part.bytes ?? 0) / total,
    tokens: part.tokens ?? 0,
  }));
}

function sessionBar(payload) {
  const parts = sessionSplit(payload);
  const segments = parts.map((part, index) => `<rect class="budget-split budget-split-${index}" x="${parts.slice(0, index).reduce((sum, prior) => sum + prior.share * 100, 0)}" y="0" width="${part.share * 100}" height="10"><title>${escapeHtml(`${part.label}: ${part.bytes} B (${Math.round(part.share * 100)}%)`)}</title></rect>`).join('');
  return `<svg class="budget-split-bar" viewBox="0 0 100 10" role="img" aria-label="session split">${segments}</svg><ul class="budget-legend">${parts.map((part, index) => `<li><span class="budget-swatch budget-swatch-${index}" aria-hidden="true"></span>${escapeHtml(part.label)} <span class="computed">${escapeHtml(String(part.bytes))} B · ${escapeHtml(`${Math.round(part.share * 100)}%`)} · ~${escapeHtml(String(part.tokens))} tokens</span></li>`).join('')}</ul>`;
}

function layoutPanel(payload) {
  const layout = layoutTreemap(payload);
  if (layout.rectangles.length === 0) {
    return emptyState({ title: 'No measured bytes', hint: 'A repository with no projected region and no reader files has nothing to draw.' });
  }
  const frame = layout.frame
    ? `<rect class="budget-frame${layout.frame.over ? ' budget-frame-over' : ''}" x="${layout.frame.x}" y="${layout.frame.y}" width="${layout.frame.w}" height="${layout.frame.h}"><title>${escapeHtml(`always-on budget: ${layout.frame.bytes} B`)}</title></rect>`
    : '';
  const rects = layout.rectangles.map((rect) => `<rect class="budget-rect" x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" data-bytes="${rect.bytes}" data-repository="${escapeHtml(rect.repository)}" data-loader="${escapeHtml(rect.group)}"><title>${escapeHtml(`${rect.repository} · ${rect.group}: ${rect.bytes} B generated, ${rect.readerBytes} B read`)}</title></rect>`).join('');
  const labels = layout.groups.map((group) => `<text class="budget-group-label" x="${group.x + 2}" y="14">${escapeHtml(group.repository)}</text>`).join('');
  const verdict = layout.overflow
    ? `<p class="slot-error">over budget by ${escapeHtml(String(layout.overBy))} B: the rectangles extend past the frame rather than being clipped.</p>`
    : `<p class="computed">${escapeHtml(`${layout.totalBytes} B generated against a ${layout.budgetBytes ?? 'unmeasured'} B always-on budget.`)}</p>`;
  return `${verdict}<div class="budget-chart"><svg viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-label="token treemap grouped by repository and loader">${frame}${rects}${labels}</svg></div>`;
}

function rectTable(payload) {
  const layout = layoutTreemap(payload);
  if (layout.rectangles.length === 0) return '<p class="empty-hint">No rectangles.</p>';
  return table({
    columns: ['repository', 'loader', 'generated B', 'read B', 'area'],
    rows: layout.rectangles.map((rect) => [rect.repository, rect.group, String(rect.bytes), String(rect.readerBytes), String(rect.area)]),
  });
}

/** The room's shell; `budget` is reused for the session result so both modes share it. */
export function budget(payload) {
  if (!payload?.ok) return refusalPanel(payload ?? { ok: false });
  const layout = layoutTreemap(payload);
  const session = payload.mode === 'session';
  const summary = session
    ? `${payload.total?.bytes ?? 0} B across the session`
    : `${payload.totals?.generatedBytes ?? 0} B generated · ${payload.totals?.tokens ?? 0} tokens · ${layout.overflow ? 'over budget' : 'within budget'}`;
  return `${card({
    title: 'The Budget',
    body: `<p class="budget-intro">Rectangles are sized by measured bytes, grouped by repository and loader. The frame is the always-on budget; an over-budget picture is taller than its frame, not clipped.</p><p>${badge(summary, layout.overflow ? 'bad' : 'ok')}</p>${layoutPanel(payload)}`,
  })}${session ? card({ title: 'Session split', body: sessionBar(payload) }) : ''}${card({ title: 'Rectangles', body: rectTable(payload) })}${card({
    title: 'Measure a session',
    body: `<form id="budget-session" class="budget-session"><label for="budget-session-path">local transcript</label><input id="budget-session-path" name="session" type="text" autocomplete="off" placeholder="./session.jsonl"><button type="submit">measure session</button></form><p class="computed">A URL is refused before any read. The split is rules, file reads and tool output, as shares of the measured bytes.</p><div id="budget-session-result" role="status"></div>`,
  })}${card({
    title: 'How this was computed',
    body: '<p class="computed">read <code>simt tokens --json</code> through the API; areas use the measured byte counts, never a token estimate, and a session path is a local file only (ADR-075).</p>',
  })}`;
}
