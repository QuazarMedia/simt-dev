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
import { applicableClaims, readApplicability } from '../knowledge/validity.mjs';
import { MAX_PAGE, exportBundle, importBundle } from '../knowledge/bundle.mjs';
import { readJsonDocument } from './doc-input.mjs';
import { readFile } from 'node:fs/promises';
import { rank as rankUnits } from '../knowledge/rank.mjs';
import { regenerationCandidates } from '../knowledge/derivations.mjs';
import { aggregate as aggregateDebt, coldStart as coldStartDebt, rank as rankDebt, weightSensitivity } from '../knowledge/debt.mjs';
import { impactReport } from '../knowledge/impact.mjs';
import { extractDocument } from '../knowledge/sections.mjs';

const WHY_USAGE = `run: ${CLI} knowledge why <claim-id> --claims <file> [--limit <n>] [--page <n>]`;
const EXPORT_USAGE = `run: ${CLI} knowledge export --input <file>`;
const IMPORT_USAGE = `run: ${CLI} knowledge import --input <file>`;

/**
 * @param {object} doc
 * @param {string} id
 * @param {{limit?: number, page?: number}} [paging]
 * @returns {object}
 */
export function knowledgeWhyFacts(doc, id, { limit = MAX_PAGE, page = 0, asOf = null, knownAt = null } = {}) {
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
  // The map keeps the raw record for a refused claim so its problems can be reported; that
  // also made the requested id findable, and the command then rendered `asserts undefined`
  // and exited 0. A refusal is the answer for that id.
  const refusedHere = refused.find((entry) => entry.id === id);
  if (refusedHere) return { error: `claim ${id} was refused: ${refusedHere.reason}` };

  const claim = claims.find((record) => record?.id === id) ?? null;
  if (claim === null) return { error: `no claim ${id} in the document, which holds ${claims.length} claim(s)` };

  // A refused sibling is not evidence about anything: it stays in `refused` and in the
  // problems list, but the graph and the conflict detector only see claims that read.
  const readable = claims.filter((record) => !refused.some((entry) => entry.id === record?.id));

  const graph = buildClaimGraph({ artifacts: Array.isArray(doc.artifacts) ? doc.artifacts : [], claims: readable, edges: Array.isArray(doc.edges) ? doc.edges : [] });
  const upstream = lineage(graph, id);
  const downstream = impact(graph, id);
  const conflicts = findConflicts(readable);
  const validity = readApplicability(claim.applicability ?? claim);

  // W14: "what applied at this date, knowing what was known then" is a different question from
  // "what does the claim say", and it is the one latest-wins gets wrong. Asked only when both
  // dates are given: an answer without a time is not a bitemporal one.
  let at = null;
  if ((typeof asOf === 'string' && asOf !== '') || (typeof knownAt === 'string' && knownAt !== '')) {
    try {
      at = applicableClaims(claims, {
        subject: claim.subject,
        predicate: claim.predicate,
        asOf,
        knownAt,
        authority: Array.isArray(doc.authority) ? doc.authority : [],
      });
    } catch (error) {
      return { error: error.message };
    }
  }

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
    at,
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

/**
 * The units a question may use, ranked (W19).
 *
 * @param {object} doc
 * @param {{query?: string, limit?: number}} [options]
 * @returns {object}
 */
function knowledgeRankFacts(doc, { query = '', limit = 10 } = {}) {
  const units = Array.isArray(doc?.units) ? doc.units : null;
  if (units === null) return { error: 'the document needs a units list: [{id, path, text, headings, scope, authority}]' };
  if (typeof query !== 'string' || query.trim() === '') return { error: 'rank needs --query' };
  return {
    ok: true,
    command: 'knowledge rank',
    ...rankUnits(units, {
      query,
      scope: doc.scope ?? {},
      permissions: Array.isArray(doc.permissionsHeld) ? doc.permissionsHeld : null,
      limit: Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 10,
    }),
  };
}

/**
 * Which outputs a change puts in question (W17).
 *
 * @param {object} doc
 * @returns {object}
 */
function knowledgeDerivationsFacts(doc) {
  try {
    return { ok: true, command: 'knowledge derivations', ...regenerationCandidates(doc) };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Rank the knowledge debt by consequence per effort (W47).
 *
 * @param {object} doc
 * @param {{weights?: object|null}} [options]
 * @returns {object}
 */
function knowledgeDebtFacts(doc, { weights = null } = {}) {
  const items = Array.isArray(doc?.items) ? doc.items : null;
  if (items === null) return { error: 'the document needs an items list' };
  const chosen = weights ?? (doc.weights !== null && typeof doc.weights === 'object' ? doc.weights : null);
  const options = chosen === null ? {} : { weights: chosen };
  let sensitivity = null;
  if (doc.sensitivity !== null && typeof doc.sensitivity === 'object') {
    try {
      sensitivity = weightSensitivity(items, { weights: chosen ?? undefined, field: doc.sensitivity.field, to: Number(doc.sensitivity.to) });
    } catch (error) {
      sensitivity = { error: error.message };
    }
  }
  const ranked = rankDebt(items, options);
  return {
    ok: true,
    command: 'knowledge debt',
    ranked,
    aggregate: aggregateDebt(items, options),
    coldStart: coldStartDebt(ranked),
    sensitivity,
    weights: chosen,
  };
}

/**
 * What a change reaches over typed edges, and where the graph cannot say (W22).
 *
 * @param {object} doc
 * @param {{refs?: string[], limit?: number|null}} [options]
 * @returns {object}
 */
function knowledgeImpactFacts(doc, { refs = [], limit = null } = {}) {
  const graph = doc?.graph ?? (Array.isArray(doc?.nodes) ? { nodes: doc.nodes, edges: Array.isArray(doc.edges) ? doc.edges : [] } : null);
  const changed = Array.isArray(refs) && refs.length > 0 ? refs : doc?.change?.refs;
  if (!Array.isArray(changed) || changed.length === 0) return { error: 'impact needs --refs <id,...> or change.refs' };
  try {
    return {
      ok: true,
      command: 'knowledge impact',
      ...impactReport({
        graph,
        change: { refs: changed, scopes: doc.change?.scopes ?? doc.scopes ?? {}, tenant: doc.change?.tenant ?? doc.tenant ?? null },
        derivations: doc.derivations ?? null,
        lessons: Array.isArray(doc.lessons) ? doc.lessons : [],
        limits: limit === null || limit === undefined || !Number.isFinite(Number(limit)) ? {} : { nodes: Number(limit) },
      }),
    };
  } catch (error) {
    return { error: error.message };
  }
}

function parseWeights(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const weights = {};
  for (const pair of value.split(',')) {
    const [key, raw] = pair.split('=');
    const number = Number(raw);
    if (key === undefined || key.trim() === '' || !Number.isFinite(number)) return null;
    weights[key.trim()] = number;
  }
  return Object.keys(weights).length === 0 ? null : weights;
}

function parseList(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '') : [];
}

export async function knowledgeCommand(sub, args, flags) {
  if (sub === 'why') {
    if (args.length === 0) return fail('a claim id is required', EXIT.USAGE, WHY_USAGE);
    if (args.length > 1) return fail(`unknown knowledge why argument ${args[1]}`, EXIT.USAGE, WHY_USAGE);
    const read = await readJsonDocument(flags, 'claims');
    if (read.error !== undefined) return fail(read.error, EXIT.USAGE, WHY_USAGE);
    const payload = knowledgeWhyFacts(read.doc, args[0], {
      limit: flags.limit,
      page: flags.page,
      asOf: flags.asOf,
      knownAt: flags.knownAt,
    });
    if (payload.error !== undefined) return fail(payload.error, EXIT.FAIL, 'a document of {claims, edges, artifacts}, with an id on every claim you name');
    present(payload, () => renderWhy(payload), flags);
    return EXIT.OK;
  }

  // The four document doors answer a question over one file, and none of them writes.
  if (sub === 'rank' || sub === 'derivations' || sub === 'debt' || sub === 'impact') {
    const usage = `run: ${CLI} knowledge ${sub} --input <file>`;
    if (args.length > 0) return fail(`unknown knowledge ${sub} argument ${args[0]}`, EXIT.USAGE, usage);
    const document = await readJsonDocument(flags, 'input');
    if (document.error !== undefined) return fail(document.error, EXIT.USAGE, usage);
    const payload =
      sub === 'rank'
        ? knowledgeRankFacts(document.doc, { query: flags.query, limit: flags.limit })
        : sub === 'derivations'
          ? knowledgeDerivationsFacts(document.doc)
          : sub === 'debt'
            ? knowledgeDebtFacts(document.doc, { weights: parseWeights(flags.weights) })
            : knowledgeImpactFacts(document.doc, { refs: parseList(flags.refs), limit: flags.limit });
    if (payload.error !== undefined) return fail(payload.error, EXIT.FAIL, usage);
    present(payload, () => renderKnowledge(payload), flags);
    return EXIT.OK;
  }

  if (sub === 'sections') {
    if (args.length !== 1) return fail('knowledge sections needs one markdown file', EXIT.USAGE, `run: ${CLI} knowledge sections <file.md>`);
    let source;
    try {
      source = await readFile(args[0], 'utf8');
    } catch (error) {
      return fail(`cannot read ${args[0]}: ${error.code ?? error.message}`, EXIT.FAIL, null);
    }
    const payload = { ...extractDocument(source), ok: true, command: 'knowledge sections', path: args[0] };
    present(payload, () => renderKnowledge(payload), flags);
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
  if (payload.at !== null) {
    lines.push(`at         ${payload.at.result} at ${payload.at.asOf}, knowing what was known at ${payload.at.knownAt}`);
    for (const winner of payload.at.claims) lines.push(`in force   ${winner.id} = ${JSON.stringify(winner.value)}`);
    for (const reason of payload.at.reasons) lines.push(`because    ${reason}`);
  }
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

function renderKnowledge(payload) {
  if (payload.command === 'knowledge rank') return renderRank(payload);
  if (payload.command === 'knowledge derivations') return renderDerivations(payload);
  if (payload.command === 'knowledge debt') return renderDebt(payload);
  if (payload.command === 'knowledge impact') return renderImpact(payload);
  return renderSections(payload);
}

function renderRank(payload) {
  const lines = [`query      ${payload.query}`];
  for (const hit of payload.ranked) lines.push(`${String(hit.score).padStart(6)}  ${hit.id}  ${hit.path ?? ''}`);
  if (payload.ranked.length === 0) lines.push('ranked     none for this question');
  for (const unit of payload.unknownScope) lines.push(`unknown    ${unit.path ?? unit.id}  scope not stated, so it cannot be ranked as if it applied`);
  for (const unit of payload.excluded) lines.push(`excluded   ${unit.id ?? '(no id)'}  ${unit.reason}`);
  lines.push(`embeddings ${payload.embeddings}`);
  return lines.join('\n');
}

function renderDerivations(payload) {
  const lines = [`candidates ${payload.candidates.length}`];
  for (const entry of payload.candidates) lines.push(`stale      ${entry.output}  ${(entry.reasons ?? []).join('; ')}`);
  for (const entry of payload.conflicts ?? []) lines.push(`conflict   ${entry.output}  ${(entry.reasons ?? []).join('; ')}`);
  for (const entry of payload.unknown ?? []) lines.push(`unknown    ${typeof entry === 'string' ? entry : entry.output ?? entry.id}  receipt absence cannot justify a minimal safe set`);
  for (const entry of payload.reusable ?? []) lines.push(`reuse      ${typeof entry === 'string' ? entry : entry.output ?? entry.id}`);
  return lines.join('\n');
}

function renderDebt(payload) {
  const lines = [`items      ${payload.ranked.length}`];
  for (const item of payload.ranked) {
    lines.push(`${item.score.toFixed(2).padStart(6)}  ${item.id}  ${item.kind}`);
    for (const reason of item.reasons ?? []) lines.push(`           ${reason}`);
  }
  lines.push(`total      ${payload.aggregate.totalDebt}`);
  if (payload.aggregate.confidentialExcluded > 0) lines.push(`withheld   ${payload.aggregate.confidentialExcluded} confidential item(s), counted for their owner and never in this total`);
  if (payload.coldStart.cold) lines.push('cold-start yes: no query frequency is recorded for these items');
  if (payload.sensitivity?.moved !== undefined) {
    for (const moved of payload.sensitivity.moved) lines.push(`moved      ${moved.id} ${moved.before} -> ${moved.after}`);
    lines.push(`because    ${payload.sensitivity.explanation}`);
  }
  return lines.join('\n');
}

function renderImpact(payload) {
  const lines = [`refs       ${(payload.change?.refs ?? payload.refs ?? []).join(', ')}`];
  const buckets = payload.buckets ?? null;
  if (buckets === null) {
    for (const entry of payload.affected ?? payload.reached ?? []) lines.push(`affected   ${typeof entry === 'string' ? entry : entry.id}`);
  } else {
    for (const [bucket, list] of Object.entries(buckets)) {
      for (const entry of Array.isArray(list) ? list : []) lines.push(`${bucket.padEnd(10)} ${typeof entry === 'string' ? entry : entry.id ?? JSON.stringify(entry)}`);
    }
  }
  for (const entry of payload.unknown ?? []) lines.push(`unknown    ${entry.ref ?? entry.id}  ${entry.reason ?? 'unknown'}`);
  for (const entry of payload.excluded ?? []) lines.push(`excluded   ${entry.id ?? entry.ref}  ${entry.reason ?? 'excluded'}`);
  for (const reason of payload.reasons ?? []) lines.push(`because    ${reason}`);
  if (payload.truncated) lines.push('truncated  1: the bound was reached, so verify conservatively');
  return lines.join('\n');
}

function renderSections(payload) {
  const lines = [`path       ${payload.path}`];
  const units = payload.sections ?? payload.units ?? [];
  for (const unit of units) lines.push(`${String(unit.anchor ?? '#').padEnd(30)} ${unit.title ?? unit.heading ?? ''}`);
  lines.push(`units      ${units.length}`);
  if (payload.truncated) lines.push('truncated  1');
  return lines.join('\n');
}
