// Hook normalization for non-shell actions (W40).
//
// One policy table already decides what an agent may do; the harnesses disagree about what a tool
// call looks like. This module names the call in the table's own terms — operation identity,
// target, resource selector, effect class — so a browser action, an API call and a shell wrapper
// can be judged by the same rows.
//
// The failures it exists to prevent:
//
//   * the same action judged differently in two harnesses because one payload was recognised and
//     the other was not;
//   * a payload nobody could classify being treated as allowed at a boundary that claims to
//     mediate;
//   * shell text analysis presented as a security boundary, when it reads a string a wrapper can
//     defeat;
//   * a recorded tool call keeping the token it carried.

import { decide } from './decide.mjs';
import { digestOf } from '../knowledge/observations.mjs';
import { canonicalJson } from '../util/canonical.mjs';
import { redactDiagnostics } from '../work/trust.mjs';

/** What a call does, in the terms the policy table reasons about. */
export const EFFECT_CLASSES = Object.freeze(['read', 'local-write', 'history', 'push', 'remote-write', 'unknown']);

/** What the boundary can honestly claim about a call. */
export const ASSURANCE = Object.freeze(['mediated', 'observe-only']);

const isText = (value) => typeof value === 'string' && value.length > 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Classify an effect from the facts a renderer produced.
 *
 * A command the parser could not read is `unknown`, not `read`: the difference between "nothing
 * happens" and "we did not understand it" is the whole point of the class.
 */
function classify(command, parsed, writes) {
  if (writes.length > 0) return 'local-write';
  if (parsed.some((fact) => fact.kind === 'git' && fact.sub === 'push')) return 'push';
  if (parsed.some((fact) => fact.kind === 'git' && ['commit', 'reset', 'rebase', 'revert'].includes(fact.sub))) return 'history';
  if (isText(command) && parsed.length === 0) return 'unknown';
  if (isText(command)) return 'read';
  return 'read';
}

/**
 * Name one tool call.
 *
 * @param {{facts?: object, harness?: string}} input
 */
export function normaliseFacts({ facts = {}, harness = null } = {}) {
  const writes = (Array.isArray(facts?.writes) ? facts.writes : []).filter((entry) => isObject(entry) && isText(entry.path));
  const parsed = Array.isArray(facts?.shell?.facts) ? facts.shell.facts.filter(isObject) : [];
  const command = isText(facts?.command) ? facts.command : null;
  const effect = classify(command, parsed, writes);
  const resource = writes.map((entry) => entry.path).sort();
  const operation = digestOf(canonicalJson({ effect, resources: resource, surface: command === null ? 'tool' : 'shell' }));
  return {
    harness: isText(harness) ? harness : null,
    surface: command === null ? 'tool' : 'shell',
    effect,
    classified: effect !== 'unknown',
    resource,
    target: 'repository',
    operation,
  };
}

/**
 * Mediate a call through the existing policy table.
 *
 * The table decides; this only decides what the boundary may claim when the table had no facts to
 * work with. At a mediated boundary an unclassifiable mutation is denied, because "we could not
 * read it" is not "it is fine".
 *
 * @param {{facts?: object, env?: object, harness?: string, mediated?: boolean}} input
 */
export function mediate({ facts = {}, env = {}, harness = null, mediated = false } = {}) {
  const operation = normaliseFacts({ facts, harness });
  const assurance = mediated ? 'mediated' : 'observe-only';

  if (!operation.classified) {
    return mediated
      ? { verdict: 'deny', assurance, operation, reason: 'the call could not be classified, and a mediated boundary does not allow what it cannot name' }
      : { verdict: 'allow', assurance, operation, reason: 'unclassified call; this boundary observes and does not mediate' };
  }

  const decision = decide({ event: 'pre-tool-use', facts, env });
  return {
    verdict: decision.decision === 'deny' ? 'deny' : 'allow',
    assurance,
    operation,
    blocked: decision.blocked,
    messages: decision.messages,
  };
}

/**
 * Whether two normalised calls are the same action, whatever harness reported them.
 *
 * @param {object[]} operations
 */
export function parity(operations = []) {
  const list = (Array.isArray(operations) ? operations : []).filter(isObject);
  const effects = new Set(list.map((entry) => entry.effect));
  const operationsSet = new Set(list.map((entry) => entry.operation));
  return {
    same: effects.size <= 1 && operationsSet.size <= 1,
    effects: [...effects].sort(),
    harnesses: list.map((entry) => entry.harness).filter(Boolean).sort(),
  };
}

/**
 * The record a mediated call may leave behind.
 *
 * Redaction happens before recording, not on display: a log that is redacted when read has
 * already been written.
 *
 * @param {{operation?: object, output?: string}} input
 */
export function recordedCall({ operation = null, output = '' } = {}) {
  const redacted = redactDiagnostics(output);
  return {
    operation: operation === null ? null : { effect: operation.effect, resource: operation.resource ?? [], harness: operation.harness ?? null },
    output: redacted.text,
    redacted: redacted.changed,
  };
}
