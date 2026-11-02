// The manifest's own schema: one table of the keys this file may carry, and one
// loader that says what is wrong with the file rather than throwing or guessing.
//
// The manifest was read in 29 places, each doing a bare `JSON.parse` and then
// reaching for the key it wanted. That is three answers to "what is this repo" -
// the parse, the key access, and whatever default the caller invented - and a
// manifest with `"mode": "kernal"` reached the projection as a mode it had never
// heard of. A typo in one key silently changed behaviour, because nothing in the
// tool had ever said what the keys are.
//
// Every shape below was read off the manifest this repository carries, not from
// memory: the first draft of this table called `limits.fileLines` a positive integer
// and `surfaces` an object, and both are wrong in the only file the tool has to hand.
// `test/manifest-schema.test.mjs` holds the table to that file, which is the check
// that would have caught it.
//
// `owner` is the reason a key is in this table at all. A `tool` key is written by
// this binary and a repository editing it is fighting the writer; a `repo` key is
// the repository's own declaration and this tool only reads it. The distinction is
// already load-bearing (`GENERATED_KEYS`, `init` keeping `limits`), and stating it
// here is what keeps the two from drifting apart.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MANIFEST_FILE, MANIFEST_LEGACY } from '../name.mjs';
import { WORK_VERSION, validateWork } from '../work/config.mjs';

/** Absent means 1: the field arrived after the file did, and every file predates it. */
const MANIFEST_VERSION = 1;

/**
 * The manifest a repository has, which is not necessarily the one this tool would write.
 *
 * The file was renamed from `simt-dev.json` to `simt.json`. Every read site used to say
 * `join(root, MANIFEST_FILE)` and would have reported an adopted repository as unadopted the
 * day the constant moved - and "no manifest" means "never adopted", which is the answer
 * that offers to re-adopt a repo that is already done. Fourteen repositories carry the
 * old name on disk.
 *
 * So the old name is read as a fallback and the new one is written. `writeManifest`
 * renames rather than creating a second file, which is how the window closes: the first
 * `simt init` or `simt sync` in an adopted repo retires the old name by moving it.
 */
export async function manifestPath(root) {
  const next = join(root, MANIFEST_FILE);
  if (existsSync(next)) return next;
  const previous = join(root, MANIFEST_LEGACY);
  return existsSync(previous) ? previous : next;
}


const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isStringList = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
const isPositiveInt = (value) => Number.isInteger(value) && value > 0;

/**
 * The keys a manifest may carry.
 *
 * `check` returns a sentence naming what is wrong, or null. It returns a sentence
 * rather than a boolean because the reader of a problem is a person looking at a file
 * they edited by hand, and "invalid" tells them nothing they did not know.
 */
