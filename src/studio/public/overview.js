
import { badge, card, escapeHtml, refusalPanel, table } from './components.js';

function toneFor(status) {
  if (status === 'current') return 'ok';
  if (status === 'stale') return 'warn';
  return /invalid|missing|drift|foreign/.test(status) ? 'bad' : 'neutral';
}

/** A slot that could not answer is a fact about the repository, shown as one. */
function slotError(title, slot) {
  return card({
    title,
    body: `<p class="slot-error">${badge('unreadable', 'bad')} ${escapeHtml(slot.error)}</p>`,
  });
}

function details(summary, rows) {
  if (rows.rows.length === 0) return '';
  return `<details class="rows"><summary>${escapeHtml(summary)}</summary>${table(rows)}</details>`;
}

function gateCard(snapshot, check) {
  if (check && check.ok === false && check.error !== undefined) {
    return card({ title: 'Gate', body: refusalPanel(check) });
  }
  const findings = check?.findings ?? [];
  const cached = snapshot.check;
  const line = cached === null || cached === undefined
    ? 'no cache yet - the findings below are read live'
    : (cached.error ? `cache unreadable: ${cached.error}` : cached.line);
  const rows = {
    columns: ['status', 'file', 'detail', 'remedy'],
    rows: findings.map((f) => [f.status, f.file, f.detail ?? '', f.remedy ?? '']),
  };
  const verdict = check?.ok === false ? badge('gate red', 'bad') : badge('gate green', 'ok');
  const count = findings.length === 0 ? '<p>0 findings</p>' : details(`${findings.length} findings`, rows);
  return card({
    title: 'Gate',
    body: `<p>${escapeHtml(line)}</p>${count}`,
    footer: verdict,
  });
}

function gitHooksCard(snapshot) {
  const hooks = snapshot.gitHooks;
  if (hooks?.error) return slotError('Git hooks', hooks);
  const wired = hooks.events.filter((e) => e.present && !e.stale).length;
  const rows = {
    columns: ['event', 'present', 'stale'],
    rows: hooks.events.map((e) => [e.event, e.present ? 'yes' : 'no', e.stale ? 'yes' : 'no']),
  };
  const foreign = hooks.foreign > 0 ? ` ${badge(`${hooks.foreign} foreign`, 'warn')}` : '';
  const gates = hooks.gatesError ? `<p class="slot-error">${escapeHtml(hooks.gatesError)}</p>` : '';
  return card({
    title: 'Git hooks',
    body: `<p>${wired}/${hooks.events.length} events wired${foreign}</p>${gates}${details(`${hooks.events.length} events`, rows)}`,
  });
}

function agentHooksCard(snapshot) {
  const agent = snapshot.agentHooks;
  if (agent?.error) return slotError('Agent hooks', agent);
  const rows = {
    columns: ['harness', 'path', 'state'],
    rows: agent.harnesses.map((h) => [h.id, h.path, h.state]),
  };
  return card({
    title: 'Agent hooks',
    body: `<p>${agent.wired}/${agent.total} harnesses wired</p>${details(`${agent.total} harnesses`, rows)}`,
  });
}

function evidenceCard(snapshot) {
  const evidence = snapshot.evidence;
  if (evidence?.error) return slotError('Evidence', evidence);
  const verdict = evidence.testsRecorded === null
    ? badge('no head tree', 'neutral')
    : (evidence.testsRecorded ? badge('test run for this tree', 'ok') : badge('no test run for this tree', 'warn'));
  const errors = evidence.errors > 0 ? ` ${badge(`${evidence.errors} unreadable`, 'bad')}` : '';
  return card({
    title: 'Evidence',
    body: `<p>${evidence.entries} run(s) recorded${errors}</p>`,
    footer: verdict,
  });
}

function leasesCard(snapshot) {
  const leases = snapshot.leases;
  if (leases?.error) return slotError('Leases', leases);
  const rows = { columns: ['path'], rows: leases.paths.map((p) => [p]) };
  return card({
    title: 'Leases',
    body: `<p>${leases.active} active</p>${details(`${leases.paths.length} paths`, rows)}`,
  });
}

function slicesCard(snapshot) {
  const slices = snapshot.slices;
  if (slices?.error) return slotError('Plan progress', slices);
  const states = Object.entries(slices.totals);
  const rows = { columns: ['state', 'count'], rows: states.map(([state, count]) => [state, String(count)]) };
  return card({
    title: 'Plan progress',
    body: `<p>${slices.ready} ready</p>${details(`${states.length} states`, rows)}`,
  });
}

function journalCard(snapshot) {
  const journal = snapshot.journal;
  if (journal?.error) return slotError('Journal', journal);
  const last = journal.last === null ? '' : `<p>last set: ${escapeHtml(journal.last)}</p>`;
  return card({ title: 'Journal', body: `<p>${journal.sets} undo set(s)</p>${last}` });
}

function nextStepCard(work) {
  if (work && work.ok === false && work.error !== undefined) {
    return card({ title: 'Next step', body: refusalPanel(work) });
  }
  const next = work?.next;
  if (!next) return card({ title: 'Next step', body: '<p>nothing pending - the declaration is complete</p>' });
  return card({
    title: 'Next step',
    body: `<p>${escapeHtml(next.step)}</p><p class="remedy-command">${escapeHtml(next.remedy)}</p>`,
  });
}

/**
 * Render one overview from the three door payloads. `check` and `work` may be a
 * refusal payload instead of a document; each is confined to its own card.
 */
export function overview(snapshot, check, work) {
  const head = snapshot.head ?? 'unborn';
  const verdict = snapshot.ok ? badge('gate green', 'ok') : badge('gate red', 'bad');
  const header = card({
    title: 'This repository',
    body: `<dl class="facts"><dt>root</dt><dd>${escapeHtml(snapshot.root)}</dd><dt>head</dt><dd>${escapeHtml(head)}</dd></dl>`,
    footer: verdict,
  });
  return (
    `<div class="overview">` +
    header +
    gateCard(snapshot, check) +
    gitHooksCard(snapshot) +
    agentHooksCard(snapshot) +
    evidenceCard(snapshot) +
    leasesCard(snapshot) +
    slicesCard(snapshot) +
    journalCard(snapshot) +
    nextStepCard(work) +
    `</div>` +
    `<p class="computed">how this was computed: <code>simt status --json</code> · <code>simt check --json</code> · <code>simt work inspect --json</code></p>`
  );
}
