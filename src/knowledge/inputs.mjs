// `simt check` validates the knowledge inputs a repository has authored.
//
// Six doors read six conventional files under `.simt/knowledge/`, and each door
// asserts a shape as its first gate before it can answer. A file that is absent
// is legal - the door simply has nothing to read. A file that is present but
// does not parse, or that misses the shape its door requires, is a red state no
// one sees until an agent invokes that door and reads an error it could have
// caught at the gate. This module is that check: one finding per defect,
// naming the file, the defect, and the remedy, so `simt check` is the first
// place a malformed input is heard of.
//
// The contract checked for each file is the shape its door asserts before it
// can start - the same predicate the reader applies - so a file that passes
// here is a file the door can read, and one that fails here is one the door
// would refuse.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { BUNDLE_SCHEMA, importBundle } from './bundle.mjs';

/**
 * The directory the knowledge doors read their inputs from. Its presence is the
 * declaration that gates the knowledge rule; its contents are
 * what this validator checks.
 */
export const KNOWLEDGE_DIR = '.simt/knowledge';

// The six conventional inputs, each named for the door it feeds. The order is
// the doors' order, so a reader scanning the findings sees why, rank, debt,
// impact, derivations, import - the order the rule teaches.
const INPUTS = [
  { file: 'claims.json', door: 'why' },
  { file: 'units.json', door: 'rank' },
  { file: 'debt.json', door: 'debt' },
  { file: 'impact.json', door: 'impact' },
  { file: 'derivations.json', door: 'derivations' },
  { file: 'export.json', door: 'import' },
];

const isText = (value) => typeof value === 'string' && value.length > 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The structural problems a file shaped for `door` carries, empty when the file
 * is shaped for its reader. Each entry is a `{detail, remedy}` pair, phrased the
 * way the door phrases its own refusal, so the finding and the door agree.
 *
 * @param {string} door
 * @param {object} doc the parsed, object-typed document
 * @returns {Array<{detail: string, remedy: string}>}
 */
function shapeProblems(door, doc) {
  switch (door) {
    case 'why':
      // `knowledgeWhyFacts` reads `doc.claims` and refuses a document without a list.
      // `edges` and `artifacts` are optional: the graph builder defaults them to [].
      return Array.isArray(doc.claims)
        ? []
        : [{ detail: 'the why door needs a claims list', remedy: 'give the file a "claims" array, with an id on every claim' }];
    case 'rank':
      // `knowledgeRankFacts` reads `doc.units` and refuses a document without a list.
      return Array.isArray(doc.units)
        ? []
        : [{ detail: 'the rank door needs a units list', remedy: 'give the file a "units" array of {id, path, text, ...}' }];
    case 'debt':
      // `knowledgeDebtFacts` reads `doc.items` and refuses a document without a list.
      return Array.isArray(doc.items)
        ? []
        : [{ detail: 'the debt door needs an items list', remedy: 'give the file an "items" array of {id, kind, effort, ...}' }];
    case 'impact': {
      // `knowledgeImpactFacts` resolves the graph from `doc.graph` or a top-level
      // `nodes`, and `impactReport` throws without a graph that has nodes. `change`
      // is optional: the door accepts `--refs` at invoke time, so the file only
      // owes an array-shaped `change.refs` when it names one at all.
      const problems = [];
      const graph = isObject(doc.graph) ? doc.graph : Array.isArray(doc.nodes) ? { nodes: doc.nodes } : null;
      if (graph === null || !Array.isArray(graph.nodes)) {
        problems.push({
          detail: 'the impact door needs a graph with nodes',
          remedy: 'give the file a "graph" object with a "nodes" array, or a top-level "nodes" array',
        });
      }
      if (doc.change !== undefined && !isObject(doc.change)) {
        problems.push({ detail: '"change" must be an object', remedy: 'make "change" an object with a "refs" array' });
      } else if (isObject(doc.change) && doc.change.refs !== undefined && !Array.isArray(doc.change.refs)) {
        problems.push({ detail: '"change.refs" must be a list', remedy: 'make "change.refs" an array of claim ids' });
      }
      return problems;
    }
    case 'derivations': {
      // `regenerationCandidates` destructures `receipts`, `outputs`, `changes` and
      // `observed`, defaulting each to []. A field that is present but not a list
      // would be silently dropped, so the shape the door can read is: each present
      // field is an array.
      const problems = [];
      for (const field of ['receipts', 'outputs', 'changes', 'observed']) {
        if (doc[field] !== undefined && !Array.isArray(doc[field])) {
          problems.push({ detail: `"${field}" must be a list`, remedy: `make "${field}" an array` });
        }
      }
      return problems;
    }
    case 'import':
      // The import door is `importBundle`: it is the reader, and it is exported, so
      // the validator asks it directly rather than restating its contract. The
      // problems it returns already carry a detail and a remedy, so they become
      // findings verbatim. `at` is null so an expired bundle is not a structural
      // defect here - expiration is a question of when, not of shape.
      return importBundle(doc, { at: null }).problems.map((problem) => ({ detail: problem.detail, remedy: problem.remedy }));
    default:
      return [];
  }
}

/**
 * The findings a repository's knowledge inputs carry, for `simt check` to count.
 *
 * The directory is the declaration: a repository without `.simt/knowledge/` has
 * authored nothing and gets no findings, so a non-adopting repo is unaffected in
 * both findings and exit code. Within the directory, each conventional file that
 * is present is checked; an absent file is legal and raises nothing.
 *
 * @param {string} root
 * @returns {Promise<Array<{file: string, status: string, detail: string, remedy: string}>>}
 */
export async function knowledgeInputFindings(root) {
  const dir = join(root, KNOWLEDGE_DIR);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const present = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));

  const findings = [];
  for (const { file, door } of INPUTS) {
    if (!present.has(file)) continue;
    const rel = `${KNOWLEDGE_DIR}/${file}`;

    let text;
    try {
      text = await readFile(join(dir, file), 'utf8');
    } catch (error) {
      findings.push({ file: rel, status: 'invalid', detail: `cannot read the input: ${error.code ?? error.message}`, remedy: 'restore the file, or remove it' });
      continue;
    }

    let doc;
    try {
      doc = JSON.parse(text);
    } catch (error) {
      findings.push({ file: rel, status: 'invalid', detail: `not JSON: ${error.message}`, remedy: 'fix the JSON, or remove the file' });
      continue;
    }

    if (!isObject(doc)) {
      // Arrays parse to `typeof 'object'`, so the guard is the array-excluding
      // predicate: a list-shaped document is not a document the doors read.
      findings.push({ file: rel, status: 'invalid', detail: 'must hold a JSON object', remedy: 'wrap the input in an object, or remove the file' });
      continue;
    }

    for (const problem of shapeProblems(door, doc)) {
      findings.push({ file: rel, status: 'invalid', detail: problem.detail, remedy: problem.remedy });
    }
  }
  return findings;
}