export const KEYS = [
  { key: '$comment', owner: 'tool', generated: true, since: '0.7.0', check: (v) => (typeof v === 'string' || isStringList(v) ? null : '$comment must be a string or a list of strings') },
  { key: 'id', owner: 'tool', since: '0.7.0', check: (v) => (typeof v === 'string' && v.length > 0 ? null : 'id must be a non-empty string') },
  { key: 'version', owner: 'tool', since: '0.9.0', check: (v) => (Number.isInteger(v) && v >= 1 ? null : 'version must be an integer of at least 1') },
  { key: 'stack', owner: 'tool', since: '0.7.0', check: (v) => (isStringList(v) ? null : 'stack must be a list of profile ids') },
  { key: 'limits', owner: 'repo', since: '0.7.0', check: (v) => (isObject(v) ? null : 'limits must be an object') },
  // {warn, error, excludeTextFiles, exclude} - ADR-005's two tiers plus the paths a
  // repository opts out of, all of which the repository owns and `init` keeps.
  { key: 'limits.fileLines', owner: 'repo', since: '0.7.0', check: (v) => (isObject(v) && isPositiveInt(v.warn) && isPositiveInt(v.error) && v.error >= v.warn ? null : 'limits.fileLines must be {warn, error} with error >= warn') },
  { key: 'limits.coverage', owner: 'repo', since: '0.7.0', check: (v) => (v === null || (typeof v === 'number' && v >= 0 && v <= 100) ? null : 'limits.coverage must be null or a percentage') },
  { key: 'gates', owner: 'repo', since: '0.7.0', check: (v) => (isObject(v) ? null : 'gates must be an object of gate name to command') },
  { key: 'localSkills', owner: 'repo', since: '0.7.0', check: (v) => (isStringList(v) ? null : 'localSkills must be a list of skill ids') },
  { key: 'profiles', owner: 'repo', since: '0.8.0', check: (v) => (isStringList(v) ? null : 'profiles must be a list of profile ids') },
  { key: 'substitutions', owner: 'repo', since: '0.8.0', check: (v) => (isObject(v) ? null : 'substitutions must be an object keyed by rule id') },
  { key: 'packs', owner: 'repo', since: '0.8.0', check: (v) => (Array.isArray(v) ? null : 'packs must be a list') },
  // A workspace declaration is a path relative to the repository; `workspace.mjs`
  // refuses to walk one that resolves outside, so the type is the whole check.
  { key: 'workspace', owner: 'repo', since: '0.7.0', check: (v) => (typeof v === 'string' ? null : 'workspace must be a path string') },
  { key: 'decisions', owner: 'repo', since: '0.8.0', check: (v) => (isObject(v) ? null : 'decisions must be an object') },
  { key: 'budget', owner: 'repo', since: '0.8.0', check: (v) => (isObject(v) ? null : 'budget must be an object') },
  { key: 'budget.bytes', owner: 'repo', since: '0.8.0', check: (v) => (isPositiveInt(v) ? null : 'budget.bytes must be a positive integer') },
  { key: 'mode', owner: 'repo', since: '0.8.0', check: (v) => (v === 'full' || v === 'kernel' ? null : 'mode must be "full" or "kernel", not ' + JSON.stringify(v)) },
  { key: 'shared', owner: 'repo', since: '0.8.0', check: (v) => (isObject(v) ? null : 'shared must be an object') },
  // The overlay `plan/template.mjs` compiles over the default tracker body; an array
  // would be accepted by an object-typed read and then produce an empty template.
  { key: 'plans', owner: 'repo', since: '0.7.0', check: (v) => (isObject(v) ? null : 'plans must be an object overlay') },
  // Null and absent both mean "the global standard applies" (manifestDrift's own
  // rule), and a list is what `init` writes. An object here is a shape nothing has
  // ever produced, so accepting it would be the validator blessing a typo.
  { key: 'surfaces', owner: 'repo', since: '0.8.0', check: (v) => (v === null || isStringList(v) ? null : 'surfaces must be null or a list of surface ids') },
  { key: 'projection', owner: 'tool', generated: true, since: '0.7.0', check: (v) => (isObject(v) ? null : 'projection must be an object') },
];

const KNOWABLE = new Set(KEYS.map((entry) => entry.key));

/** The keys this tool writes, derived from the table: the `generated` marks above. */
export const GENERATED_KEYS_OF = new Set(KEYS.filter((entry) => entry.generated === true).map((entry) => entry.key));


/**
 * Namespaces a consumer registered against this table.
 *
 * A namespace is a sub-object of the manifest that another part of the tool owns -
 * `work` is the first. It registers its keys here rather than editing the
 * table, so adding one touches two files and no reader has to learn a second shape
 */
const NAMESPACES = new Map();

/**
 * Declare the keys of one namespace. Registered keys are checked exactly like top-level
 * ones; a namespace nobody registered is left alone, because an unknown key has never
 * been an error in this file.
 *
 * @param {string} name the manifest key that carries the namespace
 * @param {{key: string, since?: string, check: (value: unknown) => string|null}[]} keys
 * @returns {number} how many keys the namespace declares
 */
export function registerNamespace(name, keys) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error('namespace "' + name + '" must be lower-case words joined by hyphens');
  }
  if (KNOWABLE.has(name)) throw new Error('namespace "' + name + '" is already a manifest key');
  if (NAMESPACES.has(name)) throw new Error('namespace "' + name + '" is already registered');
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('namespace "' + name + '" must register at least one key');
  }
  for (const entry of keys) {
    if (typeof entry?.key !== 'string' || !/^[a-z][a-z0-9]*$/.test(entry.key)) {
      throw new Error('namespace "' + name + '" keys must be lower-case single words');
    }
    if (typeof entry.check !== 'function') {
      throw new Error('namespace "' + name + '" key "' + entry.key + '" has no check');
    }
  }
  NAMESPACES.set(name, keys.map((entry) => ({ owner: 'repo', since: '0.9.0', ...entry })));
  return keys.length;
}

