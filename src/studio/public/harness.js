// The Harness wall: the CLI's detect and status documents, one tile per harness, and the
// policy table in the reader's terms. Live policy decisions are appended from the Pulse
// stream; a deny is shown with its rule id and verdict, never softened into a warning.

import { badge, card, emptyState, escapeHtml } from './components.js';

function stateOf(tile) {
  const hook = tile.hook;
  if (!hook) {
    if (tile.kind === 'mcp') return 'mcp-config';
    return tile.channel ? 'detected' : 'detection-only';
  }
  if (hook.state === 'present' && /trust/i.test(String(hook.note ?? ''))) return 'untrusted';
  return hook.state ?? 'unknown';
}

const LABELS = Object.freeze({
  present: 'installed',
  drift: 'drifted',
  absent: 'not installed',
  untrusted: 'installed, not trusted',
  'detection-only': 'detection only',
  detected: 'detected',
  'mcp-config': 'MCP config present',
  unreadable: 'unreadable',
  none: 'no hooks file',
  other: 'not ours',
  skipped: 'not selected',
  unknown: 'unknown',
});

const CLASSES = Object.freeze({
  present: 'harness-present',
  drift: 'harness-drift',
  absent: 'harness-absent',
  untrusted: 'harness-present harness-untrusted',
  'detection-only': 'harness-detection-only',
  detected: 'harness-detected',
  'mcp-config': 'harness-mcp',
  unreadable: 'harness-unreadable',
  none: 'harness-none',
  other: 'harness-other',
  skipped: 'harness-skipped',
  unknown: 'harness-unknown',
});

