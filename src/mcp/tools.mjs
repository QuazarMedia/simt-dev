// The MCP tool surface: a second front door onto the same logic the CLI uses.
//
// Deliberately a subset. Every tool here is READ-ONLY, because the commands that write
// (`init`, `sync`, `hooks install`, `skills install`, `upgrade`) each exist to be read as
// a diff by a human before they touch anything (ADR-001, ADR-004). A model can call a
// tool; a model cannot review a diff it never showed you.
//
// The tools return the same facts the commands render, by calling the command
// modules' core functions rather than rebuilding the answers. The commands render
// for terminals, these return JSON for a model, and the two copies had already
// drifted: MCP `check` reported 3 findings where the command reports 77, the MCP
// `doctor` was a fingerprint with none of the findings, `rules_list` missed the
// per-surface rules, and the skills payloads disagreed on field names (Q15). The
// CLI keeps its field names; the tools adopt them. What is shared is the whole
// answer, because two answers to one question is what ADR-035 rules out.
//
// Bodies are never inlined by `skills_brief`. Tier 1 is a set of pointers and reasons;
// the body is a separate call. A 384 KB reference inlined into a tool result is the exact
// failure progressive disclosure exists to prevent, and a transport makes it easier to
// cause by accident because the caller cannot see the size until it has paid for it.

import { loadRegistry } from '../graph/load.mjs';
import { provenanceDigest } from '../projection/project.mjs';
import { discover } from '../compare/discover.mjs';
import { buildRow, summarise } from '../compare/row.mjs';
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

const GATE_KINDS = new Map(Object.entries(GATES).map(([name, g]) => [name, g.kind]));

/** A schema with no required fields still needs the object declared. */
const noArgs = { type: 'object', properties: {}, required: [] };

/**
 * Output schemas, one per tool, describing what a SUCCESSFUL call returns.
 *
 * Every one of these tools is a reader: none writes, and none writes twice. The
 * annotations say so, and the schemas say what comes back — because a client that can
 * validate an answer against a declared shape catches a wrong answer at the boundary,
 * while one handed a bag of JSON has to trust that the tool meant it.
 *
 * Properties are required unless the payload can legitimately omit them: `error` is
 * absent when there is none, `body` is null when there is none, and a schema that
 * required the exception would describe a shape that never occurs. `additionalProperties`
 * is left open, which is what the 2026-07-28 revision permits and what a reader wants:
 * these payloads are data, and a new field from a future release should not make an
 * older client's validation fail.
 */
/**
 * The shape of a failure, exported because a client validating an answer needs it and
 * because the test that checks every tool's answer needs it for the failures. Two
 * copies of this schema would drift, and the copy that drifted would be the one nobody
 * validates against - which is exactly how a remedy quietly stops being a string.
 */
export const ERROR_SHAPE = {
  type: 'object',
  properties: { error: { type: 'string' }, remedy: { type: ['string', 'null'] } },
  required: ['error'],
};

