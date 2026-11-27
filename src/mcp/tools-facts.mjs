// Half of the MCP tool list. The tools are read-only and answer through the commands.

import { provenanceDigest } from '../projection/project.mjs';
import { discover } from '../compare/discover.mjs';
import { buildRows, resolveConcurrency, summarise } from '../compare/row.mjs';
import { GATES } from '../hooks/gates.mjs';
import { checkRepo } from '../commands/sync.mjs';
import { parseSubtaskId } from '../brief/drilldown.mjs';
import { retrievalMode } from '../index/retrieval-mode.mjs';
import { assembleBrief } from '../brief/assemble.mjs';
import { SECTIONS, DEFAULT_BRIEF_BYTES } from '../brief/packet.mjs';
import { federationAccess, readFederation } from '../federation/config.mjs';
import { consult } from '../federation/query.mjs';
import { planNext, planDone } from '../plan/index.mjs';
import { buildPrBody } from '../prbody.mjs';
import { configPaths, readUserConfig, resolveWorkspace } from '../workspace.mjs';
import { CLI } from '../name.mjs';
import { GATE_KINDS, output, rootArg } from './schemas.mjs';
import { rootOf } from './schemas.mjs';

/**
 * The packet payload behind `brief` and its `skills_brief` view.
 *
 * Read, never build: every tool here declares itself read-only, and a call that indexed
 * the tree would make that declaration false. A cold repository is told the command that
 * makes the index rather than handed a second, registry-only document under the same
 * name; the skills view is a section of this packet, not another packet (ADR-226).
 */
export async function briefPayload(args, { only = null } = {}) {
  const root = rootOf(args);
  if (only !== null && !SECTIONS.includes(String(only).toUpperCase())) {
    throw Object.assign(new Error(`unknown brief section ${only}`), {
      remedy: `one of ${SECTIONS.join(', ').toLowerCase()}`,
    });
  }
  const budget = Number.isFinite(args?.budget) && args.budget >= 0 ? args.budget : DEFAULT_BRIEF_BYTES;
  const subtask = parseSubtaskId(args?.subtask);
  if (Number.isNaN(subtask)) throw new Error('subtask must be a positive integer');
  const retrieval = retrievalMode(args?.retrieval);
  if (subtask !== null && retrieval === 'v1') throw new Error('subtask selection requires retrieval v2 or v3');
  if (retrieval === null) throw new Error('retrieval must be v1, v2 or v3');
  const result = await assembleBrief({
    root,
    task: typeof args?.task === 'string' ? args.task : '',
    paths: typeof args?.paths === 'string' ? args.paths : null,
    budget,
    retrieval,
    subtask,
    build: false,
    only,
    scopeSpans: args?.scopes === true,
    nash: args?.nash === true,
    seen: typeof args?.seen === 'string' || Array.isArray(args?.seen) ? args.seen : null,
    recordSeen: false,
  });
  if (result.error) {
    // An assembly failure already carries its own message and remedy. Replacing both
    // with the index remedy made a build failure or an unreadable tree look like a cold
    // index.
    const failure = result.error;
    throw Object.assign(new Error(failure?.message ?? 'the packet could not be assembled'), {
      remedy: failure?.remedy ?? null,
    });
  }
  if (result.cold) {
    const broken = result.broken === true;
    const detail = result.indexError?.message;
    throw Object.assign(
      new Error(
        broken
          ? `could not read the index${detail ? ` (${detail})` : ''}`
          : 'the index is empty, so the packet cannot be assembled',
      ),
      {
        remedy:
          result.indexError?.code === 'INDEX_BUSY'
            ? 'wait for the other index run, then retry'
            : `run: ${CLI} index`,
      },
    );
  }
  return {
    root: result.root,
    kind: result.kind,
    basis: result.basis,
    task: result.task,
    scope: result.scope,
    budget: result.budget,
    bytes: result.packed.after,
    before: result.packed.before,
    floorHeld: result.packed.floorHeld,
    cut: result.packed.cut,
    sections: result.sections,
    ...(result.scopes ? { scopes: result.scopes } : {}),
    ...(result.seen ? { seen: result.seen } : {}),
    ...result.composite,
    text: result.packed.text,
  };
}

