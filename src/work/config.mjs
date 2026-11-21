// The `work` namespace: a versioned declaration a knowledge or operations repository makes.
//
// A repository whose product is documents has no package runner to find, and the honest
// answer to "which checks apply" is "the ones it declares, or none". That is what `work`
// carries: scopes, artifact contracts, validators and targets - all reviewable in the
// manifest, none of it inferred from a directory name or a country taxonomy.
//
// Four rules keep adoption honest:
//
//   * `version` is required and must be one this parser knows. A shape it does not know is
//     refused with a remedy, because guessing is how a document scope silently becomes an
//     app or a remote target silently becomes local.
//   * A field that arrived in a later version is refused under an earlier one, by name. The
//     reader then learns that the field needs a version bump, not that the tool never heard
//     of it - and a repository still writing version 1 keeps every field it had.
//   * Unknown keys are refused inside `work`, and two scopes may not claim one path. Both
//     are declarations about what will be checked; a duplicate or a misspelling is a check
//     the repository believes it has and does not.
//   * A path is a repository-relative path. `./docs`, `docs/` and `docs` are one tree, so
//     they are one claim; an absolute path or a `..` segment names something the repository
//     does not own and is refused rather than trimmed into something that resolves.
//
// This module reads nothing and writes nothing: `init` and `doctor` decide when to ask.

import { normalizePath } from './artifacts.mjs';
import { OBLIGATION_KINDS, validatorProblem } from './validators.mjs';

/** The version this build writes. */
export const WORK_VERSION = 2;

/** Every version this parser reads. Version 1 is a version-2 declaration without `ignore`. */
export const SUPPORTED_WORK_VERSIONS = Object.freeze([1, 2, 3]);

/** The version each field arrived in. A field absent here is version 1's. */
const FIELD_VERSION = new Map([['scope.ignore', 2], ['scope.checks', 3], ['scope.independent', 3], ['scope.tracker', 3], ['scope.catalogue', 3], ['scope.share', 3]]);