const output = {
  doctor: {
    // The `doctor --json` document minus its envelope: the same findings, the
    // same workspace answer, the same fingerprint. (Q15)
    type: 'object',
    properties: {
      root: { type: 'string' },
      stack: { type: 'array', items: { type: 'string' } },
      facts: { type: 'array', items: { type: 'string' } },
      factEvidence: { type: 'object', additionalProperties: { type: ['string', 'null'] } },
      signals: { type: 'array', items: { type: 'string' } },
      // One entry per signal, naming the file that proved it. The payload is a list of
      // paths, not of records - `fingerprint` returns evidence as the paths themselves.
      evidence: { type: 'array', items: { type: 'string' } },
      manifest: { type: ['object', 'null'] },
      error: { type: ['string', 'null'] },
      workspace: {
        type: 'object',
        properties: {
          // Null is the honest value for a repository that is not inside a workspace:
          // there is no root to name, and naming the repository as one would be a claim
          // about the reader's directory layout that nothing established.
          root: { type: ['string', 'null'] },
          source: { type: ['string', 'null'] },
          detail: { type: ['string', 'null'] },
          error: { type: ['string', 'null'] },
        },
        required: ['root', 'source'],
      },
      shared: { type: ['object', 'null'] },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            severity: { type: 'string' },
            detail: { type: 'string' },
            remedy: { type: ['string', 'null'] },
            why: { type: ['string', 'null'] },
            safe: { type: 'boolean' },
            fixed: { type: 'boolean' },
          },
          required: ['id', 'severity', 'detail', 'safe', 'fixed'],
        },
      },
      fix: {
        type: 'object',
        properties: {
          requested: { type: 'boolean' },
          applied: { type: 'boolean' },
          fixed: { type: 'array', items: { type: 'string' } },
          failed: { type: 'array', items: { type: 'object' } },
        },
        required: ['requested', 'applied', 'fixed', 'failed'],
      },
      remedy: { type: ['string', 'null'] },
    },
    required: ['root', 'workspace', 'stack', 'facts', 'signals', 'evidence', 'findings'],
  },
  skills_index: {
    type: 'object',
    properties: {
      skills: { type: 'number' },
      totalBytes: { type: 'number' },
      deferred: { type: 'array', items: { type: 'string' } },
      workspace: { type: 'object' },
      verified: { type: 'boolean' },
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            summary: { type: 'string' },
            bytes: { type: 'number' },
            stack: { type: 'array', items: { type: 'string' } },
            deferred: { type: 'boolean' },
          },
          required: ['name', 'bytes'],
        },
      },
    },
    required: ['skills', 'totalBytes', 'entries'],
  },
  // The `skills brief --json` document minus its envelope, or the `--all` one.
  // The CLI keeps its field names; this adopts them. (Q15)
  skills_brief: {
    anyOf: [
      {
        type: 'object',
        properties: {
          repo: {
            type: 'object',
            properties: {
              root: { type: 'string' },
              stack: { type: 'array', items: { type: 'string' } },
              facts: { type: 'array', items: { type: 'string' } },
            },
            required: ['root', 'stack', 'facts'],
          },
          workspace: { type: 'string' },
          task: { type: ['string', 'null'] },
          budget: { type: 'number' },
          inlineBytes: { type: 'number' },
          resolved: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                bytes: { type: 'number' },
                summary: { type: 'string' },
                why: { type: 'array', items: { type: 'string' } },
              },
              required: ['name', 'bytes', 'why'],
            },
          },
          deferred: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, bytes: { type: 'number' }, reason: { type: 'string' } },
              required: ['name', 'bytes', 'reason'],
            },
          },
          excluded: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, reason: { type: 'string' } },
              required: ['name', 'reason'],
            },
          },
          warning: { type: 'string' },
        },
        required: ['repo', 'budget', 'inlineBytes', 'resolved', 'deferred', 'excluded'],
      },
      {
        type: 'object',
        properties: {
          all: { type: 'boolean', enum: [true] },
          repoStack: { type: 'array', items: { type: 'string' } },
          inline: { type: 'array', items: { type: 'string' } },
          deferred: { type: 'array', items: { type: 'string' } },
          warning: { type: 'string' },
        },
        required: ['all', 'repoStack', 'inline', 'deferred'],
      },
    ],
  },
  // The `skills show --json` document minus its envelope, plus the body text the
  // command prints below the metadata. (Q15)
  skills_show: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      summary: { type: 'string' },
      bytes: { type: 'number' },
      capabilities: { type: 'array', items: { type: 'string' } },
      stack: { type: 'array', items: { type: 'string' } },
      keywords: { type: 'array', items: { type: 'string' } },
      deferred: { type: 'boolean' },
      requires: { type: 'array', items: { type: 'string' } },
      variants: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, stack: { type: 'array', items: { type: 'string' } }, bytes: { type: 'number' } },
          required: ['id'],
        },
      },
      sources: { type: 'array', items: { type: 'object' } },
      aliasOf: { type: ['string', 'null'] },
      variantOf: { type: ['string', 'null'] },
      workspace: { type: 'string' },
      body: { type: ['string', 'null'] },
      bodyFrom: { type: 'string' },
      bodyText: { type: 'string' },
    },
    required: ['name', 'bytes', 'bodyFrom', 'requires', 'variants'],
  },
  skills_find: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            score: { type: 'number' },
            summary: { type: 'string' },
            reasons: { type: 'array', items: { type: 'string' } },
          },
          required: ['name', 'score', 'reasons'],
        },
      },
    },
    required: ['query', 'results'],
  },
  // The `skills why --json` document minus its envelope. (Q15)
  skills_why: {
    type: 'object',
    properties: {
      skill: { type: 'string' },
      score: { type: 'number' },
      compatible: { type: 'boolean' },
      gate: { type: 'string' },
      repo: {
        type: 'object',
        properties: {
          root: { type: 'string' },
          stack: { type: 'array', items: { type: 'string' } },
          facts: { type: 'array', items: { type: 'string' } },
          evidence: { type: 'array', items: { type: 'string' } },
        },
      },
      workspace: { type: 'object' },
      paths: { type: 'array', items: { type: 'string' } },
      taskTokens: { type: 'array', items: { type: 'string' } },
      signals: { type: 'array', items: { type: 'string' } },
      variants: { type: 'array', items: { type: 'object' } },
      aliasOf: { type: ['string', 'null'] },
      variantOf: { type: ['string', 'null'] },
      requires: { type: 'array', items: { type: 'string' } },
    },
    required: ['skill', 'score', 'compatible', 'signals'],
  },
  rules_list: {
    type: 'object',
    properties: {
      sha: { type: 'string' },
      notes: { type: 'array', items: { type: 'string' } },
      rules: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: ['string', 'null'] },
            title: { type: ['string', 'null'] },
            // A profile may name one signal or several, and the frontmatter keeps both
            // spellings. Describing only the list would make a conforming rule look
            // broken.
            applies: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] },
            origin: { type: 'string' },
            source: { type: 'string' },
            bytes: { type: 'number' },
            adrs: { type: 'array', items: { type: 'string' } },
            error: { type: ['string', 'null'] },
            fallback: { type: 'boolean' },
            selected: { type: ['boolean', 'null'] },
          },
          required: ['source', 'bytes', 'selected'],
        },
      },
    },
    required: ['sha', 'rules'],
  },
  // The `rules why --json` document minus its envelope, either direction. (Q15)
  rules_why: {
    type: 'object',
    properties: {
      direction: { type: 'string', enum: ['rule', 'decision'] },
      id: { type: 'string' },
      rule: { type: 'string' },
      title: { type: ['string', 'null'] },
      source: { type: 'string' },
      origin: { type: 'string' },
      adrs: { type: 'array', items: { type: 'object' } },
      uncited: { type: 'boolean' },
      others: { type: 'array', items: { type: 'string' } },
      adr: { type: 'object' },
      supersededBy: { type: ['object', 'null'] },
      inForce: { type: 'object' },
      rules: { type: 'array', items: { type: 'string' } },
    },
    required: ['direction', 'id'],
  },
  check: {
    type: 'object',
    properties: {
      root: { type: 'string' },
      ok: { type: 'boolean' },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            status: { type: 'string' },
            detail: { type: ['string', 'null'] },
            remedy: { type: ['string', 'null'] },
          },
          required: ['file', 'status'],
        },
      },
    },
    required: ['root', 'ok', 'findings'],
  },
  compare: {
    type: 'object',
    properties: {
      root: { type: 'string' },
      shape: { type: 'string', enum: ['repo', 'workspace'] },
      expectedSha: { type: 'string' },
      summary: { type: 'object' },
      repos: { type: 'array', items: { type: 'object' } },
      worktrees: { type: 'array', items: { type: 'object' } },
      directories: { type: 'array', items: { type: 'string' } },
    },
    required: ['root', 'shape', 'expectedSha', 'summary', 'repos'],
  },
  plan_next: {
    type: 'object',
    properties: {
      root: { type: 'string' },
      next: { type: ['object', 'null'] },
      reason: { type: ['string', 'null'] },
    },
    required: ['root', 'next', 'reason'],
  },
  plan_done: {
    type: 'object',
    properties: {
      root: { type: 'string' },
      id: { type: 'string' },
      doc: { type: 'string' },
      line: { type: 'number' },
      from: { type: 'string' },
      to: { type: 'string' },
      wouldChange: { type: 'boolean' },
      dryRun: { type: 'boolean' },
      remedy: { type: ['string', 'null'] },
    },
    required: ['root', 'id', 'wouldChange', 'dryRun'],
  },
  brief: {
    type: 'object',
    properties: {
      root: { type: 'string' },
      kind: { type: 'string' },
      basis: { type: 'string' },
      task: { type: 'string' },
      scope: { type: 'array', items: { type: 'string' } },
      budget: { type: 'number' },
      bytes: { type: 'number' },
      before: { type: 'number' },
      floorHeld: { type: 'boolean' },
      cut: { type: 'array', items: { type: 'string' } },
      sections: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
      text: { type: 'string' },
    },
    required: ['root', 'kind', 'basis', 'task', 'scope', 'budget', 'bytes', 'before', 'floorHeld', 'cut', 'sections', 'text'],
  },
  pr_body: {
    type: 'object',
    properties: {
      root: { type: 'string' },
      base: { type: ['string', 'null'] },
      tree: { type: ['string', 'null'] },
      verdict: { type: 'string' },
      unreviewed: { type: 'array', items: { type: 'string' } },
      paths: { type: 'array', items: { type: 'string' } },
      decisions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            id: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'string' },
          },
          required: ['path', 'id', 'title', 'status'],
        },
      },
      gates: {
        type: 'object',
        properties: {
          declared: { type: 'array', items: { type: 'string' } },
          evidenceMode: { type: ['string', 'null'] },
          run: { type: ['object', 'null'] },
          rulesOk: { type: ['boolean', 'null'] },
          hooksOk: { type: ['boolean', 'null'] },
          blocking: { type: 'number' },
          warnings: { type: 'number' },
          cached: { type: 'boolean' },
        },
        required: ['declared', 'blocking', 'warnings', 'cached'],
      },
      evidence: {
        type: 'object',
        properties: {
          entries: { type: 'array', items: { type: 'object' } },
          errors: { type: 'array', items: { type: 'string' } },
        },
        required: ['entries', 'errors'],
      },
    },
    required: ['root', 'base', 'tree', 'verdict', 'unreviewed', 'decisions', 'gates', 'evidence', 'paths'],
  },
  federation_query: {
    type: 'object',
    properties: {
      root: { type: 'string' },
      query: { type: 'string' },
      servers: { type: 'array', items: { type: 'string' } },
      answers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            server: { type: 'string' },
            tool: { type: 'string' },
            query: { type: 'string' },
            text: { type: 'string' },
          },
          required: ['server', 'tool', 'query', 'text'],
        },
      },
      findings: { type: 'array', items: { type: 'string' } },
    },
    required: ['root', 'query', 'servers', 'answers', 'findings'],
  },
  /** The shape of every tool failure, which is a result and not a protocol error. */
  error: ERROR_SHAPE,
};

