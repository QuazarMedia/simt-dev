// The doors the remaining Plan 4 modules were missing.
//
// Each of these modules shipped with its own unit test and no caller: a review bundle that no
// reviewer could open (W42), an adapter contract suite nothing validated against (W48), the
// obligation evaluators behind `verify` (W24, W26, W30), discovery candidates that were never
// recallable (W43), the proof-bearing packet (W20), the index overlay (W18), the ledger's own
// validation (W25), and the bench's compat corpus and world model (W01, W45).
//
// Every door follows one convention: `--input <file|->` holds a JSON object, the module does the
// work, and the answer is the module's own facts rather than a second interpretation of them.

import { EXIT, fail, present } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { commandRoot } from '../repo-root.mjs';
import { readJsonDocument } from './doc-input.mjs';
import { inspectTarget } from '../actions/targets.mjs';
import { semanticDelta } from '../actions/delta.mjs';
import { channelIndependence } from '../actions/observe.mjs';
import { planRetry } from '../actions/retry.mjs';
import { buildReviewBundle, checkBundle, promote } from '../actions/review.mjs';
import { conformance, parseDescriptor } from '../adapters/conformance.mjs';
import { evaluateObligations } from '../verify/contracts.mjs';
import { checkGeneration, selectRubrics } from '../verify/documents.mjs';
import { checkProcedures } from '../verify/procedures.mjs';
import { authorityOf, dedupeCandidates, packetEntries } from '../memory/discovery.mjs';
import { buildProofPacket } from '../brief/proof.mjs';
import { readNode } from '../index/overlay.mjs';
import { joinRepresentations, obligationsFor } from '../work/artifacts.mjs';
import { checkChain, validateEvidence } from '../ledger/evidence.mjs';

const list = (value) => (Array.isArray(value) ? value : []);

/**
 * A review bundle a human can read before execution, and the same bundle after it (W42).
 *
 * @param {object} doc
 * @returns {object}
 */
function actionReviewFacts(doc) {
  try {
    const delta = doc.beforeObject !== undefined && doc.afterObject !== undefined ? semanticDelta(doc.beforeObject, doc.afterObject) : (doc.delta ?? null);
    const bundle = buildReviewBundle({ ...doc, delta });
    return {
      ok: true,
      command: 'action review',
      bundle,
      check: checkBundle(bundle),
      delta,
      retry: doc.operation !== undefined ? planRetry(doc.operation) : null,
      observation: doc.channels !== undefined ? channelIndependence(list(doc.channels)) : null,
      target: doc.snapshot !== undefined ? inspectTarget(doc.snapshot, doc.inspect ?? {}) : null,
      promotion: doc.promoteTo !== undefined ? promote(bundle, doc.promoteTo ?? {}) : null,
    };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * The adapter contract suite over descriptors (W48).
 *
 * @param {object} doc
 * @returns {object}
 */
function adapterCheckFacts(doc) {
  const parsed = typeof doc.text === 'string' ? parseDescriptor(doc.text) : null;
  const adapters = list(doc.adapters).length > 0 ? doc.adapters : parsed?.descriptor !== undefined ? [parsed.descriptor] : [];
  return { ok: true, command: 'adapter check', parsed, ...conformance(adapters) };
}

function verifyContractsFacts(doc) {
  return {
    ok: true,
    command: 'verify contracts',
    ...evaluateObligations(doc.contract ?? {}, list(doc.observations), doc.options ?? {}),
  };
}

function verifyDocumentsFacts(doc) {
  return {
    ok: true,
    command: 'verify documents',
    generation: checkGeneration(doc.output ?? {}, doc.contract ?? {}),
    rubrics: list(doc.rubrics).length > 0 ? selectRubrics({ document: doc.document ?? {}, matrix: list(doc.matrix), rubrics: doc.rubrics }) : null,
  };
}

function verifyProceduresFacts(doc) {
  return { ok: true, command: 'verify procedures', ...checkProcedures(list(doc.records), { files: doc.files ?? null }) };
}

function lessonsDiscoverFacts(doc) {
  const deduped = dedupeCandidates(list(doc.candidates));
  return {
    ok: true,
    command: 'lessons discover',
    candidates: deduped.kept,
    merged: deduped.merged,
    authorities: deduped.kept.map((entry) => authorityOf(entry)),
    recall: doc.context !== undefined ? packetEntries(deduped.kept, doc.context ?? {}) : null,
  };
}

function workPacketFacts(doc) {
  try {
    return { ok: true, command: 'work packet', ...buildProofPacket(list(doc.units), { budget: doc.budget ?? undefined, required: list(doc.required) }) };
  } catch (error) {
    return { error: error.message };
  }
}

function indexOverlayFacts(doc) {
  return {
    ok: true,
    command: 'index overlay',
    ...readNode(doc.node ?? doc),
    artifacts: list(doc.representations).length > 0 ? joinRepresentations(doc.representations) : null,
    obligations: typeof doc.kind === 'string' ? obligationsFor({ kind: doc.kind, path: doc.path ?? '' }) : null,
  };
}

function evidenceValidateFacts(doc) {
  return {
    ok: true,
    command: 'evidence validate',
    ...validateEvidence(doc.line ?? doc, doc.options ?? {}),
    chain: list(doc.records).length > 0 ? checkChain(doc.records) : null,
  };
}

export const DOCUMENT_DOORS = {

  'action review': actionReviewFacts,
  'adapter check': adapterCheckFacts,
  'verify contracts': verifyContractsFacts,
  'verify documents': verifyDocumentsFacts,
  'verify procedures': verifyProceduresFacts,
  'lessons discover': lessonsDiscoverFacts,
  'work packet': workPacketFacts,
  'index overlay': indexOverlayFacts,
  'evidence validate': evidenceValidateFacts,
};

/**
 * Run one door: a document in, the module's facts out.
 *
 * @param {string} path
 * @param {string[]} args
 * @param {object} flags
 */
export async function wireCommand(path, args, flags) {
  const facts = DOCUMENT_DOORS[path];
  if (facts === undefined) return fail(`unknown door ${path}`, EXIT.USAGE, `run: ${CLI} help --all`);
  const usage = `run: ${CLI} ${path} --input <file>`;
  if (args.length > 0) return fail(`unknown ${path} argument ${args[0]}`, EXIT.USAGE, usage);
  const read = await readJsonDocument(flags, 'input');
  if (read.error !== undefined) return fail(read.error, EXIT.USAGE, usage);
  const payload = await facts(read.doc, flags);
  if (payload.error !== undefined) return fail(payload.error, EXIT.FAIL, usage);
  present(payload, () => render(payload), flags);
  return EXIT.OK;
}

function render(payload) {
  const lines = [];
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'ok' || key === 'command' || value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${key.padEnd(14)} ${value.length} item(s)`);
      for (const entry of value.slice(0, 10)) lines.push(`  ${typeof entry === 'string' ? entry : JSON.stringify(entry).slice(0, 160)}`);
      continue;
    }
    if (typeof value === 'object') {
      lines.push(`${key.padEnd(14)} ${JSON.stringify(value).slice(0, 200)}`);
      continue;
    }
    lines.push(`${key.padEnd(14)} ${value}`);
  }
  if (lines.length === 0) lines.push('(no facts: the document carried nothing this door reads)');
  return lines.join('\n');
}
