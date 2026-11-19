// The effective work declaration: read once, validated once, normalized once.
//
// Three readers used to answer "what does this repository declare" three ways: `work inspect`
// called `validateWork` on the raw manifest value, the facet probe reached into
// `manifest.work.targets` looking only at its shape, and the validator probe read
// `work.scopes` without either. A repository with a typo therefore had a scope for one command
// and no scope for another, and an invalid declaration was half-read everywhere.
//
// The rule here is the one ADR-144 states: an invalid declaration is not a declaration. When
// validation fails, `scopes`, `targets` and `adapters` are empty and the problems say why -
// nothing downstream has to decide whether to trust half of it. `normalizedWork` supplies the
// spelling, so `./docs` and `docs` reach a resolver as one path.

import { loadManifest } from '../manifest/schema.mjs';
import { normalizedWork, validateWork } from './config.mjs';

/**
 * What this repository's `work` key says, in the shape its readers consume.
 *
 * The manifest loader also reports its own problems (an unparseable file, a key with an
 * impossible type); they are carried in `manifestProblems` so a caller can show one list
 * rather than two that disagree.
 *
 * @param {string} root
 * @returns {Promise<{declared: boolean, ok: boolean, version: number|null, scopes: object[], targets: object[], adapters: string[], problems: object[], manifestProblems: string[]}>}
 */
export async function readWork(root) {
  const loaded = await loadManifest(root).catch(() => ({ manifest: null, problems: [] }));
  const manifestProblems = Array.isArray(loaded.problems) ? loaded.problems : [];
  const declared = loaded.manifest?.work ?? null;
  if (declared === null || declared === undefined) {
    return { declared: false, ok: true, version: null, scopes: [], targets: [], adapters: [], problems: [], manifestProblems };
  }
  const checked = validateWork(declared);
  const effective = checked.ok ? normalizedWork(declared) : normalizedWork({});
  return {
    declared: true,
    ok: checked.ok,
    version: effective.version ?? (Number.isInteger(declared?.version) ? declared.version : null),
    scopes: effective.scopes,
    targets: effective.targets,
    adapters: effective.adapters,
    problems: checked.problems,
    manifestProblems,
  };
}
