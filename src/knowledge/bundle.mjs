// Read-only query interop and offline bundles (W23).
//
// The same facts are asked for through a terminal, an MCP client and a handoff to another
// repository. Three doors, one answer — and the failures this module exists to prevent are the
// ones that appear when "one answer" is implemented as "one blob":
//
//   * A restricted fact filtered out after ranking still shapes the order, so the answer
//     reveals it. Filtering happens before the ranker sees anything.
//   * A count of what was withheld is itself a disclosure: "2 internal results" tells the
//     reader the fact exists. Policy can require the count to be absent, not zero.
//   * An imported bundle is text from somewhere else. It is parsed as data and never as an
//     instruction: nothing in it is executed, and an imperative sentence in a fact stays a
//     sentence.
//   * A door is read-only only if every surface agrees. A CLI verb that writes and an MCP tool
//     that writes are the same defect, and parity is checked structurally rather than assumed.
//
// The module is pure. Expiry is compared against a date the caller supplies, because a bundle
// that expires differently depending on the reader's clock is not a contract.

import { digestOf } from './observations.mjs';

export const BUNDLE_SCHEMA = 'simt.bundle/1';
export const BUNDLE_SCHEMA_VERSION = 1;
export const MAX_BUNDLE_BYTES = 64 * 1024;
export const MAX_PAGE = 100;

const isText = (value) => typeof value === 'string' && value.length > 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The four read-only doors this slice proposes, each named on both surfaces.
 *
 * `paginated` is a claim about the answer rather than the transport: a door that returns a
 * collection must be able to return it in pages and to say when a page was cut.
 */
export const READ_ONLY_DOORS = Object.freeze([
  { name: 'work inspect', cli: 'work inspect', mcp: 'work_inspect', paginated: true },
  { name: 'knowledge why', cli: 'knowledge why', mcp: 'knowledge_why', paginated: true },
  { name: 'verify plan', cli: 'verify plan', mcp: 'verify_plan', paginated: false },
  { name: 'action status', cli: 'action status', mcp: 'action_status', paginated: false },
]);

/**
 * Check that each door exists on both surfaces and that neither surface makes it a writer.
 *
 * @param {{cli?: object[], mcp?: object[], doors?: object[]}} input
 */
export function checkDoors({ cli = [], mcp = [], doors = READ_ONLY_DOORS } = {}) {
  const cliByName = new Map((Array.isArray(cli) ? cli : []).filter((entry) => isText(entry?.name)).map((entry) => [entry.name, entry]));
  const mcpByName = new Map((Array.isArray(mcp) ? mcp : []).filter((entry) => isText(entry?.name)).map((entry) => [entry.name, entry]));
  const errors = [];

  for (const door of doors) {
    const onCli = cliByName.get(door.cli);
    const onMcp = mcpByName.get(door.mcp);
    if (onCli === undefined) {
      errors.push({ door: door.name, surface: 'cli', problem: 'absent from the CLI', remedy: `register ${door.cli} beside the other read commands` });
    } else if (onCli.writes === true) {
      errors.push({ door: door.name, surface: 'cli', problem: 'the CLI verb writes', remedy: `${door.cli} must not mutate; move the write to its own command` });
    }
    if (onMcp === undefined) {
      errors.push({ door: door.name, surface: 'mcp', problem: 'absent from the read-only MCP server', remedy: `expose ${door.mcp} through the read-only tool list` });
    } else if (onMcp.writes === true) {
      errors.push({ door: door.name, surface: 'mcp', problem: 'the MCP tool writes', remedy: `remove ${door.mcp} from the read-only server; ADR-001 keeps mutations off it` });
    }
  }

  return { ok: errors.length === 0, errors, doors: doors.map((door) => door.name) };
}

const allows = (fact, held) => {
  if (!isText(fact.permission)) return true;
  return Array.isArray(held) && held.includes(fact.permission);
};

/**
 * Export a bounded, permission-filtered bundle.
 *
 * @param {object} input
 * @returns {object}
 */
