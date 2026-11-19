// Native metadata: what a document already says about itself, and what it points at.
//
// A repository that has a handbook already writes frontmatter, and a
// repository that generates its documents already keeps sidecars. The slice reads what is
// there rather than asking for a second catalogue, and the rules that keep it honest are:
//
//   * Only the keys this reader knows are interpreted. Unrelated frontmatter (`draft`,
//     `tags`) belongs to the document's own tooling and is left alone; a *known* key whose
//     value this subset cannot read is reported, because silently ignoring it would make the
//     artifact say something the document does not.
//   * Identity is declared, never inferred. A frontmatter `id` travels with the file, and a
//     path map in `.simt/knowledge/identities.json` covers the files that cannot carry one.
//     `artifactId` already knows both, so a move keeps the id only where someone said so.
//   * Document sections are evidence, and only a claim a maintainer marked `reviewed` is a
//     reviewed claim. A reviewed document does not make its markers reviewed: the claim says
//     its own status, and this module does not upgrade it.
//   * Applicability is carried, not judged. A document's dates become the claim's
//     applicability record only when both ends of the pair are declared; the temporal answer
//     is `applicableClaims`' job, and a claim without dates says it has no window.
//   * A missing source and a proposed link are different findings. One is a reference that
//     does not resolve, the other resolves but is not yet the document's own claim, and a
//     reader that merged them would report a suggestion as lineage.
//
// Dates are validated by the same predicate `readApplicability` uses, so a metadata date and
// a claim's window cannot disagree about what an ISO day is.

import { parseFrontmatter } from '../text/frontmatter.mjs';
import { artifactId, normalizePath } from '../work/artifacts.mjs';
import { SCOPE_FIELDS, isIsoDay } from './validity.mjs';
import { extractClaims } from './claims.mjs';

// The finding codes a reader of this module may see: `unsupported-schema`, `invalid-date`,
// `duplicate-id`, `ambiguous-scope`, `proposed-link`, `invalid-sidecar`, `invalid-claim`,
// `unresolved-source` and `uncertain-anchor`. They are separate answers on purpose - the
// acceptance for this slice is that a reader can tell them apart.

/** The conventional identity file: authored, tracked, and read by the same reader as `check`. */
export const IDENTITY_FILE = '.simt/knowledge/identities.json';

/** Every frontmatter or sidecar key this reader interprets. Everything else is the document's. */
export const METADATA_KEYS = Object.freeze(['id', 'type', 'scope', 'language', 'authority', 'validFrom', 'validTo', 'knownAt', 'sources']);

export const AUTHORITIES = Object.freeze(['declared', 'reviewed']);

export const ARTIFACT_TYPES = Object.freeze(['document', 'requirement', 'procedure', 'template', 'source', 'dataset', 'remote-object']);

/** The type a work scope's kind implies, so a document needs no `type` when its scope says it. */
export const KIND_TYPES = Object.freeze({ document: 'document', recipe: 'procedure', source: 'source', dataset: 'dataset', 'remote-object': 'remote-object' });

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.length > 0;

function problem(code, path, field, message, remedy) {
  return { code, path, field, message, remedy };
}

/**
 * One inline value as this subset reads it.
 *
 * A value that starts like JSON is parsed as JSON, which is how a scope or a source object is
 * written without a YAML parser. Anything else is text. A shape the subset cannot read is an
 * error rather than the string it looked like.
 *
 * @returns {{value?: unknown, error?: string}}
 */
function inlineValue(raw) {
  const text = raw.trim();
  if (text === '') return { value: '' };
  if (text === '|' || text === '>' || text.startsWith('&') || text.startsWith('*')) {
    return { error: 'block scalars, anchors and aliases are not part of the subset this reader knows' };
  }
  if (text.startsWith('{') || text.startsWith('[') || text.startsWith('"')) {
    try {
      return { value: JSON.parse(text) };
    } catch {
      return { error: `${JSON.stringify(text)} starts like JSON and does not parse` };
    }
  }
  return { value: text };
}

