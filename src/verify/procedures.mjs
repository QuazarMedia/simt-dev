// Recipe and procedure contracts (W26).
//
// A repository describes its own procedures in its own language: a decorated Python function, a
// shell recipe, a runbook with steps. The adapter's job is to read what those annotations already
// say, not to translate them into a second vocabulary that then drifts from the first.
//
// Four rules follow, and each one is a failure this module exists to prevent:
//
//   * The annotations survive verbatim. `@not_idempotent`, `@mutates` and `@graduated` are
//     recorded as they were written, because the local text is the authority and a summary that
//     softens "not idempotent" into "may be retried" is a different procedure.
//   * An orchestration is not a function. A runbook that calls three recipes and waits for a
//     person is `kind: 'orchestration'` with `callable: false`, even when it contains a `def`:
//     treating it as one callable hides the steps and the waits that make it work.
//   * Unparsed text stays unparsed, and the coverage says so. A prose section the adapter does
//     not understand is listed with a reason and a fraction, never silently dropped and never
//     guessed at.
//   * A capability is not a type. A fallback that returns the same object but cannot honour the
//     privacy the procedure requires is rejected, because the shape of the return value is not
//     the guarantee the caller needs.
//
// The checks reuse what the repository already declares: imports are compared against the files
// it has, prerequisites against each other, calls against the recipes that exist. Nothing here
// runs a procedure or opens a file.

export const PROCEDURES_SCHEMA_VERSION = 1;

/** The three things a procedure document can be. */
export const PROCEDURE_KINDS = Object.freeze(['reference', 'recipe', 'orchestration']);

/** Effect kinds that change something outside the process. */
const MUTATING_EFFECTS = new Set(['remote-write', 'delete', 'publish', 'grant', 'charge', 'send']);

