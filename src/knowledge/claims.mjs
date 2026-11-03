// Claims and typed dependencies: what is asserted, on what evidence, and what depends on it.
//
// A document is not evidence of its own correctness. The unit that can be checked is the
// claim: a subject, a predicate, a typed value, a unit, the scope it applies to, and the
// sources that support it. Everything downstream - a paragraph, a design note, a recipe, a
// graduated helper - depends on some subset of those, and the dependency is what makes
// "this source changed" answerable with "these outputs are now suspect".
//
// Three rules keep that answer honest:
//
//   * A value has a type. `19` and `"19"` are different claims, and so are `19 %` and `19`.
//     A key that dropped the type or the unit would unify them, and every downstream check
//     would then be checking the wrong assertion.
//   * A proposal is not authority. An edge extracted by a model, or written by an agent, is
//     `proposed` until someone reviews it; traversal used for checks skips those, and a
//     separate query returns them.
//   * Prose is unassessed, not false. Only an explicit marker becomes a claim. A parser that
//     invented claims from sentences would be asserting on the document's behalf, and
//     "unassessed" is the true answer for text nobody declared.
//
// Edges point from the entity being discussed to its basis: `claim --derived-from--> source`,
// `helper --implements--> recipe`, `recipe --affects-object--> object`. `supports` is the one
// exception, because the supporter is the basis: `source --supports--> claim`. Every other
// kind reads left to right as "the left one depends on the right one", which is what makes
// one traversal answer both lineage and impact.

export const CLAIMS_SCHEMA_VERSION = 1;

/** The typed relations a claim graph may carry. */
export const EDGE_KINDS = Object.freeze([
  'supports',
  'contradicts',
  'derived-from',
  'supersedes',
  'imports-context',
  'implements',
  'generated-by',
  'verifies',
  'affects-object',
]);

/**
 * Edges that express dependence, and are therefore traversable.
 *
 * A contradiction is a finding about two claims, not a reason one of them is built from the
 * other, and a supersession replaces rather than supports. Following either during impact
 * analysis would report a document as stale because a rival claim disagreed with it.
 */
const DEPENDENCY_EDGES = new Set(['supports', 'derived-from', 'imports-context', 'implements', 'generated-by', 'verifies', 'affects-object']);

/** Review state. Only `reviewed` may answer a mandatory check or name an authority. */
export const CLAIM_STATUSES = Object.freeze(['proposed', 'reviewed']);

/** The value types a claim can carry. A date is a string with a declared format, later. */
const VALUE_TYPES = Object.freeze(['number', 'string', 'boolean']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.length > 0;

const normaliseText = (value) => String(value).normalize('NFKC').trim();

/**
 * One claim, validated. A record is refused rather than repaired: a claim missing its
 * subject is not a claim about everything.
 *
 * @returns {{claim?: object, problems?: string[]}}
 */
export function readClaim(input = {}) {
  const source = isObject(input) ? input : {};
  const problems = [];
  const identity = (key) => {
    if (!isText(source[key])) {
      problems.push(`${key} must be a non-empty string`);
      return null;
    }
    return normaliseText(source[key]);
  };
  const id = identity('id');
  const subject = identity('subject');
  const predicate = identity('predicate');
  const type = source.type;
  if (!VALUE_TYPES.includes(type)) problems.push(`type must be one of ${VALUE_TYPES.join(', ')}; an untyped value can unify with a different one`);

  let value = source.value;
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) problems.push('a number claim needs a finite number value');
  } else if (type === 'string') {
    if (!isText(value)) problems.push('a string claim needs a non-empty string value');
    else value = normaliseText(value);
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') problems.push('a boolean claim needs a boolean value');
  }

  let unit = null;
  if (source.unit !== undefined && source.unit !== null) {
    if (!isText(source.unit)) problems.push('unit must be a non-empty string when given');
    else unit = normaliseText(source.unit);
  }

  const evidence = source.evidence ?? [];
  if (!Array.isArray(evidence) || !evidence.every(isText)) problems.push('evidence must be a list of references');

  const status = source.status ?? 'proposed';
  if (!CLAIM_STATUSES.includes(status)) problems.push(`status must be one of ${CLAIM_STATUSES.join(', ')}`);

  const applicability = source.applicability ?? null;
  if (applicability !== null && !isObject(applicability)) problems.push('applicability must be an object when given');

  if (problems.length > 0) return { problems };
  return {
    claim: {
      id,
      subject,
      predicate,
      type,
      value,
      unit,
      applicability,
      evidence: evidence.map(normaliseText),
      status,
    },
  };
}

