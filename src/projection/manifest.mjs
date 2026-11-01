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
// rationale is not duplicated into the JSON (data must stay data); `simt init`
// prints the reason for each value it writes.

import { readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { journaledWriteFile } from '../journal.mjs';
// gates.mjs imports nothing, so this direction cannot cycle. It is the gate table
// this file already selects from; duplicating the runnability rules here would be two
// answers to "can this repo run that gate", which is precisely the kind of drift this
// file exists to prevent elsewhere.
import { getGate } from '../hooks/gates.mjs';
// Q31: the one Node runner table. This module and the card, capability,
// dispatcher and CI workflow all spell `<manager> run <script>` from it.
import { runScript } from '../ecosystem/node-runner.mjs';
// Q70: the ecosystem records. A new ecosystem is a new file under `ecosystems/`, not a
// row added to this table. records.mjs imports nothing from this package, so this edge
// cannot cycle.
import { ecosystemGateRows } from '../ecosystem/records.mjs';

// Imported as well as re-exported: a bare `export { X as Y } from` binds nothing here,
// and the manifest name is used a dozen times below in remedy strings that name this
// file by name.
import { MANIFEST_FILE, MANIFEST_LEGACY } from '../name.mjs';
import { GENERATED_KEYS_OF, KEYS, loadManifest, manifestPath } from '../manifest/schema.mjs';
import { CLI } from '../name.mjs';
import { packageVersion } from '../package-version.mjs';
import { defaultGates, planGates } from '../gates/index.mjs';
export { ECOSYSTEMS, defaultGates, gateRunnable, planGates, unrunnableGates } from '../gates/index.mjs';
export const MANIFEST = MANIFEST_FILE;

// Still exported from here because this is where the manifest lived: every caller that
// resolved its path through this module keeps working, and the implementation moved.
export { manifestPath };

export { MANIFEST_LEGACY };

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
  $comment: [
    `Written and maintained by simt-dev. \`${CLI} sync --yes\` regenerates the projected rules.`,
    `\`${CLI} init\` refreshes the SHA and keeps every key it does not write, so a value you add here survives a re-init.`,
    `\`plans\` is such a key: it selects the tracker template and the directories \`${CLI} plan\` reads.`,
    'Omit it and the tracker template applies, which reads docs/plans, docs/research and docs/reviews.',
  ].join(' '),
};

/**
 * Gate names the shared dispatcher knows how to run (step 8). Choosing these from
 * the detected stack rather than asking a human keeps `init` non-interactive.
 */
