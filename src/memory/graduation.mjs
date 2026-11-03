// Procedure graduation and semantic conformance (W44).
//
// Turning exploration into a recipe, and a recipe into code, is where a single successful run
// becomes a claimed general procedure. The failures this module is built around:
//
//   * one trace graduating to a helper because it happened to work once;
//   * a common subsequence presented as the procedure when it was the accident of one run;
//   * environment-local ids carried into a portable recipe;
//   * a helper compared to the reference by transport trace rather than by semantic result;
//   * a single tenant's trace becoming a "portable skill" by deleting its hostname.
//
// So graduation needs at least three independent validated runs, the minimum is evidence for a
// review rather than proof of generality, held-out and failure-path checks gate promotion, and the
// comparison is over postconditions and frame conditions.

export const MIN_RUNS = 3;

/** What a graduation proposal says about itself. */
export const PROPOSAL_STATES = Object.freeze(['proposable', 'insufficient-evidence', 'blocked']);

const isText = (value) => typeof value === 'string' && value.length > 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const runKey = (run) => `${run?.goal ?? ''}|${run?.capability ?? ''}`;

/** The steps every trace has, in the order the first one used them. */
function commonSteps(sequences = []) {
  if (sequences.length === 0) return [];
  const [first] = sequences;
  return first.filter((step) => sequences.every((sequence) => sequence.includes(step)));
}

/** Values that look environment-local: they must be parameters, not constants. */
function environmentLocal(values = []) {
  const local = values.filter((value) => typeof value === 'string' && (/^[0-9]+$/.test(value) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value) || value.includes('.example.')));
  return [...new Set(local)].sort();
}

/**
 * Propose graduation from the traces that support it.
 *
 * @param {{traces?: object[]}} input
 */
export function proposeGraduation({ traces = [] } = {}) {
  const groups = new Map();
  for (const run of (Array.isArray(traces) ? traces : []).filter(isObject)) {
    const key = runKey(run);
    if (!groups.has(key)) groups.set(key, { goal: run.goal ?? null, capability: run.capability ?? null, runs: [] });
    groups.get(key).runs.push(run);
  }

  return {
    proposals: [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, group]) => {
        const validated = group.runs.filter((run) => run.validated === true && run.independent !== false);
        if (validated.length < MIN_RUNS) {
          return {
            goal: group.goal,
            capability: group.capability,
            state: 'insufficient-evidence',
            validated: validated.length,
            reason: `${validated.length} validated independent run(s); ${MIN_RUNS} are needed, and even ${MIN_RUNS} is evidence to review rather than proof of generality`,
          };
        }
        const sequences = validated.map((run) => (Array.isArray(run.steps) ? run.steps : [])).filter((steps) => steps.length > 0);
        const common = commonSteps(sequences);
        const branches = validated.flatMap((run) => (run.steps ?? []).filter((step) => !common.includes(step))).filter((step, index, all) => all.indexOf(step) === index).sort();
        return {
          goal: group.goal,
          capability: group.capability,
          state: 'proposable',
          validated: validated.length,
          key,
          common,
          branches,
          parameters: environmentLocal(validated.flatMap((run) => run.values ?? [])),
          requiresHeldOut: true,
          requiresFailurePath: true,
          humanReview: true,
          reason: 'a proposal for review, not a promoted helper',
        };
      }),
  };
}

/**
 * Whether a proposal may become a helper.
 *
 * @param {{proposal?: object, heldOut?: object|null, failurePath?: object|null}} input
 */
export function promotionReady({ proposal = null, heldOut = null, failurePath = null } = {}) {
  const missing = [];
  if (proposal?.state !== 'proposable') missing.push('a proposal with at least three validated independent runs');
  if (heldOut?.passed !== true) missing.push('a held-out variant that passes');
  if (failurePath?.passed !== true) missing.push('a failure-path check that passes');
  return {
    ready: missing.length === 0,
    state: missing.length === 0 ? 'proposable' : 'blocked',
    missing,
    humanReview: true,
  };
}

/**
 * Compare a reference procedure and a helper on what they achieved, not how they got there.
 *
 * @param {{reference?: object, helper?: object, postconditions?: object[], frames?: object[]}} input
 */
export function differentialReplay({ reference = null, helper = null, postconditions = [], frames = [] } = {}) {
  const fields = (object) => (isObject(object?.fields) ? object.fields : {});
  const failed = [];
  for (const entry of Array.isArray(postconditions) ? postconditions : []) {
    const field = isObject(entry) ? entry.field : null;
    if (!isText(field)) continue;
    if (JSON.stringify(fields(helper)[field]) !== JSON.stringify(fields(reference)[field])) failed.push({ field, kind: 'postcondition' });
  }
  for (const entry of Array.isArray(frames) ? frames : []) {
    const field = isObject(entry) ? entry.field : null;
    if (!isText(field)) continue;
    const expected = isObject(entry) ? entry.expect : undefined;
    if (JSON.stringify(fields(helper)[field]) !== JSON.stringify(expected)) failed.push({ field, kind: 'frame' });
  }
  return {
    equivalent: failed.length === 0,
    failed,
    transportIdentical: false,
    reason: failed.length === 0 ? 'the semantic result matches; the transport trace need not' : 'the helper does not reach the same result',
  };
}

/**
 * Whether a trace cluster is portable or belongs to one environment.
 *
 * Removing the hostname from a tenant's trace does not make the procedure portable: the
 * environment-local parameters are what carry the coupling.
 *
 * @param {object[]} traces
 */
export function portability(traces = []) {
  const environments = new Set((Array.isArray(traces) ? traces : []).map((run) => run?.environment ?? null).filter(Boolean));
  const parameters = environmentLocal((Array.isArray(traces) ? traces : []).flatMap((run) => run?.values ?? []));
  return {
    portable: environments.size > 1 && parameters.length > 0,
    environments: [...environments].sort(),
    parameters,
    reason:
      environments.size > 1
        ? parameters.length > 0
          ? 'more than one environment and the environment-local values are parameters'
          : 'one environment only, or nothing to parameterise'
        : 'a single environment cannot establish portability, whatever the hostname is called',
  };
}
