// Custody's view-model: the ledger as chains bound to the trees they proved.
//
// The current tree is bright, superseded trees stay inspectable, and a failed link is
// never hidden by a green summary. v1 lines have no kind or outcome; they are labelled
// local-only instead of being given a v2 verdict they never carried.

import { badge, card, emptyState, escapeHtml } from './components.js';

function statusTone(link) {
  if (link.legacy) return 'neutral';
  if (link.outcome === 'passed') return 'ok';
  if (link.outcome === 'timeout' || link.outcome === 'cancelled') return 'warn';
  return 'bad';
}

function statusLabel(link) {
  if (link.legacy) return 'local-only';
  return link.outcome ?? (link.exit === 0 ? 'passed' : 'failed');
}

function duration(link) {
  return Number.isFinite(link.ms) ? `${link.ms} ms` : '—';
}

function linkRow(link) {
  const tone = statusTone(link);
  const failed = tone === 'bad';
  const gate = link.gate ?? (link.legacy ? 'v1 run' : '—');
  return `<li class="custody-link custody-${tone}${failed ? ' custody-failed' : ''}${link.legacy ? ' custody-legacy' : ''}">
    <span class="custody-gate">${escapeHtml(gate)}</span>
    <span class="custody-outcome">${badge(statusLabel(link), tone)}</span>
    <span class="custody-cmd">${escapeHtml(link.cmd)}</span>
    <span class="custody-duration">${escapeHtml(duration(link))}</span>
    <span class="custody-adr">${link.adr ? escapeHtml(link.adr) : '—'}</span>
    ${link.summary ? `<span class="custody-summary">${escapeHtml(link.summary)}</span>` : ''}
    ${link.legacy ? '<span class="custody-note">v1 line · local-only</span>' : ''}
  </li>`;
}

function chainView(chain) {
  const failed = chain.links.filter((link) => !link.legacy && statusTone(link) === 'bad').length;
  const legacy = chain.links.filter((link) => link.legacy).length;
  return `<section class="custody-chain${chain.current ? ' custody-current' : ' custody-stale'}" data-tree="${escapeHtml(chain.tree)}">
    <header class="custody-chain-head">
      <h2>${escapeHtml(chain.tree)}</h2>
      ${chain.current ? badge('current tree', 'ok') : badge('stale · HEAD moved', 'warn')}
      ${badge(`${chain.links.length} run(s)`, 'neutral')}
      ${failed ? badge(`${failed} failed`, 'bad') : ''}
      ${legacy ? badge(`${legacy} local-only`, 'neutral') : ''}
    </header>
    <ol class="custody-links">${chain.links.map(linkRow).join('')}</ol>
  </section>`;
}

function claimView(claim) {
  if (!claim) {
    return `<form id="custody-claim" class="custody-claim">
      <label for="custody-claim-text">check a commit-message claim</label>
      <input id="custody-claim-text" name="claim" type="text" autocomplete="off">
      <button type="submit">check</button>
      <p class="computed">The verdict uses <code>simt evidence check</code>'s own claim reader; it does not write the message.</p>
    </form>`;
  }
  const tone = !claim.claims ? 'neutral' : claim.supported ? 'ok' : 'bad';
  const label = !claim.claims ? 'does not claim a run' : claim.supported ? 'supported by this tree' : 'unsupported by this tree';
  return `<div class="custody-verdict">${badge(label, tone)} <span class="custody-claim-text">${escapeHtml(claim.message)}</span><p class="computed">checked against <code>${escapeHtml(claim.tree)}</code> through the index tree.</p></div>`;
}

function catalogView(catalog) {
  return `<details class="custody-catalog"><summary>Gate catalog (${catalog.length})</summary><ul>${catalog
    .map(
      (gate) =>
        `<li><strong>${escapeHtml(gate.name)}</strong> ${badge(gate.kind, 'neutral')} <span class="custody-adr">${escapeHtml(gate.adr)}</span><p>${escapeHtml(gate.why)}</p></li>`,
    )
    .join('')}</ul></details>`;
}

/** Render the Custody room. */
export function custody(payload) {
  if (!payload?.ok) {
    return `<section class="refusal" role="alert"><h2>Refused</h2><p class="refusal-error">${escapeHtml(payload?.error ?? 'the ledger reader refused')}</p><p class="refusal-remedy"><span class="refusal-label">remedy</span> ${escapeHtml(payload?.remedy ?? 'run: simt evidence')}</p></section>`;
  }
  const chains = payload.chains ?? [];
  const errors = payload.errors ?? [];
  const body = chains.length
    ? chains.map(chainView).join('')
    : emptyState({ title: 'No recorded runs', hint: 'Gate runs appear here after a hook or slice finish records one.' });
  const errorsView = errors.length
    ? `<div class="custody-errors">${errors.map((error) => `<p class="slot-error">${escapeHtml(error)}</p>`).join('')}</div>`
    : '';
  const failed = chains.reduce(
    (sum, chain) => sum + chain.links.filter((link) => !link.legacy && statusTone(link) === 'bad').length,
    0,
  );
  return `${card({
    title: 'Custody',
    body: `<p class="custody-intro">Gate runs bound to the tree they proved. The current tree is bright; older trees stay inspectable. ${badge(`${failed} failed link(s)`, failed ? 'bad' : 'ok')} ${badge(`${chains.length} tree(s)`, 'neutral')}</p>${errorsView}${body}`,
  })}${card({ title: 'Claim check', body: claimView(payload.claim) })}${card({
    title: 'Gate catalog',
    body: catalogView(payload.catalog ?? []),
    footer: '<p class="computed">The ADR beside a run is the gate declaration in <code>src/hooks/gates.mjs</code>.</p>',
  })}${card({
    title: 'How this was computed',
    body: '<p class="computed">read the ledger through the same <code>simt evidence</code> reader; current-tree entries compare with <code>evidence --json</code>, and every tree is grouped from the same ledger file.</p>',
  })}`;
}
