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

import { readFile, mkdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { EXIT, fail, note, present, writeMode } from '../output/index.mjs';
import { CLI, MANIFEST_FILE } from '../name.mjs';
import { commandRoot } from '../repo-root.mjs';
import { diffField, emitDiffs } from '../diff.mjs';
import { readWork } from '../work/effective.mjs';
import { CORPUS_DIR, CORPUS_SCHEMA_VERSION } from '../knowledge/corpus.mjs';
import { collectCorpus, readLocalBytes } from '../knowledge/collect.mjs';
import { configuredCatalogue, scopedExchange } from '../knowledge/catalogue.mjs';
import { citationFor, citationOf, corpusDocument, rankCorpus } from '../knowledge/query.mjs';
import { buildClaimGraph, impact, lineage, proposedEdges, readClaim } from '../knowledge/claims.mjs';
import { findConflicts } from '../knowledge/conflicts.mjs';
import { applicableClaims, readApplicability, satisfiesScope, SCOPE_FIELDS } from '../knowledge/validity.mjs';
import { MAX_PAGE, exportBundle, importBundle } from '../knowledge/bundle.mjs';
import { readJsonDocument } from './doc-input.mjs';
import { rank as rankUnits } from '../knowledge/rank.mjs';
import { regenerationCandidates } from '../knowledge/derivations.mjs';
import { aggregate as aggregateDebt, coldStart as coldStartDebt, rank as rankDebt, weightSensitivity } from '../knowledge/debt.mjs';
import { impactReport } from '../knowledge/impact.mjs';
import { scopedImpact } from '../knowledge/local-impact.mjs';
import { extractDocument } from '../knowledge/sections.mjs';

const WHY_USAGE = `run: ${CLI} knowledge why <claim-id> (--claims <file> | --scope <id>) [--limit <n>] [--page <n>]`;
const RANK_USAGE = `run: ${CLI} knowledge rank (--input <file> | --scope <id>) --query "<question>"`;
const EXPORT_USAGE = `run: ${CLI} knowledge export --input <file>`;
const IMPORT_USAGE = `run: ${CLI} knowledge import --input <file>`;
const BUILD_USAGE = `run: ${CLI} knowledge build --scope <id> [--yes]`;

/** The marker a maintainer adds to turn a section into a reviewed claim, as the extractor reads it. */
const CLAIM_MARKER_EXAMPLE = '<!-- claim: id=<id> subject=<subject> predicate=<predicate> type=number value=<value> status=reviewed -->';

/**
 * The scope dimensions a `--where` flag names, validated against the ones a claim can carry.
 * Nothing is inferred from the query's spelling: a dimension nobody declared is a usage error.
 *
 * @param {unknown} value
 * @returns {{scope: object}|{error: string}}
 */
function parseWhere(value) {
  if (value === undefined || value === null || value === '') return { scope: {} };
  if (typeof value !== 'string') return { error: `--where takes key=value pairs, e.g. ${SCOPE_FIELDS[0]}=DE` };
  const scope = {};
  for (const pair of value.split(',')) {
    const eq = pair.indexOf('=');
    const key = eq === -1 ? '' : pair.slice(0, eq).trim();
    const val = eq === -1 ? '' : pair.slice(eq + 1).trim();
    if (!SCOPE_FIELDS.includes(key)) return { error: `--where: \`${key === '' ? pair.trim() : key}\` is not a scope dimension; known dimensions: ${SCOPE_FIELDS.join(', ')}` };
    if (val === '') return { error: `--where ${key} needs a value` };
    scope[key] = val;
  }
  return { scope };
}

/**
 * The one declared scope a command names, read from the effective work declaration.
 *
 * @param {object} flags
 * @param {string} verb what the caller wants to do with the scope, for the refusal's wording
 * @returns {Promise<{root: string, work: object, scope: object}|{error: {message: string, exit: number, remedy: string}}>}
 */
async function declaredScope(flags, verb) {
  const root = commandRoot(flags);
  const work = await readWork(root);
  if (!work.ok) return { error: { message: `${MANIFEST_FILE}'s work declaration is invalid: ${work.problems[0].message}`, exit: EXIT.CONFIG, remedy: work.problems[0].remedy } };
  if (!work.declared) {
    return { error: { message: `this repository declares no work, so it has no scope to ${verb}`, exit: EXIT.USAGE, remedy: `run: ${CLI} work setup --scope <id> --path <dir> --kind document` } };
  }
  const scope = work.scopes.find((row) => row.id === flags.scope);
  if (scope === undefined) {
    const known = work.scopes.map((row) => `\`${row.id}\``).join(', ');
    return { error: { message: `\`${flags.scope}\` is not a declared scope`, exit: EXIT.USAGE, remedy: known === '' ? `declare one first: ${CLI} work setup --scope <id> --path <dir> --kind document` : `declared scopes are ${known}; pass one of them as --scope` } };
  }
  return { root, work, scope };
}

/**
 * The built corpus one declared scope answers from, or the actionable reason it cannot.
 *
 * A missing, unreadable or foreign-schema corpus is a rebuild away, and the refusal says so.
 * Freshness covers what the corpus indexed: a changed or vanished source makes its sections
 * stale. A new file is a coverage gap the next build closes, not a wrong answer, so it does
 * not refuse the query.
 *
 * @param {object} flags
 * @returns {Promise<{root: string, scope: object, corpus: object}|{error: {message: string, exit: number, remedy: string}}>}
 */
async function scopedCorpus(flags) {
  const declared = await declaredScope(flags, 'query');
  if (declared.error !== undefined) return declared;
  const { root, scope } = declared;
  const rebuild = `run: ${CLI} knowledge build --scope ${scope.id} --yes`;
  const physicalRoot = await realpath(root);
  const relativePath = join(CORPUS_DIR, `${scope.id}.json`);
  const bytes = await readLocalBytes(physicalRoot, relativePath, 64 << 20);
  const text = bytes?.toString('utf8') ?? null;
  if (text === null) return { error: { message: `no corpus is built for scope \`${scope.id}\``, exit: EXIT.FAIL, remedy: rebuild } };
  let corpus;
  try {
    corpus = JSON.parse(text);
  } catch {
    return { error: { message: `the corpus for scope \`${scope.id}\` does not parse`, exit: EXIT.FAIL, remedy: rebuild } };
  }
  if (corpus?.schema !== CORPUS_SCHEMA_VERSION || corpus?.scope !== scope.id) {
    return { error: { message: `the corpus for scope \`${scope.id}\` was written under another schema or scope`, exit: EXIT.FAIL, remedy: rebuild } };
  }
  const live = await collectCorpus(declared);
  if (live.error !== undefined) return { error: { message: live.error, exit: EXIT.CONFIG, remedy: live.remedy } };
  const indexed = new Map(live.corpus.inventory.filter(({ state }) => state === 'indexed').map((row) => [row.path, row]));
  const stale = [];
  for (const row of Array.isArray(corpus.inventory) ? corpus.inventory : []) {
    if (row?.state !== 'indexed') continue;
    const current = indexed.get(row.path);
    if (!current) stale.push('a cached source is gone or outside current scope permissions');
    else if (current.digest !== row.digest) stale.push(`${current.path} changed`);
  }
  if (stale.length > 0) {
    const shown = stale.slice(0, 5).join('; ');
    return { error: { message: `the corpus for scope \`${scope.id}\` is stale: ${shown}${stale.length > 5 ? `; and ${stale.length - 5} more` : ''}`, exit: EXIT.FAIL, remedy: rebuild } };
  }
  return { ...declared, corpus: live.corpus };
}

/**
 * @param {object} doc
 * @param {string} id
 * @param {{limit?: number, page?: number}} [paging]
 * @returns {object}
 */
export function knowledgeWhyFacts(doc, id, { limit = MAX_PAGE, page = 0, asOf = null, knownAt = null, scope = {} } = {}) {
  const declared = Array.isArray(doc.claims) ? doc.claims : null;
  if (declared === null) return { error: 'the document needs a claims list' };
  // A caller through `run()` passes the strings `parse` never saw: the same rejection has
  // to happen here, or `limit: 'foo'` silently becomes MAX_PAGE.
  const size = Number(limit);
  const index = Number(page);
  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE) return { error: `--limit takes an integer from 1 to ${MAX_PAGE}` };
  if (!Number.isInteger(index) || index < 0) return { error: '--page takes a non-negative integer' };

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
        scope,
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
    if (flags.scope !== undefined) {
      if (flags.claims !== undefined) return fail('knowledge why reads --claims or --scope, not both', EXIT.USAGE, WHY_USAGE);
      const where = parseWhere(flags.where);
      if (where.error !== undefined) return fail(where.error, EXIT.USAGE, WHY_USAGE);
      const loaded = await scopedCorpus(flags);
      if (loaded.error !== undefined) return fail(loaded.error.message, loaded.error.exit, loaded.error.remedy);
      return whyFromCorpus(loaded.corpus, args[0], flags, where.scope);
    }
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

  if (sub === 'impact' && (flags.changed === true || flags.scope !== undefined)) {
    const usage = `run: ${CLI} knowledge impact --changed --scope <id>`;
    if (args.length > 0 || flags.changed !== true || typeof flags.scope !== 'string' ||
        flags.input !== undefined || flags.refs !== undefined) {
      return fail('scoped impact needs --changed and --scope without an explicit input or refs', EXIT.USAGE, usage);
    }
    const declared = await declaredScope(flags, 'inspect');
    if (declared.error !== undefined) return fail(declared.error.message, declared.error.exit, declared.error.remedy);
    let report;
    try {
      report = await scopedImpact({ ...declared, limit: flags.limit });
    } catch (error) {
      return fail(`could not inspect the scoped change: ${error.message.split('\n')[0]}`, EXIT.FAIL, usage);
    }
    if (report.error !== undefined) return fail(report.error, EXIT.FAIL, report.remedy);
    const payload = { ok: true, command: 'knowledge impact', ...report };
    present(payload, () => renderImpact(payload), flags);
    return EXIT.OK;
  }

  // The four document doors answer a question over one file, and none of them writes.
  if (sub === 'rank' || sub === 'derivations' || sub === 'debt' || sub === 'impact') {
    if (sub === 'rank' && flags.scope !== undefined) {
      if (args.length > 0) return fail(`unknown knowledge rank argument ${args[0]}`, EXIT.USAGE, RANK_USAGE);
      if (flags.input !== undefined) return fail('knowledge rank reads --input or --scope, not both', EXIT.USAGE, RANK_USAGE);
      if (typeof flags.query !== 'string' || flags.query.trim() === '') return fail('rank needs --query', EXIT.USAGE, RANK_USAGE);
      const where = parseWhere(flags.where);
      if (where.error !== undefined) return fail(where.error, EXIT.USAGE, RANK_USAGE);
      const loaded = await scopedCorpus(flags);
      if (loaded.error !== undefined) return fail(loaded.error.message, loaded.error.exit, loaded.error.remedy);
      const limit = Number.isFinite(Number(flags.limit)) ? Math.floor(Number(flags.limit)) : 10;
      const catalogue = await configuredCatalogue(loaded, loaded.corpus);
      const alias = catalogue?.entries?.find(({ id }) => id === flags.query);
      const query = alias?.artifact ?? flags.query;
      const scoped = rankCorpus(loaded.corpus, { query, scope: where.scope, limit });
      const required = Object.entries(where.scope);
      scoped.exact = scoped.exact.filter(({ citation }) =>
        satisfiesScope(citation.scope, required) === 'match' &&
        (!alias || citation.path === alias.path && citation.anchor === alias.anchor));
      const payload = { ok: true, command: 'knowledge rank', ...scoped, query: flags.query,
        ...(catalogue === null ? {} : { catalogue: catalogue.error ? { error: catalogue.error }
          : { matched: scoped.exact.length > 0 ? alias?.id ?? null : null, candidates: catalogue.entries.length, problems: catalogue.problems.length } }) };

      present(payload, () => renderKnowledge(payload), flags);
      return EXIT.OK;
    }
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

  if (sub === 'build') {
    if (args.length > 0) return fail(`unknown knowledge build argument ${args[0]}`, EXIT.USAGE, BUILD_USAGE);
    if (typeof flags.scope !== 'string' || flags.scope === '') return fail('knowledge build needs a scope', EXIT.USAGE, BUILD_USAGE);
    return knowledgeBuildCommand(flags);
  }

  if ((sub === 'export' || sub === 'import') && flags.scope !== undefined) {
    const usage = `run: ${CLI} knowledge ${sub} --scope <id>${sub === 'import' ? ' --input <file>' : ''}`;
    if (args.length > 0 || typeof flags.scope !== 'string' ||
        (sub === 'import' ? flags.input === undefined : flags.input !== undefined)) {
      return fail('scoped exchange needs the intended scope and input form', EXIT.USAGE, usage);
    }
    const context = await declaredScope(flags, sub);
    if (context.error !== undefined) return fail(context.error.message, context.error.exit, context.error.remedy);
    let doc = null;
    if (sub === 'import') {
      const read = await readJsonDocument(flags, 'input');
      if (read.error !== undefined) return fail(read.error, EXIT.USAGE, usage);
      doc = read.doc;
    }
    try {
      const result = await scopedExchange(sub, context, { doc, limit: Number(flags.limit ?? 20), page: Number(flags.page ?? 0) });
      if (result.error !== undefined) return fail(result.error, EXIT.FAIL, result.remedy ?? usage);
      const payload = { ok: true, command: `knowledge ${sub}`, ...result };
      present(payload, () => sub === 'export' ? renderExport(payload)
        : Array.isArray(payload.entries) ? renderCatalogue(payload) : renderImport(payload), flags);
      return payload.ok ? EXIT.OK : EXIT.FAIL;
    } catch (error) {
      return fail(`cannot ${sub} scoped knowledge: ${error.message.split('\n')[0]}`, EXIT.FAIL, usage);
    }
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

/**
 * `knowledge why` over a built corpus: a claim gets the full explanation, and a section
 * without one gets its citation and the supported way to add a claim. A section is evidence;
 * refusing it outright would hide the source the search just found.
 *
 * @param {object} corpus
 * @param {string} id
 * @param {object} flags
 * @param {object} where the scope dimensions the question requires
 * @returns {number}
 */
function whyFromCorpus(corpus, id, flags, where) {
  const found = citationFor(corpus, id);
  if (found === null) {
    return fail(`no claim or section \`${id}\` in scope \`${corpus.scope}\``, EXIT.FAIL, `run: ${CLI} knowledge rank --scope ${corpus.scope} --query "<terms>" to find the id a citation carries`);
  }
  if (found.kind === 'claim') {
    const payload = knowledgeWhyFacts(corpusDocument(corpus), id, {
      limit: flags.limit,
      page: flags.page,
      asOf: flags.asOf,
      knownAt: flags.knownAt,
      scope: where,
    });
    if (payload.error !== undefined) return fail(payload.error, EXIT.FAIL, WHY_USAGE);
    payload.scope = corpus.scope;
    payload.source = { path: found.artifact.path, revision: found.artifact.revision, provenance: found.artifact.provenance };
    present(payload, () => renderWhy(payload), flags);
    return EXIT.OK;
  }
  const claims = Array.isArray(found.artifact.claims) ? found.artifact.claims : [];
  const payload = {
    ok: true,
    command: 'knowledge why',
    id,
    scope: corpus.scope,
    kind: found.kind,
    claim: null,
    source: found.unit !== undefined
      ? citationOf(found.unit, found.artifact)
      : { path: found.artifact.path, revision: found.artifact.revision, provenance: found.artifact.provenance, authorityBasis: 'evidence' },
    claims: claims.map((claim) => claim.id),
    reason: claims.length > 0
      ? `this artifact holds ${claims.length} claim(s); ask about one by its id`
      : 'this section is evidence, and no reviewed claim states it',
    addClaim: {
      marker: CLAIM_MARKER_EXAMPLE,
      remedy: `add a claim marker beside the section in ${found.artifact.path}, then run: ${CLI} knowledge build --scope ${corpus.scope} --yes`,
    },
  };
  present(payload, () => renderWhy(payload), flags);
  return EXIT.OK;
}

function renderWhy(payload) {
  if (payload.claim === null) return renderCitation(payload);
  const lines = [`claim      ${payload.id}`];
  if (payload.scope !== undefined) lines.push(`scope      ${payload.scope}`);
  if (payload.source !== undefined) lines.push(`source     ${payload.source.path} (${payload.source.provenance})`);
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
  // `size` is the limit, not a page count: `page 0 of 50` read as fifty pages when the
  // document held three nodes. The machine fields `index`, `size` and `total` stay stable.
  lines.push(`page       ${payload.page.index} (limit ${payload.page.size}, ${payload.page.total} node(s))`);
  if (payload.lineage.truncated || payload.impact.truncated) lines.push('truncated  1');
  if (!payload.certifies) lines.push('certifies  no: this scan covers declared claims, not the documents behind them');
  return lines.join('\n');
}

function renderCitation(payload) {
  const source = payload.source;
  const lines = [
    `citation   ${payload.id}`,
    `scope      ${payload.scope}`,
    `source     ${source.path}${source.anchor ? `#${source.anchor}` : ''}`,
  ];
  if (source.lineStart !== undefined) lines.push(`lines      ${source.lineStart}..${source.lineEnd} (bytes ${source.byteStart}..${source.byteEnd})`);
  lines.push(`revision   ${source.revision ?? '(none)'} (${source.provenance})`);
  lines.push(`authority  ${source.authorityBasis ?? 'evidence'}`);
  lines.push(`reason     ${payload.reason}`);
  for (const id of payload.claims) lines.push(`claim      ${id}  run: ${CLI} knowledge why ${id} --scope ${payload.scope}`);
  lines.push(`add claim  ${payload.addClaim.marker}`);
  lines.push(`remedy     ${payload.addClaim.remedy}`);
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

function renderCatalogue(payload) {
  return [`candidates ${payload.entries.length}`, `proposed   ${payload.edges.length} edge(s)`,
    `observed   ${payload.observations.length} external record(s)`,
    ...payload.problems.map(({ code, id }) => `unknown    ${code}${id ? `  ${id}` : ''}`),
    'executed   0'].join('\n');
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

/**
 * Build one scope's corpus, previewed and then written under the ignored local area.
 *
 * The build reads tracked files, so it answers from the manifest and from Git and never from
 * a guess about the directory. A scope that is not declared is refused by name instead of
 * being sampled: an undeclared scope has no authority to include anything.
 *
 * @param {object} flags
 * @returns {Promise<number>}
 */
async function knowledgeBuildCommand(flags) {
  const mode = writeMode(flags);
  const declared = await declaredScope(flags, 'build');
  if (declared.error !== undefined) return fail(declared.error.message, declared.error.exit, declared.error.remedy);
  const { root, work, scope } = declared;

  const relativePath = join(CORPUS_DIR, `${scope.id}.json`);
  const path = join(root, relativePath);
  const before = await readTextFile(path);
  let previous = null;
  if (before !== null) {
    try {
      previous = JSON.parse(before);
    } catch {
      // A corpus this build cannot read is not a policy: it is a cache, and a cache that does
      // not parse is rebuilt rather than trusted.
      previous = null;
    }
  }

  const collected = await collectCorpus({ root, work, scope, previous });
  if (collected.error !== undefined) return fail(collected.error, EXIT.CONFIG, collected.remedy);
  const { corpus, truncated } = collected;
  // The stored document is the corpus, and only the corpus: a build statistic kept inside it
  // would make the second build differ from the first byte for byte.
  const stored = { schema: corpus.schema, scope: corpus.scope, policy: corpus.policy, counts: corpus.counts, inventory: corpus.inventory, artifacts: corpus.artifacts, units: corpus.units, problems: corpus.problems };
  const text = `${JSON.stringify(stored, null, 2)}\n`;
  const changed = before !== text;
  const apply = `run: ${CLI} knowledge build --scope ${scope.id} --yes`;
  const diffs = flags.diff === true ? [{ path: relativePath, before, after: text }] : [];
  const payload = {
    ok: true,
    command: 'knowledge build',
    root,
    scope: scope.id,
    corpus: relativePath,
    dryRun: !mode.apply,
    changed,
    written: false,
    truncated,
    policy: corpus.policy,
    counts: corpus.counts,
    reused: corpus.reused,
    inventory: corpus.inventory,
    artifacts: corpus.artifacts,
    units: corpus.units,
    problems: corpus.problems,
    ...diffField(diffs, flags),
    remedy: changed && !mode.apply ? apply : null,
  };

  if (mode.apply && changed) {
    // A corpus is derived state under the ignored area, so it is not journaled: nothing under
    // `.simt/` is. It is written through a temporary file and a rename instead, so a reader
    // never sees half a JSON document, and a rebuild is the way back from a bad one.
    const temp = `${path}.tmp-${process.pid}`;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(temp, text);
      await rename(temp, path);
    } catch (error) {
      await unlink(temp).catch(() => {});
      return fail(`the corpus could not be written: ${String(error?.message ?? error).split('\n')[0]}`, EXIT.FAIL, `the previous corpus, if any, is untouched; fix the reason, then rerun ${apply.replace('run: ', '')}`);
    }
    payload.written = true;
    note(`wrote    ${relativePath}`);
  }

  present(payload, () => renderBuild(payload), flags);
  emitDiffs(diffs, flags);
  return EXIT.OK;
}

async function readTextFile(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function renderBuild(payload) {
  const counts = payload.counts;
  const refused = ['ignored', 'denied', 'symlink', 'untracked', 'too-large', 'generated', 'sidecar', 'unsupported', 'missing', 'outside']
    .filter((state) => counts[state] > 0)
    .map((state) => `${counts[state]} ${state}`)
    .join(', ');
  const lines = [
    `scope      ${payload.scope}  ${counts.candidates} candidates, ${counts.indexed} indexed`,
    `units      ${counts.units} sections (${payload.reused} reused)`,
    `artifacts  ${counts.artifacts} (${counts.claims} claims)`,
    `policy     ${payload.policy}`,
    `corpus     ${payload.corpus}`,
  ];
  if (refused !== '') lines.push(`refused    ${refused}`);
  // Metadata findings are counted by code, so a missing source, a proposed link and an invalid
  // date are three answers rather than one number.
  const codes = new Map();
  for (const entry of payload.problems) codes.set(entry.code, (codes.get(entry.code) ?? 0) + 1);
  if (codes.size > 0) lines.push(`findings   ${[...codes].sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => `${count} ${code}`).join(', ')}`);
  if (payload.truncated) lines.push(`truncated  the build stopped at its candidate bound; scope a smaller path or build the rest under a second scope`);
  if (!payload.changed) lines.push('unchanged  the corpus on disk is the one this build would write');
  else lines.push(payload.written ? 'wrote      one corpus' : 'would write  one corpus (preview: no bytes written)');
  if (payload.remedy !== null) lines.push(`apply      ${payload.remedy}`);
  return lines.join('\n');
}

export function renderKnowledge(payload) {
  if (payload.command === 'knowledge build') return renderBuild(payload);
  if (payload.command === 'knowledge rank') return renderRank(payload);
  if (payload.command === 'knowledge derivations') return renderDerivations(payload);
  if (payload.command === 'knowledge debt') return renderDebt(payload);
  if (payload.command === 'knowledge impact') return renderImpact(payload);
  return renderSections(payload);
}

function renderRank(payload) {
  const lines = [`query      ${payload.query}`];
  if (payload.scope !== undefined && payload.scope !== null) lines.push(`scope      ${payload.scope}`);
  for (const hit of payload.ranked) {
    lines.push(`${String(hit.score).padStart(6)}  ${hit.id}  ${hit.path ?? ''}`);
    if (hit.citation != null) {
      const cite = hit.citation;
      lines.push(`        cite ${cite.path}${cite.anchor ? `#${cite.anchor}` : ''} lines ${cite.lineStart}..${cite.lineEnd} · ${cite.authorityBasis} · ${cite.revision ?? cite.provenance}`);
    }
  }
  if (payload.ranked.length === 0) lines.push('ranked     none for this question');
  for (const reason of payload.reasons ?? []) lines.push(`because    ${reason}`);
  for (const entry of payload.exact ?? []) {
    const cite = entry.citation;
    lines.push(`exact      ${entry.id}  ${cite.path}${cite.anchor ? `#${cite.anchor}` : ''} lines ${cite.lineStart}..${cite.lineEnd}`);
  }
  for (const unit of payload.unknownScope) lines.push(`unknown    ${unit.path ?? unit.id}  scope not stated, so it cannot be ranked as if it applied`);
  for (const unit of payload.excluded) lines.push(`excluded   ${unit.id ?? '(no id)'}  ${unit.reason}`);
  lines.push(`embeddings ${payload.embeddings}`);
  return lines.join('\n');
}

function renderDerivations(payload) {
  const lines = [`candidates ${payload.candidates.length}`];
  for (const entry of payload.candidates) lines.push(`stale      ${entry.output}  ${(entry.reasons ?? []).join('; ')}`);
  for (const entry of payload.conflicts ?? []) lines.push(`conflict   ${entry.output}  ${(entry.reasons ?? []).join('; ')}`);
  if (payload.status === 'nothing-changed') lines.push('change     no changed paths in this scope');
  for (const entry of payload.proposed ?? []) lines.push(`proposed    ${entry}`);
  for (const entry of payload.regeneration?.stale ?? []) {
    lines.push(`stale      ${entry.output}${entry.generator ? `  generator=${entry.generator.id}` : ''}  ${entry.reasons.join(', ')}`);
  }
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
  const lines = [`refs       ${(payload.changed ?? payload.change?.refs ?? payload.refs ?? []).join(', ')}`];
  // `impactReport` hands back `affected` as a bucket object; the flat-list shape is the
  // legacy one. Both render; the object is iterated per bucket so a claims-only change is
  // not printed as `affected undefined`.
  const affected = payload.buckets ?? payload.affected ?? payload.reached ?? [];
  const rows = Array.isArray(affected)
    ? affected.map((entry) => ['affected', entry])
    : Object.entries(affected).flatMap(([bucket, list]) => (Array.isArray(list) ? list : []).map((entry) => [bucket, entry]));
  for (const [bucket, entry] of rows) lines.push(`${bucket.padEnd(10)} ${typeof entry === 'string' ? entry : entry.id ?? JSON.stringify(entry)}`);
  if (payload.status === 'nothing-changed') lines.push('change     no changed paths in this scope');
  for (const entry of payload.proposed ?? []) lines.push(`proposed    ${entry}`);
  for (const entry of payload.regeneration?.stale ?? []) {
    lines.push(`stale      ${entry.output}${entry.generator ? `  generator=${entry.generator.id}` : ''}  ${entry.reasons.join(', ')}`);
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
