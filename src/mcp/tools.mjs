// The MCP tool surface: a second front door onto the same logic the CLI uses.
//
// Deliberately a subset. Every tool here is READ-ONLY, because the commands that write
// (`init`, `sync`, `hooks install`, `skills install`, `upgrade`) each exist to be read as
// a diff by a human before they touch anything (ADR-001, ADR-004). A model can call a
// tool; a model cannot review a diff it never showed you.
//
// The tools build their own payloads from the same modules the commands use rather than
// calling the command functions. That is not duplication for its own sake: the commands
// render for terminals, these return JSON for a model, and forcing one renderer through a
// transport it was not written for is how a "clean" abstraction starts lying about bytes.
// What is shared is the LOGIC - fingerprint, the registry, the resolver, the region
// planner - and that is what has to be shared, because two resolvers would be two
// answers to the same question.
//
// Bodies are never inlined by `skills_brief`. Tier 1 is a set of pointers and reasons;
// the body is a separate call. A 384 KB reference inlined into a tool result is the exact
// failure progressive disclosure exists to prevent, and a transport makes it easier to
// cause by accident because the caller cannot see the size until it has paid for it.

import { fingerprint } from '../resolve/fingerprint.mjs';
import { loadRegistry, REGISTRY_PATH } from '../graph/load.mjs';
import { tokenize, rankSkills, closure, selectWithinBudget, scoreSkill, selectionVerdict, stackCompatible } from '../resolve/resolve.mjs';
import { loadRules, select, checkTargets, provenanceDigest } from '../projection/project.mjs';
import { loadDecisions, byId, citations } from '../decisions/index.mjs';
import { discover } from '../compare/discover.mjs';
import { buildRow, summarise } from '../compare/row.mjs';
import { GATES } from '../hooks/gates.mjs';
import { dirtyPaths, parsePathList, readBody } from '../commands/skills.mjs';
import { resolveWorkspace } from '../workspace.mjs';
import { measureSkill } from '../graph/load.mjs';

const GATE_KINDS = new Map(Object.entries(GATES).map(([name, g]) => [name, g.kind]));

/** A schema with no required fields still needs the object declared. */
const noArgs = { type: 'object', properties: {}, required: [] };
const rootArg = {
  type: 'object',
  properties: { root: { type: 'string', description: 'repository root; defaults to the editor cwd' } },
  required: [],
};

function rootOf(args) {
  return typeof args?.root === 'string' && args.root.length > 0 ? args.root : process.cwd();
}

async function registry(args) {
  const { registry, errors, ok, verified, workspace } = await loadRegistry(REGISTRY_PATH, args ?? {});
  if (!ok) {
    throw Object.assign(new Error(errors[0]), {
      remedy: 'run: simt-dev graph lint',
    });
  }
  return { registry, verified, workspace };
}

