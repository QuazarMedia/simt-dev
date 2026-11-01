// The MCP schemas and the two helpers every tool handler shares.
//
// Split out of tools.mjs, which crossed the repository ceiling carrying the tool list
// and the shapes it answers with. The shapes are data a client validates against; the
// handlers are the tools. A tool module imports both and defines neither.

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

export const GATE_KINDS = new Map(Object.entries(GATES).map(([name, g]) => [name, g.kind]));

/** A schema with no required fields still needs the object declared. */
export const noArgs = { type: 'object', properties: {}, required: [] };

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

export const output = {
  doctor: {
    // The `doctor --json` document minus its envelope: the same findings, the
    // same workspace answer, the same fingerprint. 
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
  // The CLI keeps its field names; this adopts them. 
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
  // command prints below the metadata. 
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
      bodyText: { type: ['string', 'null'] },
      reason: { type: ['string', 'null'], description: 'why there is no body, when there is none' },
    },
    required: ['name', 'bytes', 'body', 'bodyFrom', 'bodyText', 'reason', 'requires', 'variants'],
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
  // The `skills why --json` document minus its envelope. 
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
  // The `rules why --json` document minus its envelope, either direction. 
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
      partial: { type: 'boolean' },
      cursor: { type: ['string', 'null'] },
      total: { type: 'number' },
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
      note: { type: ['string', 'null'] },
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

export const rootArg = {
  type: 'object',
  properties: { root: { type: 'string', description: 'repository root; defaults to the editor cwd' } },
  required: [],
};


export function rootOf(args) {
  return typeof args?.root === 'string' && args.root.length > 0 ? args.root : process.cwd();
}

export async function registry(args) {
  const { registry, errors, ok, verified, workspace } = await loadRegistry(null, args ?? {});
  if (!ok) {
    throw Object.assign(new Error(errors[0]), {
      remedy: `run: ${CLI} graph lint`,
    });
  }
  return { registry, verified, workspace };
}
