// The Constellation's reader: the same corpus document `knowledge why` builds, as a graph.
//
// The corpus is derived state, so this reader validates its schema and scope before using
// it and never reads a document body. Scope comes from the work declaration; a cold corpus
// is a build remedy, not an empty sky.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildClaimGraph } from '../knowledge/claims.mjs';
import { CORPUS_DIR, CORPUS_SCHEMA_VERSION } from '../knowledge/corpus.mjs';
import { corpusDocument } from '../knowledge/query.mjs';
import { readWork } from '../work/effective.mjs';

function digestOf(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function scopeFor(root, requested) {
  const work = await readWork(root);
  if (!work.ok) {
    return { error: `${work.problems[0]?.message ?? 'the work declaration is invalid'}`, remedy: work.problems[0]?.remedy ?? 'run: simt work inspect' };
  }
  if (!work.declared) {
    return { error: 'this repository declares no work, so there is no corpus to draw', remedy: 'run: simt work setup --scope <id> --path <dir> --kind document' };
  }
  const scope = requested ? work.scopes.find((row) => row.id === requested) : work.scopes[0];
  if (!scope) {
    return {
      error: `\`${requested ?? '(none)'}\` is not a declared scope`,
      remedy: `declared scopes are ${work.scopes.map((row) => `\`${row.id}\``).join(', ')}`,
    };
  }
  return { scope };
}

/**
 * One scoped corpus as artifacts, claims and typed edges.
 *
 * The graph validates edges with `buildClaimGraph`; an edge naming a missing node is a
 * problem in the payload, never an invented node. A node with no declared scope is marked
 * for the separate table band rather than mixed into the placed sky.
 */
export async function knowledgeGraph(root, requestedScope = null) {
  const selected = await scopeFor(root, requestedScope);
  if (selected.error) return { ok: false, error: selected.error, remedy: selected.remedy };
  const scope = selected.scope;
  const rebuild = `run: simt knowledge build --scope ${scope.id} --yes`;
  let corpus;
  try {
    corpus = JSON.parse(await readFile(join(root, CORPUS_DIR, `${scope.id}.json`), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: false, error: `no corpus is built for scope \`${scope.id}\``, remedy: rebuild };
    return { ok: false, error: `the corpus for scope \`${scope.id}\` could not be read (${error.code ?? error.message})`, remedy: rebuild };
  }
  if (corpus?.schema !== CORPUS_SCHEMA_VERSION || corpus?.scope !== scope.id) {
    return { ok: false, error: `the corpus for scope \`${scope.id}\` was written under another schema or scope`, remedy: rebuild };
  }

  const document = corpusDocument(corpus);
  const graph = buildClaimGraph(document);
  const nodes = graph.nodes.map((node) => {
    const nodeScope = node.scope ?? node.claim?.applicability ?? null;
    return {
      id: node.id,
      kind: node.kind,
      path: node.path ?? null,
      scope: nodeScope,
      unknownScope: nodeScope === null || (typeof nodeScope === 'object' && Object.keys(nodeScope).length === 0),
    };
  });
  return {
    ok: true,
    command: 'knowledge graph',
    root,
    scope: corpus.scope,
    corpus: {
      schema: corpus.schema,
      policy: corpus.policy,
      counts: corpus.counts,
      problems: corpus.problems ?? [],
    },
    seed: digestOf({ scope: corpus.scope, artifacts: document.artifacts.map((row) => row.id), claims: document.claims.map((row) => row.id) }).slice(0, 16),
    graph: { nodes, edges: graph.edges, problems: graph.problems },
  };
}
