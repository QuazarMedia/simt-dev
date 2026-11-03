// Generation lineage: which outputs came from which inputs, and what a change makes stale.
//
// A document that was generated has a receipt: the input sections and claims it was built
// from, with their digests; the template, skill, rubric and generator it was built with; and
// the output's own digest. From that, two questions become answerable without re-reading
// anything: if this source changed, which outputs must be regenerated; and if nothing that
// went into an output changed, may it be reused as-is.
//
// Three rules keep the answer safe:
//
//   * A dependency set is complete only if the receipt says so. Absence of the statement is
//     `complete: false`, and an incomplete set expands the candidate scope to every output
//     of the same generator rather than guessing that the unchanged-looking ones are fine.
//   * Regeneration is a proposal. Nothing here writes a file, and an output whose current
//     bytes differ from its receipt is a merge conflict: the hand edit is somebody's work,
//     and overwriting it is the failure this module exists to prevent.
//   * A missing receipt is unknown lineage, not clean lineage. An output nobody recorded a
//     generation for cannot be excluded from a minimal safe set, so `minimalSafe` is false
//     whenever one exists.
//
// The digest of a receipt's dependency set is its Merkle key: two receipts with the same
// inputs, tools and generator describe the same derivation and may reuse one another's
// result.

import { digestOf } from './observations.mjs';

export const DERIVATION_SCHEMA_VERSION = 1;

/** The kinds of tool a derivation depends on. A generator is the thing that ran. */
export const TOOL_KINDS = Object.freeze(['template', 'skill', 'rubric', 'generator']);

const DIGEST = /^sha256-[0-9a-f]{64}$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.length > 0;
const isDigest = (value) => typeof value === 'string' && DIGEST.test(value);
const isVersion = (value) => Number.isInteger(value) || isText(value);

/** A stable reference for a tool, so a change can name it without naming an output. */
export function toolRef(tool) {
  return `${tool.kind}:${tool.id}@${tool.version}`;
}

/**
 * One generation receipt, validated where it is written.
 *
 * `complete` defaults to false: a receipt that does not claim a complete dependency set has
 * none, and the conservative reading is the only safe one.
 *
 * @returns {{receipt?: object, problems?: string[]}}
 */
export function readReceipt(input = {}) {
  const source = isObject(input) ? input : {};
  const problems = [];

  if (!isText(source.id)) problems.push('id must be a non-empty string');
  if (!isObject(source.output) || !isText(source.output.path) || !isDigest(source.output.digest)) {
    problems.push('output must be {path, digest} with a sha256 digest');
  }

  const inputs = source.inputs ?? [];
  if (!Array.isArray(inputs) || !inputs.every((entry) => isObject(entry) && isText(entry.ref) && isDigest(entry.digest))) {
    problems.push('inputs must be a list of {ref, digest}');
  }

  const tools = source.tools ?? [];
  if (!Array.isArray(tools) || !tools.every((entry) => isObject(entry) && TOOL_KINDS.includes(entry.kind) && isText(entry.id) && isVersion(entry.version) && isDigest(entry.digest))) {
    problems.push(`tools must be a list of {kind, id, version, digest} with kind one of ${TOOL_KINDS.join(', ')}`);
  }

  const generator = source.generator ?? null;
  if (generator !== null && (!isObject(generator) || !isText(generator.id) || !isVersion(generator.version))) {
    problems.push('generator must be {id, version} when given');
  }

  if (source.complete !== undefined && typeof source.complete !== 'boolean') problems.push('complete must be a boolean when given');

  if (problems.length > 0) return { problems };
  return {
    receipt: {
      version: DERIVATION_SCHEMA_VERSION,
      id: source.id,
      output: { path: source.output.path, digest: source.output.digest },
      inputs: inputs.map((entry) => ({ ref: entry.ref, digest: entry.digest })),
      tools: tools.map((entry) => ({ kind: entry.kind, id: entry.id, version: entry.version, digest: entry.digest })),
      generator,
      complete: source.complete === true,
    },
  };
}

/**
 * The Merkle key of a derivation: what went in, with what digest.
 *
 * Sorted, so two receipts written in different orders are the same derivation; the output is
 * deliberately not part of it, because the question is whether the same work was done.
 */
export function derivationDigest(receipt = {}) {
  const inputs = [...(receipt.inputs ?? [])].map((entry) => [entry.ref, entry.digest]).sort((a, b) => a[0].localeCompare(b[0]));
  const tools = [...(receipt.tools ?? [])].map((entry) => [entry.kind, String(entry.id), String(entry.version), entry.digest]).sort((a, b) => `${a[0]}:${a[1]}@${a[2]}`.localeCompare(`${b[0]}:${b[1]}@${b[2]}`));
  return digestOf(JSON.stringify({ inputs, tools, generator: receipt.generator ?? null }));
}

/**
 * Which outputs a change puts in question, which are reusable, and which cannot be decided.
 *
 * @param {{receipts?: object[], outputs?: string[], changes?: {ref: string, digest: string}[], observed?: {path: string, digest: string}[]}} input
 * @returns {object}
 */
