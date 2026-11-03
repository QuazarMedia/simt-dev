// Portable object snapshots and semantic deltas (W31).
//
// A remote change is reviewable only if its delta is meaningful: a reviewer must be able to see
// what would change, and what must not. The failures this module exists for:
//
//   * a permuted unordered collection produced a delta, so every read looked like a change and
//     reviewers learned to skim;
//   * a permission change was lost because the field's value was masked, so a privilege edit
//     disappeared from the diff;
//   * a masked field was guessed at instead of reported unknown;
//   * a lossy snapshot justified replacing a whole object, silently dropping fields it never saw;
//   * a promotion copied an environment-local id into another environment.
//
// Field classes make the difference between "a label changed" and "a permission changed" a
// property of the data rather than of the reviewer's attention. A masked or opaque field never
// becomes a guess: it stays unknown, and an unknown cannot justify replacement.

import { digestOf } from '../knowledge/observations.mjs';
import { canonicalJson } from '../util/canonical.mjs';

export const OBJECT_SCHEMA = 'simt.object/1';

/** What kind of thing a field is, which decides how a change to it is read. */
export const FIELD_CLASSES = Object.freeze(['identity', 'functional', 'permission', 'privacy', 'reference', 'opaque']);

/** The change kinds a delta can report. `unknown` is a change that was seen but not read. */
export const CHANGE_KINDS = Object.freeze(['added', 'removed', 'changed', 'renamed', 'reset', 'unknown']);

const SIGNIFICANT = new Set(['permission', 'privacy']);
const isText = (value) => typeof value === 'string' && value.length > 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const fieldOf = (raw) => {
  if (isObject(raw) && ('class' in raw || 'value' in raw || 'masked' in raw)) {
    return {
      class: FIELD_CLASSES.includes(raw.class) ? raw.class : 'functional',
      value: raw.value ?? null,
      ordered: raw.ordered === true,
      masked: raw.masked === true,
      ...(raw.default !== undefined ? { default: raw.default } : {}),
      ...(raw.kind !== undefined ? { kind: raw.kind } : {}),
    };
  }
  return { class: 'functional', value: raw ?? null, ordered: false, masked: false };
};

/**
 * A canonical object: declared fields, classified, with a digest over the readable content.
 *
 * @param {{namespace?: string, type?: string, id?: string, fields?: object}} input
 */
export function canonicalObject({ namespace, type, id, fields = {} } = {}) {
  const normalised = {};
  for (const name of Object.keys(fields).sort()) normalised[name] = fieldOf(fields[name]);
  const snapshot = {
    schema: OBJECT_SCHEMA,
    namespace: isText(namespace) ? namespace : null,
    type: isText(type) ? type : null,
    id: isText(id) ? id : null,
    identity: isText(namespace) && isText(type) && isText(id) ? `${namespace}:${type}:${id}` : null,
    fields: normalised,
    masked: Object.keys(normalised).filter((name) => normalised[name].masked).sort(),
  };
  snapshot.digest = digestOf(canonicalJson(snapshot));
  return snapshot;
}

const comparable = (field) => {
  if (Array.isArray(field.value) && !field.ordered) return [...field.value].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  return field.value;
};

const same = (before, after) => canonicalJson(comparable(before)) === canonicalJson(comparable(after));

const referenceOf = (value) => (isObject(value) && isText(value.ref) ? value.ref : value);

/**
 * The semantic delta between two canonical objects.
 *
 * @param {object} before
 * @param {object} after
 */
export function semanticDelta(before, after) {
  const b = isObject(before?.fields) ? before.fields : {};
  const a = isObject(after?.fields) ? after.fields : {};
  const changes = [];
  const unknown = [];
  const names = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();

  for (const name of names) {
    const was = b[name];
    const is = a[name];

    if (!was || !is) {
      const present = was ?? is;
      if (present.masked) {
        unknown.push({ field: name, reason: 'masked', class: present.class });
        continue;
      }
      changes.push({ field: name, kind: was ? 'removed' : 'added', class: present.class, ...(was ? { before: was.value } : { after: is.value }) });
      continue;
    }

    if (was.masked || is.masked) {
      if (SIGNIFICANT.has(was.class) || SIGNIFICANT.has(is.class)) {
        // A permission or privacy change is reported even when its value is unreadable. Silence
        // here is the failure that lets a privilege edit pass review.
        changes.push({ field: name, kind: 'unknown', class: SIGNIFICANT.has(is.class) ? is.class : was.class, significant: true, visible: true });
      } else {
        unknown.push({ field: name, reason: 'masked', class: is.class });
      }
      continue;
    }

    if (same(was, is)) continue;

    if (is.class === 'reference') {
      // The reference travels, not the wrapper around it: a delta that carried `{ref, kind}` would
      // print as an object in an explanation and resolve to nothing in a promotion.
      changes.push({ field: name, kind: 'renamed', class: 'reference', before: referenceOf(was.value), after: referenceOf(is.value) });
      continue;
    }
    if (is.default !== undefined && canonicalJson(is.value) === canonicalJson(is.default)) {
      changes.push({ field: name, kind: 'reset', class: is.class, before: was.value, after: is.value });
      continue;
    }
    changes.push({ field: name, kind: 'changed', class: is.class, before: was.value, after: is.value });
  }

  const lossy = unknown.length > 0 || Object.values({ ...b, ...a }).some((field) => field.class === 'opaque');
  return { changes, unknown, lossy, before: before?.identity ?? null, after: after?.identity ?? null };
}