/**
 * The known keys of a frontmatter block.
 *
 * Line-based on purpose: the subset is `key: value`, an inline JSON value, and a `- item`
 * list. A known key written as a nested block is reported with the line it starts on, and an
 * unknown key is skipped without a finding.
 *
 * @param {string|null} front the block's interior, as `parseFrontmatter` returns it
 * @param {{path?: string}} [options]
 * @returns {{fields: Map<string, unknown>, problems: object[]}}
 */
export function parseMetadataFrontmatter(front, { path = '' } = {}) {
  const fields = new Map();
  const problems = [];
  if (typeof front !== 'string') return { fields, problems };

  const lines = front.split(/\r?\n/);
  let open = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item !== null && open !== null) {
      const parsed = inlineValue(item[1]);
      if (parsed.error !== undefined) problems.push(problem('unsupported-schema', path, open, `${open}: ${parsed.error}`, 'write the item as text, or as inline JSON'));
      else if (Array.isArray(fields.get(open))) fields.get(open).push(parsed.value);
      continue;
    }
    if (/^\s/.test(line)) {
      if (open !== null) {
        problems.push(problem('unsupported-schema', path, open, `${open} is written as a nested block, and this reader knows a scalar or a list`, `write ${open} as \`${open}: value\` or a \`- item\` list`));
      }
      open = null;
      continue;
    }

    const pair = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    open = null;
    if (pair === null) continue;
    const [name, rest] = [pair[1], pair[2]];
    if (!METADATA_KEYS.includes(name)) continue;
    const parsed = inlineValue(rest);
    if (parsed.error !== undefined) {
      problems.push(problem('unsupported-schema', path, name, `${name}: ${parsed.error}`, `write ${name} as a value this reader can read`));
      continue;
    }
    if (parsed.value === '') {
      fields.set(name, []);
      open = name;
      continue;
    }
    fields.set(name, parsed.value);
  }
  return { fields, problems };
}

/**
 * The known keys of a sidecar, which is JSON and exists only for this reader.
 *
 * Unlike a document's frontmatter, a key this reader does not know in a `.meta.json` file is
 * a mistake: the file was written for this purpose, so a misspelt field is a field nobody
 * declared.
 *
 * @param {string} text
 * @param {{path?: string}} [options]
 * @returns {{fields: Map<string, unknown>, problems: object[]}}
 */
function readSidecarDocument(text, { path = '' } = {}) {
  const fields = new Map();
  const file = `${path}.meta.json`;
  let doc;
  try {
    doc = JSON.parse(String(text));
  } catch (error) {
    return { fields, problems: [problem('invalid-sidecar', path, null, `${file} is not JSON: ${error.message}`, 'fix the JSON, or remove the sidecar')] };
  }
  if (!isObject(doc)) {
    return { fields, problems: [problem('invalid-sidecar', path, null, `${file} must hold an object`, 'write the fields in an object')] };
  }
  const problems = [];
  for (const [key, value] of Object.entries(doc)) {
    if (METADATA_KEYS.includes(key)) fields.set(key, value);
    else problems.push(problem('unsupported-schema', path, key, `${file} carries \`${key}\`, which is not a field this reader knows`, `known fields: ${METADATA_KEYS.join(', ')}`));
  }
  return { fields, problems };
}

/** The work scope that owns a path, or null. Literal and glob paths are both the declaration's. */
function owningScope(scopes, path) {
  const list = Array.isArray(scopes) ? scopes : [];
  return list.find((scope) => (Array.isArray(scope?.paths) ? scope.paths : []).some((prefix) => {
    const base = normalizePath(prefix);
    return base !== null && (base === '' || path === base || path.startsWith(`${base}/`));
  })) ?? null;
}

