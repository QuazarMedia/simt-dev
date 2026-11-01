// Benchmark task descriptors, schema v2.
//
// Schema v1 was whatever the miner happened to write: nothing validated a field, a task
// said nothing about how hard it is or what the agent may see, and the grader assumed the
// only oracle in the world was a hidden test patch. A field that is not
// checked is a guess about what it means, and an oracle that is not declared cannot be
// swapped for a different kind of task.
//
// v1 stays readable. `normaliseTask` fills the v2 fields and keeps every v1 key it does
// not own, so a corpus mined before this module existed runs without a re-mine and a
// stored record still means what it meant.
export const TASK_SCHEMA_VERSION = 2;

/** Gold-file counts that separate the strata. Declared here, so a report can name one. */
const STRATUM_LIMITS = Object.freeze({ small: 2, medium: 5 });

/** The oracle kinds a grader registry can answer for. */
const ORACLE_TYPES = new Set(['tests', 'outcome']);

/**
 * How an outcome oracle states what settles a task.
 *
 * A hidden test patch settles a source-code change. Work whose result is a document, a
 * recipe or a remote object has no test to run, so it declares predicates over the
 * artifacts and effects the task may produce — and the predicates are part of the
 * oracle, not something a grader infers.
 */
export const OUTCOME_PREDICATE_KINDS = Object.freeze([
  'artifact-contains',
  'artifact-equals',
  'artifact-matches',
  'artifact-absent',
]);

const PREDICATE_KINDS = new Set(OUTCOME_PREDICATE_KINDS);

/** What the agent may see. A repository task shows the checked-out tree at `base`. */
const AGENT_VISIBLE_KINDS = new Set(['repository']);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The stratum a task belongs to, from the size of the change its gold patch makes.
 *
 * A stratum is a property of the task, not of the run: two arms on the same task are
 * compared within it, so it cannot be recomputed differently by each reader.
 *
 * @param {{files?: number}} [gold]
 * @returns {'small'|'medium'|'large'}
 */
function stratumOf(gold = {}) {
  const files = Number(gold?.files ?? 0);
  if (files <= STRATUM_LIMITS.small) return 'small';
  if (files <= STRATUM_LIMITS.medium) return 'medium';
  return 'large';
}

function fail(source, message) {
  throw new Error(`${source}: ${message}`);
}

function stringList(value) {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : null;
}

/**
 * Validate one task descriptor and answer its v2 form.
 *
 * Every problem is reported in words that name the file and the field, because a corpus
 * is operator input: a task the tool cannot read is the operator's to fix, not a stack
 * trace to decode.
 *
 * @param {object} raw a v1 or v2 descriptor
 * @param {{source?: string}} [options]
 * @returns {object} the v2 descriptor
 */
