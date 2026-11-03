// Source observations: what was fetched, when, and from what it has changed.
//
// Retrieval that notices a change is useful; retrieval that turns into a crawler is not.
// So the two halves are separate. An observation is a record an adapter produced: an
// allowlisted source, the instant it was fetched, a digest of the representation, the
// source's own revision, the content scope and whether it parsed. A refresh is a *plan* -
// a method, a URL, conditional headers and a budget - that a separate, opt-in executor may
// carry out. Nothing in this module opens a socket, and the offline paths (`brief`, `check`,
// hooks) never reach it.
//
// Three failures it exists to prevent:
//
//   * A cosmetic change reported as an operative one. Line endings and trailing spaces are
//     normalized only by a canonicalizer with a reviewed id and version; the record keeps
//     the raw digest beside the canonical one, so "unchanged" is a bounded statement about
//     a named normalizer rather than about the bytes.
//   * A failed refresh reported as fresh. A transport failure or a non-200, non-304 status
//     returns `unknown`, not the previous observation silently reused.
//   * A source URL that reaches the machine it runs on. Schemes, ports, credentials, private
//     addresses and hosts outside the declared allowlist are refused before a request is
//     planned, and a redirect target is checked as strictly as the first hop.

import { createHash } from 'node:crypto';

export const OBSERVATION_SCHEMA_VERSION = 1;

/** What a refresh may conclude about the source. Nothing here is a pass. */
export const CHANGES = Object.freeze(['changed', 'unchanged', 'not-modified', 'unknown']);

/** Whether the content was read at all. */
export const PARSE_STATUSES = Object.freeze(['parsed', 'unsupported', 'failed']);

/** Freshness is a state with an explicit clock, not a boolean. */
export const FRESHNESS_STATES = Object.freeze(['fresh', 'stale', 'unknown']);

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DIGEST = /^sha256-[0-9a-f]{64}$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.length > 0;
const isInstant = (value) => typeof value === 'string' && INSTANT.test(value);

/**
 * Reviewed canonicalizers, by id and version.
 *
 * The normalizer may only undo things that carry no meaning: a BOM, a line-ending
 * convention, trailing horizontal whitespace. It must not touch anything inside a line,
 * because that is where an amount, a date or a unit lives, and collapsing the space in
 * `19 %` would change a value the document is about.
 */
const CANONICALIZERS = new Map([
  [
    'line-endings-v1',
    {
      version: 1,
      apply: (text) =>
        text
          .replace(/^\uFEFF/, '')
          .replace(/\r\n?/g, '\n')
          .split('\n')
          .map((line) => line.replace(/[ \t]+$/, ''))
          .join('\n'),
    },
  ],
]);

export const CANONICALIZER_IDS = Object.freeze([...CANONICALIZERS.keys()]);

/** A content digest in one spelling, so two records can be compared without parsing them. */
export function digestOf(text) {
  return `sha256-${createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')}`;
}

/**
 * Normalize a representation, if a reviewed canonicalizer is named.
 *
 * @param {string} text
 * @param {{canonicalizer?: {id: string, version: number}|null}} [options]
 * @returns {{text: string, digest: string, rawDigest: string, canonicalizer: object|null}}
 */
export function canonicalize(text, { canonicalizer = null } = {}) {
  const source = typeof text === 'string' ? text : String(text ?? '');
  const rawDigest = digestOf(source);
  if (canonicalizer === null || canonicalizer === undefined) {
    return { text: source, digest: rawDigest, rawDigest, canonicalizer: null };
  }
  const entry = CANONICALIZERS.get(canonicalizer.id);
  if (entry === undefined) {
    throw new Error(`canonicalizer ${JSON.stringify(canonicalizer.id)} is not one of ${CANONICALIZER_IDS.join(', ')}; a cosmetic normalizer is applied only after it was reviewed`);
  }
  if (canonicalizer.version !== entry.version) {
    throw new Error(`canonicalizer ${canonicalizer.id} is version ${entry.version}, not ${JSON.stringify(canonicalizer.version)}`);
  }
  const normalised = entry.apply(source);
  return { text: normalised, digest: digestOf(normalised), rawDigest, canonicalizer: { id: canonicalizer.id, version: entry.version } };
}

/**
 * One observation of a source, validated where it is written.
 *
 * @returns {{observation?: object, problems?: string[]}}
 */