/**
 * A stable sentence for one change.
 *
 * @param {object} change
 */
export function explain(change) {
  switch (change?.kind) {
    case 'added':
      return `${change.field} was added`;
    case 'removed':
      return `${change.field} was removed`;
    case 'renamed':
      return `${change.field} now references ${JSON.stringify(change.after)} instead of ${JSON.stringify(change.before)}`;
    case 'reset':
      return `${change.field} was reset to its declared default`;
    case 'unknown':
      return change.significant
        ? `${change.field} changed in a ${change.class} field whose value is masked; the change is visible and its content is not read`
        : `${change.field} changed and its value is masked; the delta is not guessed`;
    default:
      return `${change.field} changed`;
  }
}

/**
 * The typed edges a snapshot's declared references contribute.
 *
 * An opaque body keeps a digest and an unknown-dependency frontier: it is reported incomplete
 * rather than assumed independent.
 *
 * @param {object} snapshot
 */
export function referenceEdges(snapshot) {
  const edges = { calls: [], reads: [], writes: [], dependsOn: [] };
  const opaque = [];
  for (const [name, field] of Object.entries(isObject(snapshot?.fields) ? snapshot.fields : {})) {
    if (field.class === 'opaque') {
      opaque.push({ field: name, digest: digestOf(canonicalJson(field.value)), dependsOn: 'unknown' });
      continue;
    }
    if (field.class !== 'reference') continue;
    const ref = isObject(field.value) ? field.value.ref : field.value;
    if (!isText(ref)) continue;
    const kind = isObject(field.value) && isText(field.value.kind) ? field.value.kind : 'depends-on';
    const bucket = kind === 'call' ? 'calls' : kind === 'read' ? 'reads' : kind === 'write' ? 'writes' : 'dependsOn';
    edges[bucket].push(ref);
  }
  for (const key of Object.keys(edges)) edges[key].sort();
  return { ...edges, opaque, incomplete: opaque.length > 0 };
}

/**
 * The fields that must be unchanged for the delta to be the intended change.
 *
 * @param {object} before
 * @param {{changes: object[]}} delta
 */
export function frameConditions(before, delta) {
  const touched = new Set((delta?.changes ?? []).map((change) => change.field));
  return Object.entries(isObject(before?.fields) ? before.fields : {})
    .filter(([name, field]) => !touched.has(name) && !field.masked && field.class !== 'opaque')
    .map(([name, field]) => ({ field: name, expect: field.value }))
    .sort((a, b) => a.field.localeCompare(b.field));
}

/**
 * Whether a snapshot is complete enough to justify replacing the whole object.
 *
 * A lossy snapshot is a partial view. Replacing the object with it would delete fields the
 * snapshot never saw, so it may only describe the fields it read.
 *
 * @param {object} snapshot
 */
export function canReplaceWholeObject(snapshot) {
  const fields = Object.values(isObject(snapshot?.fields) ? snapshot.fields : {});
  return (snapshot?.masked ?? []).length === 0 && !fields.some((field) => field.class === 'opaque');
}

/**
 * Resolve a reference delta against each target's own mapping.
 *
 * A logical reference is what travels; an environment-local id is what does not. A change that
 * carries a raw id is rejected rather than copied.
 *
 * @param {{changes: object[]}} delta
 * @param {{name: string, map?: object, rawIds?: string[]}[]} targets
 */
export function promotionPlan(delta, targets = []) {
  const references = (delta?.changes ?? []).filter((change) => change.class === 'reference');
  const rawIds = new Set((Array.isArray(targets) ? targets : []).flatMap((target) => target.rawIds ?? []));
  const rejected = [];
  const plans = [];

  for (const change of references) {
    const logical = isText(change.after) ? change.after : null;
    if (logical === null) {
      rejected.push({ field: change.field, reason: 'the change carries no logical reference' });
      continue;
    }
    if (rawIds.has(logical) || /^[0-9]+$/.test(logical) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(logical)) {
      rejected.push({ field: change.field, reason: `${logical} is an environment-local id, not a logical reference` });
      continue;
    }
    const resolved = (Array.isArray(targets) ? targets : []).map((target) => ({
      target: target.name ?? null,
      resolved: isObject(target.map) && isText(target.map[logical]) ? target.map[logical] : null,
    }));
    const unmapped = resolved.filter((entry) => entry.resolved === null).map((entry) => entry.target);
    plans.push({ field: change.field, logical, resolved, ...(unmapped.length > 0 ? { unmapped } : {}) });
  }

  return { plans: plans.sort((a, b) => a.field.localeCompare(b.field)), rejected };
}