export function buildManifest({ root, stack = [], sha, version, existing = null, capability = null, surfaces = undefined, facts = [] }) {
  const gates = defaultGates(stack, facts, root);
  const limits = defaultLimits();

  // A re-init must never silently weaken a repo's own declaration: existing
  // limits and gates win over defaults, and only the projection stamp is refreshed.
  const limitsFinal = existing?.limits ? { ...limits, ...existing.limits } : limits;
  const planned = planGates(stack, capability, facts, root);
  // The seeds land only on a FRESH manifest. On an existing one the repo's
  // declaration is the answer, and adding commands under it would be a re-init
  // writing into a field the reader owns — the same rule as the gates above.
  const gatesFinal = existing?.gates
    ? { ...gates, ...existing.gates }
    : Object.keys(planned.commands).length > 0
      ? { ...planned.gates, commands: planned.commands }
      : planned.gates;

  const owned = {
    ...MANIFEST_COMMENT,
    id: existing?.id ?? defaultId(root),
    stack: existing?.stack?.length ? existing.stack : stack,
    limits: limitsFinal,
    gates: gatesFinal,
    localSkills: existing?.localSkills ?? [],
    // ADR-013: profile ids the repo wants, whether they ship centrally or live
    // in `.simt/profiles/`. Detection already selects the right profiles; this
    // is the declaration a reviewer reads to see the repo's intent stated rather
    // than inferred.
    profiles: existing?.profiles ?? [],
    // ADR-016: per-repo values for the canonical `.mdc` rules' declared
    // substitutions, keyed by rule id. Seeded empty rather than absent so the
    // shape is visible in the file before anything needs it. `__optIn` is not a
    // substitution value: it lists the rules this repo declares it has a problem
    // with, which is something detection cannot infer.
    substitutions: existing?.substitutions ?? {},
    // ADR-065: rule sets this repository shares with its siblings, and the digest
    // of the bytes it has for each. Not a generated field - which packs a repo uses
    // is the repo's decision, and `check` reports a digest that does not match the
    // directory rather than a value here that differs from what the tool would pick.
    packs: existing?.packs ?? [],
    // ADR-072: how many bytes of always-on projection this repository has agreed to
    // carry. A declaration, not a generated field, for the same reason `packs` is not:
    // the number is the repository's own line in the sand, and `upgrade` must not
    // rewrite it to whatever the tool happens to project today — a budget that moved by
    // itself would be a budget nobody is held to.
    //
    // Absent when the repository declared nothing, which is the point. Writing the
    // default here would make every adopted repo look like it had chosen it, and a
    // reader told "declared: true" about a line nobody wrote is being lied to about the
    // only thing the number is for. The default belongs to whoever measures, and
    // `budgetFinding` and `simt tokens` both read it from one place.
    ...(existing?.budget === undefined ? {} : { budget: existing.budget }),
    // ADR-073: `full` projects every selected rule; `kernel` projects only the hard
    // constraints and defers the rest to `rules show`. Absent means `full`, and the
    // default stays `full` because nobody has yet measured whether a kernel loses
    // compliance — a mode chosen by default would be a bet the
    // repository never made. Declared, not generated, for the same reason as `budget`.
    ...(existing?.mode === undefined ? {} : { mode: existing.mode }),
    // ADR-084: the rules this repository hands to the workspace's user-level copy, and
    // the level that copy lives at. Declared, not generated, for the same reason as
    // `budget` and `mode`: `shared install` writes the list once, but the bytes that land
    // in a repository's region depend on it on every `sync` — so if `upgrade` rewrote it
    // from its own opinion of what a workspace shares, a repository's region would change
    // without anybody asking, which is the failure `budget` moving by itself was.
    // Absent means "no repository in this workspace shares anything", which is the state
    // every repository is in until somebody runs `shared install`.
    ...(existing?.shared === undefined ? {} : { shared: existing.shared }),
    // ADR-020: which editors this repo's rules are projected into. Absent means the
    // global standard applies; an explicit empty list is a real choice meaning
    // AGENTS.md only. Recorded rather than inferred, because "which IDE does this repo
    // support" is a decision a reviewer should be able to read in one line — and
    // because a typo here silently reduces the estate to AGENTS.md, which looks
    // exactly like a working setup.
    surfaces: surfaces ?? existing?.surfaces ?? null,
    // simtDevSha is the digest of the rule bytes this projection was rendered from;
    // version is the simt-dev release that produced it. The gate compares the running
    // binary to version and refuses on a mismatch, which is how a repository without
    // npm (the release binary in `.simt/bin`, pinned only by this field) is held to
    // the release it adopted. See src/package-version.mjs.
    projection: { simtDevSha: sha ?? null, version: version ?? null },
  };
  return withRepoKeys(existing, owned);
}

/**
 * Keys this writer does not recognise belong to the repository.
 *
 * A re-init used to return only the object above, so anything else in the file
 * disappeared. `plans` is the tracker overlay, and it is not the only key a
 * repository might have added. Owned keys stay in the order the writer emits
 * them; an unknown key is copied after them, in the order the file had it.
 */
function withRepoKeys(existing, owned) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return owned;
  const kept = {};
  for (const key of Object.keys(existing)) {
    if (Object.hasOwn(owned, key)) continue;
    kept[key] = existing[key];
  }
  return { ...owned, ...kept };
}

/**
 * Declared gates this repo cannot run, as findings.
 *
 * `init` no longer writes them, but a manifest written by an older version still
 * carries them and a hand-edited one can add them back. Leaving that to
 * `hooks status` means the repo is green until someone installs hooks, at which
 * point every commit fails and the first exit anyone finds is `--no-verify`.
 * So the check that guards the generated rules also reports the landmine.
 *
 * @returns {{file: string, status: string, gate: string, detail: string, remedy: string}[]}
 */
function defaultLimits() {
  return { coverage: null, fileLines: { warn: 400, error: 1000 } };
}

/** ADR-006: coverage stays null. Set it only if the repo has a real numeric gate. */

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