export function readObservation(input = {}) {
  const source = isObject(input) ? input : {};
  const problems = [];

  if (!isText(source.source)) problems.push('source must be a non-empty reference');
  if (!isInstant(source.fetchedAt)) problems.push(`fetchedAt must be an ISO instant (YYYY-MM-DDTHH:MM:SSZ), not ${JSON.stringify(source.fetchedAt)}`);
  if (source.digest !== undefined && source.digest !== null && !DIGEST.test(source.digest)) {
    problems.push('digest must be sha256-<64 hex> when given');
  }
  if (source.revision !== undefined && source.revision !== null && !isText(source.revision)) problems.push('revision must be a non-empty string when given');
  const parseStatus = source.parseStatus ?? 'parsed';
  if (!PARSE_STATUSES.includes(parseStatus)) problems.push(`parseStatus must be one of ${PARSE_STATUSES.join(', ')}`);

  let canonicalizer = null;
  if (source.canonicalizer !== undefined && source.canonicalizer !== null) {
    const entry = CANONICALIZERS.get(source.canonicalizer.id);
    if (entry === undefined) problems.push(`canonicalizer must be one of ${CANONICALIZER_IDS.join(', ')}`);
    else if (source.canonicalizer.version !== entry.version) problems.push(`canonicalizer ${source.canonicalizer.id} is version ${entry.version}`);
    else canonicalizer = { id: source.canonicalizer.id, version: entry.version };
  }

  let scope = null;
  if (source.scope !== undefined && source.scope !== null) {
    if (!isObject(source.scope) || !Number.isInteger(source.scope.start) || !Number.isInteger(source.scope.end) || source.scope.start < 0 || source.scope.end < source.scope.start) {
      problems.push('scope must be a byte range {start, end} with 0 <= start <= end');
    } else scope = { start: source.scope.start, end: source.scope.end };
  }

  if (problems.length > 0) return { problems };
  return {
    observation: {
      version: OBSERVATION_SCHEMA_VERSION,
      source: source.source,
      fetchedAt: source.fetchedAt,
      digest: source.digest ?? null,
      revision: source.revision ?? null,
      parseStatus,
      canonicalizer,
      scope,
    },
  };
}

/** A host this tool refuses to reach, whatever the allowlist says. */
function privateReason(host) {
  const name = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local') || name.endsWith('.internal')) return `host ${host} is a private destination`;
  if (name === '::1' || name === '::' || name.startsWith('fc') || name.startsWith('fd') || name.startsWith('fe80')) return `host ${host} is a private destination`;
  const octets = name.split('.');
  if (octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part))) {
    const [a, b] = octets.map(Number);
    if (a === 0 || a === 10 || a === 127) return `host ${host} is a private destination`;
    if (a === 169 && b === 254) return `host ${host} is a private destination`;
    if (a === 172 && b >= 16 && b <= 31) return `host ${host} is a private destination`;
    if (a === 192 && b === 168) return `host ${host} is a private destination`;
    if (a === 100 && b >= 64 && b <= 127) return `host ${host} is a private destination`;
  }
  return null;
}

/**
 * Whether a refresh may address this destination at all.
 *
 * @param {string} url
 * @param {{allowlist?: string[], schemes?: string[], maxRedirects?: number}} [policy]
 * @returns {{ok: boolean, url?: string, reason?: string}}
 */
export function checkDestination(url, policy = {}) {
  const schemes = Array.isArray(policy.schemes) && policy.schemes.length > 0 ? policy.schemes : ['https'];
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return { ok: false, reason: `${JSON.stringify(url)} is not a URL` };
  }
  const scheme = parsed.protocol.replace(':', '');
  if (!schemes.includes(scheme)) return { ok: false, reason: `scheme ${scheme} is not one of ${schemes.join(', ')}` };
  if (parsed.username !== '' || parsed.password !== '') return { ok: false, reason: 'a source URL may not carry credentials' };

  const host = parsed.hostname.toLowerCase();
  const refused = privateReason(host);
  if (refused !== null) return { ok: false, reason: refused };

  const allowlist = (Array.isArray(policy.allowlist) ? policy.allowlist : []).map((entry) => String(entry).toLowerCase()).filter(isText);
  if (allowlist.length === 0) return { ok: false, reason: 'no allowlist is declared, so no destination is allowed' };
  // A suffix match, not a substring one: `evil-example.org` must not pass for `example.org`.
  if (!allowlist.some((entry) => host === entry || host.endsWith(`.${entry}`))) {
    return { ok: false, reason: `host ${host} is not in the declared allowlist` };
  }
  if (parsed.port !== '' && parsed.port !== '443') return { ok: false, reason: `port ${parsed.port} is not the declared 443` };
  return { ok: true, url: parsed.toString() };
}

/**
 * A redirect target is a destination too, and the hop budget is finite.
 *
 * @param {string} to
 * @param {object} policy
 * @param {{hops?: number}} [options]
 */
export function checkRedirect(to, policy = {}, { hops = 0 } = {}) {
  const maxRedirects = Number.isInteger(policy.maxRedirects) ? policy.maxRedirects : 0;
  if (hops >= maxRedirects) return { ok: false, reason: `the redirect budget of ${maxRedirects} is exhausted` };
  return checkDestination(to, policy);
}

/**
 * What a refresh would send, and why it may not.
 *
 * The plan is data: no request is made here, and a caller that never invokes an executor
 * never reaches the network.
 *
 * @param {object|null} previous an observation record, or `{source, revision}`
 * @param {{allowlist?: string[], maxRequests?: number, maxBytes?: number, maxRedirects?: number, schemes?: string[]}} [policy]
 * @param {{fetchedAt?: string|null}} [options]
 */