export function exportBundle({
  facts = [],
  repository = null,
  revisions = [],
  applicability = {},
  expiresAt = null,
  permissionsHeld = [],
  limitBytes = MAX_BUNDLE_BYTES,
  limit = 20,
  page = 0,
  hideCounts = false,
  rank = null,
} = {}) {
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) throw new Error('a bundle needs a positive byte limit');
  if (!Number.isFinite(limit) || limit <= 0 || limit > MAX_PAGE) throw new Error(`a bundle page must be between 1 and ${MAX_PAGE} facts`);
  if (!Number.isFinite(page) || page < 0) throw new Error('a page index must be a non-negative number');

  const list = (Array.isArray(facts) ? facts : []).filter((fact) => isObject(fact) && isText(fact.id) && isText(fact.text));
  // Permission first: the ranker must not see, and therefore cannot order by, a fact the
  // reader may not have.
  const permitted = list.filter((fact) => allows(fact, permissionsHeld));
  const restricted = list.length - permitted.length;

  const ordered = rank === null ? permitted : rank(permitted);
  if (rank === null) ordered.sort((a, b) => a.id.localeCompare(b.id));

  const start = page * limit;
  const window = ordered.slice(start, start + limit);
  const chosen = [];
  const reasons = [];
  let bytes = 0;
  for (const fact of window) {
    const cost = Buffer.byteLength(JSON.stringify(fact)) + 1;
    if (bytes + cost > limitBytes) {
      reasons.push(`the page stopped at ${limitBytes} bytes`);
      break;
    }
    bytes += cost;
    chosen.push(fact);
  }
  const truncated = start + window.length < ordered.length || chosen.length < window.length;
  if (start + window.length < ordered.length) reasons.push(`${ordered.length - start - window.length} more fact(s) are on a later page`);

  const payload = chosen.map((fact) => ({
    id: fact.id,
    kind: isText(fact.kind) ? fact.kind : 'fact',
    text: fact.text,
    permission: isText(fact.permission) ? fact.permission : 'public',
    revision: isObject(fact.revision) ? { ref: fact.revision.ref ?? null, digest: fact.revision.digest ?? null } : { ref: null, digest: null },
    obligations: Array.isArray(fact.obligations) ? [...fact.obligations].filter(isText).sort() : [],
  }));

  const envelope = {
    schema: BUNDLE_SCHEMA,
    version: BUNDLE_SCHEMA_VERSION,
    producer: { repository, digest: digestOf(JSON.stringify({ revisions, facts: payload })) },
    revisions: (Array.isArray(revisions) ? revisions : []).filter((revision) => isObject(revision) && isText(revision.ref)).map((revision) => ({ ref: revision.ref, digest: revision.digest ?? null })),
    applicability: isObject(applicability) ? applicability : {},
    expiresAt: isText(expiresAt) ? expiresAt : null,
    page: { index: page, size: chosen.length, total: ordered.length },
    omitted: {
      // A count is a disclosure. Policy may require the fact that something was withheld to
      // be invisible, so the count is absent rather than zero.
      restricted: hideCounts ? null : restricted,
      beyondPage: hideCounts ? null : Math.max(0, ordered.length - start - chosen.length),
    },
    truncated,
    facts: payload,
  };

  return { ok: true, bundle: envelope, truncated, reasons, bytes: Buffer.byteLength(JSON.stringify(envelope)) };
}

/**
 * Import a bundle as data.
 *
 * @param {string|object} input
 * @param {{permissionsHeld?: string[], at?: string|null}} [options]
 * @returns {object}
 */
export function importBundle(input, { permissionsHeld = [], at = null } = {}) {
  let parsed = input;
  const problems = [];

  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch {
      return { ok: false, facts: [], withheld: 0, problems: [{ code: 'format', detail: 'the bundle is not JSON', remedy: 'send the bundle exactly as it was exported' }], executed: false, effects: [], treatAs: 'data' };
    }
  }
  if (!isObject(parsed) || parsed.schema !== BUNDLE_SCHEMA) {
    problems.push({ code: 'schema', detail: `the bundle schema is ${JSON.stringify(parsed?.schema ?? null)}`, remedy: `send a ${BUNDLE_SCHEMA} bundle` });
    return { ok: false, facts: [], withheld: 0, problems, executed: false, effects: [], treatAs: 'data' };
  }
  if (parsed.version !== BUNDLE_SCHEMA_VERSION) {
    problems.push({ code: 'version', detail: `version ${JSON.stringify(parsed.version)} is not ${BUNDLE_SCHEMA_VERSION}`, remedy: 'export the bundle with a reader that speaks this version' });
  }
  if (isText(parsed.expiresAt) && isText(at) && at > parsed.expiresAt) {
    problems.push({ code: 'expired', detail: `the bundle expired on ${parsed.expiresAt}`, remedy: 'ask the producer for a refreshed bundle' });
  }

  const facts = [];
  let withheld = 0;
  for (const fact of Array.isArray(parsed.facts) ? parsed.facts : []) {
    if (!isObject(fact) || !isText(fact.id) || !isText(fact.text)) {
      problems.push({ code: 'fact', detail: 'a fact has no id or no text', remedy: 'drop the malformed fact, or ask the producer to re-export' });
      continue;
    }
    if (!isObject(fact.revision) || !isText(fact.revision.digest)) {
      problems.push({ code: 'no-revision-digest', detail: `${fact.id} names no revision digest`, remedy: 'a fact without a digest cannot be checked; re-export it with one' });
      continue;
    }
    if (!allows(fact, permissionsHeld)) {
      withheld += 1;
      continue;
    }
    facts.push(fact);
  }

  return {
    ok: problems.length === 0,
    bundle: { schema: parsed.schema, producer: parsed.producer ?? null, revisions: parsed.revisions ?? [], applicability: parsed.applicability ?? {}, expiresAt: parsed.expiresAt ?? null },
    facts,
    withheld,
    problems,
    // The two fields that make the promise checkable rather than stylistic.
    executed: false,
    effects: [],
    treatAs: 'data',
  };
}
