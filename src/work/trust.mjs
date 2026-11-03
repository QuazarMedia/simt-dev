// Trust boundaries, injection and secret minimisation (W41).
//
// Retrieved material is not an instruction, and tool output is not a policy. The failures this
// module exists to prevent:
//
//   * a hostile document or tool result broadening the effect set, invoking another adapter or
//     rewriting the rules a run follows;
//   * derived chunks losing the label of the source they came from;
//   * an adapter called with a path outside its root, a URL to an unexpected host, an oversized
//     input or an argv the schema never allowed;
//   * a denied path's content reaching an index, a vector, a receipt or an error message;
//   * hashing a credential and treating the hash as access control;
//   * an assurance report that describes mediation it does not have.
//
// Labels are attached to content, not to a prompt: control text is the repository's own policy,
// a contract is reviewed, and everything else is evidence that may inform a run and cannot change
// it. Redaction reuses the repository's secret scanner rather than a second pattern list.

import { redactText } from '../secrets.mjs';

const TRUST_LABELS = Object.freeze(['control', 'contract', 'evidence']);

/** Where content came from decides what it may do. */
export function labelSource({ origin = 'untrusted', reviewed = false } = {}) {
  if (origin === 'repo-policy') return 'control';
  if (reviewed === true || origin === 'reviewed-contract') return 'contract';
  return 'evidence';
}

/** Only the repository's own policy may change what the rules require. */
export const mayChangePolicy = (label) => label === 'control';

/** A derived chunk carries its parent's label: a summary of evidence is evidence. */
export function inheritLabels(chunks = [], parent = 'evidence') {
  return (Array.isArray(chunks) ? chunks : []).map((chunk) => ({ ...chunk, label: parent }));
}

/**
 * Resolve a path inside its root, or refuse it.
 *
 * Refusal is the answer for an absolute path, a parent reference and an empty one: the adapter's
 * root is the whole world it may read.
 *
 * @param {{path?: string, root?: string}} input
 */
export function canonicalPath({ path = null, root = null } = {}) {
  if (typeof path !== 'string' || path.length === 0) return null;
  const normalised = path.replace(/\\/g, '/');
  if (normalised.startsWith('/') || normalised.split('/').includes('..')) return null;
  return root ? `${root}/${normalised}`.replace(/\/{2,}/g, '/') : normalised;
}

/**
 * Validate a call before it is dispatched.
 *
 * @param {object} input
 */
export function checkAdapterCall({
  adapter = null,
  operation = null,
  allowlist = {},
  argv = [],
  path = null,
  root = null,
  url = null,
  size = 0,
  maxSize = 1_000_000,
  schemes = ['https'],
} = {}) {
  const refuse = (reason) => ({ allowed: false, reason, adapter, operation });
  if (typeof adapter !== 'string' || !Object.prototype.hasOwnProperty.call(allowlist ?? {}, adapter)) return refuse(`${adapter ?? 'this adapter'} is not declared in the operation allowlist`);
  if (!(allowlist[adapter] ?? []).includes(operation)) return refuse(`${adapter} does not declare the operation ${operation}`);

  if (!Array.isArray(argv) || argv.some((entry) => typeof entry !== 'string' || /[\n\0]/.test(entry))) return refuse('argv must be strings without control characters');
  if (path !== null && canonicalPath({ path, root }) === null) return refuse(`${path} resolves outside ${root ?? 'its root'}`);
  if (url !== null) {
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch {
      return refuse(`${url} is not a URL`);
    }
    if (!schemes.includes(parsed.protocol.replace(':', ''))) return refuse(`${parsed.protocol.replace(':', '')} is not an allowed scheme`);
    if (parsed.username || parsed.password) return refuse('a URL carrying credentials is refused');
  }
  if (!Number.isFinite(size) || size < 0) return refuse('size must be a non-negative number');
  if (size > maxSize) return refuse(`${size} bytes exceeds the ${maxSize} byte bound`);

  return { allowed: true, reason: null, adapter, operation };
}

/**
 * Redact a diagnostic before it is logged, stored or attached to a receipt.
 *
 * @param {string} text
 */
export function redactDiagnostics(text) {
  const original = String(text ?? '');
  const redacted = redactText(original);
  return { text: redacted, changed: redacted !== original };
}

/**
 * Whether a path may enter an index, a vector or a receipt body.
 *
 * A denied path is not summarised, hashed into a vector, or quoted in an error: its content must
 * not appear anywhere, and "appears nowhere" starts with not being indexed.
 *
 * @param {{path?: string, deniedPaths?: string[]}} input
 */
export function mayIndex({ path = null, deniedPaths = [] } = {}) {
  if (typeof path !== 'string') return { indexed: false, reason: 'no path was given' };
  const denied = (Array.isArray(deniedPaths) ? deniedPaths : []).some((prefix) => path === prefix || path.startsWith(`${prefix.replace(/\/$/, '')}/`));
  return denied ? { indexed: false, reason: `${path} is under a denied path; its content is not indexed, summarised or quoted` } : { indexed: true, reason: null };
}

/**
 * What a run's assurance actually covers.
 *
 * The report names the routes that are not mediated by a hook, and states the limit of a shared
 * user account rather than implying per-actor separation it cannot provide.
 *
 * @param {{adapters?: object[]}} input
 */
export function assuranceReport({ adapters = [] } = {}) {
  const list = (Array.isArray(adapters) ? adapters : []).filter((adapter) => adapter && typeof adapter.name === 'string');
  return {
    mediated: list.filter((adapter) => adapter.mediated === true).map((adapter) => adapter.name).sort(),
    unmediatedRoutes: list.filter((adapter) => adapter.mediated !== true).map((adapter) => adapter.name).sort(),
    sharedUserLimits: 'a shared account cannot separate actors: actions are attributable to the account, not to a person',
    requiresPlatformAuthorization: true,
    labels: [...TRUST_LABELS],
  };
}
