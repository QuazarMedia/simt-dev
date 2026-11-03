// `simt knowledge why | export | import` — the knowledge doors (W20, W23).
//
// `why` answers why a claim is held, what rests on it, and where it disagrees. `export` writes a
// bounded, permission-filtered packet another repository can read offline; `import` validates
// such a packet as data and never as an instruction. All three read a document and none of them
// writes, dispatches or opens a socket.
//
// The two collections `why` returns are paged, because `READ_ONLY_DOORS` declares this door
// paginated: a door that can only answer "all of it" is a door whose answer grows without a
// bound, and the cut has to be visible rather than implied.

import { EXIT, fail, present } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { buildClaimGraph, impact, lineage, proposedEdges, readClaim } from '../knowledge/claims.mjs';
import { findConflicts } from '../knowledge/conflicts.mjs';
import { readApplicability } from '../knowledge/validity.mjs';
import { MAX_PAGE, exportBundle, importBundle } from '../knowledge/bundle.mjs';
import { readJsonDocument } from './doc-input.mjs';

const WHY_USAGE = `run: ${CLI} knowledge why <claim-id> --claims <file> [--limit <n>] [--page <n>]`;
const EXPORT_USAGE = `run: ${CLI} knowledge export --input <file>`;
const IMPORT_USAGE = `run: ${CLI} knowledge import --input <file>`;

/**
 * @param {object} doc
 * @param {string} id
 * @param {{limit?: number, page?: number}} [paging]
 * @returns {object}
 */
export function knowledgeWhyFacts(doc, id, { limit = MAX_PAGE, page = 0 } = {}) {
  const declared = Array.isArray(doc.claims) ? doc.claims : null;
  if (declared === null) return { error: 'the document needs a claims list' };
  const size = Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : MAX_PAGE;
  const index = Number.isFinite(Number(page)) ? Math.floor(Number(page)) : 0;
  if (size < 1 || size > MAX_PAGE) return { error: `--limit takes 1 to ${MAX_PAGE}` };
  if (index < 0) return { error: '--page takes a non-negative number' };

  // Through the reader, not straight from the document. `readClaim` validates a record and moves
  // its validity window under `applicability`, which is where the conflict detector compares it:
  // a raw record with a top-level `validFrom` read as a claim with no period, so two values that
  // were successive in time came back `indeterminate` instead of `different-period`.
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

  const start = index * size;
  const pageOf = (list, walk) => {
    const slice = list.slice(start, start + size);
    return {
      reachable: slice,
      total: list.length,
      edges: walk.edges.length,
      cycles: walk.cycles,
      // Two cuts, and both are said out loud: this page stopped short, or the walk did.
      truncated: walk.truncated || list.length > start + slice.length,
    };
  };

  return {
    ok: true,
    command: 'knowledge why',
    id,
    claim,
    graph: { edges: Array.isArray(graph.edges) ? graph.edges.length : 0 },
    lineage: pageOf(upstream.reachable, upstream),
    impact: pageOf(downstream.reachable, downstream),
    conflicts: conflicts.findings.filter((finding) => finding.claims.includes(id)),
    applicability: validity.applicability ?? claim.applicability ?? null,
    problems: [...(validity.problems ?? []), ...refused.map((entry) => `${entry.id ?? '(no id)'}: ${entry.reason}`)],
    proposedEdges: proposedEdges(graph).filter((edge) => edge.from === id || edge.to === id).length,
    certifies: conflicts.certifies,
    page: { index, size, total: Math.max(upstream.reachable.length, downstream.reachable.length) },
  };
}

/**
 * @param {object} doc
 * @returns {object}
 */
