// The `work` namespace: a versioned declaration a knowledge or operations repository makes.
//
// A repository whose product is documents has no package runner to find, and the honest
// answer to "which checks apply" is "the ones it declares, or none". That is what `work`
// carries: scopes, artifact contracts, validators and targets - all reviewable in the
// manifest, none of it inferred from a directory name or a country taxonomy.
//
// Two rules keep adoption honest:
//
//   * `version` is required and matched exactly. A shape this parser does not know is
//     refused with a remedy, because guessing is how a document scope silently becomes an
//     app or a remote target silently becomes local.
//   * Unknown keys are refused inside `work`, and two scopes may not claim the same path.
//     Both are declarations about what will be checked; a duplicate or a misspelling is a
//     check the repository believes it has and does not.
//
// This module reads nothing and writes nothing: `init` and `doctor` decide when to ask.

/** The only schema version this parser understands. */
export const WORK_VERSION = 1;

const TOP_KEYS = new Set(['version', 'scopes', 'targets', 'adapters']);
const SCOPE_KEYS = new Set(['id', 'paths', 'kind', 'validators', 'targets']);
const TARGET_KEYS = new Set(['namespace', 'type', 'name']);
const KINDS = new Set(['source', 'document', 'dataset', 'recipe', 'remote-object']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.length > 0;

function problem(path, message, remedy) {
  return { path, message, remedy };
}

/**
 * Validate a manifest's `work` value.
 *
 * @returns {{ok: boolean, problems: {path: string, message: string, remedy: string}[]}}
 */
export function validateWork(work) {
  const problems = [];
  if (!isObject(work)) {
    return { ok: false, problems: [problem('work', 'work must be an object', 'write "work": {"version": 1, ...} or remove the key')] };
  }
  if (work.version !== WORK_VERSION) {
    return {
      ok: false,
      problems: [problem('work.version', `work.version must be ${WORK_VERSION}, not ${JSON.stringify(work.version)}`, `set "work": {"version": ${WORK_VERSION}} or remove the key; this parser refuses a version it does not know`)],
    };
  }
  for (const key of Object.keys(work)) {
    if (!TOP_KEYS.has(key)) problems.push(problem(`work.${key}`, `work.${key} is not a known key`, `known keys: ${[...TOP_KEYS].join(', ')}`));
  }

  const scopes = work.scopes ?? [];
  if (!Array.isArray(scopes)) {
    problems.push(problem('work.scopes', 'work.scopes must be a list', 'write scopes as a list of {id, paths}'));
  } else {
    const ids = new Set();
    const claimed = new Map();
    scopes.forEach((scope, index) => {
      const at = `work.scopes[${index}]`;
      if (!isObject(scope)) {
        problems.push(problem(at, `${at} must be an object`, 'write a scope as {id, paths, kind?}'));
        return;
      }
      if (!isText(scope.id)) problems.push(problem(`${at}.id`, `${at}.id must be a non-empty string`, 'give every scope a stable id'));
      else if (ids.has(scope.id)) problems.push(problem(`${at}.id`, `scope id \`${scope.id}\` is declared twice`, 'ids are how artifacts are referenced; a duplicate makes the reference ambiguous'));
      else ids.add(scope.id);
      for (const key of Object.keys(scope)) {
        if (!SCOPE_KEYS.has(key)) problems.push(problem(`${at}.${key}`, `${at}.${key} is not a known key`, `known keys: ${[...SCOPE_KEYS].join(', ')}`));
      }
      const paths = scope.paths;
      if (!Array.isArray(paths) || paths.length === 0 || !paths.every(isText)) {
        problems.push(problem(`${at}.paths`, `${at}.paths must be a non-empty list of path prefixes`, 'name the directories this scope owns, relative to the repository root'));
      } else {
        for (const path of paths) {
          if (claimed.has(path)) {
            problems.push(problem(`${at}.paths`, `\`${path}\` is claimed by both \`${claimed.get(path)}\` and \`${scope.id}\``, 'two scopes on one path is a claim the tool cannot resolve; split the path or drop one'));
          } else claimed.set(path, scope.id);
        }
      }
      if (scope.kind !== undefined && !KINDS.has(scope.kind)) {
        problems.push(problem(`${at}.kind`, `${at}.kind must be one of ${[...KINDS].join(', ')}`, 'omit kind to let the artifact contract decide it'));
      }
      if (scope.validators !== undefined && (!Array.isArray(scope.validators) || !scope.validators.every(isText))) {
        problems.push(problem(`${at}.validators`, `${at}.validators must be a list of commands`, 'a validator is a command this repository can actually run'));
      }
      if (scope.targets !== undefined && (!Array.isArray(scope.targets) || !scope.targets.every(isText))) {
        problems.push(problem(`${at}.targets`, `${at}.targets must be a list of target ids`, 'reference a declared target by its id'));
      }
    });
  }

  const targets = work.targets ?? [];
  if (!Array.isArray(targets)) {
    problems.push(problem('work.targets', 'work.targets must be a list', 'write targets as a list of {namespace, type}'));
  } else {
    targets.forEach((target, index) => {
      const at = `work.targets[${index}]`;
      if (!isObject(target)) {
        problems.push(problem(at, `${at} must be an object`, 'write a target as {namespace, type, name?}'));
        return;
      }
      for (const key of Object.keys(target)) {
        if (!TARGET_KEYS.has(key)) problems.push(problem(`${at}.${key}`, `${at}.${key} is not a known key`, `known keys: ${[...TARGET_KEYS].join(', ')}`));
      }
      if (!isText(target.namespace)) problems.push(problem(`${at}.namespace`, `${at}.namespace must be a non-empty string`, 'a target without a namespace has no identity'));
      if (!isText(target.type)) problems.push(problem(`${at}.type`, `${at}.type must be a non-empty string`, 'a target without a type has no identity'));
    });
  }

  if (work.adapters !== undefined && (!Array.isArray(work.adapters) || !work.adapters.every(isText))) {
    problems.push(problem('work.adapters', 'work.adapters must be a list of adapter ids', 'adapters are installed separately; list only the ones this repository intends to use'));
  }

  return { ok: problems.length === 0, problems };
}