/**
 * What two claims must share to be the same assertion: subject, predicate, type, value and
 * unit. Applicability is carried beside the identity rather than inside it, because two
 * scopes of one claim are a question for the temporal model, not two claims.
 */
export function claimKey(record) {
  const unit = isText(record?.unit) ? normaliseText(record.unit).toLowerCase() : '';
  return [normaliseText(record?.subject ?? ''), normaliseText(record?.predicate ?? ''), record?.type, JSON.stringify(record?.value), unit].join('|');
}

/** Whether two records assert the same thing, at the strength the tool is willing to claim. */
export function sameClaim(left, right) {
  return claimKey(left) === claimKey(right);
}

/**
 * Group claims by identity.
 *
 * A group of more than one is the candidate set for a repeated assertion, never a silent
 * merge: the caller decides what a repeated assertion means, and a claim with a different
 * unit or type is in a different group.
 */
export function unifyClaims(claims = []) {
  const groups = new Map();
  for (const record of Array.isArray(claims) ? claims : []) {
    const key = claimKey(record);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => ({ key, claims: group }));
}

/** Explicit marker syntax, in an HTML comment so it survives rendering invisibly. */
const MARKER = /<!--\s*claim:(.*?)-->/;
const FIELD = /([a-z][a-z-]*)\s*=\s*("[^"]*"|\S+)/gi;
const MARKER_FIELDS = new Set(['id', 'subject', 'predicate', 'type', 'value', 'unit', 'evidence', 'status']);

/**
 * A marker's value, typed by its declared type or inferred deterministically.
 *
 * Inference is the fallback for a marker that states no type; it is still a decision the
 * record carries, so a `19` marker and a `"19"` one remain distinguishably typed.
 */
function parseMarkerValue(raw, type) {
  if (raw === undefined) return { value: undefined, type };
  if (type === 'number') return { value: Number(raw), type };
  if (type === 'boolean') return { value: raw === 'true' ? true : raw === 'false' ? false : raw, type };
  if (type === 'string') return { value: raw, type };
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return { value: Number(raw), type: 'number' };
  if (raw === 'true' || raw === 'false') return { value: raw === 'true', type: 'boolean' };
  return { value: raw, type: 'string' };
}

/**
 * The claims a document declares, and everything it did not.
 *
 * `unassessed` counts the non-empty lines that carry no marker. They are not claims and they
 * are not false; they are text this parser has no grounds to say anything about.
 *
 * @param {string} text
 * @param {{path?: string}} [options]
 * @returns {{version: number, path: string, claims: object[], problems: {line: number, message: string}[], unassessed: number}}
 */
export function extractClaims(text, { path = '' } = {}) {
  const source = typeof text === 'string' ? text : String(text ?? '');
  const claims = [];
  const problems = [];
  let unassessed = 0;

  source.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '') return;
    const marker = MARKER.exec(line);
    if (marker === null) {
      unassessed += 1;
      return;
    }
    const before = problems.length;
    const fields = {};
    FIELD.lastIndex = 0;
    let match;
    while ((match = FIELD.exec(marker[1])) !== null) {
      const key = match[1].toLowerCase();
      if (key === 'applicability') {
        problems.push({ line: index + 1, message: 'applicability is a claim record field, not a marker field' });
        continue;
      }
      if (!MARKER_FIELDS.has(key)) {
        problems.push({ line: index + 1, message: `unknown claim field \`${key}\`; a misspelt field is a claim nobody declared` });
        continue;
      }
      fields[key] = match[2].startsWith('"') ? match[2].slice(1, -1) : match[2];
    }

    const typed = parseMarkerValue(fields.value, fields.type);
    const read = readClaim({
      id: fields.id,
      subject: fields.subject,
      predicate: fields.predicate,
      type: typed.type,
      value: typed.value,
      unit: fields.unit,
      evidence: fields.evidence === undefined ? [] : fields.evidence.split(',').map((part) => part.trim()).filter(isText),
      status: fields.status,
    });
    if (read.problems) for (const message of read.problems) problems.push({ line: index + 1, message });
    // A marker with one bad field declares no claim: half of it would be an assertion
    // nobody wrote.
    else if (problems.length === before) claims.push(read.claim);
  });

  return { version: CLAIMS_SCHEMA_VERSION, path, claims, problems, unassessed };
}

/**
 * A graph of artifacts and claims, with the typed edges between them.
 *
 * An edge naming a node the graph does not have is a problem, not a node created on the way
 * past: a dependency on something absent is the unknown frontier, and inventing the far end
 * would report a chain as complete.
 */