/** One declared source reference, as text or as an object. */
function readRef(entry, { path, problems }) {
  const fields = typeof entry === 'string' ? { ref: entry } : isObject(entry) ? entry : null;
  if (fields === null) {
    problems.push(problem('unsupported-schema', path, 'sources', 'a source must be a reference string or an object', 'write "docs/page.md#anchor" or {path, anchor, type}'));
    return null;
  }
  const raw = isText(fields.ref) ? fields.ref : isText(fields.path) ? fields.path : null;
  if (raw === null) {
    problems.push(problem('unsupported-schema', path, 'sources', 'a source object needs a ref or a path', 'name the file the reference points at'));
    return null;
  }
  const [beforeHash] = raw.split('#');
  const anchor = isText(fields.anchor) ? fields.anchor : raw.includes('#') ? raw.slice(raw.indexOf('#') + 1) : null;
  const target = normalizePath(beforeHash);
  if (target === null) {
    problems.push(problem('unsupported-schema', path, 'sources', `${JSON.stringify(raw)} is not a repository-relative reference`, 'a reference names a file this repository owns'));
    return null;
  }
  return {
    ref: raw,
    from: path,
    path: target,
    anchor: anchor === '' ? null : anchor,
    type: isText(fields.type) ? fields.type : null,
    proposed: fields.proposed === true,
  };
}

/**
 * The declared metadata of one document, validated.
 *
 * @param {Map<string, unknown>} fields
 * @param {{path?: string, scopes?: object[]}} [options]
 * @returns {{metadata: object, problems: object[]}}
 */
export function readMetadata(fields, { path = '', scopes = [] } = {}) {
  const problems = [];
  const metadata = {
    id: null,
    type: null,
    scope: null,
    language: null,
    authority: 'declared',
    validFrom: null,
    validTo: null,
    knownAt: null,
    sources: [],
  };
  const text = (key) => {
    const value = fields.get(key);
    if (value === undefined) return null;
    if (!isText(value)) {
      problems.push(problem('unsupported-schema', path, key, `${key} must be a non-empty string`, `write ${key} as text`));
      return null;
    }
    return value.trim();
  };

  metadata.id = text('id');
  metadata.language = text('language');
  const type = text('type');
  if (type !== null) {
    if (ARTIFACT_TYPES.includes(type)) metadata.type = type;
    else problems.push(problem('unsupported-schema', path, 'type', `type must be one of ${ARTIFACT_TYPES.join(', ')}`, 'write the artifact type, or omit it to let the work scope decide'));
  }
  const authority = text('authority');
  if (authority !== null) {
    if (AUTHORITIES.includes(authority)) metadata.authority = authority;
    else problems.push(problem('unsupported-schema', path, 'authority', `authority must be one of ${AUTHORITIES.join(', ')}`, 'say whether the document is reviewed, or omit it'));
  }

  const scope = fields.get('scope');
  if (scope !== undefined) {
    if (!isObject(scope)) {
      problems.push(problem('ambiguous-scope', path, 'scope', `scope must name its ${SCOPE_FIELDS.join('/')}, not ${JSON.stringify(scope)}`, `write {"${SCOPE_FIELDS[0]}": "..."}; a bare value is a scope nobody can compare`));
    } else {
      const clean = {};
      for (const [key, value] of Object.entries(scope)) {
        if (!SCOPE_FIELDS.includes(key)) problems.push(problem('ambiguous-scope', path, 'scope', `scope.${key} is not one of ${SCOPE_FIELDS.join(', ')}`, `write one of ${SCOPE_FIELDS.join(', ')}`));
        else if (!isText(value)) problems.push(problem('ambiguous-scope', path, 'scope', `scope.${key} must be a non-empty string`, 'name the value the scope holds'));
        else clean[key] = value;
      }
      metadata.scope = Object.keys(clean).length > 0 ? clean : null;
    }
    // A declared scope for a path no work scope owns is a scope the build cannot place.
    if (metadata.scope !== null && Array.isArray(scopes) && scopes.length > 0 && owningScope(scopes, path) === null) {
      problems.push(problem('ambiguous-scope', path, 'scope', `${path} declares a scope, and no work scope owns its path`, 'declare the path in a work scope, or remove the metadata scope'));
    }
  }

  for (const key of ['validFrom', 'validTo', 'knownAt']) {
    const value = fields.get(key);
    if (value === undefined) continue;
    if (!isIsoDay(value)) {
      problems.push(problem('invalid-date', path, key, `${key} must be an ISO date (YYYY-MM-DD), not ${JSON.stringify(value)}`, 'write the day the value applies from, applies to, or was known on'));
      continue;
    }
    metadata[key] = value;
  }
  if (metadata.validFrom !== null && metadata.validTo !== null && metadata.validTo <= metadata.validFrom) {
    problems.push(problem('invalid-date', path, 'validTo', `validTo (${metadata.validTo}) must be after validFrom (${metadata.validFrom}); the interval is half-open`, 'move validTo past validFrom'));
  }

  const sources = fields.get('sources');
  if (sources !== undefined) {
    if (!Array.isArray(sources)) problems.push(problem('unsupported-schema', path, 'sources', 'sources must be a list', 'write a `- reference` list'));
    else for (const entry of sources) {
      const ref = readRef(entry, { path, problems });
      if (ref !== null) metadata.sources.push(ref);
    }
  }
  return { metadata, problems };
}

