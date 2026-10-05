// simt-dev.json - the one manifest per repo.
//
// One file answers every question the tool needs: what this repo is, what it is
// allowed to declare, which gates it runs, and which simt-dev produced its rules.
//
// This is where two rulings land in code:
//   ADR-005 file length is two tiers (400 review trigger, 1000 ceiling) - a default,
//            overridable per repo under limits.fileLines.
//   ADR-006 evidence discipline is central; the NUMERIC bar is declared per repo.
//            So limits.coverage defaults to null. A null is a real, valid answer:
//            the evidence-discipline rules still apply, there is simply no number.
//            Inventing a number here would be worse than declaring none.
//
// Every default this module produces is explained by the ADR that requires it. The
// rationale is not duplicated into the JSON (data must stay data); `simt-dev init`
// prints the reason for each value it writes.

import { readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

export const MANIFEST = 'simt-dev.json';

/**
 * The one definition of the file's own comment, exported because `upgrade` rewrites
 * the manifest and must not carry a stale copy forward. Two literals for one string
 * is how the old one survived every upgrade.
 *
 * Every value here is read by someone who cannot see simt-dev's own tree, so this
 * names only things true in the repo it lands in. An earlier version pointed at
 * docs/decisions/ and claimed each value cites the ADR that requires it; no value
 * cited one, so it was decoration that misdescribed the file. The provenance that IS
 * real is the recorded SHA under `projection`.
 */
export const MANIFEST_COMMENT = {
  $comment:
    'Written and maintained by simt-dev. Edit by hand only if you intend to take ownership of this file: `simt-dev sync` regenerates the projected rules, and re-running `simt-dev init` refreshes the SHA without weakening a value you set here.',
};

/**
 * Gate names the shared dispatcher knows how to run (step 8). Choosing these from
 * the detected stack rather than asking a human keeps `init` non-interactive.
 */
const GATES_BY_STACK = [
  {
    when: ['gradle', 'kotlin', 'connectiq'],
    preCommit: ['format', 'lint', 'i18n-completeness'],
    prePush: ['test'],
  },
  {
    when: ['python'],
    preCommit: ['format', 'lint', 'i18n-completeness'],
    prePush: ['test', 'coverage'],
  },
  {
    when: ['node', 'node-web', 'cloudflare-workers', 'typescript'],
    preCommit: ['format', 'lint'],
    prePush: ['test', 'typecheck'],
  },
];

/** Extra gate implied by a specific tag, applied after the table above. */
const TAG_GATES = [
  { tag: 'connectiq', preCommit: ['memory', 'codegen-drift'] },
  { tag: 'hono', preCommit: ['i18n-completeness'] },
];

/**
 * Build a manifest from a fingerprint. Pure, so the whole default surface is
 * testable without a filesystem.
 */
export function buildManifest({ root, stack = [], sha, existing = null }) {
  const gates = defaultGates(stack);
  const limits = defaultLimits(stack);

  // A re-init must never silently weaken a repo's own declaration: existing
  // limits and gates win over defaults, and only the projection stamp is refreshed.
  const limitsFinal = existing?.limits ? { ...limits, ...existing.limits } : limits;
  const gatesFinal = existing?.gates ? { ...gates, ...existing.gates } : gates;

  return {
    ...MANIFEST_COMMENT,
    id: existing?.id ?? defaultId(root),
    stack: existing?.stack?.length ? existing.stack : stack,
    limits: limitsFinal,
    gates: gatesFinal,
    localSkills: existing?.localSkills ?? [],
    // ADR-013: profile ids the repo wants, whether they ship centrally or live
    // in `.simt-dev/profiles/`. Detection already selects the right profiles; this
    // is the declaration a reviewer reads to see the repo's intent stated rather
    // than inferred.
    profiles: existing?.profiles ?? [],
    // ADR-016: per-repo values for the canonical `.mdc` rules' declared
    // substitutions, keyed by rule id. Seeded empty rather than absent so the
    // shape is visible in the file before anything needs it. `__optIn` is not a
    // substitution value: it lists the rules this repo declares it has a problem
    // with, which is something detection cannot infer.
    substitutions: existing?.substitutions ?? {},
    projection: { simtDevSha: sha ?? null },
  };
}

/** ADR-005: 400 is a review trigger, 1000 a hard ceiling. Generated files exempt. */
function defaultLimits() {
  return { coverage: null, fileLines: { warn: 400, error: 1000 } };
}

/** ADR-006: coverage stays null. Set it only if the repo has a real numeric gate. */
function defaultGates(stack) {
  const tags = new Set(stack);
  const gates = { preCommit: [], prePush: [] };

  for (const row of GATES_BY_STACK) {
    if (row.when.some((tag) => tags.has(tag))) {
      gates.preCommit.push(...row.preCommit);
      gates.prePush.push(...row.prePush);
    }
  }
  for (const row of TAG_GATES) {
    if (tags.has(row.tag)) gates.preCommit.push(...row.preCommit);
  }

  // A repo with no recognised stack still gets a gate list, because a gate that
  // runs nothing is indistinguishable from a gate that was never installed.
  if (gates.preCommit.length === 0) gates.preCommit.push('format', 'lint');
  if (gates.prePush.length === 0) gates.prePush.push('test');

  return { preCommit: dedupe(gates.preCommit), prePush: dedupe(gates.prePush) };
}

function dedupe(list) {
  return [...new Set(list)];
}

/**
 * A repo id is the directory name. Using it rather than a guessed field keeps
 * `init` working in a directory that is not yet a git repo (step 8 scaffolds
 * those), where no remote name exists to read.
 */
function defaultId(root) {
  // Resolve before taking the basename: `basename('.')` is `''`, so every repo adopted
  // with `--root .` or a bare positional was written as `unnamed-repo`. The id is the
  // one field in the manifest a human reads, and it was wrong for the most natural
  // invocation of the command.
  const name = basename(resolve(root));
  return name === '' || name === '.' ? 'unnamed-repo' : name;
}

/** @returns {{manifest: object|null, exists: boolean, error: string|null}} */
export async function readManifest(root) {
  const path = join(root, MANIFEST);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { manifest: null, exists: false, error: null };
  }
  try {
    return { manifest: JSON.parse(text), exists: true, error: null };
  } catch (error) {
    return { manifest: null, exists: true, error: `unparseable: ${error.message}` };
  }
}

export async function writeManifest(root, manifest) {
  const path = join(root, MANIFEST);
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}