/**
 * The fields this tool writes. Everything else in a manifest belongs to the
 * repository that adopted the tool.
 *
 * It is a value rather than an expression inside `manifestDrift` because the question
 * "is this field ours?" now has two callers that must answer it identically: the gate
 * that reports one stale, and `sync`, which repairs exactly the fields the gate names.
 * A second implementation of this set is a repair that fixes a field nothing reports,
 * or a report about a field nothing repairs - and each half passes its own test,
 * which is ADR-045's shape reached from the other direction.
 */
/**
 * The bytes of always-on projection a repository carries per root before the number is
 * worth an argument.
 *
 * Thirty thousand is S38's figure and not a measurement this tool took: it is the line
 * the review drew, the one the whole row exists to check. A default nobody would accept
 * is a default that reports nothing, and a budget only works as a budget when exceeding
 * it is something a reader can see.
 */
export const DEFAULT_BUDGET_BYTES = 30000;

/**
 * The budget a repository declared, or the default it gets for declaring nothing.
 *
 * One reader for one number, and it exists because two callers need it and a third
 * already had its own: the packer that cuts a kernel to fit (ADR-083) and the meter that
 * reports what it carries, against a ceiling each would otherwise spell differently. The
 * byte they disagree about is the byte the repository wrote down.
 *
 * `0` is honoured — "this repository wants an empty projection" is a decision somebody can
 * make. `null`, a string and `NaN` are not budgets at all, and a hand-edited manifest is
 * exactly where one turns up; the default stands in rather than the ceiling becoming a
 * string that every comparison against it silently passes.
 */
export function declaredBudget(manifest) {
  const declared = manifest?.budget?.bytes;
  return Number.isFinite(declared) && declared >= 0 ? declared : DEFAULT_BUDGET_BYTES;
}

/**
 * Report a projection that carries more than the repository agreed to carry.
 *
 * Non-blocking by design, and that is the honest answer rather than a convenient one:
 * the plan's own wording is that `check` reports `BUDGET-CUT` and nothing is cut, because
 * cutting requires a kernel to pack lines into and the kernel does not exist yet
 * (blocked on the evaluation). A gate that failed here would fail every
 * repository in the estate on a number this tool has not yet earned the right to enforce.
 *
 * The finding names what is over and what is NOT cut, because a reader who is told only
 * that a budget was exceeded will assume something was removed and stop looking.
 *
 * @returns {{file: string, status: string, detail: string, remedy: string}|null}
 */
export function budgetFinding(bytes, budget, mode = 'full') {
  const allowed = budget?.bytes ?? DEFAULT_BUDGET_BYTES;
  if (!Number.isFinite(bytes) || bytes <= allowed) return null;
  // The two modes answer different questions, and conflating them is the one way this
  // finding could be actively wrong. In `full` nothing is cut, so a reader told only
  // "over budget" would look for a removed rule and find none. In `kernel` the packing
  // already ran and the projection the reader will see is the packed one — so a number
  // over the line here means the KERNEL is over the line, which is a different remedy
  // entirely: no amount of raising the number fixes a kernel that is too large on its own.
  const kernel = mode === 'kernel';
  return {
    file: MANIFEST,
    status: 'budget',
    detail: kernel
      ? `${bytes} bytes of always-on projection in kernel mode; this repository declared ${allowed}. The kernel itself is over the line: only hard and command rules were packed, so this is not a projection waiting to be trimmed`
      : `${bytes} bytes of always-on projection; this repository declared ${allowed}. Nothing was cut: the projection is still in full mode, so every rule is loaded as written`,
    remedy: kernel
      ? `raise budget.bytes to ${bytes}, or move rules out of the hard and command classes into convention or style, which is the only way a kernel shrinks`
      : `raise budget.bytes to ${bytes} if the projection is meant to be this size, switch mode to kernel to defer the convention and style rules, or narrow the rules that carry it`,
  };
}

/**
 * The workspace-shared rules this repository declared, as a set of ids.
 *
 * One reader, because the region, `doctor` and `shared` all need the same answer and a
 * projection that renders a delta the meter cannot see is the one-question-two-answers
 * defect this repository exists to end.
 *
 * `level` is read and validated rather than assumed, because `user` is the only level any
 * reader loads from outside a repository and a hand-edited manifest is exactly where a
 * second value turns up. A list that is not a list of strings yields an empty set: the
 * repository then projects everything it selects, which is the state it was in before
 * anybody ran `shared install`, and is never a state that loses a rule.
 */