/**
 * The applicability a document's own dates give its claims, or null.
 *
 * Both ends are required: an effective start with no recording date cannot answer "what was
 * known", and `readApplicability` says so by refusing the record. Nothing here fills a date in.
 */
function claimApplicability(metadata = {}) {
  if (!isIsoDay(metadata.validFrom) || !isIsoDay(metadata.knownAt)) return null;
  return {
    validFrom: metadata.validFrom,
    validTo: isIsoDay(metadata.validTo) ? metadata.validTo : null,
    recordedFrom: metadata.knownAt,
    recordedTo: null,
    revision: null,
    scope: isObject(metadata.scope) ? { ...metadata.scope } : {},
    supersedes: [],
  };
}

/**
 * One document's artifact: identity, declared shape and dates, its claims and its references.
 *
 * @param {{path: string, text?: string, scopes?: object[], identities?: object, sidecar?: string|null}} input
 * @returns {{artifact: object, refs: object[], problems: object[]}}
 */
export function describeArtifact({ path, text = '', scopes = [], identities = {}, sidecar = null } = {}) {
  const { front, body } = parseFrontmatter(text);
  const head = parseMetadataFrontmatter(front, { path });
  const tail = sidecar === null ? { fields: new Map(), problems: [] } : readSidecarDocument(sidecar, { path });
  const fields = new Map([...head.fields, ...tail.fields]);
  const { metadata, problems: declared } = readMetadata(fields, { path, scopes });

  const problems = [...head.problems, ...tail.problems, ...declared];
  const extracted = extractClaims(body, { path });
  for (const entry of extracted.problems) {
    problems.push(problem('invalid-claim', path, `line ${entry.line}`, `${entry.message}`, 'fix the marker, or remove it; a half-read claim is an assertion nobody made'));
  }

  const applicability = claimApplicability(metadata);
  const claims = extracted.claims.map((claim) => ({
    ...claim,
    path,
    applicability,
    // The claim says its own status. A reviewed document does not review its markers.
    authority: claim.status === 'reviewed' ? 'reviewed' : 'proposed',
  }));

  const scope = owningScope(scopes, path);
  const id = artifactId({ path, anchor: null, explicitId: metadata.id ?? undefined, renames: identities });
  const artifact = {
    id,
    path,
    type: metadata.type ?? (isText(scope?.kind) ? KIND_TYPES[scope.kind] ?? 'document' : 'document'),
    language: metadata.language,
    authority: metadata.authority,
    scope: metadata.scope,
    validFrom: metadata.validFrom,
    validTo: metadata.validTo,
    knownAt: metadata.knownAt,
    applicability,
    sources: [],
    claims,
    declared: metadata.id !== null || metadata.type !== null || metadata.scope !== null || metadata.language !== null || metadata.validFrom !== null || metadata.knownAt !== null || metadata.sources.length > 0,
  };
  // The extractor must see the body, not the metadata: a `---` underline turns `id: x` into a
  // setext heading, and a corpus that indexed its own frontmatter would cite a section called
  // `id-x`. The offset is how a unit of the body still names bytes of the file.
  const removed = text.slice(0, text.length - body.length);
  const offset = { bytes: Buffer.byteLength(removed, 'utf8'), lines: (removed.match(/\n/g) ?? []).length };
  return { artifact, refs: metadata.sources, problems, body, offset };
}

