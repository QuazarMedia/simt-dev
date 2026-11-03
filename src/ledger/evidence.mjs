// Evidence ledger v2: what was inspected, and what proves it still applies (W28).
//
// The existing ledger answers "a command passed on this tree". That is local evidence, and it
// is the right answer to the local question. It is not an answer to "the target still holds
// this", and the failures this module exists to prevent are the ones where the two are read as
// one sentence:
//
//   * the same Git tree verified against a target that has since been reset — the tree did not
//     move, so the local record looks current, and the target is a different incarnation;
//   * an explicitly scoped proof invalidated because an unrelated object moved in the same
//     target, which trains a reader to ignore the evidence;
//   * an unknown dependency treated as if it had been scoped, so a target revision change
//     silently keeps an old result;
//   * a v1 record (or a v2 run record) offered as proof about a remote target it never touched;
//   * a verifier that wrote to the subject it was verifying, leaving a record that describes a
//     tree that no longer exists;
//   * a raw log kept because it was convenient, with a token in it.
//
// So a v2 envelope binds the local subject (tree and overlay), the verifier and contract
// digests, the source observations, the target namespace and incarnation, the actor, the
// before/after revisions, the obligation results and the observation time. Validation compares
// that binding against the world it is being asked about, and an append-only chain of canonical
// digests detects damage — while never claiming to be an execution attestation.

import { digestOf } from '../knowledge/observations.mjs';

/** The envelope's own schema, distinct from the run-record `v` in the ledger file. */
export const EVIDENCE_SCHEMA = 'simt.evidence/2';
export const EVIDENCE_VERSION = 2;

/** What a record can be, relative to the question being asked. */
export const EVIDENCE_STATES = Object.freeze(['current', 'stale', 'raced', 'inapplicable']);

const SECRET_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /sk-[A-Za-z0-9]{16,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(?:token|secret|password|api[_-]?key)\s*[=:]\s*\S+/gi,
];

const isText = (value) => typeof value === 'string' && value.length > 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** JSON with sorted keys, so two equal records have one digest. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Reduce a command's output to what may be kept: a redacted summary and a digest.
 *
 * The raw log is never stored. A ledger is read by every later gate, shipped in bug reports and
 * often pasted into an issue; a token in it has already leaked by the time anyone notices.
 *
 * @param {string} text
 * @returns {{summary: string, redactions: number, digest: string}}
 */
export function sanitizeOutput(text) {
  const raw = String(text ?? '');
  let redactions = 0;
  let redacted = raw;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, () => {
      redactions += 1;
      return '[redacted]';
    });
  }
  const firstLine = redacted.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '';
  return {
    summary: firstLine.slice(0, 200),
    redactions,
    digest: digestOf(redacted),
  };
}

/**
 * Build the envelope a run records.
 *
 * @param {object} input
 * @returns {object}
 */