export function regenerationCandidates({ receipts = [], outputs = [], changes = [], observed = [] } = {}) {
  const problems = [];
  const accepted = [];
  for (const entry of Array.isArray(receipts) ? receipts : []) {
    const read = readReceipt(entry);
    if (read.problems) problems.push({ id: entry?.id ?? null, problems: read.problems });
    else accepted.push(read.receipt);
  }

  const byOutput = new Map();
  for (const receipt of accepted) {
    const path = receipt.output.path;
    if (!byOutput.has(path)) byOutput.set(path, []);
    byOutput.get(path).push(receipt);
  }

  const changeMap = new Map((Array.isArray(changes) ? changes : []).filter((entry) => isObject(entry) && isText(entry.ref)).map((entry) => [entry.ref, entry.digest]));
  const changing = new Set(changeMap.keys());
  const observedMap = new Map((Array.isArray(observed) ? observed : []).filter((entry) => isObject(entry) && isText(entry.path)).map((entry) => [entry.path, entry.digest]));

  const conflicts = [];
  const decided = new Set();

  // Two receipts for one output that describe different derivations are two generators
  // racing. Picking one would silently discard the other's work.
  for (const [path, list] of byOutput) {
    if (list.length > 1 && new Set(list.map(derivationDigest)).size > 1) {
      conflicts.push({ output: path, receipts: list.map((receipt) => receipt.id).sort(), reasons: ['two receipts for one output describe different derivations'] });
      decided.add(path);
    }
  }

  // A current output that no longer matches its receipt is an edit, and an edit is not
  // something a proposal may overwrite.
  for (const path of byOutput.keys()) {
    if (decided.has(path)) continue;
    const digest = observedMap.get(path);
    if (digest !== undefined && byOutput.get(path)[0].output.digest !== digest) {
      conflicts.push({ output: path, receipts: [byOutput.get(path)[0].id], reasons: ['the output was edited after it was generated'] });
      decided.add(path);
    }
  }

  // Staleness is computed to a fixpoint: a stale output's own digest will change, which
  // makes everything derived from that output stale in the next round.
  const stale = new Map();
  let progress = true;
  while (progress) {
    progress = false;
    for (const receipt of accepted) {
      if (stale.has(receipt.id) || decided.has(receipt.output.path)) continue;
      const reasons = [];
      for (const input of receipt.inputs) {
        if (!changing.has(input.ref)) continue;
        const declared = changeMap.get(input.ref);
        if (declared !== undefined && declared === input.digest) continue;
        reasons.push(`input ${input.ref} changed`);
      }
      for (const tool of receipt.tools) {
        const ref = toolRef(tool);
        if (!changing.has(ref)) continue;
        const declared = changeMap.get(ref);
        if (declared !== undefined && declared === tool.digest) continue;
        reasons.push(`tool ${ref} changed`);
      }
      if (reasons.length > 0) {
        stale.set(receipt.id, reasons);
        changing.add(receipt.output.path);
        progress = true;
      }
    }
  }

  const candidates = [];
  const unknown = [];

  for (const [path, list] of byOutput) {
    if (decided.has(path)) continue;
    const [receipt] = list;
    if (stale.has(receipt.id)) candidates.push({ output: path, receipt: receipt.id, reasons: stale.get(receipt.id) });
    else if (receipt.complete !== true) candidates.push({ output: path, receipt: receipt.id, reasons: ['the dependency set is incomplete, so the safe set expands'] });
  }

  // Conservative expansion: an incomplete dependency set means any output of the same
  // generator may have been built from the same unknown inputs.
  const incompleteGenerators = new Set(
    candidates.filter((entry) => byOutput.get(entry.output)[0].complete !== true && byOutput.get(entry.output)[0].generator !== null).map((entry) => byOutput.get(entry.output)[0].generator.id),
  );
  for (const [path, list] of byOutput) {
    if (decided.has(path) || candidates.some((entry) => entry.output === path)) continue;
    if (list[0].generator !== null && incompleteGenerators.has(list[0].generator.id)) {
      candidates.push({ output: path, receipt: list[0].id, reasons: [`output of generator ${list[0].generator.id}, whose dependency set is incomplete elsewhere`] });
    }
  }

  // Reuse is decided after the expansion, because an output the expansion pulled in is no
  // longer reusable even though its own receipt is complete.
  const reusable = [];
  for (const [path, list] of byOutput) {
    if (decided.has(path) || candidates.some((entry) => entry.output === path)) continue;
    reusable.push({ output: path, receipt: list[0].id });
  }

  for (const path of Array.isArray(outputs) ? outputs.filter(isText) : []) {
    if (!byOutput.has(path)) unknown.push({ output: path, reason: 'no generation receipt, so its lineage is unknown' });
  }

  candidates.sort((a, b) => a.output.localeCompare(b.output));
  conflicts.sort((a, b) => a.output.localeCompare(b.output));
  reusable.sort((a, b) => a.output.localeCompare(b.output));
  unknown.sort((a, b) => a.output.localeCompare(b.output));

  const minimalSafe = unknown.length === 0 && accepted.every((receipt) => receipt.complete === true);

  return {
    version: DERIVATION_SCHEMA_VERSION,
    candidates,
    conflicts,
    reusable,
    unknown,
    minimalSafe,
    proposal: candidates.length > 0 ? 'regenerate' : 'none',
    // Regeneration is a reviewed patch proposal. Nothing here writes, and no caller may
    // read this flag as permission to overwrite.
    applies: false,
    problems,
  };
}
