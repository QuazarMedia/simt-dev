// The wired doors, as MCP tools.
//
// Each tool calls the same fact function its command calls (`DOCUMENT_DOORS`), so the transport
// and the terminal cannot disagree about a review bundle, an obligation result or a packet. All
// nine are read-only: they take a document and return what the module concluded, and none writes,
// dispatches or opens a socket.
//
// The bench doors are deliberately absent: they live in the bench package, and the core MCP
// server must not depend on a package the core installs without.

import { DOCUMENT_DOORS } from '../commands/wires.mjs';
import { output } from './schemas.mjs';

const DOCUMENT = { type: 'object', description: 'the document the door reads, as JSON' };

function refuse(error, remedy) {
  throw Object.assign(new Error(error), { remedy });
}

function tool(name, path, description, remedy) {
  return {
    outputSchema: output.work_doc,
    name,
    description,
    inputSchema: { type: 'object', properties: { document: DOCUMENT }, required: ['document'] },
    async run(args) {
      const facts = await DOCUMENT_DOORS[path](args.document);
      if (facts.error !== undefined) refuse(facts.error, remedy);
      return { ok: true, doc: facts };
    },
  };
}

export const TOOLS_WIRES = [
  tool(
    'action_review',
    'action review',
    'A review bundle before execution: contract, semantic delta, target incarnation, authorization and postconditions, with the checks still missing.',
    'pass {contract: {commit}, target: {incarnation}, before, authorization: {digest}, postconditions}',
  ),
  tool(
    'adapter_check',
    'adapter check',
    'Validate adapter descriptors as data: interfaces, capability and side effects, with observe-only kept apart from execute. Nothing is loaded or run.',
    'pass {adapters: [...]}, or {text} holding a descriptor to parse',
  ),
  tool(
    'verify_contracts',
    'verify contracts',
    'Evaluate obligations against observations, keeping pass, fail, unknown, unavailable, not-run and waived apart from a review verdict.',
    'pass {contract: {obligations: [...]}, observations: [...]}',
  ),
  tool(
    'verify_documents',
    'verify documents',
    'Check a generated document against its pinned template, required sections, source scope and declared representation.',
    'pass {output: {template, sections, sources}, contract: {template, sections, sourceScope}}',
  ),
  tool(
    'verify_procedures',
    'verify procedures',
    'Check procedures for missing imports, calls to undeclared procedures, and flag prerequisites no environment can satisfy.',
    'pass {records: [{id, imports, calls, prerequisites}], files: [...]}',
  ),
  tool(
    'lessons_discover',
    'lessons discover',
    'Deduplicate discovery candidates by proposition and scope, and report the authority each one has actually earned.',
    'pass {candidates: [{proposition, kind, verified}]}',
  ),
  tool(
    'work_packet',
    'work packet',
    'The proof-bearing task packet: mandatory units kept, citations required, and an over-budget packet reported as incomplete rather than trimmed.',
    'pass {units: [{id, text, revision, anchor, obligations, mandatory}], budget}',
  ),
  tool(
    'index_overlay',
    'index overlay',
    'A working-tree or staged index node labelled by the provenance its revision proves, with the artifact obligations it carries.',
    'pass {node: {key, kind, source, provenance, trust, revision}}',
  ),
  tool(
    'evidence_validate',
    'evidence validate',
    'Validate a ledger evidence record against a tree, target and obligations, and report the chain of custody behind it.',
    'pass {line} or {records: [...]} for a chain',
  ),
];
