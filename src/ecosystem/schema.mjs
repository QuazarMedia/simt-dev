// What a repository-local ecosystem record may say.
//
// A local record is configuration, and configuration arrives from a reader who cannot
// see this source. The loader used to merge whatever parsed, so an ecosystem with
// `manifestOrder` and no `facts` crashed `init` on `facts[0]`, and a language named only
// in a local record resolved through the loader while the index had never heard of it.
// Validation here is the difference between a config error and a bug report.
//
// The schema is versioned and bounded. Versioned because a future field must be able to
// say so rather than being guessed at; bounded because a record is read on every
// detection pass and nothing about it is large.
//
// Quarantine, not repair: a record with a problem is dropped whole and named, and the
// shipped record with its id (if any) stays in force. Half-applying a record is how one
// invalid field silently changes what a repository's gates do.

const RECORD_VERSION = 1;
/** A record larger than this is not a record; it is a paste. */
export const MAX_RECORD_BYTES = 64 * 1024;
/** More local files than this under `.simt/ecosystems/` is a directory to look at. */
export const MAX_LOCAL_RECORDS = 64;

const ID = /^[a-z0-9][a-z0-9-]*$/;
const FACT = /^has-[a-z0-9-]+$/;
const LANG = /^[a-z0-9][a-z0-9+#-]*$/;
const EXT = /^\.[A-Za-z0-9.]+$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value) => Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry !== '');

/**
 * Validate one local record.
 *
 * @param {string} id the file stem, which the record's own id must match
 * @param {unknown} rec the parsed JSON
 * @param {{bytes?: number}} [options]
 * @returns {{ok: true, record: object} | {ok: false, problems: string[]}}
 */
export function validateRecord(id, rec, { bytes = 0 } = {}) {
  const problems = [];
  const bad = (message) => problems.push(message);

  if (bytes > MAX_RECORD_BYTES) bad(`${id}.json is ${bytes} bytes; a record is at most ${MAX_RECORD_BYTES}`);
  if (!isObject(rec)) return { ok: false, problems: [...problems, `${id}.json is not a JSON object`] };

  if (rec.v !== undefined) {
    if (!Number.isInteger(rec.v) || rec.v < 1) bad(`v must be a positive integer`);
    else if (rec.v > RECORD_VERSION) bad(`v ${rec.v} is newer than this build reads (${RECORD_VERSION})`);
  }
  if (rec.id !== undefined && rec.id !== id) bad(`id "${rec.id}" does not match the file name "${id}"`);
  if (rec.id === undefined) bad('id is required, and must match the file name');
  if (!ID.test(id)) bad(`"${id}" is not a usable record id (lowercase letters, digits and hyphens)`);

  if (rec.facts !== undefined && !strings(rec.facts)) bad('facts must be a list of strings');
  for (const fact of rec.facts ?? []) {
    if (!FACT.test(fact)) bad(`facts "${fact}" is not a has-* fact`);
  }

  // `manifestOrder` seeds a gate row, and the row reads the fact that proves the
  // ecosystem: a row with no fact is the shape that crashed `init`.
  if (rec.manifestOrder !== undefined) {
    if (!Number.isInteger(rec.manifestOrder)) bad('manifestOrder must be an integer');
    if (!Array.isArray(rec.facts) || rec.facts.length === 0) bad('manifestOrder needs facts: the gate row is keyed by the fact that proves it');
  }

  if (rec.markers !== undefined) {
    if (!strings(rec.markers)) bad('markers must be a list of repository-relative paths');
    for (const marker of rec.markers ?? []) {
      if (marker.startsWith('/') || marker.split('/').includes('..')) {
        bad(`marker "${marker}" must be a path inside the repository`);
      }
    }
  }

  if (rec.languages !== undefined) {
    if (!Array.isArray(rec.languages)) bad('languages must be a list');
    else {
      for (const [i, language] of rec.languages.entries()) {
        if (!isObject(language)) {
          bad(`languages[${i}] is not an object`);
          continue;
        }
        if (typeof language.lang !== 'string' || !LANG.test(language.lang)) bad(`languages[${i}].lang is not a language name`);
        if (!Array.isArray(language.exts) || language.exts.length === 0) bad(`languages[${i}].exts must be a non-empty list`);
        for (const ext of language.exts ?? []) {
          if (typeof ext !== 'string' || !EXT.test(ext)) bad(`languages[${i}].exts "${ext}" is not an extension`);
        }
        if (language.canonical !== undefined) {
          for (const ext of language.canonical) {
            if (typeof ext !== 'string' || !EXT.test(ext)) bad(`languages[${i}].canonical "${ext}" is not an extension`);
          }
        }
        const patterns = language.testConventions?.base;
        if (patterns !== undefined) {
          if (!strings(patterns)) bad(`languages[${i}].testConventions.base must be a list of patterns`);
          for (const source of patterns ?? []) {
            try {
              new RegExp(source);
            } catch {
              bad(`languages[${i}].testConventions.base "${source}" is not a regular expression`);
            }
          }
        }
      }
    }
  }

  if (rec.gates !== undefined) {
    if (!isObject(rec.gates)) bad('gates must be an object');
    else {
      for (const key of ['preCommit', 'prePush']) {
        if (rec.gates[key] !== undefined && !strings(rec.gates[key])) bad(`gates.${key} must be a list of gate names`);
      }
      if (rec.gates.commands !== undefined) {
        if (!isObject(rec.gates.commands) || !Object.values(rec.gates.commands).every((v) => typeof v === 'string' && v !== '')) {
          bad('gates.commands must map gate names to non-empty command lines');
        }
      }
    }
  }

  return problems.length === 0 ? { ok: true, record: rec } : { ok: false, problems };
}
