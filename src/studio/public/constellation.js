
import { badge, card, emptyState, escapeHtml } from './components.js';

const WIDTH = 800;
const HEIGHT = 460;

export function scopeLabel(scope) {
  if (scope === null || scope === undefined) return 'unknown scope';
  if (typeof scope !== 'object') return String(scope);
  const entries = Object.entries(scope).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? 'unknown scope' : entries.map(([key, value]) => `${key}=${value}`).join(' ');
}

function seedPhase(seed) {
  let hash = 2166136261;
  for (const char of String(seed ?? '')) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 360) * (Math.PI / 180);
}

function point(index, count, band, phase = 0) {
  if (count <= 1) return { x: WIDTH / 2, y: band === 'unknown' ? 415 : 220 };
  const angle = (Math.PI * 2 * index) / count + phase;
  if (band === 'unknown') {
    return { x: 70 + (660 * index) / Math.max(1, count - 1), y: 415 };
  }
  return { x: WIDTH / 2 + Math.cos(angle) * 235, y: 220 + Math.sin(angle) * 125 };
}

/** Deterministic coordinates for every node; no clock, no randomness, no canvas input. */
export function layoutGraph(graph, seed = '') {
  const nodes = [...(graph?.nodes ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const known = nodes.filter((node) => !node.unknownScope);
  const unknown = nodes.filter((node) => node.unknownScope);
  const phase = seedPhase(seed);
  const placed = [
    ...known.map((node, index) => ({ ...node, ...point(index, known.length, 'known', phase), band: 'known' })),
    ...unknown.map((node, index) => ({ ...node, ...point(index, unknown.length, 'unknown'), band: 'unknown' })),
  ];
  return { seed, width: WIDTH, height: HEIGHT, nodes: placed };
}

function edgeClass(edge) {
  return `constellation-edge constellation-edge-${String(edge.kind).replace(/[^a-z-]/gi, '')}${edge.status === 'reviewed' ? '' : ' constellation-proposed'}`;
}

function nodeLabel(node) {
  return node.kind === 'claim' ? node.id : (node.path ?? node.id);
}

function edgeRows(edges) {
  if (edges.length === 0) return '<p class="empty-hint">No typed edges.</p>';
  return `<ul class="constellation-edges">${edges
    .map(
      (edge) =>
        `<li class="${edgeClass(edge)}" data-from="${escapeHtml(edge.from)}" data-to="${escapeHtml(edge.to)}"><span>${escapeHtml(edge.from)}</span> <span class="constellation-edge-kind">${escapeHtml(edge.kind)}</span> <span>${escapeHtml(edge.to)}</span> ${edge.status === 'proposed' ? badge('proposed', 'warn') : ''}</li>`,
    )
    .join('')}</ul>`;
}

function nodeTable(nodes) {
  if (nodes.length === 0) return '<p class="empty-hint">No nodes.</p>';
  return `<table class="table constellation-table"><thead><tr><th scope="col">node</th><th scope="col">kind</th><th scope="col">scope</th><th scope="col">why</th></tr></thead><tbody>${nodes
    .map(
      (node) =>
        `<tr${node.unknownScope ? ' class="constellation-unknown"' : ''}><td>${escapeHtml(nodeLabel(node))}</td><td>${escapeHtml(node.kind)}</td><td>${escapeHtml(scopeLabel(node.scope))}</td><td><button type="button" class="constellation-node" data-node-id="${escapeHtml(node.id)}">open</button></td></tr>`,
    )
    .join('')}</tbody></table>`;
}

/** The why panel, rendered from `knowledge why --scope`'s own answer. */
export function whyPanel(payload) {
  if (!payload?.ok) {
    return `<section class="refusal" role="alert"><h2>Refused</h2><p class="refusal-error">${escapeHtml(payload?.error ?? 'the why reader refused')}</p><p class="refusal-remedy"><span class="refusal-label">remedy</span> ${escapeHtml(payload?.remedy ?? 'run: simt knowledge why --scope <id> <claim>')}</p></section>`;
  }
  if (!payload.claim) {
    return `<p class="computed">${escapeHtml(payload.reason ?? 'this node is a citation, not a claim')}</p>${payload.source ? `<dl class="facts"><dt>source</dt><dd>${escapeHtml(payload.source.path)}</dd><dt>revision</dt><dd>${escapeHtml(payload.source.revision ?? 'unknown')}</dd></dl>` : ''}`;
  }
  const claim = payload.claim;
  const conflicts = payload.conflicts ?? [];
  return `<dl class="facts">
      <dt>claim</dt><dd>${escapeHtml(claim.id)}</dd>
      <dt>asserts</dt><dd>${escapeHtml(claim.subject)} ${escapeHtml(claim.predicate)} = ${escapeHtml(JSON.stringify(claim.value))}${claim.unit ? ` ${escapeHtml(claim.unit)}` : ''}</dd>
      <dt>status</dt><dd>${escapeHtml(claim.status ?? 'unspecified')}</dd>
      <dt>source</dt><dd>${payload.source ? escapeHtml(payload.source.path) : '—'}</dd>
      <dt>lineage</dt><dd>${escapeHtml(String(payload.lineage?.total ?? 0))} node(s), ${escapeHtml(String(payload.lineage?.edges ?? 0))} edge(s)</dd>
      <dt>impact</dt><dd>${escapeHtml(String(payload.impact?.total ?? 0))} node(s), ${escapeHtml(String(payload.impact?.edges ?? 0))} edge(s)</dd>
    </dl>${conflicts.length ? `<h3>Conflicts</h3><ul>${conflicts.map((conflict) => `<li>${escapeHtml(JSON.stringify(conflict))}</li>`).join('')}</ul>` : '<p class="empty-hint">No conflicting claims.</p>'}`;
}

/** The rank box's answer, rendered from `knowledge rank --scope`. */
export function rankPanel(payload) {
  if (!payload?.ok) {
    return `<section class="refusal" role="alert"><h2>Refused</h2><p class="refusal-error">${escapeHtml(payload?.error ?? 'the rank reader refused')}</p><p class="refusal-remedy"><span class="refusal-label">remedy</span> ${escapeHtml(payload?.remedy ?? 'run: simt knowledge rank --scope <id> --query "<question>"')}</p></section>`;
  }
  const hits = payload.ranked ?? [];
  if (hits.length === 0) return `<p class="empty-hint">${escapeHtml((payload.reasons ?? ['no ranked hits']).join('; '))}</p>`;
  return `<ol class="constellation-hits">${hits
    .map((hit) => {
      const cite = hit.citation;
      return `<li><strong>${escapeHtml(hit.path ?? hit.id)}</strong>${cite ? ` <span class="computed">${escapeHtml(cite.anchor ?? '')} · ${escapeHtml(cite.path)} · lines ${escapeHtml(`${cite.lineStart}-${cite.lineEnd}`)}</span>` : ''}</li>`;
    })
    .join('')}</ol>`;
}

/** Render the room's shell. The canvas is a picture of the table, never a second source. */
export function constellation(payload) {
  if (!payload?.ok) {
    return `${card({
      title: 'The Constellation',
      body: `<p class="constellation-intro">A cold corpus has a remedy, not an empty sky.</p>`,
    })}${card({
      title: 'Build the corpus',
      body: `<p class="slot-error">${escapeHtml(payload?.error ?? 'no corpus')}</p><p class="remedy-command">${escapeHtml(payload?.remedy ?? 'run: simt knowledge build --scope <id> --yes')}</p>`,
    })}`;
  }
  const graph = payload.graph ?? { nodes: [], edges: [] };
  const layout = layoutGraph(graph, payload.seed);
  if (layout.nodes.length === 0) {
    return emptyState({ title: 'No graph nodes', hint: 'The corpus is built but contains no claims or artifacts.' });
  }
  const canvas = `<canvas id="constellation-canvas" width="${layout.width}" height="${layout.height}" role="img" aria-label="claim graph with ${layout.nodes.length} nodes and ${graph.edges.length} edges"></canvas>`;
  const table = nodeTable(layout.nodes);
  const panel = '<div id="constellation-why" class="constellation-panel" role="region" aria-live="polite"><p class="empty-hint">Select a node to read its why.</p></div>';
  const rank = `<form id="constellation-rank" class="constellation-rank" data-scope="${escapeHtml(payload.scope)}"><label for="constellation-query">ask the corpus</label><input id="constellation-query" name="query" type="text" autocomplete="off"><button type="submit">rank</button></form><div id="constellation-rank-result" class="constellation-panel" role="status"></div>`;
  const problemCount = (payload.corpus?.problems ?? []).length + (graph.problems ?? []).length;
  const problems = problemCount
    ? `<p class="slot-error">${escapeHtml(`${problemCount} corpus or graph problem(s)`)}</p>`
    : '';
  return `${card({
    title: 'The Constellation',
    body: `<p class="constellation-intro">The claim graph for scope <code>${escapeHtml(payload.scope)}</code>, seeded by the corpus digest. Known scopes draw in the sky; unknown-scope nodes sit in the lower band. ${badge(`${layout.nodes.length} nodes`, 'neutral')} ${badge(`${graph.edges.length} edges`, 'neutral')}</p>${problems}<div class="constellation-canvas">${canvas}</div>`,
  })}${card({ title: 'Graph data', body: table })}${card({ title: 'Edges', body: edgeRows(graph.edges ?? []) })}${card({ title: 'Why', body: panel })}${card({ title: 'Rank', body: rank })}${card({
    title: 'How this was computed',
    body: '<p class="computed">read the derived corpus through <code>simt knowledge build</code>/<code>corpusDocument</code>; positions are a pure function of sorted node ids, and the why and rank panels call <code>knowledge why --scope</code> and <code>knowledge rank --scope</code>.</p>',
  })}`;
}