const rootArg = {
  type: 'object',
  properties: { root: { type: 'string', description: 'repository root; defaults to the editor cwd' } },
  required: [],
};

function rootOf(args) {
  return typeof args?.root === 'string' && args.root.length > 0 ? args.root : process.cwd();
}

async function registry(args) {
  const { registry, errors, ok, verified, workspace } = await loadRegistry(null, args ?? {});
  if (!ok) {
    throw Object.assign(new Error(errors[0]), {
      remedy: `run: ${CLI} graph lint`,
    });
  }
  return { registry, verified, workspace };
}

export const TOOLS = [
  {
    outputSchema: output.doctor,
    name: 'doctor',
    description:
      'Classify a repository: stack tags, emitted facts with the file that proved each, and manifest presence. Call this first when the repo is unknown.',
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
      'THE entry point. Resolve the skill set for a task: selected with why, deferred, and not selected with reason - the reasons let you override the resolver instead of guessing at it.',
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
      return {
        ...facts.skill,
        workspace: facts.workspace,
        body: facts.body,
        bodyFrom: facts.bodyFrom,
        bodyText: facts.bodyText,
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
        registry: { type: 'string', description: 'path to skills.graph.json; else --registry / SIMT_REGISTRY / default tiers' },
      },
      required: ['query'],
    },
    async run(args) {
      return skillsFindFacts(typeof args?.query === 'string' ? args.query : '', args ?? {});
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
      'The workspace matrix: every repository with its adoption, region state, pinned SHA, hook routing and gates, plus the problems found.',
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
      if (result.cold) throw Object.assign(new Error('this repository has no index to answer from'), { remedy: `run: ${CLI} index` });
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

export function toolNames() {
  return TOOLS.map((t) => t.name);
}

export { measureSkill };