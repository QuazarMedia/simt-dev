// `simt knowledge why <claim-id>` — why a claim is held, what rests on it, and where it disagrees.
//
// Plan 4's second door (W20), the knowledge half of `simt why`. It reads one document of
// claims and edges, builds the graph the knowledge modules already agree on, and answers the
// three questions a reviewer asks before relying on a claim: what it derives from, what would
// break if it were wrong, and whether another claim contradicts it. The conflict scan is a
// statement about declared claims only — `certifies` stays false, because a clean scan is not a
// statement that the documents are consistent.

import { EXIT, fail, present } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { buildClaimGraph, impact, lineage, proposedEdges, readClaim } from '../knowledge/claims.mjs';
import { findConflicts } from '../knowledge/conflicts.mjs';
import { readApplicability } from '../knowledge/validity.mjs';
import { readJsonDocument } from './doc-input.mjs';

const USAGE = `run: ${CLI} knowledge why <claim-id> --claims <file>`;

/**
 * @param {object} doc
 * @param {string} id
 * @returns {object}
 */
export function knowledgeWhyFacts(doc, id) {
  const declared = Array.isArray(doc.claims) ? doc.claims : null;
  if (declared === null) return { error: 'the document needs a claims list' };
  // Through the reader, not straight from the document. `readClaim` validates a record and
  // moves its validity window under `applicability`, which is where the conflict detector
  // compares it: a raw record with a top-level `validFrom` read as a claim with no period, so
  // two values that were successive in time came back `indeterminate` instead of
  // `different-period`, and one that was a real contradiction did the same.
  const refused = [];
  const claims = declared.map((record) => {
    const read = readClaim(record);
    if (read.claim === undefined) {
      refused.push({ id: record?.id ?? null, reason: (read.problems ?? ['the claim could not be read']).join('; ') });
      return record;
    }
    const validity = readApplicability(read.claim.applicability ?? record);
    return { ...read.claim, applicability: read.claim.applicability ?? validity.applicability ?? null };
  });
  const claim = claims.find((record) => record?.id === id) ?? null;
  if (claim === null) return { error: `no claim ${id} in the document, which holds ${claims.length} claim(s)` };

  const graph = buildClaimGraph({ artifacts: Array.isArray(doc.artifacts) ? doc.artifacts : [], claims, edges: Array.isArray(doc.edges) ? doc.edges : [] });
  const upstream = lineage(graph, id);
  const downstream = impact(graph, id);
  const conflicts = findConflicts(claims);
  const validity = readApplicability(claim.applicability ?? claim);
  return {
    ok: true,
    command: 'knowledge why',
    id,
    claim,
    graph: { edges: Array.isArray(graph.edges) ? graph.edges.length : 0 },
    lineage: { reachable: upstream.reachable, edges: upstream.edges.length, cycles: upstream.cycles, truncated: upstream.truncated },
    impact: { reachable: downstream.reachable, edges: downstream.edges.length, cycles: downstream.cycles, truncated: downstream.truncated },
    conflicts: conflicts.findings.filter((finding) => finding.claims.includes(id)),
    applicability: validity.applicability ?? claim.applicability ?? null,
    problems: [...(validity.problems ?? []), ...refused.map((entry) => `${entry.id ?? '(no id)'}: ${entry.reason}`)],
    proposedEdges: proposedEdges(graph).filter((edge) => edge.from === id || edge.to === id).length,
    certifies: conflicts.certifies,
  };
}

export async function knowledgeWhyCommand(args, flags) {
  if (args.length === 0) return fail('a claim id is required', EXIT.USAGE, USAGE);
  if (args.length > 1) return fail(`unknown knowledge why argument ${args[1]}`, EXIT.USAGE, USAGE);
  const read = await readJsonDocument(flags, 'claims');
  if (read.error !== undefined) return fail(read.error, EXIT.USAGE, USAGE);
  const payload = knowledgeWhyFacts(read.doc, args[0]);
  if (payload.error !== undefined) return fail(payload.error, EXIT.FAIL, `a document of {claims, edges, artifacts}, with an id on every claim you name`);
  present(payload, () => render(payload), flags);
  return EXIT.OK;
}

function render(payload) {
  const lines = [`claim      ${payload.id}`];
  lines.push(`asserts    ${payload.claim.subject} ${payload.claim.predicate} = ${JSON.stringify(payload.claim.value)}${payload.claim.unit ? ` ${payload.claim.unit}` : ''}`);
  lines.push(`status     ${payload.claim.status ?? 'unspecified'}`);
  lines.push(`lineage    ${payload.lineage.reachable.length} node(s), ${payload.lineage.edges} edge(s)`);
  for (const id of payload.lineage.reachable.filter((entry) => entry !== payload.id)) lines.push(`derives    ${id}`);
  lines.push(`impact     ${payload.impact.reachable.length} node(s), ${payload.impact.edges} edge(s)`);
  for (const id of payload.impact.reachable.filter((entry) => entry !== payload.id)) lines.push(`affects    ${id}`);
  for (const finding of payload.conflicts) {
    lines.push(`conflict   ${finding.verdict} against ${finding.claims.filter((id) => id !== payload.id).join(', ')}`);
  }
  if (payload.conflicts.length === 0) lines.push('conflict   none among the claims in this document');
  if (payload.applicability !== null) {
    lines.push(`valid      ${payload.applicability.validFrom} .. ${payload.applicability.validTo ?? 'open'}`);
  }
  for (const problem of payload.problems) lines.push(`problem    ${problem}`);
  if (payload.lineage.truncated || payload.impact.truncated) lines.push('truncated  1');
  if (!payload.certifies) lines.push('certifies  no: this scan covers declared claims, not the documents behind them');
  return lines.join('\n');
}