/** One tile per detected harness, joined with the status row that has the same id. */
export function harnessTiles(payload) {
  const detected = Array.isArray(payload?.detect?.repo?.rows) ? payload.detect.repo.rows : [];
  const hooks = Array.isArray(payload?.hooks?.harnesses) ? payload.hooks.harnesses : [];
  const byId = new Map();
  for (const row of detected) {
    const id = row.surface ?? row.dir;
    const current = byId.get(id) ?? { id, detections: [] };
    current.detections.push(row);
    byId.set(id, current);
  }
  for (const hook of hooks) {
    const current = byId.get(hook.id) ?? { id: hook.id, detections: [] };
    current.hook = hook;
    byId.set(hook.id, current);
  }
  return [...byId.values()]
    .map((row) => {
      const first = row.detections[0] ?? {};
      const tile = {
        id: row.id,
        label: first.label ?? row.hook?.id ?? row.id,
        kind: first.kind ?? 'rules',
        channel: first.channel ?? false,
        dir: first.dir ?? row.hook?.path ?? null,
        readsAgentsMd: first.readsAgentsMd ?? null,
        readsAgentsMdNote: first.readsAgentsMdNote ?? null,
        verified: first.verified ?? null,
        detections: row.detections,
        hook: row.hook ?? null,
      };
      return { ...tile, state: stateOf(tile) };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function tileHtml(tile) {
  const state = LABELS[tile.state] ?? tile.state;
  const reads = tile.readsAgentsMd === null ? 'not verified' : `AGENTS.md: ${tile.readsAgentsMd}`;
  const dirs = tile.detections.map((row) => row.dir).filter(Boolean);
  const hooked = tile.hook
    ? `<dt>hooks</dt><dd>${escapeHtml(tile.hook.path ?? '(no hooks file)')} · ${escapeHtml(tile.hook.state)}${tile.hook.prompt ? ` · prompt-submit: ${escapeHtml(tile.hook.prompt)}` : ''}</dd>${tile.hook.note ? `<dt>note</dt><dd>${escapeHtml(tile.hook.note)}</dd>` : ''}${tile.hook.state === 'absent' ? '<dt>install</dt><dd><code>simt agent-hooks install --yes</code></dd>' : ''}`
    : '<dt>hooks</dt><dd>no hook row was reported</dd>';
  return `<article class="harness-tile ${CLASSES[tile.state] ?? 'harness-unknown'}" data-harness="${escapeHtml(tile.id)}" data-state="${escapeHtml(tile.state)}">
    <header class="harness-head"><h3>${escapeHtml(tile.label)}</h3>${badge(state, tile.state === 'drift' || tile.state === 'unreadable' ? 'bad' : tile.state === 'untrusted' ? 'warn' : 'neutral')}</header>
    <p class="harness-id"><code>${escapeHtml(tile.id)}</code>${tile.channel ? ' · rule channel' : ' · no rule channel'}</p>
    <dl class="facts">${dirs.length ? `<dt>detected at</dt><dd>${dirs.map((dir) => `<code>${escapeHtml(dir)}</code>`).join(', ')}</dd>` : ''}<dt>reads</dt><dd>${escapeHtml(reads)}${tile.readsAgentsMdNote ? ` — ${escapeHtml(tile.readsAgentsMdNote)}` : ''}</dd>${hooked}</dl>
    ${tile.state === 'detection-only' ? '<p class="computed">Detection only: present on disk, with no rule file this release writes.</p>' : ''}
    ${tile.verified ? `<p class="computed">vendor source: <a href="${escapeHtml(tile.verified)}" rel="noreferrer noopener">${escapeHtml(tile.verified)}</a></p>` : ''}
  </article>`;
}

/** A live policy decision, in the fields the wall shows and nowhere else. */
export function policyEvent(event) {
  const data = event?.data && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data : {};
  const blocked = Array.isArray(data.blocked) ? data.blocked.filter(Boolean) : [];
  return {
    id: event?.id ?? null,
    ts: event?.ts ?? null,
    harness: event?.harness ?? null,
    subject: event?.subject ?? null,
    verdict: typeof data.decision === 'string' ? data.decision : (typeof data.verdict === 'string' ? data.verdict : 'unknown'),
    rules: blocked.length > 0 ? blocked : (typeof data.rule === 'string' ? [data.rule] : []),
    lifted: Array.isArray(data.lifted) ? data.lifted.filter(Boolean) : [],
    messages: Array.isArray(data.messages) ? data.messages.filter((message) => typeof message === 'string') : [],
  };
}

export function policyEventItem(event) {
  const decision = policyEvent(event);
  const verdict = decision.verdict;
  const tone = verdict === 'deny' ? 'harness-deny' : verdict === 'allow' ? 'harness-allow' : 'harness-unknown';
  return `<li class="harness-event ${tone}" data-event-id="${escapeHtml(decision.id ?? '')}" data-verdict="${escapeHtml(verdict)}">
    <strong class="harness-verdict">${escapeHtml(verdict)}</strong>
    <span class="harness-event-subject">${escapeHtml(decision.subject ?? '(no subject)')}</span>
    ${decision.harness ? badge(decision.harness, 'neutral') : ''}
    <span class="harness-rules">rule: ${decision.rules.length ? decision.rules.map((rule) => `<code>${escapeHtml(rule)}</code>`).join(', ') : '<em>none reported</em>'}</span>
    ${decision.lifted.length ? `<span class="harness-lifted">lifted: ${decision.lifted.map((rule) => `<code>${escapeHtml(rule)}</code>`).join(', ')}</span>` : ''}
    ${decision.messages.map((message) => `<p class="harness-message">${escapeHtml(message)}</p>`).join('')}
  </li>`;
}

function policyHtml(policy) {
  return `<li class="harness-policy"><strong><code>${escapeHtml(policy.id)}</code></strong> ${badge(policy.event, 'neutral')} <span class="computed">${escapeHtml(policy.adr)} · reads ${escapeHtml(policy.inspects)}</span><p>${escapeHtml(policy.message)}</p><p class="computed">override: <code>SIMT_ALLOW=${escapeHtml(policy.id)}</code></p></li>`;
}

/** The room shell. The feed is a log so a screen reader hears a denial when it lands. */
export function harnessWall(payload) {
  const tiles = harnessTiles(payload);
  const problems = payload?.hooks?.problems ?? [];
  const policies = payload?.policies ?? [];
  const summary = `${tiles.filter((tile) => tile.state === 'present').length} installed · ${tiles.filter((tile) => tile.state === 'detection-only').length} detection only · ${tiles.filter((tile) => tile.state === 'drift' || tile.state === 'unreadable').length} need attention`;
  const wall = tiles.length
    ? `<div class="harness-grid">${tiles.map(tileHtml).join('')}</div>`
    : emptyState({ title: 'No harness configuration found', hint: 'That is a repository nobody has set an agent up in, not a failure.' });
  return `${card({
    title: 'The Harness wall',
    body: `<p class="harness-intro">What is present on disk, and what each harness will actually run. The two answers are kept apart: a detected config with no rule channel is not reported as an installed hook.</p><p>${badge(summary, 'neutral')}</p>${problems.length ? `<div class="refusal" role="alert"><h2>Status problems</h2><ul>${problems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join('')}</ul></div>` : ''}${wall}`,
  })}${card({
    title: 'Live policy decisions',
    body: `<p class="computed">replayed and followed from <code>.simt/local/events.jsonl</code>; only <code>policy.decided</code> events land here, with the rule ids and verdict the hook produced.</p><ol id="harness-feed" class="harness-feed" role="log" aria-live="polite" aria-relevant="additions"><li class="empty-hint">No policy decision has landed in this window.</li></ol>`,
  })}${card({
    title: 'The policy table',
    body: policies.length
      ? `<p class="computed">the same table the hook reads; an override lifts exactly the policy it names.</p><ul class="harness-policies">${policies.map(policyHtml).join('')}</ul>`
      : '<p class="empty-hint">No policies are published by this release.</p>',
  })}${card({
    title: 'How this was computed',
    body: '<p class="computed"><code>GET /api/harness</code> carries <code>harness detect --json</code> and <code>agent-hooks status --json</code> as their own documents, plus the policy table. The live feed is the same SSE stream as the Pulse; it never reads a file an event names.</p>',
  })}`;
}
