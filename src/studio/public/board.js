
import { badge, card, emptyState, escapeHtml } from './components.js';

const STATE_TONES = {
  complete: 'ok',
  done: 'ok',
  accepted: 'warn',
  'in progress': 'accent',
  queued: 'neutral',
};

function laneOf(slice) {
  return slice.lane || 'unlaned';
}

function stateTone(state) {
  return STATE_TONES[String(state ?? '').toLowerCase()] ?? 'neutral';
}

/** The tracker stores dependencies as one cell; the board wants named edges. */
export function dependenciesOf(slice) {
  const raw = slice?.dependsOn;
  if (Array.isArray(raw)) return raw;
  return String(raw ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id && !['—', '-', 'n/a'].includes(id.toLowerCase()));
}

/** Dependency edges that name a row the board actually carries. */
export function dependencyEdges(slices) {
  const known = new Set(slices.map((slice) => slice.id));
  const edges = [];
  for (const slice of slices) {
    for (const to of dependenciesOf(slice)) {
      if (known.has(to)) edges.push({ from: slice.id, to });
    }
  }
  return edges;
}

/** The active claim covering a slice, by its explicit slice id or its worktree path. */
export function leaseFor(slice, leases) {
  const worktree = `/worktrees/${slice.id.toLowerCase()}`;
  return leases.find(
    (lease) =>
      (lease.kind === 'slice' && lease.slice === slice.id) ||
      (typeof lease.path === 'string' && lease.path.endsWith(worktree)),
  ) ?? null;
}

export function worktreeFor(slice, worktrees) {
  const id = slice.id.toLowerCase();
  return worktrees.find((worktree) => worktree.id.toLowerCase() === id) ?? null;
}

function timeLabel(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : 'unknown expiry';
}

function chip(label, tone = 'neutral') {
  return `<span class="board-chip">${badge(label, tone)}</span>`;
}

function cardFor(slice, { nextId, leases, worktrees, brief }) {
  const lease = leaseFor(slice, leases);
  const worktree = worktreeFor(slice, worktrees);
  const chips = [
    worktree ? chip(`worktree ${worktree.path}`, 'accent') : '',
    lease ? chip(`lease ${lease.session} until ${timeLabel(lease.expiresAt)}`, 'warn') : '',
  ].join('');
  const dependsOn = dependenciesOf(slice);
  const depends = dependsOn.length
    ? `depends on ${dependsOn.map((id) => escapeHtml(id)).join(', ')}`
    : 'no dependencies';
  const briefBody = brief
    ? `<pre class="board-brief">${escapeHtml(brief)}</pre>`
    : '<p class="empty-hint">No brief for this slice.</p>';
  return `<details class="board-card board-state-${stateTone(slice.state)}${slice.id === nextId ? ' board-next' : ''}" data-slice="${escapeHtml(slice.id)}"${slice.id === nextId ? ' open' : ''}>
    <summary>
      <span class="board-id">${escapeHtml(slice.id)}</span>
      <span class="board-title">${escapeHtml(slice.title || slice.id)}</span>
      ${badge(slice.state ?? 'unknown', stateTone(slice.state))}
      ${slice.id === nextId ? badge('next', 'accent') : ''}
    </summary>
    <div class="board-detail">
      <p class="board-meta">${escapeHtml(slice.doc ?? '')}${slice.tier ? ` · ${escapeHtml(slice.tier)}` : ''} · ${escapeHtml(depends)}</p>
      <div class="board-chips">${chips || '<span class="empty-hint">no worktree or lease</span>'}</div>
      ${briefBody}
      <p class="board-commands"><code>simt slice start ${escapeHtml(slice.id)}</code> <code>simt slice finish ${escapeHtml(slice.id)}</code></p>
    </div>
  </details>`;
}

/** Render the board. A plan-reader refusal is the room's refusal; it is never an empty board. */
export function board(payload) {
  if (!payload?.ok) {
    return `<section class="refusal" role="alert"><h2>Refused</h2><p class="refusal-error">${escapeHtml(payload?.error ?? 'the plan reader refused')}</p><p class="refusal-remedy"><span class="refusal-label">remedy</span> ${escapeHtml(payload?.remedy ?? 'run: simt plan status')}</p></section>`;
  }
  const slices = payload.slices ?? [];
  if (slices.length === 0) {
    return emptyState({ title: 'No tracker rows', hint: 'Run simt plan status to see what the board would read.' });
  }
  const lanes = [...new Set(slices.map(laneOf))].sort();
  const edges = dependencyEdges(slices);
  const nextId = payload.next?.next?.id ?? null;
  const columns = lanes
    .map((lane) => {
      const rows = slices
        .filter((slice) => laneOf(slice) === lane)
        .sort((a, b) => a.id.localeCompare(b.id));
      return `<section class="board-lane" aria-labelledby="board-lane-${escapeHtml(lane)}">
        <h2 id="board-lane-${escapeHtml(lane)}">${escapeHtml(lane)} <span class="board-count">${rows.length}</span></h2>
        ${rows.map((slice) => cardFor(slice, { nextId, leases: payload.leases ?? [], worktrees: payload.worktrees ?? [], brief: payload.briefs?.[slice.id] ?? null })).join('')}
      </section>`;
    })
    .join('');
  const edgeList = edges.length
    ? `<ul class="board-edges" aria-label="dependency edges">${edges.map((edge) => `<li data-from="${escapeHtml(edge.from)}" data-to="${escapeHtml(edge.to)}">${escapeHtml(edge.from)} → ${escapeHtml(edge.to)}</li>`).join('')}</ul>`
    : '<p class="empty-hint">No dependency edges between these rows.</p>';
  const leaseError = payload.leasesError
    ? `<p class="slot-error">Leases unreadable: ${escapeHtml(payload.leasesError)}</p>`
    : '';
  return `${card({
    title: 'The Board',
    body: `<p class="board-intro">Every tracker row as a card: lanes are columns, tier is weight, and the next ready slice wears the accent. ${badge(`${edges.length} edges`, 'neutral')} ${badge(`${payload.leases?.length ?? 0} leases`, 'neutral')} ${badge(`${payload.worktrees?.length ?? 0} worktrees`, 'neutral')}</p>${leaseError}<div class="board">${columns}</div>`,
  })}${card({ title: 'Dependencies', body: edgeList })}${card({
    title: 'How this was computed',
    body: '<p class="computed">read <code>simt plan status --json</code>, <code>simt plan next --json</code>, <code>.simt/local/worktrees/</code> and <code>.simt/local/leases.json</code>; card details use the tracker row and a brief when one exists.</p>',
  })}`;
}