/** The namespaces a consumer declared, for a reader that needs the whole set. */
export function registeredNamespaces() {
  return [...NAMESPACES.keys()].sort();
}

/**
 * What is wrong with one parsed manifest.
 *
 * An unknown key is not a problem. A repository that keeps its own note in this file
 * is doing the thing the file's own comment invites, and a validator that refused it
 * would be the tool insisting its schema is the whole of a file it calls the
 * repository's. Only a KNOWN key with an impossible value is reported.
 */
export function manifestProblems(manifest) {
  const problems = [];
  for (const { key, check } of KEYS) {
    const [head, tail] = key.includes('.') ? key.split('.') : [key, null];
    if (!(head in manifest)) continue;
    if (tail !== null && (!isObject(manifest[head]) || !(tail in manifest[head]))) continue;
    const value = tail === null ? manifest[head] : manifest[head][tail];
    if (value === undefined) continue;
    const problem = check(value);
    if (problem !== null) problems.push(problem);
  }
  for (const [name, keys] of NAMESPACES) {
    const value = manifest[name];
    if (!isObject(value)) continue;
    for (const entry of keys) {
      if (!(entry.key in value) || value[entry.key] === undefined) continue;
      const problem = entry.check(value[entry.key]);
      if (problem !== null) problems.push(name + '.' + entry.key + ': ' + problem);
    }
  }
  return problems;
}

/**
 * The manifest a repository has, with its problems named.
 *
 * `manifest` is null when there is no file and when the file does not parse, because
 * a caller that receives a half-read object cannot tell which it has - and the one
 * caller that did (`fingerprint`) returned `{error}` in place of a manifest, so a
 * broken file looked like a declaration of a key called `error`.
 * `exists` and `problems` are what tell the two apart, and neither is optional.
 *
 * @returns {Promise<{manifest: object|null, exists: boolean, version: number, problems: string[], path: string}>}
 */
export async function loadManifest(root) {
  const path = await manifestPath(root);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { manifest: null, exists: false, version: MANIFEST_VERSION, problems: [], path };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { manifest: null, exists: true, version: MANIFEST_VERSION, problems: [`unparseable: ${error.message}`], path };
  }
  if (!isObject(parsed)) {
    return { manifest: null, exists: true, version: MANIFEST_VERSION, problems: ['not a JSON object'], path };
  }
  return {
    manifest: parsed,
    exists: true,
    version: Number.isInteger(parsed.version) ? parsed.version : MANIFEST_VERSION,
    problems: manifestProblems(parsed),
    path,
  };
}

/** One key of the `work` namespace, reported through the same problem surface as the rest. */
function workKeyProblem(key, value) {
  const scoped = validateWork({ version: WORK_VERSION, [key]: value });
  const found = scoped.problems.find((entry) => entry.path.startsWith(`work.${key}`));
  return found === undefined ? null : `${found.message}; ${found.remedy}`;
}

// `work` is one object with rules across its fields - duplicate scope ids, two scopes on
// one path - so it registers as a namespace rather than as separate top-level keys
// (ADR-144). Registering here means every reader of the manifest gets the validation,
// not only the code that happens to import the work module.
registerNamespace('work', [
  {
    key: 'version',
    since: '0.8.0',
    check: (v) => (v === WORK_VERSION ? null : `must be ${WORK_VERSION}, not ${JSON.stringify(v)}; set "work": {"version": ${WORK_VERSION}} or remove the key`),
  },
  { key: 'scopes', since: '0.8.0', check: (v) => workKeyProblem('scopes', v) },
  { key: 'targets', since: '0.8.0', check: (v) => workKeyProblem('targets', v) },
  { key: 'adapters', since: '0.8.0', check: (v) => workKeyProblem('adapters', v) },
]);
