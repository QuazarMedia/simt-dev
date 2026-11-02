// Artifact identity and scope resolution: which contract owns a path, and what a thing is.
//
// Two identity questions, both answered by declaration rather than by convention:
//
//   * A document's Markdown, its rendered HTML and its source manifest are one artifact.
//     That is only sayable if the artifact has an id of its own; a path is a location, and
//     a rename is not a new artifact when the id is explicit.
//   * A country tree is a scope, not a package. Scopes nest, so the most specific literal
//     path wins; a glob can decide between scopes that no literal reaches; and two scopes
//     of equal specificity are refused rather than ordered by an accident of listing.
//
// The third rule is the one a code-only view gets wrong: a `.py` helper under a document
// scope is still executable. Obligations are the union of what the scope says the artifact
// is and what its representation is, never the intersection.

/** Obligations a kind carries by itself. */
const KIND_OBLIGATIONS = {
  source: ['test', 'lint'],
  document: ['structure', 'links'],
  dataset: ['schema', 'provenance'],
  recipe: ['contract'],
  'remote-object': ['identity', 'postcondition'],
};

const EXECUTABLE = /\.(mjs|cjs|js|ts|py|sh|kt|kts|java)$/i;

function segmentsOf(path) {
  return path.split('/').filter((part) => part !== '' && part !== '.');
}

function isGlob(segment) {
  return /[*?[]/.test(segment);
}

/** Literal segments decide first; the glob is only a tie-break inside one scope. */
function specificity(prefix) {
  const parts = segmentsOf(prefix);
  return {
    literals: parts.filter((part) => !isGlob(part)).length,
    depth: parts.length,
    globs: parts.filter(isGlob).length,
  };
}

function prefixMatches(prefix, path) {
  const want = segmentsOf(prefix);
  const have = segmentsOf(path);
  if (want.length > have.length) return false;
  return want.every((part, index) => (isGlob(part) ? globSegment(part, have[index]) : part === have[index]));
}

/** One segment of a glob, with the two wildcards path declarations actually use. */
function globSegment(pattern, value) {
  const source = pattern
    .split('')
    .map((char) => {
      if (char === '*') return '[^/]*';
      if (char === '?') return '[^/]';
      return char.replace(/[.+^${}()|\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${source}$`).test(value);
}

/**
 * The scope that owns a path, or why no single scope does.
 *
 * @returns {{scope: string|null, error?: {kind: 'conflict'|'none', candidates: string[]}}}
 */
export function resolveScope(scopes, path) {
  const matches = scopes.filter((scope) => (scope.paths ?? []).some((prefix) => prefixMatches(prefix, path)));
  if (matches.length === 0) return { scope: null, error: { kind: 'none', candidates: [] } };
  const scored = matches.map((scope) => {
    const prefixes = scope.paths.filter((prefix) => prefixMatches(prefix, path));
    // A scope is as specific as the most specific of its own prefixes.
    const best = prefixes
      .map(specificity)
      .sort((a, b) => b.literals - a.literals || a.globs - b.globs || b.depth - a.depth)[0];
    return { id: scope.id, ...best };
  });
  // Literals first, then the fewer wildcards, then depth: a scope that names a literal
  // tree outranks one reaching the same path through a glob, and only two literal scopes
  // are compared by how much of the path they name.
  scored.sort((a, b) => b.literals - a.literals || a.globs - b.globs || b.depth - a.depth);
  const [winner, runnerUp] = scored;
  if (runnerUp !== undefined && runnerUp.literals === winner.literals && runnerUp.globs === winner.globs && runnerUp.depth === winner.depth) {
    const candidates = scored
      .filter((row) => row.literals === winner.literals && row.depth === winner.depth && row.globs === winner.globs)
      .map((row) => row.id);
    return { scope: null, error: { kind: 'conflict', candidates } };
  }
  return { scope: winner.id };
}

/**
 * A stable id for an artifact.
 *
 * An explicit id wins and survives a rename; without one, the id is the path plus the
 * anchor, and a rename is a new id unless the repository records the mapping. Saying that
 * plainly is better than a heuristic that guesses two paths are the same document.
 */
export function artifactId({ path, anchor = null, explicitId = undefined, renames = {} }) {
  if (typeof explicitId === 'string' && explicitId !== '') return explicitId;
  if (Object.hasOwn(renames, path)) return renames[path];
  return anchor === null ? path : `${path}#${anchor}`;
}

/** A remote object is never identified by its display name alone. */
export function remoteIdentity({ namespace, type, id } = {}) {
  const missing = ['namespace', 'type', 'id'].filter((key) => typeof { namespace, type, id }[key] !== 'string' || { namespace, type, id }[key] === '');
  if (missing.length > 0) return { error: `remote identity needs ${missing.join(', ')}; a display name is not an identity` };
  return { id: `${namespace}:${type}:${id}` };
}

/**
 * What must hold for an artifact: the scope's kind plus the representation's own demands.
 *
 * The union matters for the case that motivated the slice: a script under a document scope
 * keeps `execute` alongside `structure`, because it really does run.
 */
export function obligationsFor({ kind, path }) {
  const obligations = [...(KIND_OBLIGATIONS[kind] ?? [])];
  if (EXECUTABLE.test(path)) obligations.push('execute');
  return obligations;
}

/** Join representations that share an explicit artifact id. */
export function joinRepresentations(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    const id = entry.id;
    if (!grouped.has(id)) grouped.set(id, { id, representations: [] });
    grouped.get(id).representations.push({ path: entry.path, mediaType: entry.mediaType ?? null });
  }
  return [...grouped.values()].map((artifact) => ({
    ...artifact,
    representations: artifact.representations.sort((a, b) => a.path.localeCompare(b.path)),
  }));
}