export const TOOLS = [
  {
    name: 'doctor',
    description:
      'Classify a repository: its stack tags, the emitted facts with the file that proved each, and whether a simt-dev manifest is present. Call this first when you do not yet know what a repo is.',
    inputSchema: rootArg,
    async run(args) {
      const root = rootOf(args);
      const ws = await resolveWorkspace(args ?? {});
      const result = await fingerprint(root);
      return {
        root,
        workspace: { root: ws.root, source: ws.source, detail: ws.detail },
        stack: result.stack,
        facts: Object.fromEntries(result.facts.map((f) => [f, result.factEvidence[f] ?? null])),
        signals: result.signals,
        evidence: result.evidence,
        manifest: result.manifest,
        error: result.error ?? null,
      };
    },
  },

  {
    name: 'skills_index',
    description:
      'The full skill catalogue: every skill with its summary, size, stack tags and whether it is deferred. Cheap enough to always afford, and the fallback when brief returns nothing useful.',
    inputSchema: noArgs,
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
    name: 'skills_brief',
    description:
      'THE entry point. Resolve the skill set for a task in a repository. Returns what was selected, why each was selected, what was deferred, and what was NOT selected with the reason - the last part matters, because it is what lets you override the resolver instead of guessing at it.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string' },
        task: { type: 'string', description: 'what you are about to do, in your own words' },
        paths: { type: 'string', description: 'comma-separated globs; defaults to the git diff' },
        budget: { type: 'number', description: 'context budget in bytes (default 20480)' },
        skill: { type: 'string', description: 'force a skill in, comma-separated' },
        all: { type: 'boolean', description: 'ignore the budget' },
      },
      required: [],
    },
    async run(args) {
      const root = rootOf(args);
      const { registry: reg } = await registry(args);
      const repo = await fingerprint(root);
      const paths = args?.paths ? parsePathList(args.paths) : await dirtyPaths(root);
      const forced = parsePathList(args?.skill);
      const budget = Number.isInteger(args?.budget) ? args.budget : 20480;

      const context = { repoStack: repo.signals, taskTokens: tokenize(args?.task ?? ''), paths };
      const { selected, excluded } = rankSkills(reg.skills, context, { forced });
      const expanded = closure(selected, reg.skills);

      // The budget decides what is INLINED, and it is the same function the CLI
      // uses — not a second copy of the same loop. The two copies had drifted: this one
      // checked `deferred` *after* the budget and inlined a deferred dependency, while
      // `skills brief` checked it first and did not. A caller reaching for the MCP tool
      // and a caller reaching for the command got different answers to one question, and
      // neither could see the other (ADR-035's shape, one level down).
      //
      // No body is ever returned by this tool: a caller that wants one calls
      // skills_show, which makes the cost visible before it is paid.
      const { picked, deferred, used } = selectWithinBudget(expanded, {
        budget,
        all: args?.all === true,
      });

      const closureNames = new Set(expanded.map((e) => e.skill.name));
      return {
        repo: { root, stack: repo.stack, facts: repo.facts },
        task: args?.task ?? null,
        budget,
        inlineBytes: used,
        selected: picked.map((e) => ({
          name: e.skill.name,
          bytes: e.skill.bytes,
          summary: e.skill.summary,
          why: [...e.reasons, ...[...e.via].map((v) => `requires:${v}`)],
        })),
        deferred: deferred.map((e) => ({
          name: e.skill.name,
          bytes: e.skill.bytes,
          reason: e.skill.deferred ? 'marked deferred' : 'over budget',
        })),
        notSelected: excluded
          .filter((e) => !closureNames.has(e.skill.name))
          .map((e) => ({ name: e.skill.name, reason: e.reason })),
      };
    },
  },

  {
    name: 'skills_show',
    description: 'One skill body, with the metadata needed to decide whether to trust it: source path, which of the two locations it was read from, and its cited decisions.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        root: { type: 'string' },
        maxBytes: { type: 'number', description: 'hard ceiling on the returned text' },
      },
      required: ['name'],
    },
    async run(args) {
      const name = args?.name;
      if (typeof name !== 'string' || name.length === 0) throw new Error('skills_show needs a skill name');
      const { registry: reg } = await registry(args);
      const skill = reg.skills.find((s) => s.name === name);
      if (!skill) throw new Error(`no skill named "${name}"; call skills_index or skills_find`);

      const root = rootOf(args);
      const ws = await resolveWorkspace(args ?? {});
      const body = await readBody(skill, ws.root, root);
      const source = skill.sources?.find((s) => s.role === 'canonical') ?? skill.sources?.[0];
      const located = body.startsWith('(body unavailable') ? null : body;
      return {
        name,
        summary: skill.summary,
        bytes: skill.bytes,
        capabilities: skill.capabilities,
        stack: skill.stack,
        deferred: Boolean(skill.deferred),
        source: source ? `${source.repo}/${source.path}` : null,
        readFrom: located === null ? 'unavailable' : body.length === 0 ? 'empty' : 'ok',
        requires: skill.requires ?? [],
        variants: (skill.variants ?? []).map((v) => ({ id: v.id, stack: v.stack, bytes: v.bytes })),
        maxBytes: Number.isInteger(args?.maxBytes) ? args.maxBytes : 0,
        body: body || null,
      };
    },
  },

  {
    name: 'skills_find',
    description: 'Raw search across capability, keyword and summary. Use when skills_brief has nothing and you suspect a skill exists.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    async run(args) {
      const query = typeof args?.query === 'string' ? args.query : '';
      if (query.trim() === '') throw new Error('skills_find needs a query');
      const { registry: reg } = await registry(args);
      const tokens = tokenize(query);
      return {
        query,
        results: reg.skills
          .map((skill) => ({ skill, ...scoreSkill(skill, { repoStack: [], taskTokens: tokens, paths: [] }) }))
          .filter((r) => selectionVerdict(r.evidence, r.reasons) === null)
          .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
          .map((r) => ({ name: r.skill.name, score: r.score, summary: r.skill.summary, why: r.reasons })),
      };
    },
  },

  {
    name: 'skills_why',
    description:
      'The signal chain for one skill in one repository: its score, the reasons behind it, whether the stack gate admits it at all, and what it would take to make it selected.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, root: { type: 'string' }, task: { type: 'string' } },
      required: ['name'],
    },
    async run(args) {
      const { registry: reg } = await registry(args);
      const skill = reg.skills.find((s) => s.name === args?.name);
      if (!skill) throw new Error(`no skill named "${args?.name}"; call skills_find`);
      const root = rootOf(args);
      const repo = await fingerprint(root);
      const paths = await dirtyPaths(root);
      const { score, reasons } = scoreSkill(skill, {
        repoStack: repo.signals,
        taskTokens: tokenize(args?.task ?? ''),
        paths,
      });
      return {
        name: skill.name,
        score,
        compatible: stackCompatible(skill, repo.signals),
        reasons,
        repo: { root, signals: repo.signals, evidence: repo.evidence },
        task: args?.task ?? null,
        pathsSeen: paths.slice(0, 20),
      };
    },
  },

  {
    name: 'rules_list',
    description:
      'The rule catalogue, and which rules a given repository actually receives. Pass `root` to get the selection rather than just the catalogue.',
    inputSchema: {
      type: 'object',
      properties: { root: { type: 'string' } },
      required: [],
    },
    async run(args) {
      const root = args?.root;
      const rules = await loadRules(typeof root === 'string' && root ? root : null);
      const repo = typeof root === 'string' && root ? await fingerprint(root) : null;
      const { selected, notes } = repo
        ? select(rules, repo.stack, repo.facts)
        : { selected: [], notes: [] };
      const chosen = new Set(selected.map((r) => r.id));
      return {
        sha: await provenanceDigest(),
        notes,
        rules: [...rules]
          .sort((a, b) => String(a.id).localeCompare(String(b.id)))
          .map((r) => ({
            id: r.id,
            title: r.title,
            applies: r.applies,
            origin: r.origin,
            source: r.source,
            bytes: r.bytes,
            adrs: citations(r.body),
            error: r.error,
            selected: chosen.has(r.id),
          })),
      };
    },
  },

  {
    name: 'rules_why',
    description:
      'Why a rule exists. Give a rule id for the decisions that settled it and whether each is still in force, or an ADR id for the rules that decision restsates. A rule citing no decision reports that - it is a finding, not an empty answer.',
    inputSchema: {
      type: 'object',
      properties: { what: { type: 'string', description: 'a rule id or ADR-NNN' } },
      required: ['what'],
    },
    async run(args) {
      const what = typeof args?.what === 'string' ? args.what : '';
      const rules = await loadRules(null);
      const { decisions } = await loadDecisions();
      const index = byId(decisions);

      if (/^ADR-\d{3}$/i.test(what)) {
        const id = what.toUpperCase();
        const d = decisions.find((x) => x.id === id);
        if (!d) throw new Error(`no decision record ${id}`);
        return {
          direction: 'decision',
          id: d.id,
          title: d.title,
          status: d.status,
          // The record travels inside the installed package. A relative path would resolve
          // against the consuming repo and name a file that is not there, which is
          // worse than giving no path at all.
          readWith: `simt-dev rules why ${d.id}`,
          supersededBy: d.supersededBy,
          supersedes: d.supersedes,
          partial: d.partial,
          rules: rules.filter((r) => citations(r.body).includes(id)).map((r) => r.id),
        };
      }

      const rule = rules.find((r) => r.id === what);
      if (!rule) throw new Error(`no rule with id "${what}"; call rules_list`);
      const cited = citations(rule.body);
      return {
        direction: 'rule',
        id: rule.id,
        title: rule.title,
        source: rule.source,
        origin: rule.origin,
        uncited: cited.length === 0,
        decisions: cited.map((c) => {
          const d = index.get(c);
          return d
            ? { id: d.id, title: d.title, status: d.status, supersededBy: d.supersededBy }
            : { id: c, missing: true };
        }),
      };
    },
  },

  {
    name: 'check',
    description:
      'The gate for one repository: is its generated region current, unmanaged, drifted or malformed, and does any rule file lack an id. Read-only - it never repairs.',
    inputSchema: rootArg,
    async run(args) {
      const root = rootOf(args);
      const findings = await checkTargets(root);
      for (const r of await loadRules()) {
        if (r.error) findings.push({ file: `rules/${r.file}`, status: 'invalid', detail: r.error });
      }
      const bad = findings.filter((f) => f.status !== 'current');
      return { root, ok: bad.length === 0, findings };
    },
  },

  {
    name: 'compare',
    description:
      'The organisation-wide matrix: every repository under the root, its adoption, region state, pinned simt-dev SHA, hook routing and declared gates, plus the problems found. This is the command that replaces reconstructing the estate by hand.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'a workspace directory, or one repository' },
        workspace: { type: 'string', description: 'workspace root when root is not given' },
      },
      required: [],
    },
    async run(args) {
      const root = args?.root ?? args?.workspace ?? (await resolveWorkspace(args ?? {})).root ?? process.cwd();
      const found = await discover(root);
      if (found.error) throw Object.assign(new Error(`${root}: ${found.error}`), { remedy: 'pass root' });
      const expectedSha = await provenanceDigest();
      const context = { expectedSha, gates: new Set(Object.keys(GATES)), gateKinds: GATE_KINDS };
      const rows = [];
      for (const repo of found.repos) rows.push(await buildRow(repo, context));
      return {
        root,
        shape: found.shape,
        expectedSha,
        summary: summarise(rows, { root, shape: found.shape, expectedSha }),
        repos: rows,
        worktrees: found.worktrees.map((w) => ({ name: w.name, owner: w.ownerName })),
        directories: found.directories,
      };
    },
  },
];

export function toolNames() {
  return TOOLS.map((t) => t.name);
}

export { measureSkill };