// A repo writes `@not_idempotent` as readily as `@not-idempotent`; the tag is the same tag.
const ANNOTATION = /^\s*(?:#|\/\/|--)\s*@([a-z][a-z_-]*)(?:\s+(.*?))?\s*$/i;
const DECLARATION = /^\s*(?:async\s+)?(def|class|function|import|from|export|const|let)\b/;

const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const problem = (code, detail, remedy) => ({ code, detail, remedy });

/** Prose is the reason worth reporting; anything else the adapter simply does not know. */
const unparsedReason = (line) => (/^[A-Za-z][A-Za-z0-9 ,.'%()/-]*$/.test(line.trim()) || line.trim().startsWith('#') ? 'prose' : 'unrecognised-syntax');

/**
 * Read one procedure from its repo-owned text.
 *
 * @param {string} text
 * @param {{path?: string|null}} [options]
 */
export function readProcedure(text, { path = null } = {}) {
  const record = {
    version: PROCEDURES_SCHEMA_VERSION,
    path,
    id: null,
    kind: 'reference',
    callable: false,
    inputs: [],
    outputs: [],
    imports: [],
    actors: [],
    flags: [],
    effects: [],
    idempotent: null,
    mutates: null,
    graduated: null,
    postconditions: [],
    prerequisites: [],
    privacy: { required: [], implemented: [] },
    returns: null,
    calls: [],
    steps: [],
    problems: [],
    unparsed: [],
  };

  const lines = String(text ?? '').split('\n');
  let parsed = 0;
  let total = 0;
  let hasDefinition = false;

  const pushUnique = (list, value) => {
    if (!list.includes(value)) list.push(value);
  };

  lines.forEach((raw, index) => {
    const line = raw.replace(/\s+$/, '');
    if (line.trim().length === 0) return;
    total += 1;

    const annotation = ANNOTATION.exec(line);
    if (annotation !== null) {
      parsed += 1;
      const name = annotation[1].toLowerCase();
      const value = (annotation[2] ?? '').trim();
      switch (name) {
        case 'recipe':
          record.id = isText(value) ? value : record.id;
          record.kind = 'recipe';
          break;
        case 'kind':
          if (PROCEDURE_KINDS.includes(value)) record.kind = value;
          else record.problems.push(problem('unknown-kind', `${JSON.stringify(value)} is not one of ${PROCEDURE_KINDS.join(', ')}`, 'write the kind the procedure actually is'));
          break;
        case 'input': {
          const colon = value.indexOf(':');
          const input = colon === -1 ? { name: value, type: null } : { name: value.slice(0, colon), type: value.slice(colon + 1) };
          if (!isText(input.name)) record.problems.push(problem('input', `line ${index + 1} names no input`, 'write @input name:type'));
          else record.inputs.push(input);
          break;
        }
        case 'output':
          if (isText(value)) record.outputs.push(value);
          break;
        case 'imports':
        case 'import':
          if (isText(value)) record.imports.push(value);
          break;
        case 'actor':
          if (isText(value)) pushUnique(record.actors, value);
          break;
        case 'flag':
          if (isText(value)) pushUnique(record.flags, value);
          break;
        case 'effect': {
          const colon = value.indexOf(':');
          const effect = colon === -1 ? { kind: value, target: null } : { kind: value.slice(0, colon), target: value.slice(colon + 1) };
          if (!isText(effect.kind)) record.problems.push(problem('effect', `line ${index + 1} names no effect`, 'write @effect kind:target'));
          else record.effects.push(effect);
          break;
        }
        case 'idempotent':
          record.idempotent = true;
          break;
        case 'not-idempotent':
        case 'not_idempotent':
          // Verbatim: the local spelling of "not idempotent" is the authority.
          record.idempotent = false;
          break;
        case 'mutates':
          record.mutates = true;
          break;
        case 'graduated':
          record.graduated = isText(value) ? value : null;
          break;
        case 'postcondition':
          if (isText(value)) record.postconditions.push(value);
          break;
        case 'prerequisite': {
          const colon = value.indexOf(':');
          const dimension = colon === -1 ? value : value.slice(0, colon);
          const raw2 = colon === -1 ? '' : value.slice(colon + 1);
          const absent = raw2.startsWith('!');
          record.prerequisites.push({ dimension, value: absent ? raw2.slice(1) : raw2, present: !absent });
          break;
        }
        case 'privacy': {
          const colon = value.indexOf(':');
          const which = colon === -1 ? '' : value.slice(0, colon);
          const requirement = colon === -1 ? value : value.slice(colon + 1);
          if (which === 'required' && isText(requirement)) pushUnique(record.privacy.required, requirement);
          else if (which === 'implemented' && isText(requirement)) pushUnique(record.privacy.implemented, requirement);
          else record.problems.push(problem('privacy', `line ${index + 1} does not say required or implemented`, 'write @privacy required:<semantic> or @privacy implemented:<semantic>'));
          break;
        }
        case 'returns':
          record.returns = isText(value) ? value : null;
          break;
        case 'calls':
          if (isText(value)) pushUnique(record.calls, value);
          break;
        case 'step':
          if (isText(value)) record.steps.push(value);
          break;
        default:
          record.unparsed.push({ line: index + 1, text: line, reason: 'unsupported-annotation' });
          break;
      }
      return;
    }

    if (DECLARATION.test(line)) {
      parsed += 1;
      hasDefinition = true;
      return;
    }
    // A line indented under a definition is the body the adapter does not interpret; counting
    // it as unparsed prose would understate coverage for every real procedure.
    if (hasDefinition && /^\s{2,}\S/.test(line)) {
      parsed += 1;
      return;
    }
    record.unparsed.push({ line: index + 1, text: line, reason: unparsedReason(line) });
  });

  record.callable = record.kind === 'recipe' && hasDefinition;
  if (record.kind === 'orchestration' && record.steps.length === 0) {
    record.problems.push(problem('orchestration-without-steps', 'an orchestration is declared with no steps', 'list what it calls and waits for with @step, or declare it a recipe'));
  }
  for (const effect of record.effects) {
    if (MUTATING_EFFECTS.has(effect.kind) && record.mutates !== true) {
      record.problems.push(
        problem('undocumented-mutation', `${effect.kind}${effect.target === null ? '' : ` ${effect.target}`} changes something outside the process, but the procedure does not say it mutates`, 'add @mutates, or remove the effect'),
      );
    }
  }
  const names = new Set();
  for (const input of record.inputs) {
    if (names.has(input.name)) record.problems.push(problem('duplicate-input', `${input.name} is declared twice`, 'name each input once'));
    names.add(input.name);
  }

  record.coverage = { total, parsed, unparsed: record.unparsed.length, fraction: total === 0 ? 1 : parsed / total };
  return record;
}

/**
 * Check a set of procedures against each other and against the repository's files.
 *
 * @param {object[]} records
 * @param {{files?: string[]|null}} [options]
 */
export function checkProcedures(records = [], { files = null } = {}) {
  const list = (Array.isArray(records) ? records : []).filter((record) => record !== null && typeof record === 'object');
  const problems = [];
  const known = new Set(files === null ? [] : (Array.isArray(files) ? files : []));
  const ids = new Set(list.map((record) => record.id).filter(isText));

  for (const record of list) {
    const where = isText(record.id) ? record.id : record.path ?? 'a procedure';
    for (const imported of Array.isArray(record.imports) ? record.imports : []) {
      if (files !== null && !known.has(imported)) {
        problems.push({ procedure: where, ...problem('missing-import', `${where} imports ${imported}, which this repository does not have`, `add ${imported}, or correct the import in ${where}`) });
      }
    }
    const flags = new Map();
    for (const prerequisite of Array.isArray(record.prerequisites) ? record.prerequisites : []) {
      if (prerequisite.dimension !== 'flag' || !isText(prerequisite.value)) continue;
      const seen = flags.get(prerequisite.value);
      if (seen !== undefined && seen !== prerequisite.present) {
        problems.push({ procedure: where, ...problem('impossible-prerequisites', `${where} requires ${prerequisite.value} both present and absent`, 'remove one prerequisite; no environment satisfies both') });
      }
      flags.set(prerequisite.value, prerequisite.present);
    }
    for (const call of Array.isArray(record.calls) ? record.calls : []) {
      if (!ids.has(call)) {
        problems.push({ procedure: where, ...problem('missing-procedure', `${where} calls ${call}, which no procedure declares`, `declare ${call}, or correct the call`) });
      }
    }
  }

  const edges = new Map(list.filter((record) => isText(record.id)).map((record) => [record.id, (Array.isArray(record.calls) ? record.calls : []).filter((call) => ids.has(call))]));
  const state = new Map();
  const cycles = [];
  const visit = (id, trail) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'open') {
      cycles.push([...trail.slice(trail.indexOf(id)), id].join(' -> '));
      return;
    }
    state.set(id, 'open');
    for (const next of edges.get(id) ?? []) visit(next, [...trail, next]);
    state.set(id, 'done');
  };
  for (const id of edges.keys()) visit(id, [id]);
  for (const cycle of [...new Set(cycles)].sort()) {
    problems.push(problem('cycle', `the call graph cycles: ${cycle}`, 'break the cycle, or record the recursion as an orchestration step'));
  }

  const total = list.reduce((sum, record) => sum + (record.coverage?.total ?? 0), 0);
  const parsed = list.reduce((sum, record) => sum + (record.coverage?.parsed ?? 0), 0);
  const unparsed = list.flatMap((record) => (Array.isArray(record.unparsed) ? record.unparsed.map((entry) => ({ ...entry, procedure: record.id ?? record.path ?? null })) : []));

  return {
    version: PROCEDURES_SCHEMA_VERSION,
    ok: problems.length === 0,
    problems: problems.sort((a, b) => String(a.procedure ?? '').localeCompare(String(b.procedure ?? '')) || a.code.localeCompare(b.code)),
    coverage: { total, parsed, unparsed: unparsed.length, fraction: total === 0 ? 1 : parsed / total },
    unparsed,
  };
}

/**
 * Choose the fallback that can honour the call, not the one that returns the same type.
 *
 * @param {object[]} candidates
 * @param {{returns?: string|null, privacy?: string[]}} requirement
 */
export function selectFallback(candidates = [], { returns = null, privacy = [] } = {}) {
  const required = (Array.isArray(privacy) ? privacy : []).filter(isText);
  const rejected = [];
  let chosen = null;

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (candidate === null || typeof candidate !== 'object' || !isText(candidate.id)) continue;
    if (returns !== null && candidate.returns !== returns) {
      rejected.push({ id: candidate.id, reason: 'returns-mismatch' });
      continue;
    }
    const implemented = new Set((Array.isArray(candidate.privacy?.implemented) ? candidate.privacy.implemented : []).filter(isText));
    const missing = required.filter((semantic) => !implemented.has(semantic));
    if (missing.length > 0) {
      rejected.push({ id: candidate.id, reason: 'privacy-unsatisfied', missing });
      continue;
    }
    if (chosen === null) chosen = candidate.id;
  }

  return { chosen, rejected: rejected.sort((a, b) => a.id.localeCompare(b.id)) };
}