export function declaredShared(manifest) {
  const shared = manifest?.shared;
  if (shared === undefined || shared === null) return { level: null, rules: new Set() };
  const level = shared.level === 'user' ? 'user' : null;
  const rules = new Set(Array.isArray(shared.rules) ? shared.rules.filter((id) => typeof id === 'string') : []);
  // A level of `user` with nothing in it is a declaration that changes nothing, and a
  // level that is not `user` names a place this tool cannot write — so neither is a
  // reason to drop rules out of a region.
  if (level === null || rules.size === 0) return { level: null, rules: new Set() };
  return { level, rules };
}

// Derived from the table rather than restated: a key this tool writes is a `tool` key
// marked generated, and a second list here is the drift this module exists to end.
export const GENERATED_KEYS = GENERATED_KEYS_OF;

// The sub-keys of `projection` this tool writes. `projection` is a generated key, but
// not wholesale: the repository owns sub-keys this writer does not emit (`place` is the
// one that shipped), and a repair that replaces the object deletes them.
const PROJECTION_KEYS = new Set(['simtDevSha', 'version']);

/** The `projection` object a manifest carries; anything that is not an object is nothing. */
function projectionOf(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** Only the generated sub-keys of a `projection` object, in the order this writer emits them. */
function generatedProjection(value) {
  const out = {};
  for (const key of PROJECTION_KEYS) if (key in projectionOf(value)) out[key] = value[key];
  return out;
}

/**
 * A manifest with this tool's own fields replaced by what this build writes, and
 * nothing else touched.
 *
 * Spread from the repository's manifest rather than from `buildManifest`'s output:
 * the builder fills a default for every key, so writing its result wholesale would
 * overwrite `gates` and `limits` in any repository that chose its own. "Content the
 * repo chose is never compared" is a promise about the repair too, not only about
 * the report, and a repair is exactly where it would be broken.
 *
 * `projection` merges the same way, one level down: the object the repository has
 * keeps every sub-key it chose, and the generated sub-keys take this build's values.
 *
 * @param {object} manifest the repository's manifest, as parsed
 * @param {object} expected `buildManifest`'s output, from the call `manifestDrift` made
 * @returns {object} a new manifest; the argument is not mutated
 */
export function withGenerated(manifest, expected) {
  const patched = { ...manifest };
  for (const key of GENERATED_KEYS) {
    if (!(key in expected)) continue;
    patched[key] =
      key === 'projection'
        ? { ...projectionOf(manifest?.projection), ...expected.projection }
        : expected[key];
  }
  return patched;
}

/**
 * Is a generated field of this manifest wrong, or has a formatter taken its bytes?
 *
 * Two distinct defects, one shape of answer, because they share a cause: a generated
 * file with no path back to being correct.
 *
 * 1. A STALE GENERATED FIELD. `buildManifest` emits `$comment` and
 *    `projection.simtDevSha`; the repo owns everything else. `upgrade` spreads the
 *    existing manifest and refreshes only the SHA, so a field added to the writer
 *    after a repo was adopted never appears — one repository had been projecting for
 *    several versions with no `surfaces` key, and nothing said so. Every parse-based
 *    comparison passes, because the file is valid and the values in it are all true.
 *
 * 2. REFORMATTED BYTES. A repo with a prettier hook rewrites the manifest on the
 *    first commit: prettier collapses short arrays onto one line,
 *    `JSON.stringify(m, null, 2)` always expands them. The content is identical, so
 *    the next `init` puts simt-dev's bytes back and the formatter takes them away
 *    again. `upgrade` reported `current` the whole time, which is correct: the pin
 *    was current. The bytes were not.
 *
 *    This one is a consequence of routing, not of adoption. Nothing reformatted the
 *    manifest until the pre-commit gate started running, so every repository that
 *    adopts the tool and runs a formatter arrives here on its first commit. The
 *    remedy is therefore "stop the formatter taking it, then `sync`" — and it was
 *    `init --yes`, which re-runs adoption to change one file's formatting (ADR-050).
 *
 * Content the repo chose is never compared. A repo that edited `limits.coverage` on
 * purpose is not being told to revert it.
 *
 * @returns {{file: string, status: string, detail: string, remedy: string}|null}
 */
export async function manifestDrift(root, stack, sha) {
  const { manifest, exists, error } = await readManifest(root);
  if (!exists || error !== null || manifest === null) return null;

  const expected = buildManifest({ root, stack, sha, version: packageVersion(), existing: manifest });
  // `[...GENERATED_KEYS]`, and not `Object.keys(expected)`: the question is which
  // fields are ours, and the answer is the set above. Iterating the expected object
  // asks the same question of a different list and can only agree by coincidence.
  const stale = [...GENERATED_KEYS].filter((key) => {
    if (!(key in expected)) return false;
    // `projection` compares on the sub-keys this tool writes: a sub-key the repo
    // chose (`place`) is not a stale field, and reporting it is what made `sync`
    // delete the one setting that was not stale.
    const actual = key === 'projection' ? generatedProjection(manifest[key]) : manifest[key];
    return JSON.stringify(actual) !== JSON.stringify(expected[key]);
  });
  if (stale.length > 0) {
    return {
      file: MANIFEST,
      status: 'stale-generated-field',
      detail: `generated field(s) ${stale.join(', ')} do not match what this simt-dev writes`,
      // `sync`, and not `init`. `sync` repairs exactly this field set and nothing
      // else; `init` re-runs adoption - it tags, it branches, it asks every question
      // again - and two commands must not answer one question with different
      // instructions (ADR-050).
      //
      // The remedy said `init` because for two releases nothing could repair a stale
      // field, so the only command that could was the only one named. `sync` having
      // nothing to repair while `check` refused anyway is the one-question-two-answers
      // defect this repository exists to end, and it was true in all fourteen adopted
      // repositories at the same moment: measured, not inferred. `check` exited 1 in
      // every one of them while `sync` printed "already current; nothing written".
      //
      // No trailing parenthetical, because `compare` prints this string verbatim as
      // the remedy on its own row. A remedy that reads well in one command's output
      // and badly in another's is two answers wearing one string.
      remedy: `run: ${CLI} sync --yes`,
    };
  }

  // Form is compared by re-serialising the file's OWN parsed content in our shape,
  // not by rebuilding the manifest from defaults. Rebuilding would also report a
  // repo for an optional key it predates (`surfaces`), which is not an error: absent
  // and null both mean "the global standard applies". Comparing content-to-content
  // isolates the one question — does another tool own this file's formatting.
  const onDisk = (await readFile(await manifestPath(root), 'utf8')).trim();
  const ours = JSON.stringify(manifest, null, 2).trim();
  if (onDisk === ours) return null;
  return {
    file: MANIFEST,
    status: 'reformatted',
    detail: 'content is what simt-dev would write, but the bytes differ - another formatter owns this file',
    remedy: `add ${MANIFEST_FILE} to .prettierignore (a generated file is not prose), then: ${CLI} sync --yes`,
  };
}

/**
 * The bytes a manifest is written as.
 *
 * Exported because two callers now need them and one of them is a preview: a plan
 * that reports a byte count it computed with a different serialiser than the writer
 * used reports a number nothing will ever observe. `writeManifest` is the only place
 * this format is spelled.
 */
export function manifestText(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * The manifest in the shape the callers already read, now answered by the one loader
 *. `error` is the unreadable-file case only: a manifest with a value
 * the schema cannot use is still a manifest, and refusing it here would turn every
 * reader into a second validator.
 *
 * @returns {Promise<{manifest: object|null, exists: boolean, error: string|null}>}
 */
export async function readManifest(root) {
  const { manifest, exists, problems } = await loadManifest(root);
  return { manifest, exists, error: exists && manifest === null ? (problems[0] ?? 'unparseable') : null };
}

export async function writeManifest(root, manifest, journal = null) {
  // A repository still holding the old name gets it moved, not shadowed. Two manifests
  // in one repo is a manifest nobody can reason about, and the second would be the one
  // that is never read - so the window closes by moving the file, not by leaving both.
  const previous = join(root, MANIFEST_LEGACY);
  const fresh = join(root, MANIFEST);
  if (existsSync(previous) && !existsSync(fresh)) await rename(previous, fresh);
  // A journaled manifest is one `undo` can restore, like every other repo file a
  // command writes . Callers that span repos or the repo boundary (shared,
  // bench) pass nothing and keep the old behaviour exactly.
  if (journal) await journaledWriteFile(root, journal, fresh, manifestText(manifest));
  else await writeFile(fresh, manifestText(manifest));
  return fresh;
}
