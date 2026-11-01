// Half of the MCP tool list. The tools are read-only and answer through the commands.

import { loadRegistry } from '../graph/load.mjs';
import { provenanceDigest } from '../projection/project.mjs';
import { discover } from '../compare/discover.mjs';
import { buildRows, resolveConcurrency, summarise } from '../compare/row.mjs';
import { GATES } from '../hooks/gates.mjs';
import { checkRepo } from '../commands/sync.mjs';
import { diagnose, serialisedFindings } from '../commands/doctor.mjs';
import { rulesCatalogue, rulesWhyFacts } from '../commands/rules.mjs';
import { skillsBriefFacts, skillsFindFacts, skillsShowFacts, skillsWhyFacts } from '../commands/skills.mjs';
import { assembleBrief } from '../brief/assemble.mjs';
import { DEFAULT_BRIEF_BYTES } from '../brief/packet.mjs';
import { federationAccess, readFederation } from '../federation/config.mjs';
import { consult } from '../federation/query.mjs';
import { planNext, planDone } from '../plan/index.mjs';
import { buildPrBody } from '../prbody.mjs';
import { configPaths, readUserConfig, resolveWorkspace } from '../workspace.mjs';
import { measureSkill } from '../graph/load.mjs';
import { CLI } from '../name.mjs';
import { ERROR_SHAPE, GATE_KINDS, noArgs, output, rootArg } from './schemas.mjs';
import { registry, rootOf } from './schemas.mjs';

export const TOOLS_FACTS = [
  {
    outputSchema: output.check,
    name: 'check',
    description:
      'The gate for one repository: region current, unmanaged, drifted or malformed, and rule files lacking an id. Read-only - it never repairs.',
    inputSchema: rootArg,
    async run(args) {
      const root = rootOf(args);
      const { ok, findings } = await checkRepo(root, {});
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
    // R41's 2 KB description budget is shared, not per tool: this sentence was
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
      'The packet for one task in prompt-sized bytes: kind, commands, files, tests, decisions, skills. With no task it describes the repository.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'repository root; defaults to the editor cwd' },
        task: { type: 'string', description: "what the agent is about to do, in the user's own words" },
        paths: { type: 'string', description: 'comma-separated paths to scope the packet to, instead of the files git reports as modified' },
        budget: { type: 'number', description: 'byte ceiling; 0 means the whole packet (default 2048)' },
      },
      required: [],
    },
    async run(args) {
      const root = rootOf(args);
      const budget = Number.isFinite(args?.budget) && args.budget >= 0 ? args.budget : DEFAULT_BRIEF_BYTES;
      // Read, never build: every tool here declares itself read-only, and a call that
      // indexed the tree would make that declaration false. A brief with no index to read
      // says which command makes one - the same rule the delivered packet follows, so a
      // pull and a push pay the same price and neither one writes.
      const result = await assembleBrief({
        root,
        task: typeof args?.task === 'string' ? args.task : '',
        paths: typeof args?.paths === 'string' ? args.paths : null,
        budget,
        build: false,
      });
      if (result.error) throw Object.assign(new Error('the index could not be read'), { remedy: `run: ${CLI} index` });
      // A repository with no index is not a failed call. Every surface points here first,
      // so the one tool told to be the entry point must answer in a repository that has
      // never been indexed - it falls back to the skill packet, which is read from the
      // package rather than the tree, and names the command that unlocks the rest (Q56).
      if (result.cold) {
        const task = typeof args?.task === 'string' ? args.task : '';
        const facts = await skillsBriefFacts(root, { ...(args ?? {}), task });
        // Through JSON once, so the packet carries exactly what the text block shows: a
        // property whose value is `undefined` survives `stringify` as nothing at all, and
        // the two blocks would then describe different objects.
        const text = JSON.stringify(facts, null, 2);
        const packet = JSON.parse(text);
        const size = Buffer.byteLength(text);
        return {
          root,
          kind: 'skills',
          basis: 'registry',
          task,
          scope: [],
          budget,
          bytes: size,
          before: size,
          // The skill packet is one document and is not cut to fit: saying the floor held
          // when the answer is over it is the class of claim this review exists to remove.
          floorHeld: size <= budget,
          cut: size <= budget ? [] : ['text'],
          sections: { skills: (packet.resolved ?? []).map((s) => s.name) },
          text,
          note: `no index here, so this is the skill packet; run: ${CLI} index for the repository packet`,
        };
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
        text: result.packed.text,
      };
    },
  },
  {
    outputSchema: output.federation_query,
    name: 'federation_query',
    description:
      'Ask a declared code-graph server one structural question; the answer names the server. Starts only servers simt.json names; none declared is an error.',
    // This tool spawns the repo manifest's `command`, so it is not read-only: a client
    // that cached its answer as one would replay a process spawn as a pure read (Q13).
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
      // repo manifest alone must not authorise a spawn on the operator's machine (Q13).
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