export function planRefresh(previous = null, policy = {}, { fetchedAt = null } = {}) {
  const refusals = [];
  const destination = isObject(previous) && isText(previous.source) ? checkDestination(previous.source, policy) : { ok: false, reason: 'there is no source to refresh' };
  if (!destination.ok) refusals.push(destination.reason);

  const maxRequests = Number.isInteger(policy.maxRequests) ? policy.maxRequests : 1;
  const maxBytes = Number.isInteger(policy.maxBytes) ? policy.maxBytes : 0;
  if (maxRequests < 1) refusals.push('the request budget is exhausted');
  if (maxBytes < 1) refusals.push('the byte budget is exhausted');

  const headers = {};
  if (isText(previous?.revision)) headers['if-none-match'] = previous.revision;

  return {
    allowed: refusals.length === 0,
    refusals,
    fetchedAt,
    request: {
      method: 'GET',
      url: destination.url ?? (isText(previous?.source) ? previous.source : null),
      headers,
      budget: { requests: maxRequests, bytes: maxBytes },
    },
  };
}

/**
 * What a response means for the record.
 *
 * A 304 is the source saying "still the revision you have": the content revision is
 * retained and only the observation is new. A transport failure produces no observation at
 * all, because nothing was observed - and the answer is `unknown`, never the previous
 * record quietly standing in for a fresh read.
 *
 * @param {object|null} previous
 * @param {{status?: number, body?: string, revision?: string|null, error?: string}} response
 * @param {{fetchedAt?: string, policy?: object}} [options]
 */
export function applyResponse(previous, response = {}, { fetchedAt = null, policy = {} } = {}) {
  if (isText(response.error)) return { changed: 'unknown', observation: null, reason: `transport failure: ${response.error}` };
  if (!isInstant(fetchedAt)) throw new Error('fetchedAt must be an ISO instant (YYYY-MM-DDTHH:MM:SSZ): an observation needs the clock it was made on');

  if (response.status === 304) {
    if (!isObject(previous)) return { changed: 'unknown', observation: null, reason: 'the source reports no change but nothing was observed before' };
    return {
      changed: 'not-modified',
      observation: { ...previous, fetchedAt },
      reason: 'the source reports no change; the content revision is retained and only the observation is new',
    };
  }
  if (response.status !== 200) {
    return { changed: 'unknown', observation: null, reason: `status ${JSON.stringify(response.status)} is not an observation of content` };
  }

  const canonical = canonicalize(response.body ?? '', { canonicalizer: policy.canonicalizer ?? previous?.canonicalizer ?? null });
  const observation = {
    version: OBSERVATION_SCHEMA_VERSION,
    source: previous?.source ?? response.source ?? null,
    fetchedAt,
    digest: canonical.digest,
    rawDigest: canonical.rawDigest,
    revision: response.revision ?? null,
    parseStatus: 'parsed',
    canonicalizer: canonical.canonicalizer,
    scope: previous?.scope ?? null,
  };
  const changed = isObject(previous) && previous.digest === canonical.digest ? 'unchanged' : 'changed';
  return {
    changed,
    observation,
    reason:
      changed === 'unchanged'
        ? `the representation digest did not change${canonical.canonicalizer === null ? '' : ` under canonicalizer ${canonical.canonicalizer.id}`}`
        : 'the representation digest changed',
  };
}

/**
 * Whether a record is fresh, judged against a clock the caller supplies.
 *
 * @param {object|null} record
 * @param {{now: string, maxAgeSeconds?: number}} options
 */
export function freshness(record, { now, maxAgeSeconds = 0 } = {}) {
  if (!isInstant(now)) throw new Error('now must be an explicit ISO instant: freshness is not a clock reading');
  if (!isObject(record) || !isInstant(record.fetchedAt) || !isText(record.digest)) return { state: 'unknown', reason: 'there is no content observation to date' };
  if (record.parseStatus === 'failed') return { state: 'unknown', reason: 'the last observation failed to parse' };
  const age = (Date.parse(now) - Date.parse(record.fetchedAt)) / 1000;
  if (!Number.isFinite(age) || age < 0) return { state: 'unknown', reason: 'the observation is later than the clock asked about' };
  return age <= maxAgeSeconds ? { state: 'fresh', ageSeconds: age } : { state: 'stale', ageSeconds: age };
}

/**
 * The claims a change puts in question.
 *
 * A failure is `undetermined`, not invalidated and not clean: nothing was read, so nothing
 * is known about the claims that depend on the source.
 *
 * @param {object[]} claims records whose `evidence` lists source references
 * @param {{source: string, changed: string}} change
 */
export function invalidate(claims = [], change = {}) {
  const dependent = (Array.isArray(claims) ? claims : [])
    .filter((record) => Array.isArray(record?.evidence) && record.evidence.includes(change.source))
    .map((record) => record.id)
    .sort();
  if (change.changed === 'changed') return { invalidated: dependent, undetermined: [] };
  if (change.changed === 'unknown') return { invalidated: [], undetermined: dependent };
  return { invalidated: [], undetermined: [] };
}