export function buildClaimGraph({ artifacts = [], claims = [], edges = [] } = {}) {
  const nodes = new Map();
  const problems = [];
  const add = (id, kind, extra = {}) => {
    if (!isText(id) || !isText(kind)) {
      problems.push('a node needs a non-empty id and kind');
      return;
    }
    if (!nodes.has(id)) nodes.set(id, { id, kind, ...extra });
  };

  for (const artifact of Array.isArray(artifacts) ? artifacts : []) add(artifact?.id, artifact?.kind, artifact?.path === undefined ? {} : { path: artifact.path });
  for (const claim of Array.isArray(claims) ? claims : []) add(claim?.id, 'claim', { claim });

  const accepted = [];
  for (const edge of Array.isArray(edges) ? edges : []) {
    if (!EDGE_KINDS.includes(edge?.kind)) {
      problems.push(`edge kind ${JSON.stringify(edge?.kind)} is not one of ${EDGE_KINDS.join(', ')}`);
      continue;
    }
    const status = edge.status ?? 'proposed';
    if (!CLAIM_STATUSES.includes(status)) {
      problems.push(`edge status ${JSON.stringify(edge.status)} must be one of ${CLAIM_STATUSES.join(', ')}`);
      continue;
    }
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      problems.push(`edge ${edge.from} -${edge.kind}-> ${edge.to} names a node the graph does not have`);
      continue;
    }
    accepted.push({ from: edge.from, to: edge.to, kind: edge.kind, status });
  }

  return { version: CLAIMS_SCHEMA_VERSION, nodes: [...nodes.values()], edges: accepted, problems };
}

/** Which end of an edge is the dependent. `supports` is the one that reads backwards. */
function directionOf(edge) {
  return edge.kind === 'supports' ? { dependent: edge.to, dependency: edge.from } : { dependent: edge.from, dependency: edge.to };
}

function adjacencyOf(graph, { includeProposed }) {
  const forward = new Map();
  const backward = new Map();
  const push = (map, key, value) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  };
  for (const edge of graph.edges) {
    if (!DEPENDENCY_EDGES.has(edge.kind)) continue;
    if (edge.status !== 'reviewed' && includeProposed !== true) continue;
    const { dependent, dependency } = directionOf(edge);
    push(forward, dependent, { edge, next: dependency });
    push(backward, dependency, { edge, next: dependent });
  }
  return { forward, backward };
}

function walk(graph, root, { direction, includeProposed, limit }) {
  if (!graph.nodes.some((node) => node.id === root)) {
    return { root, unknown: true, reachable: [], edges: [], cycles: [], truncated: false };
  }
  const adjacency = adjacencyOf(graph, { includeProposed })[direction];
  const reachable = [];
  const followed = [];
  const seen = new Set();
  const onPath = new Set();
  const cycles = new Set();
  let truncated = false;

  const visit = (id) => {
    if (onPath.has(id)) {
      cycles.add(id);
      return;
    }
    if (seen.has(id)) return;
    if (seen.size >= limit) {
      truncated = true;
      return;
    }
    seen.add(id);
    onPath.add(id);
    reachable.push(id);
    for (const { edge, next } of adjacency.get(id) ?? []) {
      const key = `${edge.from}|${edge.kind}|${edge.to}|${edge.status}`;
      if (!followed.some((entry) => entry.key === key)) followed.push({ key, edge });
      visit(next);
    }
    onPath.delete(id);
  };

  visit(root);
  return { root, unknown: false, reachable, edges: followed.map((entry) => entry.edge), cycles: [...cycles].sort(), truncated };
}

/**
 * What this node is built from, transitively.
 *
 * @param {object} graph
 * @param {string} id
 * @param {{includeProposed?: boolean, limit?: number}} [options]
 */
export function lineage(graph, id, { includeProposed = false, limit = 128 } = {}) {
  return walk(graph, id, { direction: 'forward', includeProposed, limit });
}

/**
 * What depends on this node, transitively: the set a change here puts at risk.
 *
 * @param {object} graph
 * @param {string} id
 * @param {{includeProposed?: boolean, limit?: number}} [options]
 */
export function impact(graph, id, { includeProposed = false, limit = 128 } = {}) {
  return walk(graph, id, { direction: 'backward', includeProposed, limit });
}

/** The edges awaiting review: queryable, and skipped by every default traversal. */
export function proposedEdges(graph) {
  return graph.edges.filter((edge) => edge.status === 'proposed');
}
