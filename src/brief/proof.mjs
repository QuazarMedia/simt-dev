// Proof-bearing task packets: spend the bytes on obligations, and say when they did not fit.
//
// The existing packet answers "what does this repository know about this task". This one
// answers the harder question an agent actually has: what is the least I can read and still
// satisfy what this task owes. The difference is not a better summary. It is that every unit
// is attached to the obligations it is evidence for, so the packet can be selected by what it
// proves rather than by how relevant it feels.
//
// Four rules follow from that, and each one is a failure this module exists to prevent:
//
//   * Mandatory text is a floor, never a candidate. Safety and identity lines are not traded
//     against a higher-coverage quotation. If they alone exceed the ceiling the result says
//     `overBudget` and `complete: false` - it does not quietly cut the thing that keeps the
//     reader safe, and it does not claim a ceiling it did not meet.
//   * A unit with no revision and no anchor is not evidence. It is rejected with
//     `no-citation`; a quotation a reader cannot go and check is a claim, not proof.
//   * Selection is marginal coverage per byte, adjusted for authority. A unit that adds no
//     obligation is redundant however authoritative it is, and a cheap unit that closes two
//     obligations beats an expensive one that closes the same two.
//   * Time-varying observations are a separate suffix. The stable bytes stay identical between
//     two reads of the same tree, so a packet diff means the repository changed, not the clock.
//
// The result never says "complete" because it stopped: completeness is every required
// obligation covered, every mandatory unit kept, and the stable part inside the ceiling.

import { DEFAULT_BRIEF_BYTES, PROMPT_CAP_BYTES } from './packet.mjs';

export const PROOF_SCHEMA_VERSION = 1;

const byteLength = (text) => Buffer.byteLength(text);

const isText = (value) => typeof value === 'string' && value.length > 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A unit carries the citation a reader needs to check it, or it is not a unit of proof. */
function citationOf(unit) {
  if (!isObject(unit?.revision) || !isText(unit.revision.ref) || !isText(unit.revision.digest)) return null;
  const anchor = isObject(unit.anchor) && isText(unit.anchor.path) ? unit.anchor : null;
  return {
    ref: unit.revision.ref,
    digest: unit.revision.digest,
    anchor: anchor === null ? null : { path: anchor.path, startLine: anchor.startLine ?? null, endLine: anchor.endLine ?? null },
  };
}

function renderUnit(unit, citation) {
  const where = citation.anchor === null ? citation.ref : `${citation.anchor.path}${citation.anchor.startLine === null ? '' : `:${citation.anchor.startLine}-${citation.anchor.endLine ?? citation.anchor.startLine}`}`;
  return `${unit.text}  — ${where} @ ${citation.digest}`;
}

/**
 * Build a proof-bearing packet.
 *
 * @param {object[]} units
 * @param {{budget?: number, required?: string[]}} [options]
 * @returns {object}
 */
