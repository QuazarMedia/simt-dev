// The plan-4 read-only doors, as MCP tools.
//
// Each tool calls the fact function its command calls, so the CLI and the transport answer
// with one object rather than two that agree until one is edited (ADR-035). Every door is
// read-only by construction: the fact functions take a document or a root and return what the
// modules concluded, and none of them writes, dispatches or opens a socket.
//
// The document-taking tools accept the document as an object rather than a path, because a
// client has the bytes and a path in an editor's process is the editor's, not the repository's.

import { workInspectFacts } from '../commands/work.mjs';
import { knowledgeExportFacts, knowledgeImportFacts, knowledgeWhyFacts } from '../commands/knowledge.mjs';
import { verifyPlanFacts, verifySelectFacts, verifyStatusFacts } from '../commands/verify.mjs';
import { actionStatusFacts } from '../commands/action.mjs';
import { output, rootArg, rootOf } from './schemas.mjs';

const DOCUMENT = { type: 'object', description: 'the document the door reads, as JSON' };

/** A refusal the server turns into an error result with a remedy. */
function refuse(error, remedy) {
  throw Object.assign(new Error(error), { remedy });
}

export const TOOLS_WORK = [
  {
    outputSchema: output.work_doc,
    name: 'work_inspect',
    description:
      'What a repository work consists of: artifact kinds, activities, execution loci, and five validation capabilities that keep declared, available and authorized apart. Derived from paths and the manifest; nothing is executed.',
    inputSchema: rootArg,
    async run(args) {
      return { ok: true, doc: await workInspectFacts(rootOf(args)) };
    },
  },
  {
    outputSchema: output.work_doc,
    name: 'knowledge_why',
    description:
      'Why a claim is held: what it derives from, what depends on it, the conflicts that mention it, and its validity window. Reads declared claims only, so a clean scan certifies nothing.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'the claim id to explain' }, document: DOCUMENT },
      required: ['id', 'document'],
    },
    async run(args) {
      const facts = knowledgeWhyFacts(args.document, args.id);
      if (facts.error !== undefined) refuse(facts.error, 'pass a document of {claims, edges, artifacts} and an id that is on one of its claims');
      return { ok: true, doc: facts };
    },
  },
  {
    outputSchema: output.work_doc,
    name: 'verify_plan',
    description:
      'The next observation worth making: which declared capability discharges the most unmet obligation inside the stated constraints, and why it stops when nothing admissible remains. Suggests only; executes nothing.',
    inputSchema: { type: 'object', properties: { document: DOCUMENT }, required: ['document'] },
    async run(args) {
      return { ok: true, doc: verifyPlanFacts(args.document) };
    },
  },
  {
    outputSchema: output.work_doc,
    name: 'verify_select',
    description: 'The narrowest checks that prove a change: mandatory first, then cover by cost, with independence kept and unverified said out loud.',
    inputSchema: { type: 'object', properties: { document: DOCUMENT }, required: ['document'] },
    async run(args) {
      return { ok: true, doc: verifySelectFacts(args.document) };
    },
  },
  {
    outputSchema: output.work_doc,
    name: 'verify_status',
    description:
      'Closure over recorded obligations: the verdict, what is unresolved and why. An unreachable verifier is never a pass, and a remote-scope closure needs its reviewed contract.',
    inputSchema: { type: 'object', properties: { document: DOCUMENT }, required: ['document'] },
    async run(args) {
      const facts = verifyStatusFacts(args.document);
      if (facts.error !== undefined) refuse(facts.error, 'pass a document of obligations, evidence and a schema version this build knows');
      return { ok: true, doc: facts };
    },
  },
  {
    outputSchema: output.work_doc,
    name: 'action_status',
    description:
      'Where an operation stands from its journal: the state, whether it is resumable, whether an effect may be in flight, the recovery the state permits, the recorded authorization, and the guarantee the adapter can promise.',
    inputSchema: { type: 'object', properties: { document: DOCUMENT }, required: ['document'] },
    async run(args) {
      const facts = actionStatusFacts(args.document);
      if (facts.error !== undefined) refuse(facts.error, 'pass {"journal": [...]} or a bare journal array');
      return { ok: true, doc: facts };
    },
  },
  {
    outputSchema: output.work_doc,
    name: 'knowledge_export',
    description: 'A bounded, permission-filtered packet another repository can read offline; restricted facts are dropped before the page is cut.',
    inputSchema: { type: 'object', properties: { document: DOCUMENT }, required: ['document'] },
    async run(args) {
      const facts = knowledgeExportFacts(args.document);
      if (facts.error !== undefined) refuse(facts.error, 'the document limit and page must be within the bounds the export names');
      return { ok: true, doc: facts };
    },
  },
  {
    outputSchema: output.work_doc,
    name: 'knowledge_import',
    description: 'Validate an exported packet as data: schema, version, expiry and revision digests. It executes nothing and treats every fact as text.',
    inputSchema: { type: 'object', properties: { document: DOCUMENT }, required: ['document'] },
    async run(args) {
      return { ok: true, doc: knowledgeImportFacts(args.document) };
    },
  },
];
