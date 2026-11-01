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

export const TOOLS_READ = [
  {
    outputSchema: output.doctor,
    name: 'doctor',
    description:
      'Classify a repository: stack tags, the facts with the file that proved each, and manifest presence. Call this first when the repo is unknown. Read-only: `--fix` and `--diff` stay on the command.',
    inputSchema: rootArg,
    async run(args) {
      const root = rootOf(args);
      const { result, ws, shared, findings, failure } = await diagnose(root, args ?? {});
      return {
        root,
        ...result,
        workspace: { root: ws.root ?? null, source: ws.source, detail: ws.detail, error: ws.error ?? null },
        shared,
        findings: serialisedFindings(findings),
        // Read-only here: the command applies fixes behind `--fix`, the tool only reports.
        fix: { requested: false, applied: false, fixed: [], failed: [] },
        ...(failure ?? {}),
      };
    },
  },

  {
    outputSchema: output.skills_index,
    name: 'skills_index',
    description:
      'Full skill catalogue: every skill with summary, size, stack tags and deferred flag. The fallback when brief returns nothing useful.',
    inputSchema: {
      type: 'object',
      properties: {
        registry: { type: 'string', description: 'path to skills.graph.json; else --registry / SIMT_REGISTRY / default tiers' },
      },
      required: [],
    },
    async run(args) {
      const { registry: reg, verified, workspace } = await registry(args);
      return {
        skills: reg.skills.length,
        totalBytes: reg.skills.reduce((n, s) => n + s.bytes, 0),
        deferred: reg.skills.filter((s) => s.deferred).map((s) => s.name),
        workspace,
        verified,
        entries: [...reg.skills]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((s) => ({ name: s.name, summary: s.summary, bytes: s.bytes, stack: s.stack, deferred: Boolean(s.deferred) })),
      };
    },
  },

  {
    outputSchema: output.skills_brief,
    name: 'skills_brief',
    description:
      'THE entry point. Resolve the skill set for a task: selected with why, deferred, and not selected with the reason to override.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string' },
        task: { type: 'string', description: 'what you are about to do, in your own words' },
        paths: { type: 'string', description: 'comma-separated globs; defaults to the git diff' },
        budget: { type: 'number', description: 'context budget in bytes (default 20480)' },
        skill: { type: 'string', description: 'force a skill in, comma-separated' },
        all: { type: 'boolean', description: 'ignore the budget' },
        registry: { type: 'string', description: 'path to skills.graph.json; else --registry / SIMT_REGISTRY / default tiers' },
      },
      required: [],
    },
    async run(args) {
      const root = rootOf(args);
      const facts = await skillsBriefFacts(root, args ?? {});
      // No body is ever returned by this tool: a caller that wants one calls
      // skills_show, which makes the cost visible before it is paid.
      if (facts.kind === 'all') {
        return {
          all: true,
          repoStack: facts.repoStack,
          inline: facts.inline.map((s) => s.name),
          deferred: facts.deferred.map((s) => s.name),
          ...(facts.warning ? { warning: facts.warning } : {}),
        };
      }
      const { shown, shownDeferred, shownUsed, pointerOnly, excludedEntries, workspaceRoot, kind, ...doc } = facts;
      return doc;
    },
  },

  {
    outputSchema: output.skills_show,
    name: 'skills_show',
    description: 'One skill body and the metadata needed to judge it: source path, the location it was read from, and its cited decisions.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        root: { type: 'string' },
        maxBytes: { type: 'number', description: 'hard ceiling on the returned text' },
        registry: { type: 'string', description: 'path to skills.graph.json; else --registry / SIMT_REGISTRY / default tiers' },
      },
      required: ['name'],
    },
    async run(args) {
      const root = rootOf(args);
      const facts = await skillsShowFacts(root, args?.name, args ?? {});
      // The schema promises `body: null` when there is no body, and this used to hand the
      // prose that says so to the field a client tests for null: a caller checking `body`
      // for null read a paragraph as a body . The prose moves to `reason`, which is
      // where a model looks for what to do about it.
      const missing = typeof facts.bodyText === 'string' && facts.bodyText.startsWith('(body unavailable');
      return {
        ...facts.skill,
        workspace: facts.workspace,
        body: missing ? null : facts.body,
        bodyFrom: facts.bodyFrom,
        bodyText: missing ? null : facts.bodyText,
        reason: missing ? facts.bodyText : null,
      };
    },
  },

  {
    outputSchema: output.skills_find,
    name: 'skills_find',
    description: 'Raw search across capability, keyword and summary. Use when skills_brief has nothing and you suspect a skill exists.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        root: { type: 'string' },
        registry: { type: 'string', description: 'path to skills.graph.json; else --registry / SIMT_REGISTRY / default tiers' },
      },
      required: ['query'],
    },
    async run(args) {
      const root = rootOf(args);
      return skillsFindFacts(root, typeof args?.query === 'string' ? args.query : '', args ?? {});
    },
  },

  {
    outputSchema: output.skills_why,
    name: 'skills_why',
    description:
      'The signal chain for one skill in one repository: its score, the reasons, whether the stack gate admits it, and what would select it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        root: { type: 'string' },
        task: { type: 'string' },
        registry: { type: 'string', description: 'path to skills.graph.json; else --registry / SIMT_REGISTRY / default tiers' },
      },
      required: ['name'],
    },
    async run(args) {
      const root = rootOf(args);
      return skillsWhyFacts(root, args?.name, args ?? {});
    },
  },

  {
    outputSchema: output.rules_list,
    name: 'rules_list',
    description:
      'The rule catalogue, and which rules a repository actually receives. Pass root for the selection, not just the catalogue.',
    inputSchema: {
      type: 'object',
      properties: { root: { type: 'string' } },
      required: [],
    },
    async run(args) {
      const root = typeof args?.root === 'string' && args.root ? args.root : null;
      const { rules, notes } = await rulesCatalogue(root, { selectFor: root });
      return {
        sha: await provenanceDigest(),
        notes,
        rules,
      };
    },
  },

  {
    outputSchema: output.rules_why,
    name: 'rules_why',
    description:
      'Why a rule exists: a rule id for the decisions that settled it, or an ADR id for the rules that repeat it. An uncited rule is a finding, reported so.',
    inputSchema: {
      type: 'object',
      properties: { what: { type: 'string', description: 'a rule id or ADR-NNN' } },
      required: ['what'],
    },
    async run(args) {
      const what = typeof args?.what === 'string' ? args.what : '';
      return rulesWhyFacts(null, what, {});
    },
  },

];