export function buildProofPacket(units = [], { budget = DEFAULT_BRIEF_BYTES, required = [] } = {}) {
  if (!Number.isFinite(budget) || budget < 0) throw new Error(`a packet budget must be a non-negative number, not ${JSON.stringify(budget)}`);
  if (budget > PROMPT_CAP_BYTES) throw new Error(`a packet budget may not exceed the measured cap of ${PROMPT_CAP_BYTES} bytes`);

  const list = Array.isArray(units) ? units : [];
  const wanted = [...new Set((Array.isArray(required) ? required : []).filter(isText))].sort();
  const citations = new Map();
  const rejected = [];
  const candidates = [];

  for (const unit of list) {
    if (!isObject(unit) || !isText(unit.id) || !isText(unit.text)) {
      rejected.push({ id: unit?.id ?? null, reason: 'malformed', detail: 'a unit needs an id and text' });
      continue;
    }
    const citation = citationOf(unit);
    if (citation === null) {
      rejected.push({ id: unit.id, reason: 'no-citation', detail: 'name the revision and the anchor a reader can check' });
      continue;
    }
    citations.set(unit.id, citation);
    candidates.push({
      id: unit.id,
      text: unit.text,
      obligations: [...new Set((Array.isArray(unit.obligations) ? unit.obligations : []).filter(isText))],
      mandatory: unit.mandatory === true,
      dynamic: unit.dynamic === true,
      authority: Math.max(0, Number(unit.authority) || 0),
      // The unit's own encoded bytes. The newline that separates it from its neighbour is
      // charged when it is placed, so the running total is the packet's length (A40).
      cost: byteLength(renderUnit(unit, citation)),
    });
  }

  const covered = new Set();
  const selected = [];
  const order = [];
  let stableBytes = 0;
  let overBudget = false;
  const reasons = [];

  for (const unit of candidates.filter((candidate) => candidate.mandatory && !candidate.dynamic)) {
    if (selected.length > 0) stableBytes += 1;
    selected.push(unit);
    order.push(unit.id);
    stableBytes += unit.cost;
    for (const obligation of unit.obligations) covered.add(obligation);
  }
  if (stableBytes > budget) {
    overBudget = true;
    reasons.push(`the mandatory units alone are ${stableBytes} bytes against a ${budget}-byte ceiling, so the packet is over budget and incomplete`);
  }

  // Greedy by marginal coverage per byte, with authority as a bounded multiplier. The bound
  // matters: without it the most authoritative page wins every tie, which is how a hub becomes
  // the packet.
  for (;;) {
    let best = null;
    for (const unit of candidates) {
      if (selected.includes(unit) || unit.dynamic) continue;
      const gain = unit.obligations.filter((obligation) => !covered.has(obligation)).length;
      if (gain === 0) continue;
      if (stableBytes + (selected.length > 0 ? 1 : 0) + unit.cost > budget) continue;
      const score = (gain / unit.cost) * (1 + Math.min(0.5, unit.authority / 10));
      if (best === null || score > best.score || (score === best.score && unit.id < best.unit.id)) best = { unit, score };
    }
    if (best === null) break;
    if (selected.length > 0) stableBytes += 1;
    selected.push(best.unit);
    order.push(best.unit.id);
    stableBytes += best.unit.cost;
    for (const obligation of best.unit.obligations) covered.add(obligation);
  }

  const cut = [];
  for (const unit of candidates) {
    if (selected.includes(unit)) continue;
    if (unit.dynamic) continue;
    const gain = unit.obligations.filter((obligation) => !covered.has(obligation)).length;
    cut.push({
      id: unit.id,
      reason: gain === 0 ? 'redundant' : stableBytes + (selected.length > 0 ? 1 : 0) + unit.cost > budget ? 'over-budget' : 'not-selected',
      detail: gain === 0 ? 'every obligation it covers is already covered' : `${gain} obligation(s) still uncovered`,
    });
  }

  const stableText = selected.map((unit) => renderUnit(unit, citations.get(unit.id))).join('\n');
  const dynamicUnits = candidates.filter((unit) => unit.dynamic);
  const dynamicText = dynamicUnits.map((unit) => renderUnit(unit, citations.get(unit.id))).join('\n');
  const dynamicBytes = dynamicText.length === 0 ? 0 : byteLength(`\n\nDYNAMIC\n${dynamicText}`);
  const stableMeasured = byteLength(stableText);

  const omitted = wanted.filter((obligation) => !covered.has(obligation));
  const rejectedMandatory = rejected.filter((entry) => list.some((unit) => unit?.id === entry.id && unit?.mandatory === true));
  const complete = !overBudget && stableMeasured <= budget && omitted.length === 0 && rejectedMandatory.length === 0;
  if (omitted.length > 0) reasons.push(`${omitted.length} required obligation(s) are not covered: ${omitted.join(', ')}`);
  if (rejectedMandatory.length > 0) reasons.push(`a mandatory unit has no citation: ${rejectedMandatory.map((entry) => entry.id).join(', ')}`);

  return {
    version: PROOF_SCHEMA_VERSION,
    budget,
    stable: { text: stableText, bytes: stableMeasured },
    dynamic: { text: dynamicText, bytes: dynamicBytes, units: dynamicUnits.map((unit) => unit.id) },
    text: dynamicText.length === 0 ? stableText : `${stableText}\n\nDYNAMIC\n${dynamicText}`,
    selected: selected.map((unit) => unit.id),
    order,
    cut: cut.sort((a, b) => a.id.localeCompare(b.id)),
    rejected: rejected.sort((a, b) => String(a.id).localeCompare(String(b.id))),
    citations: selected.map((unit) => ({ id: unit.id, ...citations.get(unit.id) })),
    coverage: {
      required: wanted,
      covered: wanted.filter((obligation) => covered.has(obligation)),
      fraction: wanted.length === 0 ? 1 : wanted.filter((obligation) => covered.has(obligation)).length / wanted.length,
    },
    omittedObligations: omitted,
    overBudget,
    complete,
    reasons,
  };
}