export function knowledgeExportFacts(doc) {
  try {
    const result = exportBundle({
      facts: Array.isArray(doc.facts) ? doc.facts : [],
      repository: doc.repository ?? null,
      revisions: doc.revisions ?? [],
      applicability: doc.applicability ?? {},
      expiresAt: doc.expiresAt ?? null,
      permissionsHeld: Array.isArray(doc.permissionsHeld) ? doc.permissionsHeld : [],
      limitBytes: doc.limitBytes,
      limit: doc.limit,
      page: doc.page,
      hideCounts: doc.hideCounts === true,
    });
    return { ok: true, command: 'knowledge export', ...result };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * @param {object} doc
 * @returns {object}
 */
export function knowledgeImportFacts(doc) {
  // A document may be the packet itself or a wrapper carrying the permissions the reader holds.
  const packet = doc !== null && typeof doc === 'object' && doc.bundle !== undefined ? doc.bundle : doc;
  return {
    ok: true,
    command: 'knowledge import',
    ...importBundle(packet, {
      permissionsHeld: Array.isArray(doc.permissionsHeld) ? doc.permissionsHeld : [],
      at: typeof doc.at === 'string' ? doc.at : null,
    }),
  };
}

export async function knowledgeCommand(sub, args, flags) {
  if (sub === 'why') {
    if (args.length === 0) return fail('a claim id is required', EXIT.USAGE, WHY_USAGE);
    if (args.length > 1) return fail(`unknown knowledge why argument ${args[1]}`, EXIT.USAGE, WHY_USAGE);
    const read = await readJsonDocument(flags, 'claims');
    if (read.error !== undefined) return fail(read.error, EXIT.USAGE, WHY_USAGE);
    const payload = knowledgeWhyFacts(read.doc, args[0], { limit: flags.limit, page: flags.page });
    if (payload.error !== undefined) return fail(payload.error, EXIT.FAIL, 'a document of {claims, edges, artifacts}, with an id on every claim you name');
    present(payload, () => renderWhy(payload), flags);
    return EXIT.OK;
  }

  if (args.length > 0) return fail(`unknown knowledge ${sub} argument ${args[0]}`, EXIT.USAGE, sub === 'export' ? EXPORT_USAGE : IMPORT_USAGE);
  const read = await readJsonDocument(flags, 'input');
  if (read.error !== undefined) return fail(read.error, EXIT.USAGE, sub === 'export' ? EXPORT_USAGE : IMPORT_USAGE);

  if (sub === 'export') {
    const payload = knowledgeExportFacts(read.doc);
    if (payload.error !== undefined) return fail(payload.error, EXIT.USAGE, 'the limit and page in the document are invalid');
    present(payload, () => renderExport(payload), flags);
    return EXIT.OK;
  }

  const payload = knowledgeImportFacts(read.doc);
  present(payload, () => renderImport(payload), flags);
  return payload.ok ? EXIT.OK : EXIT.FAIL;
}

function renderWhy(payload) {
  const lines = [`claim      ${payload.id}`];
  lines.push(`asserts    ${payload.claim.subject} ${payload.claim.predicate} = ${JSON.stringify(payload.claim.value)}${payload.claim.unit ? ` ${payload.claim.unit}` : ''}`);
  lines.push(`status     ${payload.claim.status ?? 'unspecified'}`);
  lines.push(`lineage    ${payload.lineage.total} node(s), ${payload.lineage.edges} edge(s)`);
  for (const id of payload.lineage.reachable.filter((entry) => entry !== payload.id)) lines.push(`derives    ${id}`);
  lines.push(`impact     ${payload.impact.total} node(s), ${payload.impact.edges} edge(s)`);
  for (const id of payload.impact.reachable.filter((entry) => entry !== payload.id)) lines.push(`affects    ${id}`);
  for (const finding of payload.conflicts) {
    lines.push(`conflict   ${finding.verdict} against ${finding.claims.filter((id) => id !== payload.id).join(', ')}`);
  }
  if (payload.conflicts.length === 0) lines.push('conflict   none among the claims in this document');
  if (payload.applicability !== null) {
    lines.push(`valid      ${payload.applicability.validFrom} .. ${payload.applicability.validTo ?? 'open'}`);
  }
  for (const problem of payload.problems) lines.push(`problem    ${problem}`);
  lines.push(`page       ${payload.page.index} of ${payload.page.size} (${payload.page.total} node(s))`);
  if (payload.lineage.truncated || payload.impact.truncated) lines.push('truncated  1');
  if (!payload.certifies) lines.push('certifies  no: this scan covers declared claims, not the documents behind them');
  return lines.join('\n');
}

function renderExport(payload) {
  const bundle = payload.bundle;
  const lines = [
    `schema     ${bundle.schema}`,
    `producer   ${bundle.producer.digest}`,
    `facts      ${bundle.facts.length} of ${bundle.page.total} (page ${bundle.page.index})`,
    `withheld   ${bundle.omitted.restricted === null ? 'not stated by policy' : bundle.omitted.restricted}`,
    `expires    ${bundle.expiresAt ?? 'never'}`,
    `bytes      ${payload.bytes}`,
  ];
  for (const reason of payload.reasons) lines.push(`cut        ${reason}`);
  if (payload.truncated) lines.push('truncated  1');
  return lines.join('\n');
}

function renderImport(payload) {
  const lines = [
    `accepted   ${payload.ok ? 'yes' : 'no'}`,
    `facts      ${payload.facts.length}`,
    `withheld   ${payload.withheld}`,
    `executed   no: an imported packet is data, and every fact in it stays a sentence`,
    `treat as   ${payload.treatAs}`,
  ];
  for (const problem of payload.problems) lines.push(`problem    ${problem.code}  ${problem.detail}`);
  if (payload.bundle !== undefined) lines.push(`producer   ${payload.bundle.producer?.digest ?? '(none)'}`);
  return lines.join('\n');
}