/**
 * Resolve declared references against what this build indexes.
 *
 * A reference that does not resolve, one that names a section the target does not have, and a
 * proposed reference are three different findings, and each keeps the reference it came from
 * so the reader can open it.
 *
 * @param {object[]} refs
 * @param {{paths?: Set<string>, anchorsOf?: (path: string) => Set<string>}} [options]
 * @returns {{sources: object[], problems: object[]}}
 */
export function resolveRefs(refs = [], { paths = new Set(), anchorsOf = () => new Set() } = {}) {
  const problems = [];
  const sources = refs.map((ref) => {
    const exists = paths.has(ref.path);
    const anchorFound = exists && (ref.anchor === null || anchorsOf(ref.path).has(ref.anchor));
    if (!exists) {
      problems.push(problem('unresolved-source', ref.from, 'sources', `${ref.ref} names ${ref.path}, which this corpus does not index`, 'fix the reference, or declare the target in a work scope'));
    } else if (!anchorFound) {
      problems.push(problem('uncertain-anchor', ref.from, 'sources', `${ref.ref} names a section ${ref.path} does not have`, 'name an anchor the target document carries, or drop the fragment'));
    } else if (ref.proposed === true) {
      problems.push(problem('proposed-link', ref.from, 'sources', `${ref.ref} is marked proposed`, 'review the reference and remove "proposed" when the document really rests on it'));
    }
    return { ...ref, exists, anchorFound };
  });
  return { sources, problems };
}

/**
 * The identity file: which path is cited as which artifact id.
 *
 * The map is the explicit answer to "this file moved, and it is still the same artifact".
 * Frontmatter `id` covers a document that can carry one; this covers the rest, and both are
 * polished by the same `artifactId`.
 *
 * @param {unknown} doc
 * @returns {{paths: {path: string, id: string}[], problems: object[]}}
 */
export function readIdentityMap(doc) {
  const paths = [];
  if (!isObject(doc)) {
    return { paths, problems: [problem('unsupported-schema', IDENTITY_FILE, null, 'the identity file must hold an object', 'write {"paths": {"docs/page.md": "handbook.page"}}')] };
  }
  const problems = [];
  for (const key of Object.keys(doc)) {
    if (key !== 'paths') problems.push(problem('unsupported-schema', IDENTITY_FILE, key, `\`${key}\` is not a key this reader knows`, 'the identity file carries only "paths"'));
  }
  if (!isObject(doc.paths)) {
    problems.push(problem('unsupported-schema', IDENTITY_FILE, 'paths', 'the identity file needs a "paths" object', 'write {"paths": {"docs/page.md": "handbook.page"}}'));
    return { paths, problems };
  }

  const seen = new Map();
  for (const [raw, id] of Object.entries(doc.paths)) {
    const path = normalizePath(raw);
    if (path === null) {
      problems.push(problem('unsupported-schema', IDENTITY_FILE, raw, `${JSON.stringify(raw)} is not a repository-relative path`, 'map a path the repository owns'));
      continue;
    }
    if (!isText(id)) {
      problems.push(problem('unsupported-schema', IDENTITY_FILE, raw, `the id for ${path} must be a non-empty string`, 'give the artifact the id it is cited by'));
      continue;
    }
    paths.push({ path, id: id.trim() });
    const list = seen.get(id.trim()) ?? [];
    list.push(path);
    seen.set(id.trim(), list);
  }
  for (const [id, list] of seen) {
    if (list.length > 1) problems.push(problem('duplicate-id', IDENTITY_FILE, id, `id \`${id}\` is mapped from ${list.sort().join(', ')}`, 'one id names one artifact; give each path its own id'));
  }
  return { paths, problems };
}

/** The path-to-id map `artifactId` takes, from the entries `readIdentityMap` returns. */
export function identityMap(entries = []) {
  const map = {};
  for (const entry of entries) map[entry.path] = entry.id;
  return map;
}