export function normaliseTask(raw, { source = 'task' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(source, 'must be a JSON object');
  }
  const id = String(raw.id ?? '');
  if (!ID_PATTERN.test(id)) {
    fail(source, `field "id" must match ${ID_PATTERN} (received ${JSON.stringify(raw.id ?? null)})`);
  }
  // v1 descriptors in the wild are partial — a fixture may name only an id and a prompt.
  // A v2 descriptor is written by this package and is held to its own shape, so the
  // strictness lands on the writer that can satisfy it.
  const base = raw.base ?? null;
  if (base !== null && (typeof base !== 'string' || base.length === 0)) {
    fail(source, `field "base" must name the commit the task is mined from (received ${JSON.stringify(base)})`);
  }
  const prompt = typeof raw.prompt === 'string' ? raw.prompt : null;
  if (prompt === null && raw.prompt !== undefined) {
    fail(source, 'field "prompt" must be the text an agent is given');
  }
  const declaredV2 = Number(raw.schemaVersion ?? 1) >= TASK_SCHEMA_VERSION;
  if (declaredV2 && (base === null || prompt === null || prompt.trim().length === 0)) {
    fail(source, 'a schema v2 task names its base commit and its prompt');
  }

  const f2p = stringList(raw.f2p);
  const p2p = stringList(raw.p2p);
  if (raw.f2p !== undefined && f2p === null) fail(source, 'field "f2p" must be an array of test ids');
  if (raw.p2p !== undefined && p2p === null) fail(source, 'field "p2p" must be an array of test ids');

  const oracleRaw = raw.oracle && typeof raw.oracle === 'object' ? raw.oracle : {};
  const type = String(oracleRaw.type ?? 'tests');
  if (!ORACLE_TYPES.has(type)) {
    fail(source, `oracle type "${type}" is not one this package grades; known: ${[...ORACLE_TYPES].join(', ')}`);
  }
  if (declaredV2 && type === 'tests' && f2p === null) {
    fail(source, 'a schema v2 task with a "tests" oracle lists its fail-to-pass ids in "f2p" (an empty list is a task nothing proves)');
  }
  // An outcome task is settled by its predicates. Validated here rather than at grading
  // time, so a corpus with an unreadable predicate is refused when it is written.
  let predicates = null;
  if (type === 'outcome') {
    const raw = oracleRaw.predicates;
    if (!Array.isArray(raw) || raw.length === 0) {
      fail(source, 'an "outcome" oracle lists its predicates (an empty list is a task nothing proves)');
    }
    predicates = raw.map((entry, index) => {
      if (entry === null || typeof entry !== 'object') fail(source, `oracle.predicates[${index}] must be an object`);
      const kind = String(entry.kind ?? '');
      if (!PREDICATE_KINDS.has(kind)) {
        fail(source, `oracle.predicates[${index}].kind "${kind}" is not one this package grades; known: ${OUTCOME_PREDICATE_KINDS.join(', ')}`);
      }
      if (typeof entry.path !== 'string' || entry.path.trim() === '') {
        fail(source, `oracle.predicates[${index}] names the artifact it reads in "path"`);
      }
      if (kind === 'artifact-matches') {
        if (typeof entry.pattern !== 'string') fail(source, `oracle.predicates[${index}].pattern must be a string`);
        try {
          new RegExp(entry.pattern);
        } catch (e) {
          fail(source, `oracle.predicates[${index}].pattern does not compile: ${e.message}`);
        }
      } else if (kind !== 'artifact-absent' && typeof entry.value !== 'string') {
        fail(source, `oracle.predicates[${index}].value must be the text the artifact has to carry`);
      }
      return { kind, path: entry.path, ...(entry.value === undefined ? {} : { value: entry.value }), ...(entry.pattern === undefined ? {} : { pattern: entry.pattern }) };
    });
  }
  const allowedEffects = oracleRaw.allowedEffects === undefined ? [] : stringList(oracleRaw.allowedEffects);
  if (allowedEffects === null) fail(source, 'field "oracle.allowedEffects" must be an array of effect names');
  if (type === 'outcome' && oracleRaw.mutationRequired !== undefined && typeof oracleRaw.mutationRequired !== 'boolean') {
    fail(source, 'field "oracle.mutationRequired" must be true or false');
  }

  const visibleRaw = raw.agentVisible && typeof raw.agentVisible === 'object' ? raw.agentVisible : {};
  const visibleKind = String(visibleRaw.kind ?? 'repository');
  if (!AGENT_VISIBLE_KINDS.has(visibleKind)) {
    fail(source, `agentVisible kind "${visibleKind}" is not one this package knows; known: ${[...AGENT_VISIBLE_KINDS].join(', ')}`);
  }

  const goldRaw = raw.gold && typeof raw.gold === 'object' ? raw.gold : {};
  const gold = {
    files: Number(goldRaw.files ?? 0),
    linesAdded: Number(goldRaw.linesAdded ?? 0),
    linesRemoved: Number(goldRaw.linesRemoved ?? 0),
  };
  if (!Number.isFinite(gold.files) || gold.files < 0) fail(source, 'field "gold.files" must be a non-negative number');

  return {
    ...raw,
    schemaVersion: TASK_SCHEMA_VERSION,
    id,
    base,
    prompt: prompt ?? '',
    stratum: raw.stratum ?? stratumOf(gold),
    agentVisible: { ...visibleRaw, kind: visibleKind },
    oracle: {
      ...oracleRaw,
      type,
      tests: { f2p: f2p ?? [], p2p: p2p ?? [] },
      ...(predicates === null ? {} : { predicates, mutationRequired: oracleRaw.mutationRequired === true, allowedEffects }),
    },
    f2p: f2p ?? [],
    p2p: p2p ?? [],
    gold,
  };
}