export const TOOLS_FACTS = [
  {
    outputSchema: output.check,
    name: 'check',
    description:
      'The gate for one repository: region current, unmanaged, drifted or malformed, and rule files lacking an id. Read-only - it never repairs.',
    inputSchema: { ...rootArg, properties: { ...rootArg.properties,
      changed: { type: 'boolean', description: 'limit source and graph findings to changed files and their direct neighbors' },
    } },
    async run(args) {
      const root = rootOf(args);
      const { ok, findings } = await checkRepo(root, { changed: args?.changed === true });
      return { root, ok, findings };
    },
  },

  {
    outputSchema: output.compare,
    name: 'compare',
    description:
      'The workspace matrix: adoption, region, SHA, hooks and gates per repo, plus problems. Pages with limit/cursor; honors progressToken and cancellation.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'a workspace directory, or one repository' },
        workspace: { type: 'string', description: 'workspace root when root is not given' },
        limit: { type: 'number', description: 'page size; without it every row is built' },
        cursor: { type: 'string', description: 'opaque page start from a previous partial answer' },
        concurrency: { type: 'number', description: 'rows built at once (default 4)' },
      },
      required: [],
    },
    async run(args, ctx = {}) {
      const root = args?.root ?? args?.workspace ?? (await resolveWorkspace(args ?? {})).root ?? process.cwd();
      const found = await discover(root);
      if (found.error) throw Object.assign(new Error(`${root}: ${found.error}`), { remedy: 'pass root' });
      const expectedSha = await provenanceDigest();
      const context = { expectedSha, gates: new Set(Object.keys(GATES)), gateKinds: GATE_KINDS };
      // A page names its start as an index into discovery order, which is
      // stable between calls on an unchanged estate; garbage parses to 0
      // rather than erroring, because a dashboard that refuses to run over a
      // stale cursor is worse than one that restarts the listing.
      const start = Math.max(0, parseInt(typeof args?.cursor === 'string' ? args.cursor : '0', 10) || 0);
      const limit = typeof args?.limit === 'number' && args.limit >= 1 ? Math.floor(args.limit) : null;
      const page = limit === null ? found.repos : found.repos.slice(start, start + limit);
      const rows = await buildRows(page, context, {
        concurrency: resolveConcurrency(args ?? {}),
        signal: ctx?.signal ?? null,
        onBatch: ctx?.onProgress ? (done, total) => ctx.onProgress(start + done, found.repos.length) : null,
      });
      const next = limit !== null && start + page.length < found.repos.length ? String(start + page.length) : null;
      return {
        root,
        shape: found.shape,
        expectedSha,
        summary: summarise(rows, { root, shape: found.shape, expectedSha }),
        repos: rows,
        worktrees: found.worktrees.map((w) => ({ name: w.name, owner: w.ownerName })),
        directories: found.directories,
        ...(limit === null ? {} : { partial: next !== null, cursor: next, total: found.repos.length }),
      };
    },
  },
  {
    outputSchema: output.plan_next,
    name: 'plan_next',
    description: "The next queued slice whose dependencies are complete; its design section only. Pass id for one slice whether or not it is ready.",
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'repository root; defaults to the editor cwd' },
        id: { type: 'string', description: 'slice id; when given, return that slice' },
      },
      required: [],
    },
    async run(args) {
      const root = rootOf(args);
      const id = typeof args?.id === 'string' && args.id.length > 0 ? args.id : null;
      const result = await planNext(root, id);
      if (result.error) throw Object.assign(new Error(result.error), { remedy: result.remedy ?? null });
      return { root: result.root, next: result.next, reason: result.reason };
    },
  },
  {
    outputSchema: output.plan_done,
    name: 'plan_done',
    // Same function as the command, and deliberately a preview. This surface does
    // not write: the row change is a diff, and the command applies it behind --yes.
    description: 'Preview the one-row rewrite for a slice. The write stays on the plan done command, behind --yes.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'repository root; defaults to the editor cwd' },
        id: { type: 'string', description: 'slice id' },
        sha: { type: 'string', description: 'commit sha that closed the slice' },
        test: { type: 'string', description: 'test command that closed it' },
        state: { type: 'string', description: 'target state; omitted means the completed state of the repository template (Complete for tracker)' },
      },
      required: ['id'],
    },
    async run(args) {
      const root = rootOf(args);
      const result = await planDone(root, args?.id, {
        sha: args?.sha ?? null,
        test: args?.test ?? null,
        state: args?.state ?? null,
        dryRun: true,
      });
      if (result.error) throw Object.assign(new Error(result.error), { remedy: result.remedy ?? null });
      return {
        root: result.root,
        id: result.id,
        doc: result.doc,
        line: result.line,
        from: result.from,
        to: result.to,
        wouldChange: result.wouldChange,
        dryRun: true,
        remedy: result.remedy,
      };
    },
  },
  // The PR-flow entry point over this surface: the same engine the `pr-body`
  // command renders, returning JSON for a model. Read-only like everything
  // here — it names the tree, reads the ledger and the check cache, and writes
  // nothing, so the exit-code-never-carries-the-verdict contract stays intact.
  {
    outputSchema: output.pr_body,
    name: 'pr_body',
    // the 2 KB description budget is shared, not per tool: this sentence was
    // paid for by shortening `brief` and `federation_query`, and the test on the
    // total holds every future tool to the same trade.
    description:
      'The pull request body: ledger evidence for this tree, the decisions the diff touches, gate state, and the ADR-008 verdict with what was not reviewed.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'repository root; defaults to the editor cwd' },
        base: { type: 'string', description: 'the ref the body diffs against; defaults to origin/main, then main' },
      },
      required: [],
    },
    async run(args) {
      const root = rootOf(args);
      const base = typeof args?.base === 'string' && args.base.length > 0 ? args.base : null;
      const report = await buildPrBody(root, { base });
      if (report.error !== null) {
        throw Object.assign(new Error(report.error), {
          remedy: `run: ${CLI} pr-body --base <ref> with a ref git knows`,
        });
      }
      return {
        root,
        base: report.base,
        tree: report.tree,
        verdict: report.verdict,
        unreviewed: report.unreviewed,
        paths: report.paths,
        decisions: report.decisions,
        gates: report.gates,
        evidence: report.evidence,
      };
    },
  },
  {
    outputSchema: output.brief,
    name: 'brief',
    description:
      'The packet for a task prompt in prompt-sized bytes: kind, commands, files, tests, decisions, skills. With no task it describes the repository.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'repository root; defaults to the editor cwd' },
        task: { type: 'string', description: "what the agent is about to do, in the user's own words" },
        paths: { type: 'string', description: 'comma-separated paths to scope the packet to, instead of the files git reports as modified' },
        budget: { type: 'number', description: 'byte ceiling; 0 means the whole packet (default 2048)' },
        subtask: { type: 'integer', minimum: 1, description: 'focus the packet on this subtask number' },
        retrieval: { type: 'string', enum: ['v1', 'v2', 'v3'], description: 'default v3; pass v2 or v1 to roll back on the same index' },
        scopes: { type: 'boolean', description: 'emit bound symbol-scope line spans (`path:L1-L2 sym`) for large files' },
        nash: { type: 'boolean', description: 'enable Nash Social Welfare fair packing across subtasks and facets' },
        seen: { type: 'string', description: 'comma-separated paths/ids or session ledger path already in context' },
        only: { type: 'string', description: `one section of the packet, e.g. files or decisions; default is the whole packet (${SECTIONS.join(', ').toLowerCase()})` },
      },
      required: [],
    },
    async run(args) {
      // Pass the section as given: the assembly normalizes case, and a door that rewrote
      // it would echo `BOGUS` in an error the caller wrote as `bogus`.
      const only = typeof args?.only === 'string' && args.only.trim().length > 0 ? args.only : null;
      return briefPayload(args, { only });
    },
  },
  {
    outputSchema: output.federation_query,
    name: 'federation_query',
    description:
      'Ask a declared code-graph server one structural question; the answer names the server. Starts only servers simt.json names; none declared is an error.',
    // This tool spawns the repo manifest's `command`, so it is not read-only: a client
    // that cached its answer as one would replay a process spawn as a pure read .
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'repository root; defaults to the editor cwd' },
        query: { type: 'string', description: "the structural question to ask, in the user's own words" },
        server: { type: 'string', description: 'ask only this declared server, by name; omit to ask every one of them' },
      },
      required: ['query'],
    },
    async run(args) {
      const root = rootOf(args);
      const query = typeof args?.query === 'string' ? args.query.trim() : '';
      if (query.length === 0) {
        throw Object.assign(new Error('the query is empty'), {
          remedy: 'pass a query, for example the symbol or file to look up',
        });
      }
      const { servers, findings } = await readFederation(root);
      if (servers.length === 0) {
        throw Object.assign(new Error('this repository declares no federation server'), {
          remedy: 'add a "federation" block naming a server to simt.json, or use the brief tool',
        });
      }
      const only = typeof args?.server === 'string' && args.server.length > 0 ? args.server : null;
      const chosen = only === null ? servers : servers.filter((server) => server.name === only);
      if (only !== null && chosen.length === 0) {
        throw Object.assign(new Error(`no declared federation server is named ${only}`), {
          remedy: `declared servers: ${servers.map((server) => server.name).join(', ')}`,
        });
      }
      // A model-supplied root can point at a directory with a crafted manifest, and a
      // repo manifest alone must not authorise a spawn on the operator's machine .
      const ws = await resolveWorkspace(args ?? {});
      const user = await readUserConfig();
      const denied = federationAccess({
        root,
        cwd: process.cwd(),
        workspaceRoot: ws.root,
        serverNames: chosen.map((server) => server.name),
        userConfig: user.config,
        configPath: user.path ?? configPaths()[0] ?? '~/.config/simt-dev/config.json',
      });
      if (denied !== null) {
        throw Object.assign(new Error(denied.message), { remedy: denied.remedy });
      }
      const { answers, findings: failures } = await consult({ root, query, servers: chosen });
      return {
        root,
        query,
        servers: chosen.map((server) => server.name),
        answers,
        findings: [...findings, ...failures],
      };
    },
  },
];