const TOP_KEYS = new Set(['version', 'scopes', 'targets', 'adapters']);
const SCOPE_KEYS = new Set(['id', 'paths', 'kind', 'validators', 'targets', 'ignore', 'checks', 'independent', 'tracker', 'catalogue', 'share']);
const TARGET_KEYS = new Set(['namespace', 'type', 'name']);
const KINDS = new Set(['source', 'document', 'dataset', 'recipe', 'remote-object']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.length > 0;

function problem(path, message, remedy, code) {
  return { path, message, remedy, code };
}

/** A path a declaration may own, or the problem that says why it may not. */
function pathProblem(at, raw) {
  // A padded path is the one typo normalization cannot see: it stays distinct, claims
  // nothing, and the scope silently holds no artifacts - so it is refused where it is
  // written rather than repaired into a path nobody typed.
  if (raw !== raw.trim()) {
    return problem(
      at,
      `${JSON.stringify(raw)} has leading or trailing whitespace`,
      'write the path without padding; a padded path claims a directory that does not exist',
      'path-padded',
    );
  }
  const normalised = normalizePath(raw);
  if (normalised === null) {
    return problem(
      at,
      `${JSON.stringify(raw)} is not a repository-relative path`,
      'write the path relative to the repository root, with no leading "/" and no ".." segment; a declaration may only claim what the repository owns',
      'path-outside',
    );
  }
  return null;
}

/**
 * Validate a manifest's `work` value.
 *
 * @returns {{ok: boolean, problems: {path: string, message: string, remedy: string, code: string}[]}}
 */
export function validateWork(work) {
  const problems = [];
  if (!isObject(work)) {
    return {
      ok: false,
      problems: [problem('work', 'work must be an object', `write "work": {"version": ${WORK_VERSION}, ...} or remove the key`, 'not-object')],
    };
  }
  const version = work.version;
  if (!SUPPORTED_WORK_VERSIONS.includes(version)) {
    return {
      ok: false,
      problems: [
        problem(
          'work.version',
          `work.version must be one of ${SUPPORTED_WORK_VERSIONS.join(', ')}, not ${JSON.stringify(version)}`,
          `set "work": {"version": ${WORK_VERSION}} or remove the key; this parser refuses a version it does not know`,
          'unsupported-version',
        ),
      ],
    };
  }
  for (const key of Object.keys(work)) {
    if (!TOP_KEYS.has(key)) problems.push(problem(`work.${key}`, `work.${key} is not a known key`, `known keys: ${[...TOP_KEYS].join(', ')}`, 'unknown-key'));
  }

  const scopes = work.scopes ?? [];
  if (!Array.isArray(scopes)) {
    problems.push(problem('work.scopes', 'work.scopes must be a list', 'write scopes as a list of {id, paths}', 'invalid-scopes'));
  } else {
    const ids = new Set();
    const claimed = new Map();
    scopes.forEach((scope, index) => {
      const at = `work.scopes[${index}]`;
      if (!isObject(scope)) {
        problems.push(problem(at, `${at} must be an object`, 'write a scope as {id, paths, kind?}', 'invalid-scope'));
        return;
      }
      if (!isText(scope.id)) problems.push(problem(`${at}.id`, `${at}.id must be a non-empty string`, 'give every scope a stable id', 'invalid-id'));
      else if (ids.has(scope.id)) problems.push(problem(`${at}.id`, `scope id \`${scope.id}\` is declared twice`, 'ids are how artifacts are referenced; a duplicate makes the reference ambiguous', 'duplicate-id'));
      else ids.add(scope.id);
      for (const key of Object.keys(scope)) {
        if (!SCOPE_KEYS.has(key)) problems.push(problem(`${at}.${key}`, `${at}.${key} is not a known key`, `known keys: ${[...SCOPE_KEYS].join(', ')}`, 'unknown-key'));
        else if ((FIELD_VERSION.get(`scope.${key}`) ?? 1) > version) {
          problems.push(
            problem(
              `${at}.${key}`,
              `${at}.${key} is a version ${FIELD_VERSION.get(`scope.${key}`)} field, and this declaration is version ${version}`,
              `set "work": {"version": ${FIELD_VERSION.get(`scope.${key}`)}} at the top of the declaration, or remove ${key}; an older version does not carry it`,
              'field-needs-version',
            ),
          );
        }
      }
      const paths = scope.paths;
      if (!Array.isArray(paths) || paths.length === 0 || !paths.every(isText)) {
        problems.push(problem(`${at}.paths`, `${at}.paths must be a non-empty list of path prefixes`, 'name the directories this scope owns, relative to the repository root', 'invalid-paths'));
      } else {
        paths.forEach((raw, pathIndex) => {
          const bad = pathProblem(`${at}.paths[${pathIndex}]`, raw);
          if (bad !== null) {
            problems.push(bad);
            return;
          }
          // `.` and `''` are both the repository root, so they are one claim like any other.
          const normalised = normalizePath(raw) || '.';
          const holder = claimed.get(normalised);
          if (holder !== undefined) {
            problems.push(problem(`${at}.paths[${pathIndex}]`, `\`${normalised}\` is claimed by both \`${holder}\` and \`${scope.id}\``, 'two scopes on one path is a claim the tool cannot resolve; split the path or drop one', 'path-conflict'));
          } else claimed.set(normalised, scope.id);
        });
      }
      if (scope.kind !== undefined && !KINDS.has(scope.kind)) {
        problems.push(problem(`${at}.kind`, `${at}.kind must be one of ${[...KINDS].join(', ')}`, 'omit kind to let the artifact contract decide it', 'invalid-kind'));
      }
      if (scope.validators !== undefined && (!Array.isArray(scope.validators) || !scope.validators.every(isText))) {
        problems.push(problem(`${at}.validators`, `${at}.validators must be a list of commands`, 'a validator is a command this repository can actually run', 'invalid-validators'));
      }
      if (version >= 3 && scope.checks !== undefined) {
        if (!Array.isArray(scope.checks)) {
          problems.push(problem(`${at}.checks`, 'checks must be a list', 'declare an id, execution and coverage for each check', 'invalid-checks'));
        } else {
          const names = new Set();
          scope.checks.forEach((check, checkIndex) => {
            const field = `${at}.checks[${checkIndex}]`;
            const reason = validatorProblem(check);
            if (reason !== null) problems.push(problem(field, `${field} ${reason}`, 'update the check declaration', 'invalid-check'));
            else if (names.has(check.id)) problems.push(problem(field, `${field} repeats ${check.id}`, 'use a unique check id in the scope', 'duplicate-check'));
            else names.add(check.id);
          });
        }
      }
      if (version >= 3 && scope.independent !== undefined &&
          (!Array.isArray(scope.independent) || scope.independent.some((kind) => !OBLIGATION_KINDS.includes(kind)))) {
        problems.push(problem(`${at}.independent`, 'independent must list obligation kinds', `choose from ${OBLIGATION_KINDS.join(', ')}`, 'invalid-independence'));
      }
      if (version >= 3 && scope.tracker !== undefined) {
        const declaration = scope.tracker;
        if (!isObject(declaration) || !isText(declaration.path) || !['plan', 'markdown-items', 'markdown-table', 'json'].includes(declaration.kind)
            || !['private', 'shared'].includes(declaration.visibility)
            || Object.keys(declaration).some((key) => !['kind', 'path', 'visibility'].includes(key))) {
          problems.push(problem(`${at}.tracker`, 'tracker needs kind, path and visibility', 'declare one plan, markdown-items, markdown-table or json source as private or shared', 'invalid-tracker'));
        } else {
          const bad = pathProblem(`${at}.tracker.path`, declaration.path);
          if (bad !== null) problems.push(bad);
        }
      }
      if (version >= 3 && scope.catalogue !== undefined) {
        if (!isText(scope.catalogue) || !scope.catalogue.endsWith('.json')) {
          problems.push(problem(`${at}.catalogue`, 'catalogue must name a local JSON file', 'use a repository-relative path to a catalogue', 'invalid-catalogue'));
        } else {
          const bad = pathProblem(`${at}.catalogue`, scope.catalogue);
          if (bad !== null) problems.push(bad);
        }
      }
      if (version >= 3 && scope.share !== undefined) {
        if (!Array.isArray(scope.share) || !scope.share.every(isText)) {
          problems.push(problem(`${at}.share`, 'share must list the paths permitted for scoped export', 'list only paths approved for sharing, or omit it to withhold the scope', 'invalid-share-policy'));
        } else scope.share.forEach((path, index) => {
          const bad = pathProblem(`${at}.share[${index}]`, path);
          if (bad !== null) problems.push(bad);
        });
      }
      if (scope.targets !== undefined && (!Array.isArray(scope.targets) || !scope.targets.every(isText))) {
        problems.push(problem(`${at}.targets`, `${at}.targets must be a list of target ids`, 'reference a declared target by its id', 'invalid-targets'));
      }
      if (version >= 2 && scope.ignore !== undefined) {
        if (!Array.isArray(scope.ignore) || !scope.ignore.every(isText)) {
          problems.push(problem(`${at}.ignore`, `${at}.ignore must be a list of paths or file names`, 'list what this scope never ingests, as a path prefix or a single segment', 'invalid-ignore'));
        } else {
          scope.ignore.forEach((raw, ignoreIndex) => {
            const bad = pathProblem(`${at}.ignore[${ignoreIndex}]`, raw);
            if (bad !== null) problems.push({ ...bad, path: `${at}.ignore[${ignoreIndex}]` });
          });
        }
      }
    });
  }

  const targets = work.targets ?? [];
  if (!Array.isArray(targets)) {
    problems.push(problem('work.targets', 'work.targets must be a list', 'write targets as a list of {namespace, type}', 'invalid-targets'));
  } else {
    targets.forEach((target, index) => {
      const at = `work.targets[${index}]`;
      if (!isObject(target)) {
        problems.push(problem(at, `${at} must be an object`, 'write a target as {namespace, type, name?}', 'invalid-target'));
        return;
      }
      for (const key of Object.keys(target)) {
        if (!TARGET_KEYS.has(key)) problems.push(problem(`${at}.${key}`, `${at}.${key} is not a known key`, `known keys: ${[...TARGET_KEYS].join(', ')}`, 'unknown-key'));
      }
      if (!isText(target.namespace)) problems.push(problem(`${at}.namespace`, `${at}.namespace must be a non-empty string`, 'a target without a namespace has no identity', 'invalid-target'));
      if (!isText(target.type)) problems.push(problem(`${at}.type`, `${at}.type must be a non-empty string`, 'a target without a type has no identity', 'invalid-target'));
    });
  }

  if (work.adapters !== undefined && (!Array.isArray(work.adapters) || !work.adapters.every(isText))) {
    problems.push(problem('work.adapters', 'work.adapters must be a list of adapter ids', 'adapters are installed separately; list only the ones this repository intends to use', 'invalid-adapters'));
  }

  return { ok: problems.length === 0, problems };
}

/**
 * The effective declaration: every path in the spelling a resolver compares.
 *
 * Callers check `validateWork` first; this function is the one place the validated shape is
 * flattened, so `work inspect`, the facet probe and the validator probe cannot read three
 * spellings of the same scope.
 *
 * @param {{version?: number, scopes?: object[], targets?: object[], adapters?: string[]}} work
 * @returns {{version: number|null, scopes: {id: string, paths: string[], kind: string|null, validators: string[], ignore: string[]}[], targets: object[], adapters: string[]}}
 */
export function normalizedWork(work) {
  const scopes = Array.isArray(work?.scopes) ? work.scopes.filter(isObject) : [];
  return {
    version: Number.isInteger(work?.version) ? work.version : null,
    scopes: scopes.map((scope) => ({
      id: String(scope.id ?? ''),
      paths: (Array.isArray(scope.paths) ? scope.paths : []).map((path) => normalizePath(path) ?? path),
      kind: typeof scope.kind === 'string' ? scope.kind : null,
      validators: (Array.isArray(scope.validators) ? scope.validators : []).filter(isText),
      ignore: (Array.isArray(scope.ignore) ? scope.ignore : []).filter(isText),
      ...(Array.isArray(scope.checks) ? { checks: scope.checks } : {}),
      ...(Array.isArray(scope.independent) ? { independent: scope.independent } : {}),
      ...(typeof scope.catalogue === 'string' ? { catalogue: normalizePath(scope.catalogue) } : {}),
      ...(Array.isArray(scope.share) ? { share: scope.share.map((path) => normalizePath(path) || '.') } : {}),
      ...(isObject(scope.tracker) ? { tracker: { ...scope.tracker, path: normalizePath(scope.tracker.path) || '.' } } : {}),
    })),
    targets: Array.isArray(work?.targets) ? work.targets.filter(isObject) : [],
    adapters: Array.isArray(work?.adapters) ? work.adapters.filter(isText) : [],
  };
}