export function buildEvidence({
  observedAt,
  subject = {},
  verifier = null,
  contract = null,
  sources = [],
  target = null,
  actor = null,
  revisions = {},
  obligations = [],
  output = '',
  summary = null,
} = {}) {
  const sanitized = sanitizeOutput(output);
  const envelope = {
    schema: EVIDENCE_SCHEMA,
    version: EVIDENCE_VERSION,
    observedAt: isText(observedAt) ? observedAt : null,
    subject: {
      tree: isText(subject.tree) ? subject.tree : null,
      before: isText(subject.before) ? subject.before : isText(subject.tree) ? subject.tree : null,
      after: isText(subject.after) ? subject.after : isText(subject.tree) ? subject.tree : null,
      overlay: isText(subject.overlay) ? subject.overlay : null,
    },
    verifier: isObject(verifier) ? { id: verifier.id ?? null, digest: verifier.digest ?? null } : null,
    contract: isObject(contract) ? { digest: contract.digest ?? null } : null,
    sources: (Array.isArray(sources) ? sources : [])
      .filter((source) => isObject(source) && isText(source.ref))
      .map((source) => ({ ref: source.ref, digest: source.digest ?? null }))
      .sort((a, b) => a.ref.localeCompare(b.ref)),
    target: isObject(target)
      ? { namespace: target.namespace ?? null, incarnation: target.incarnation ?? null, revision: target.revision ?? null }
      : null,
    actor: isObject(actor) ? { id: actor.id ?? null, context: actor.context ?? null } : null,
    revisions: {
      before: revisions?.before ?? null,
      after: revisions?.after ?? null,
    },
    obligations: (Array.isArray(obligations) ? obligations : [])
      .filter((obligation) => isObject(obligation) && isText(obligation.id))
      .map((obligation) => ({
        id: obligation.id,
        state: obligation.state ?? 'unknown',
        basis: obligation.basis ?? 'local',
        // An empty scope is the unknown-dependency case, and it is recorded as empty rather
        // than filled in from the target: a scope invented at write time proves nothing.
        scope: (Array.isArray(obligation.scope) ? obligation.scope : []).filter((entry) => isObject(entry) && isText(entry.ref)).map((entry) => ({ ref: entry.ref, revision: entry.revision ?? null })),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    summary: isText(summary) ? summary : sanitized.summary,
    redactions: sanitized.redactions,
    outputDigest: sanitized.digest,
  };
  envelope.canon = digestOf(canonicalJson(envelope));
  return envelope;
}

/**
 * Read one ledger line, keeping v1's local-tree meaning.
 *
 * A v1 line — anything without this envelope's schema, including the ledger's own `v: 2` run
 * records — says one thing: a command ran on a tree. It is accepted as local evidence and is
 * never treated as evidence about a target.
 *
 * @param {object|string} line
 */
export function readEvidenceRecord(line) {
  let record = line;
  if (typeof line === 'string') {
    try {
      record = JSON.parse(line);
    } catch {
      return { version: 0, localOnly: true, damaged: true, tree: null, record: null };
    }
  }
  if (!isObject(record)) return { version: 0, localOnly: true, damaged: true, tree: null, record: null };
  if (record.schema === EVIDENCE_SCHEMA) return { version: EVIDENCE_VERSION, localOnly: false, damaged: false, tree: record.subject?.tree ?? null, record };
  return { version: 1, localOnly: true, damaged: false, tree: isText(record.tree) ? record.tree : isText(record.worktreeTree) ? record.worktreeTree : null, record };
}

/**
 * Whether a record is current evidence for the question being asked.
 *
 * @param {object|string} line a ledger line, v1 or v2
 * @param {{tree?: string|null, target?: object|null, revisions?: object, needed?: {id: string, basis?: string}[]}} expected
 */
export function validateEvidence(line, { tree = null, target = null, revisions = {}, needed = [] } = {}) {
  const read = readEvidenceRecord(line);
  const wanted = (Array.isArray(needed) ? needed : []).filter((entry) => isObject(entry) && isText(entry.id));
  const reasons = [];

  if (read.damaged) return { state: 'inapplicable', current: false, reasons: ['the record could not be read as a ledger line'] };

  if (read.version === 1) {
    // A v1 record proves a command ran on a tree and nothing about a target.
    if (wanted.some((entry) => entry.basis === 'remote')) {
      return { state: 'inapplicable', current: false, reasons: ['a v1 record cannot prove a remote obligation: it never describes a target'] };
    }
    if (isText(tree) && read.tree !== null && read.tree !== tree) return { state: 'stale', current: false, reasons: [`the record is about tree ${read.tree}, not ${tree}`] };
    return { state: 'current', current: true, reasons, remote: null };
  }

  const record = read.record;
  if (isText(record.subject?.before) && isText(record.subject?.after) && record.subject.before !== record.subject.after) {
    return { state: 'inapplicable', current: false, reasons: ['the verifier changed its own subject during the run'] };
  }
  if (isText(tree) && record.subject?.tree !== tree) {
    return { state: 'stale', current: false, reasons: [`the record is about tree ${record.subject?.tree ?? 'unknown'}, not ${tree}`] };
  }
  if (target !== null && record.target?.incarnation !== (target.incarnation ?? null)) {
    return { state: 'raced', current: false, reasons: [`the target was ${record.target?.incarnation ?? 'unrecorded'} and is now ${target.incarnation ?? 'unrecorded'}; a reset target makes the old reading about a different object`] };
  }

  for (const asked of wanted) {
    const result = record.obligations?.find((obligation) => obligation.id === asked.id);
    if (result === undefined) {
      reasons.push(`${asked.id} is not in the record`);
      continue;
    }
    if (result.state !== 'pass') {
      reasons.push(`${asked.id} was recorded as ${result.state}`);
      continue;
    }
    if (asked.basis === 'remote' && result.basis !== 'remote') {
      reasons.push(`${asked.id} was recorded as local evidence, not a remote reading`);
      continue;
    }
    const scope = Array.isArray(result.scope) ? result.scope : [];
    if (scope.length === 0) {
      // An unscoped remote result depends on the whole target. A moved target revision makes
      // it unknown, and unknown is not current.
      if (asked.basis === 'remote' && record.target?.revision !== (target?.revision ?? record.target?.revision)) {
        reasons.push(`${asked.id} has no scope, and the target revision moved`);
      }
      continue;
    }
    for (const entry of scope) {
      const current = revisions?.[entry.ref];
      if (current !== undefined && entry.revision !== null && current !== entry.revision) {
        reasons.push(`${asked.id} was proved at ${entry.ref} ${entry.revision}, which is now ${current}`);
      }
    }
  }

  if (reasons.some((reason) => /has no scope/.test(reason))) return { state: 'stale', current: false, reasons };
  if (reasons.length > 0) return { state: 'inapplicable', current: false, reasons };
  return { state: 'current', current: true, reasons: [], remote: record.target };
}

/**
 * Whether an append-only chain of records is intact.
 *
 * This detects damage — a line edited, a record removed, a file truncated. It is not an
 * attestation that the runs happened: anyone who can rewrite the file can rewrite the chain,
 * and the result says so rather than implying otherwise.
 *
 * @param {object[]} records
 */
export function checkChain(records = []) {
  const list = (Array.isArray(records) ? records : []).filter((record) => isObject(record));
  let brokenAt = null;
  let previous = null;
  for (let index = 0; index < list.length; index += 1) {
    const record = list[index];
    const { canon, ...rest } = record;
    const recomputed = digestOf(canonicalJson(rest));
    if (recomputed !== canon) {
      brokenAt = index;
      break;
    }
    if (previous !== null && record.previous !== previous) {
      brokenAt = index;
      break;
    }
    previous = canon;
  }
  return { intact: brokenAt === null, brokenAt, attestsExecution: false };
}

/**
 * Link a new envelope to the record before it.
 *
 * @param {object} envelope
 * @param {object|null} previous
 */
export function chainEvidence(envelope, previous = null) {
  const { canon, ...rest } = envelope;
  const linked = { ...rest, previous: isObject(previous) ? previous.canon ?? null : null };
  linked.canon = digestOf(canonicalJson(linked));
  return linked;
}
