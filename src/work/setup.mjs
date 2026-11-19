// `work setup`: one scope, decided before it is written.
//
// The failure this module exists to prevent is a setup that improvises. A scope invented
// from a directory name, a validator command nobody can run, a manifest rewritten around
// the repository's own keys - each of those is a declaration the repository did not make,
// and the reader has no way to tell it from one that was. So the proposal here is a
// function of the declaration and the arguments, it names every value it would add, and it
// refuses to rewrite a scope the repository already wrote.
//
// Two rules make the second apply a no-op rather than a second edit:
//
//   * The fields this command writes are the fields it compares. A scope that also carries
//     `ignore` or `targets` is the repository's declaration, not a different one, and
//     re-running setup over it changes nothing.
//   * The result is validated before anything is written, with the same reader the CLI and
//     `check` use. A proposal the parser would refuse is refused here, by field, rather than
//     landing a file that the next command reports as broken.
//
// Nothing here reads or writes: `work setup` decides when to apply, and the preview and the
// write are the same function of the same arguments.

import { manifestText } from '../projection/manifest.mjs';
import { MANIFEST_FILE } from '../name.mjs';
import { normalizePath } from './artifacts.mjs';
import { WORK_VERSION, validateWork } from './config.mjs';

const USAGE = `run: simt work setup --scope <id> --path <dir> --kind <kind> [--validator "<command>"]`;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The path as the declaration spells it, or `null` when it leaves the repository. */
function spelling(raw) {
  const normalised = normalizePath(raw);
  if (normalised === null) return null;
  return normalised === '' ? '.' : normalised;
}

/** What this command would write for one scope, in the shape the comparison uses. */
function shapeOf(scope) {
  return JSON.stringify({
    id: scope.id,
    paths: (Array.isArray(scope.paths) ? scope.paths : []).map(spelling),
    kind: typeof scope.kind === 'string' ? scope.kind : null,
    validators: Array.isArray(scope.validators) ? scope.validators : [],
  });
}

/**
 * The next manifest, or the reason there is none.
 *
 * A `changed: false` result says the scope is already declared exactly as this command would
 * write it, and carries no manifest: there is nothing to write, and substituting a
 * re-serialisation for the repository's own bytes is the edit this command refuses to make.
 *
 * @param {{manifest?: object, scope?: string, path?: string, kind?: string, validator?: string}} input
 * @returns {{changed: true, next: object, text: string, scope: object}|{changed: false, scope: object}|{error: string, remedy: string}}
 */
export function proposeScope({ manifest = {}, scope, path, kind, validator } = {}) {
  if (typeof scope !== 'string' || scope.trim() === '') return { error: 'work setup needs a scope id', remedy: USAGE };
  if (scope !== scope.trim()) return { error: `the scope id ${JSON.stringify(scope)} has leading or trailing whitespace`, remedy: 'pass the id without padding; it is how artifacts are referenced' };
  if (typeof path !== 'string' || path.trim() === '') return { error: 'work setup needs a directory to declare', remedy: USAGE };
  if (typeof kind !== 'string' || kind.trim() === '') return { error: 'work setup needs a kind', remedy: 'pass --kind <kind>; the kind decides which obligations the scope signs up for' };
  const stored = spelling(path);
  if (stored === null) return { error: `${JSON.stringify(path)} is not a repository-relative path`, remedy: 'a scope may only claim what the repository owns; pass a path inside it' };

  const existing = isObject(manifest.work) ? manifest.work : null;
  if (existing !== null) {
    // Building on a declaration the parser refuses would turn one problem into two: the
    // field the repository has to fix, and the field this command added around it.
    const checked = validateWork(existing);
    if (!checked.ok) return { error: `${MANIFEST_FILE}'s work declaration is invalid: ${checked.problems[0].message}`, remedy: checked.problems[0].remedy };
  }

  const entry = { id: scope, paths: [stored], kind: kind.trim() };
  if (typeof validator === 'string' && validator.trim() !== '') entry.validators = [validator.trim()];

  const scopes = Array.isArray(existing?.scopes) ? existing.scopes : [];
  const claimed = scopes.find((row) => isObject(row) && row.id === scope);
  if (claimed !== undefined) {
    if (shapeOf(claimed) === shapeOf(entry)) return { changed: false, scope: claimed };
    return {
      error: `scope \`${scope}\` is already declared with a different path, kind or validator`,
      remedy: `edit ${MANIFEST_FILE} by hand, or pass a new --scope id; work setup adds a scope and never rewrites one`,
    };
  }

  const nextWork = existing === null ? { version: WORK_VERSION, scopes: [entry] } : { ...existing, scopes: [...scopes, entry] };
  const checked = validateWork(nextWork);
  if (!checked.ok) return { error: `${checked.problems[0].path}: ${checked.problems[0].message}`, remedy: checked.problems[0].remedy };

  const next = { ...manifest, work: nextWork };
  return { changed: true, next, text: manifestText(next), scope: entry };
}
