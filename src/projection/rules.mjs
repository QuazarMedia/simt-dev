// Which rules apply to a repo.
//
// Split from project.mjs, which crossed the 400-line review trigger (ADR-005)
// twice while gaining two unrelated concerns. The rule is that a module answers
// one question: this one answers *which rules*, project.mjs answers *what files
// that produces*, targets.mjs answers *how a rule is rendered per surface*.
//
// Selection is a pure function of the repo's signals plus the manifest, with no
// filesystem beyond reading the rule files themselves. That purity is what makes
// the profile-selection test possible at all, and it is why `select` takes a
// pre-read rule list rather than a path.
//
// The core rule set is always included. Stack profiles are selected by
// intersection with the repo's fingerprint - platform tags *and* emitted facts,
// which are interchangeable in a profile (ADR-013) - plus one fallback profile so
// a JS/TS repo is never left with core rules and nothing else.
//
// Profiles may live in the repo, not only here. `.simt-dev/profiles/*.md` uses the
// same frontmatter contract as `rules/stacks/*.md` and is selected by the same
// matcher, so supporting an ecosystem nobody here has heard of requires no code
// change and no release.

import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { fingerprint, KNOWN_TAGS } from '../resolve/fingerprint.mjs';
import { loadMdcRules, renderMdc } from './mdc.mjs';
import { foldsRules, frontmatterBlock, resolveSurfaces, rulePath, canScope } from './surfaces.mjs';
import { ruleTargets } from './targets.mjs';
import { compose } from './markers.mjs';
import { declaredBudget, manifestPath, readManifest } from './manifest.mjs';
import { commandCard, CARD_LIMIT_BYTES } from '../kernel/card.mjs';
import { packToBudget } from '../kernel/budget.mjs';
import { filterInferable, inferableDefect, inferableProofs } from '../kernel/inferability.mjs';
import { BASELINES } from './baselines.mjs';
import { CLI } from '../name.mjs';
import { PACK_DIR, resolvePacks } from '../packs.mjs';
import { discoverPackages } from '../monorepo.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');
const RULES_DIR = join(ROOT, 'rules');

/**
 * The identity recorded in generated regions and in the manifest pin.
 *
 * This is a digest of the CONTENT that leaves this package, not a commit id, and the
 * distinction is not cosmetic. `git rev-parse` run inside `node_modules/` walks *up*
 * until it finds a `.git`, so for anyone who installed this package into a repository -
 * the whole audience for it - the stamp recorded the CONSUMER's HEAD. Git succeeded, so
 * no fallback could catch it. A consumer's HEAD moves on every commit they make,
 * including commits that touch nothing this tool projects, so `check` reported DRIFT on
 * all three generated files after an unrelated commit and exited 1, and `upgrade` named
 * a cause ("the rules changed") that was false.
 *
 * Where git could not answer at all - a published tarball has no `.git` (`files` in
 * package.json does not include one and npm never packs it) - the old code returned the
 * string `unknown`, and that was treated as a value: since the marker grammar reads
 * `[0-9a-f]{7,40}` the tool could not read back its own stamp, and `upgrade` compared
 * `unknown` against a real pin as though they were two versions, reporting "the rules
 * changed" when they had not and overwriting a good pin with `unknown` on `--yes`,
 * unrecoverably. That is the failure this replaces (ADR-032).
 *
 * The digest covers every byte string that leaves the package, and nothing else. That
 * set is `rules/` on disk plus the RENDERED baseline bodies: the shared
 * `.editorconfig` and `.gitattributes` blocks are strings a repository receives, so by
 * ADR-015's rule a source is identified by its content rather than by the file it
 * happens to live in, and a body defined in `src/` is a source like any other. The
 * registry (`graph/`) is workspace data the package no longer ships (ADR-061), so it is
 * not part of this set even where it exists on disk.
 *
 * It deliberately excludes `src/` as a directory. A refactor that changes no rule and
 * no baseline body produces byte-identical output, and stamping those
 * consumers would report drift where there is none - which is the estate's own rule that
 * a report must be a fact.
 *
 * Sorted path-then-bytes, so the value depends on content and not on readdir order,
 * and length-prefixed so no rename can be crafted to collide with a rename that did
 * not happen (the reason to hash a structured encoding rather than joined text).
 */
export async function provenanceDigest() {
  const hash = createHash('sha256');
  for (const { path, bytes } of await provenanceInputs()) {
    hash.update(`${path}:${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest('hex').slice(0, 40);
}

/**
 * The exact byte strings `provenanceDigest` hashes, as `{path, bytes}` in hash order.
 *
 * Exported because "the digest covers the right things" is a claim about a SET, and a
 * set that is only ever assembled inside the function that hashes it cannot be
 * asserted from outside: the test would have to mutate the package to see the answer.
 * This is the list, so a test can ask what is in it, and the rendering is one function
 * both the digest and that test read - the arrangement ADR-042's ruling 3 settled on.
 *
 * @returns {Promise<{path: string, bytes: Buffer}[]>}
 */
export async function provenanceInputs() {
  const inputs = [];
  for (const dir of ['rules']) {
    for (const rel of await walk(join(ROOT, dir))) {
      inputs.push({ path: `${dir}/${rel}`, bytes: await readFile(join(ROOT, dir, rel)) });
    }
  }
  // Last, and keyed by the FILE it becomes in the adopting repository rather than the
  // module it is written in: the stamp answers what content produced those bytes, and
  // `.editorconfig` is the name a reader of a generated region recognises.
  for (const b of BASELINES) {
    inputs.push({ path: `baselines/${b.file}`, bytes: Buffer.from(b.body()) });
  }
  return inputs;
}

/** @returns {Promise<string[]>} repo-relative paths, sorted, directories omitted. */
async function walk(dir, prefix = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walk(join(dir, entry.name), rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/** Repo-local profile directory, relative to a repo root (ADR-013 section 2). */
export const LOCAL_PROFILE_DIR = '.simt-dev/profiles';

/**
 * Which origin outranks which when two profiles claim one `simt-id`.
 *
 * A pack is the repository's shared policy and the built-in set is the tool's
 * opinion, so a repository can replace either and a pack can replace what the
 * tool ships. Read in one place because the answer to "whose rule is this?" is
 * asked on every rule of every projection, and a precedence that lives in two
 * places is a precedence that will disagree with itself.
 */
const ORIGIN_RANK = { central: 0, pack: 1, local: 2 };

/** Every key a stack profile or core rule may declare is this tool's own, so every
 *  one carries the `simt-` prefix (ADR-022). A profile carrying a bare key would read
 *  as an editor's instruction — Cursor, Copilot and Antigravity all parse a
 *  frontmatter block the same way — and would be silently inert. */
/** Frontmatter keys a rule profile declares. See {@link KNOWN_KEYS} on why exported. */
export const PROFILE_KEYS = new Set(['simt-id', 'simt-title', 'simt-applies', 'simt-fallback', 'simt-scope', 'simt-priority']);

/**
 * Priority classes, packed in this order (plan 0003 R07).
 *
 * A class is not a severity, it is a promise about what a reader loses by not having
 * the line. A hard constraint is one whose absence produces a defect; a command is one
 * the reader cannot guess; a convention is right to follow and harmless to miss; a style
 * is a preference. Anything after `command` is the first thing a kernel drops, and that
 * ordering is the whole content of the mode — everything else about it is bookkeeping.
 */
export const PRIORITY_CLASSES = ['hard', 'command', 'convention', 'style'];

/** The classes a kernel keeps. `full` mode keeps all four and is the default. */
export const KERNEL_CLASSES = new Set(['hard', 'command']);

/** Report the first thing wrong with a profile's frontmatter, in the order a reader
 *  fixes it: no id to select it by, then a key that will not be read, then a tag the
 *  detector cannot emit.
 *
 *  The third check is the one a repo can get wrong by itself. A profile naming a tag
 *  no repository emits selects on nothing and fails silently: it loads, it appears in
 *  the region's source list, and it is never applied. `graph lint` checks the
 *  registry's skills against the same derived vocabulary (ADR-013, Consequences), and
 *  nothing checked the profiles until S28 changed six `simt-applies` lists with no
 *  guard that any of them named a tag the engine could produce. */
function describeDefect(meta) {
  if (meta['simt-id'] === undefined) return 'missing simt-id in frontmatter';
  const unknown = Object.keys(meta).find((k) => !PROFILE_KEYS.has(k));
  if (unknown !== undefined) {
    const prefixed = `simt-${unknown.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    return PROFILE_KEYS.has(prefixed)
      ? `key "${unknown}" is this tool's own, not the editor's; it is spelled "${prefixed}"`
      : `unrecognised frontmatter key "${unknown}"; simt-dev's own keys are simt-id, simt-title, simt-applies, simt-fallback, simt-scope`;
  }
  const applies = meta['simt-applies'];
  if (!Array.isArray(applies)) return null;
  const undeclared = applies.find((tag) => !KNOWN_TAGS.has(tag));
  if (undeclared !== undefined) {
    return `simt-applies names "${undeclared}", which fingerprint() never emits, so this profile could never be selected`;
  }
  const priority = meta['simt-priority'];
  if (priority !== undefined && !PRIORITY_CLASSES.includes(priority)) {
    return `simt-priority is "${priority}"; the classes are ${PRIORITY_CLASSES.join(', ')}, in the order a kernel packs them`;
  }
  const scope = meta['simt-scope'];
  if (scope === undefined) return null;
  // A scope that matches the whole repository is the eager profile wearing a costume:
  // the reader is told the rule narrows, and the rule loads on every file. `**` and
  // `**/*` are the two spellings of that, and both are the default a surface applies
  // when it is given no pattern at all.
  const CATCH_ALL = new Set(['**', '**/*', '*']);
  if (scope.length === 0) {
    return 'simt-scope is empty; a profile with no pattern would load as eagerly as one with no simt-scope at all';
  }
  const bad = scope.find((glob) => typeof glob !== 'string' || glob === '' || CATCH_ALL.has(glob));
  if (bad !== undefined) {
    return `simt-scope needs at least one pattern that narrows; "${bad}" matches every file, so the profile would load exactly as eagerly as one with no simt-scope`;
  }
  return null;
}

/**
 * Manifest key holding per-rule substitution values, keyed by rule id.
 *
 * Substitutions live in the manifest rather than in the rule file because they are
 * facts about the repo — which glob holds its plans, which domains are production
 * — while a rule is shared by every repo that adopts it. Putting them in the rule
 * either hard-codes one repo's paths for everyone or pushes the decision back
 * into prose, which is the drift this mechanism exists to remove.
 */
export const SUBSTITUTIONS_KEY = 'substitutions';

export function isEligible(rule, signals, optedIn) {
  if (rule.optIn === true) return optedIn.has(rule.id);
  if (rule.applies === 'always') return true;
  return Array.isArray(rule.applies) && rule.applies.some((t) => signals.has(t));
}

/**
 * Read the repo's declared substitutions and opt-ins once.
 *
 * Both callers used to read and parse `simt-dev.json` separately — and `checkTargets`
 * did it inside its per-rule loop, so a repo with three projected `.mdc` rules read the
 * manifest three times to reach the same two values. A helper that answers once is also
 * the only way to be sure the writer and the gate cannot disagree about what was
 * declared.
 */
export async function readDeclared(root) {
  let parsed = {};
  try {
    parsed = JSON.parse(await readFile(await manifestPath(root), 'utf8')) ?? {};
  } catch {
    parsed = {};
  }
  const declarations = parsed[SUBSTITUTIONS_KEY] ?? {};
  const list = declarations.__optIn;
  return {
    values: declarations,
    optIn: new Set(Array.isArray(list) ? list : []),
  };
}



/**
 * Render every canonical `.mdc` rule into its own generated region.
 *
 * A rule with a defect (no id, no target) is reported and skipped rather than
 * written somewhere guessed: a rule file that silently stopped being projected
 * would look exactly like a rule file that had nothing to say.
 */
export async function mdcTargets(root, sha, manifest, flags) {
  const targets = [];

  const { resolved, bodies, problems, notes, skipped } = await ruleBodies(root, manifest, flags);

  // A surface that folds its rules into the primary document contributes no file;
  // `ruleTargets` skips it. Folding itself is `desiredRegion`'s job, and it reads the
  // same `bodies` from the same call, so the region and the files cannot disagree.
  if (foldsRules(resolved) && !resolved.surfaces.some((s) => s.rule)) {
    if (bodies.length > 0) {
      notes.push(
        `every rule is folded into ${resolved.surfaces[0].primary}; add a surface with its own rule path for a file per rule`,
      );
    }
    return { targets, problems, notes };
  }

  for (const { rule, body } of bodies) {
    const built = await ruleTargets(root, rule, body, sha, resolved, notes);
    targets.push(...built.targets);
  }

  if (skipped.length > 0) {
    notes.push(`no .mdc rule projected for ${skipped.join(', ')}; opt in with substitutions.__optIn`);
  }
  return { targets, problems, notes };
}

/**
 * Select the per-rule canonical rules and render each one, once.
 *
 * Extracted from `mdcTargets` because ADR-021 needs the SAME bodies for two
 * different destinations: folded into the primary region when the selected surface
 * has no per-rule path, and written as one file per surface when it does. Two
 * selection passes would be two answers to "which rules apply", which is the defect
 * that produced eight divergent `.mdc` files in the first place.
 */
/**
 * The value every selected surface gives `key`, or null when they do not all give one.
 *
 * A missing entry is a disagreement: the surface that has no name for the tool would
 * otherwise be handed another harness's.
 */
function agreedSubstitution(surfaces, key) {
  if (surfaces.length === 0) return null;
  const values = surfaces.map((s) => s.substitutions?.[key]);
  if (values.some((v) => typeof v !== 'string' || v === '')) return null;
  if (new Set(values).size !== 1) return null;
  return values[0];
}

/**
 * The values renderMdc receives for one rule: what the repo declared, plus a
 * surface-named value used only when every selected surface names the same one.
 *
 * The body is written once and shared by every selected surface, so one harness's
 * tool name must not be what another harness reads. `ruleBodies` (the writer) and
 * `checkTargets` (the gate) both go through this, so they cannot disagree about what
 * the body should contain — that divergence made `check` report drift on a tree
 * `init` had just written, once a surface named a substitution (S45's askTool).
 */
export function ruleValues(rule, declared, surfaces) {
  const values = { ...declared };
  for (const sub of rule.substitutions) {
    if (Object.prototype.hasOwnProperty.call(values, sub.key)) continue;
    const agreed = agreedSubstitution(surfaces, sub.key);
    if (agreed !== null) values[sub.key] = agreed;
  }
  return values;
}

async function ruleBodies(root, manifest, flags) {
  const problems = [];
  const notes = [];
  const skipped = [];
  const bodies = [];

  const { stack, facts } = await fingerprint(root);
  const signals = new Set([...stack, ...facts]);

  const rules = await loadMdcRules();
  if (rules.length === 0) {
    notes.push('no canonical .mdc rules shipped in this build');
    const resolved = resolveSurfaces(manifest, flags ?? {});
    return { resolved, bodies, problems, notes, skipped };
  }

  const declared = await readDeclared(root);

  // Deliberately NOT folded in. This array becomes `mdc.problems`, and `sync` reports it
  // as "canonical .mdc rule(s) cannot be projected" with the remedy "fix the reported
  // substitution keys in simt.json". A surface typo is not a rule problem and has no
  // substitution keys — `surfaces: ["curosr"]` was reported to a reader as though they
  // had misspelled a key in a block they had never heard of, and the only way to find the
  // real cause was to run `check`, which already said it plainly. Two surfaces report the
  // same problem; only one of them names it correctly, and the one that mislabels it is
  // the one the writer uses.
  //
  // Nothing is lost by dropping it here: `plan` returns `surfaceProblems` from this same
  // `resolveSurfaces` call, and `checkTargets` reads it independently at project.mjs.
  const resolved = resolveSurfaces(manifest, flags ?? {});

  // A manifest key that no shipped rule declares is a typo, or a leftover from a rule
  // that was renamed. Both read as "configured" in the one file a reviewer opens to
  // see what a repo has chosen, and neither has any effect — so one is reported rather
  // than ignored. `__optIn` is the one key with no rule of the same name.
  const knownKeys = new Set(['__optIn']);
  for (const rule of rules) for (const sub of rule.substitutions) knownKeys.add(sub.key);
  for (const ruleId of Object.keys(declared.values)) {
    if (ruleId === '__optIn') continue;
    if (!rules.some((r) => r.id === ruleId)) {
      notes.push(
        `manifest declares substitutions for "${ruleId}", which no canonical rule matches; ignored`,
      );
      continue;
    }
    for (const key of Object.keys(declared.values[ruleId] ?? {})) {
      if (!knownKeys.has(key)) {
        problems.push(`${ruleId}: manifest declares substitution "${key}", which the rule does not define`);
      }
    }
  }

  for (const rule of rules) {
    if (rule.error !== null) {
      problems.push(`${rule.file}: ${rule.error}`);
      continue;
    }
    // Selection mirrors the stack profiles: `simt-applies: always` is unconditional,
    // a `simt-applies` array intersects the repo's signals, and an opt-in rule waits for
    // the manifest to name it. A repo that matches nothing gets no `.mdc` rule
    // rather than a plausible-looking one it cannot act on.
    if (!isEligible(rule, signals, declared.optIn)) {
      skipped.push(rule.id);
      continue;
    }
    const { body, problems: renderProblems } = renderMdc(
      rule,
      ruleValues(rule, declared.values[rule.id] ?? {}, resolved.surfaces),
    );
    for (const p of renderProblems) problems.push(`${rule.file}: ${p}`);
    if (renderProblems.length > 0) continue;

    // One canonical body, one target per selected surface. The body is identical
    // everywhere; only the frontmatter the editor reads before any rule text
    // differs. Without this loop a repo in a Claude Code session receives
    // AGENTS.md and none of the always-on process rules, because those lived only
    // in a directory only Cursor reads.
    bodies.push({ rule, body });
  }

  return { resolved, bodies, problems, notes, skipped };
}

/**
 * The command card for a repository and the evidence its markers may be proved by.
 *
 * Both the region and the package regions need the proofs, and they must be the same set:
 * a rule dropped at the root and kept in a package would be one rule treated as two. The
 * card comes back alongside because the caller that needs the proofs also needs the card's
 * bytes, and building it twice would read the manifest twice for no second answer.
 */
async function inferableEvidence(root, { stack, facts, manifest }) {
  const card = await commandCard({ root, manifest, stack, facts });
  return { card, proofs: inferableProofs({ facts, stack, card, manifest }) };
}

/**
 * The one place the desired region is computed. `plan` (which writes) and
 * `checkTarget` (which gates) both go through this, so they cannot disagree
 * about what the region should contain — a divergence here would report drift
 * where none exists, and CI would flake on a clean tree.
 */
export async function desiredRegion(root, flags) {
  const { stack, facts, manifest } = await fingerprint(root);
  const all = await loadRules(root);
  const { selected, fallback, notes } = select(all, stack, facts);
  const { resolved, bodies, problems, notes: ruleNotes } = await ruleBodies(
    root,
    manifest,
    flags ?? {},
  );
  notes.push(...ruleNotes);

  // A profile that declares a scope leaves the region only when every selected surface
  // can load it narrowly. The alternative is a profile written only as a scoped file for
  // a reader whose surface cannot scope — a rule nobody loads, which is worse than one
  // that loads eagerly (ADR-071). A surface that cannot scope it therefore keeps the
  // profile in the region and says so, rather than letting the region quietly shrink.
  const narrowing = resolved.surfaces.every((s) => canScope(s));
  const scoped = [];
  const inRegion = [];
  for (const r of selected) {
    const declares = Array.isArray(r.scope) && r.scope.length > 0 && r.error === null;
    if (!declares) {
      inRegion.push(r);
      continue;
    }
    // A profile only leaves the region when a narrowed file can replace it. When any
    // selected surface cannot narrow, the file would be the only home for a rule that
    // reader cannot reach — so it stays, and says why.
    if (narrowing) {
      scoped.push(r);
      continue;
    }
    inRegion.push(r);
    notes.push(
      `${r.id} declares simt-scope, but ${resolved.source} selects a surface that cannot narrow a rule, so it stays in the region`,
    );
  }

// The kernel. In `kernel` mode only the hard and command classes are packed into the
  // region and every other rule is deferred to `rules show <id>`, which is what makes
  // R08's accept criterion reachable at all: a budget cannot be met by a projection that
  // never tries. `full` is the default and stays it until R02 has measured that a
  // kernel does not lose compliance, because nobody has measured it yet.
  //
  // A rule with no stated class is deferred, not packed. The two mistakes are not
  // symmetric: packing a line that should have been deferred spends the budget the mode
  // exists to save, while deferring a line that should have been packed costs a reader
  // one `rules show`. The mode is a promise about bytes, so it is the bytes that win.
  const mode = await projectionMode(root);
  const packed = [];
  const deferred = [];
  for (const r of inRegion) {
    if (mode === 'kernel' && (r.error !== null || !KERNEL_CLASSES.has(r.priority))) deferred.push(r);
    else packed.push(r);
  }
  // The command card leads the region. The exact commands for this repository are the
  // bytes a reader cannot infer from rules that are identical everywhere (plan 0003 R10),
  // so they go first — above even the core rules. It is derived from committed evidence
  // only, in one place, so `plan` and `checkTarget` cannot disagree about it and two
  // machines render it byte-identically.
  const { card, proofs } = await inferableEvidence(root, { stack, facts, manifest });
  if (card.dropped.length > 0) {
    // Reported where every other projection note is reported. A card that lost a command
    // in silence is a card a reader cannot tell is incomplete.
    notes.push(
      `command card: dropped ${card.dropped.join(', ')} to stay within ${CARD_LIMIT_BYTES} bytes`,
    );
  }
  // Inferability (R09). A marked line leaves when the repository proves the evidence it
  // names. `shipped` is a separate list from `packed` because they are separate decisions:
  // the kernel is about which classes cost a reader nothing to skip, and this is about
  // which lines the reader already knows.
  const inferable = [];
  const shipped = [];
  for (const r of packed) {
    const filtered = filterInferable(r.body, proofs);
    if (!filtered.changed) {
      shipped.push(r);
      continue;
    }
    for (const x of filtered.removed) inferable.push({ rule: r.id, text: x.text, expr: x.expr });
    shipped.push({ ...r, body: filtered.body });
  }
  if (inferable.length > 0) {
    // Never silent, and never a heading. A line that left with no trace repeats the
    // mistake ADR-073 rejected for deferred rules, and a `## Dropped` section spends region
    // bytes on lines the reader is being told not to read. A count they can act on, plus —
    // with `--explain` — the evidence behind each one, is the third option.
    notes.push(
      `inferability: dropped ${inferable.length} line(s) this repository already proves; ${CLI} sync --explain names each one and the evidence behind it`,
    );
    if (flags?.explain === true) {
      for (const x of inferable) {
        notes.push(`inferable: ${x.rule} dropped "${x.text}" — proved by ${x.expr}`);
      }
    }
  }
  const folded = foldsRules(resolved) ? bodies.map(({ rule }) => rule.id) : [];

  // The budget, and the bytes held back for what loads beside the region.
  //
  // Read from the manifest rather than from the plan's spelling of it. Plan 0003 R08
  // wrote `projection.budget.bytes`, and ADR-072 moved the key to the top level because
  // `projection` is a generated key `upgrade` replaces wholesale - a budget that reset
  // itself on upgrade would reset the reader's context size without anyone asking. The
  // plan is not edited: the key it names is wrong, and a ruling that supersedes it is
  // the record of why.
  const budget = declaredBudget(manifest);

  // The digest is needed before the region can be weighed rather than after, because the
  // provenance header is part of what lands in the file. `provenanceDigest` is a pure
  // function of the bytes this package ships, so computing it once and passing it down is
  // the same value the tail of this function was getting on its own.
  const sha = await provenanceDigest();

  /**
   * The region, assembled from whatever survived the budget (ADR-083).
   *
   * One function, called once for the whole projection and again for each attempt the
   * packer makes, so a cut region and an uncut one are the same document by construction
   * rather than by two functions agreeing. Everything that is NOT about the kernel's
   * contents lives outside it — the card, the inferability notes, the scoped pointers, the
   * folded process bodies — because a budget is a decision about rules, and folding or
   * scoping into it would make the ceiling depend on a surface this repository selected.
   */
  const assemble = (cut) => {
    const kept = shipped.filter((r) => !cut.has(r.id));
    let text = card.text ? `${card.text}\n\n${render(kept)}` : render(kept);
    const sources = kept.map((r) => r.source);

    // The pointer. A reader who opens AGENTS.md and does not find a profile they know is
    // there will look for it, and the honest answer is where it moved: the file a scoping
    // surface loads it from, and the files it now matches. Without the line the region's
    // source list is quietly short one entry, which reads as a rule that was deleted.
    if (scoped.length > 0 && narrowing) {
      const lines = scoped.map(
        (r) =>
          `- ${sourceTitle(r, 'profile')} — loads only when a matching file is in play (${r.scope.join(', ')}): ${scopedPaths(r, resolved).join(', ')}`,
      );
      text += `\n\n## Scoped rules\n\n${lines.join('\n')}`;
      for (const r of scoped) sources.push(r.source);
    }

    // Both reasons a rule is missing land in this one section. A rule deferred by its class
    // and a rule cut to reach a byte count are different decisions, but they are the same
    // fact to a reader — it is not in the file — and splitting them into two sections
    // would spend region bytes on a heading nobody can act on. The line says which it was,
    // because a rule cut for a budget is not evidence that the kernel was ever asked to
    // leave it out.
    const omitted = [
      ...deferred.map((r) => ({
        rule: r,
        why: `${r.priority ?? 'unclassified'}, deferred in kernel mode`,
      })),
      ...shipped
        .filter((r) => cut.has(r.id))
        .map((r) => ({
          rule: r,
          why: `${r.priority ?? 'unclassified'}, cut to fit the declared budget of ${budget} bytes`,
        })),
    ];
    if (omitted.length > 0) {
      // The pointer is the same shape as the scoped one above, and for the same reason:
      // a reader who opens AGENTS.md and does not find a rule they know is there will
      // look for it. What it costs to find it has to be one command, named per rule.
      const lines = omitted
        .sort((a, b) => byPriorityThenId(a.rule, b.rule))
        .map(
          ({ rule, why }) =>
            `- ${sourceTitle(rule, 'profile')} — ${why}. Show it with: ${CLI} rules show ${rule.id}`,
        );
      text += `\n\n## Deferred rules\n\n${lines.join('\n')}`;
      for (const { rule } of omitted) sources.push(rule.source);
    }

    if (folded.length > 0) {
      for (const { rule, body: ruleBody } of bodies) {
        // `## Process:`, not `### id`. The body already uses `##`, and a third-level
        // heading in front of a second-level one is the break a reader cannot repair.
        text += `\n\n${frameSource(rule, ruleBody, 'process')}`;
        sources.push(rule.source);
      }
    }

    return { body: text, sources };
  };

  // What the region will weigh in the file it lands in, measured the way the meter
  // measures it: the composed region text, markers and provenance header included. One
  // byte conservative, because the file's own trailing newline falls outside the span —
  // and conservative in that direction is the only direction a ceiling can afford.
  const regionBytes = (assembled) =>
    Buffer.byteLength(compose(assembled.body, { sha, sources: assembled.sources }));

  let assembled = assemble(new Set());
  let packing = null;
  if (mode === 'kernel') {
    const reserve = await budgetReserve(root, resolved, bodies, sha);
    const result = packToBudget({
      // Least valuable first: the comparator the deferred section already uses, reversed.
      // Class decides and the id breaks the tie, so the cut order is a fact about the
      // repository rather than about the order the filesystem listed files in.
      candidates: [...shipped].sort((a, b) => -byPriorityThenId(a, b)),
      ceiling: budget - reserve,
      costs: (cut) => regionBytes(assemble(cut)),
    });
    packing = { ...result, bytes: budget, ceiling: budget - reserve, reserve };
    if (result.cut.length > 0) assembled = assemble(new Set(result.cut));
    if (result.cut.length > 0) {
      notes.push(
        `budget: cut ${result.cut.length} kernel rule(s) — ${result.cut.join(', ')} — from ${result.before} to ${result.after} bytes against a declared budget of ${budget}, with ${reserve} reserved for the generated files that load beside the region`,
      );
    }
    if (result.floorHeld) {
      // The one case the packer cannot fix, said where the reader will see it. `hard` is
      // the floor, so the bytes still over the line are this repository's own hard
      // constraints and the only levers left are its own: a larger budget, or a rule that
      // is not as hard as it is declared. ADR-072's kernel finding says both; this says
      // they were tried first.
      notes.push(
        `budget: still ${result.after} bytes after every rule outside the hard class was cut, against a ceiling of ${budget - reserve}; a hard constraint is not cut to reach a byte count, so the kernel itself is over the line`,
      );
    }
    if (result.floorHeld && reserve >= budget) {
      // A ceiling of zero or less is arithmetically true and useless to read: it says the
      // region is allowed no bytes, without saying that the files loading beside it have
      // already spent the whole budget. One number in that manifest is the only lever, and
      // a reader left to infer it from a subtraction is a reader who will demote a hard
      // rule to fix a budget that was set below the files it covers.
      notes.push(
        `budget: the ${reserve} bytes reserved for the generated files that load beside the region already reach the ${budget} declared, so no cut order meets this budget and the region is cut as far as the hard class allows`,
      );
    }
  }

  const meta = {
    sha,
    sources: assembled.sources,
  };
  return {
    stack,
    facts,
    manifest,
    all,
    profiles: selected.map((r) => r.id),
    folded,
    mode,
    deferred: deferred.map((r) => r.id),
    // What the budget cost this projection (ADR-083), or null in `full` mode where no
    // ceiling is applied because nothing is cut. The finding and `simt tokens` both read
    // this rather than re-deriving it, so a cut cannot be reported one way and measured
    // another.
    budget: packing === null
      ? null
      : {
          bytes: packing.bytes,
          ceiling: packing.ceiling,
          reserve: packing.reserve,
          before: packing.before,
          after: packing.after,
          floorHeld: packing.floorHeld,
          cuts: shipped
            .filter((r) => packing.cut.includes(r.id))
            .map((r) => ({ id: r.id, priority: r.priority ?? 'unclassified' })),
        },
    // The marked lines that left, each with the evidence that dropped it. The region is
    // written without them; `--explain` is what reads this list, so a removal is reportable
    // without spending region bytes and without a second computation to find it.
    inferable,
    // The profiles that left the region, and the surfaces that accepted them as files.
    // `plan` writes them and `checkTarget` gates them through this list, so a projected
    // file and a drifted one are decided by the same computation.
    scoped,
    narrowing,
    surfaces: resolved.ids,
    surfaceSource: resolved.source,
    problems,
    fallback,
    notes,
    body: assembled.body,
    meta,
  };
}

/**
 * The bytes held back from the region's own ceiling for the always-on files that load
 * beside it.
 *
 * The budget is one number for a repository, not for one file, so packing the region
 * against the whole number would ship a projection that fits on its own and pushes the
 * total over the line the moment its rule files are written. Both terms below are lower
 * bounds on what that costs, and the larger is taken because the failure each one covers
 * is the one that must not happen: under-reserving reports compliance for a projection
 * that is over budget.
 *
 * The region's own span is deliberately not in either. It is the one number that moves
 * when this projection is packed, and a ceiling that depended on the thing it governs
 * would rewrite the region on the next run and report drift on a tree `sync` had just
 * written - the step-6 defect, rebuilt one layer up.
 *
 * @param {string} root
 * @param {object} resolved the surfaces this projection writes for
 * @param {{rule: object, body: string}[]} bodies the rule bodies being projected
 * @param {string} sha the provenance digest those files will be stamped with
 * @returns {Promise<number>}
 */
async function budgetReserve(root, resolved, bodies, sha) {
  // Imported here rather than at the top of the module: `measure/context.mjs` reaches back
  // into `projection/project.mjs` for the read-limit findings, so a static import from
  // `rules.mjs` closes a loop through three modules that all have to survive being loaded
  // in any order. The loop between the other two already exists and is load-bearing in
  // neither direction; this one is walked only when a kernel is being packed.
  const { measureRoot } = await import('../measure/context.mjs');
  const measured = await measureRoot(root);
  const region = measured.documents.find((d) => d.channel === 'region');
  const installed = Math.max(0, measured.generatedBytes - (region?.generatedBytes ?? 0));

  // What this projection is about to write, for a repository that has not written it yet.
  // `ruleTargets` is the one place a rule file is turned into bytes, so the number comes
  // from there rather than from a second measurement of the same file — and its notes go
  // nowhere, because `mdcTargets` reports the same ones for the same files in the same run.
  let planned = 0;
  for (const { rule, body } of bodies) {
    for (const target of (await ruleTargets(root, rule, body, sha, resolved, [])).targets) {
      planned += target.bytes;
    }
  }
  return Math.max(installed, planned);
}

/**
 * Every per-rule file a scoped profile is written to, as paths a reader can open.
 *
 * Only the surfaces that can scope get one: a Cursor `.mdc` with `globs` and
 * `alwaysApply: false`, an Antigravity file with `trigger: glob`, a Copilot
 * `.instructions.md` with `applyTo`. A surface that reads the region already (opencode)
 * has no file channel at all, and Claude's scoping key is the documented-defect one,
 * so neither appears here.
 */
function scopedPaths(rule, resolved) {
  const out = [];
  for (const s of resolved.surfaces) {
    if (!canScope(s) || !s.rule) continue;
    // A folded surface already carries the whole region; it is the reason this profile
    // is only a file when folding is off, which is the caller's question to answer.
    if (s.foldRules === true && s.readsPrimary === true && foldsRules(resolved)) continue;
    out.push(rulePath(s.id, rule.id));
  }
  return out;
}

/**
 * Read every rule file once, with its frontmatter parsed, plus any repo-local
 * profile under `.simt-dev/profiles/`.
 *
 * A rule without a `simt-id` is a defect, not a default: ids are what `rules why`
 * and the generated region's source list refer to.
 *
 * A local profile with the same id as a central one SHADOWS it — replaces it
 * rather than stacking with it. Two profiles claiming the same id would project
 * the same rules twice, and duplicated source-of-truth text is a review blocker,
 * not a style nit. The shadow is reported in `notes` so it is never silent.
 */
export async function loadRules(root = null) {
  const entries = await readdir(RULES_DIR, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name);
  const stackFiles = entries.some((e) => e.isDirectory() && e.name === 'stacks')
    ? (await readdir(join(RULES_DIR, 'stacks')))
        .filter((n) => n.endsWith('.md'))
        .map((n) => `stacks/${n}`)
    : [];

  const collected = [];

  for (const file of [...files, ...stackFiles].sort()) {
    collected.push({ file, dir: RULES_DIR, origin: 'central', source: `rules/${file}` });
  }

  // Packs go in before the repo's own profiles and after the built-ins, because
  // that is the order they lose to. The collection order is the tie-break `select`
  // reads for two profiles of equal rank, so "collected central, then pack, then
  // local" is the precedence stated once rather than restated in the comparator.
  if (root !== null) {
    const { packs } = await resolvePacks(root);
    for (const pack of packs) {
      // `present`, not `ok`. A pack whose bytes disagree with its pin still projects:
      // dropping it would let the next `sync` delete the rules it carries, so the
      // remedy the finding names would cause the damage it exists to report.
      if (!pack.present) continue;
      const packRules = join(pack.dir, 'rules');
      let names = [];
      try {
        names = (await readdir(packRules)).filter((n) => n.endsWith('.md')).sort();
      } catch {
        names = [];
      }
      let stackNames = [];
      try {
        stackNames = (await readdir(join(packRules, 'stacks')))
          .filter((n) => n.endsWith('.md'))
          .map((n) => `stacks/${n}`);
      } catch {
        stackNames.length = 0;
      }
      for (const file of [...names, ...stackNames].sort()) {
        collected.push({
          file,
          dir: packRules,
          origin: 'pack',
          source: `${PACK_DIR}/${pack.name}/rules/${file}`,
        });
      }
    }

    const localDir = join(root, LOCAL_PROFILE_DIR);
    let localNames = [];
    try {
      localNames = (await readdir(localDir)).filter((n) => n.endsWith('.md')).sort();
    } catch {
      localNames = [];
    }
    for (const name of localNames) {
      collected.push({
        file: name,
        dir: localDir,
        origin: 'local',
        source: `${LOCAL_PROFILE_DIR}/${name}`,
      });
    }
  }

  const out = [];
  for (const item of collected) {
    const text = await readFile(join(item.dir, item.file), 'utf8');
    const meta = parseFrontmatter(text);
    const body = stripFrontmatter(text);
    out.push({
      file: item.file,
      origin: item.origin,
      source: item.source,
      id: meta['simt-id'] ?? null,
      title: meta['simt-title'] ?? null,
      applies: meta['simt-applies'] ?? [],
      fallback: meta['simt-fallback'] === true,
      scope: Array.isArray(meta['simt-scope']) ? meta['simt-scope'] : null,
      priority: meta['simt-priority'] ?? null,
      bytes: Buffer.byteLength(text),
      body,
      // A marker naming evidence the tool cannot check is a broken rule like any other, so
      // it travels the field that already reaches `check` and `rules list`. The
      // frontmatter defect wins, because a rule that cannot say what it applies to cannot
      // be reasoned about at all.
      error: describeDefect(meta) ?? inferableDefect(body),
    });
  }
  return out;
}

/**
 * The regions a monorepo's packages each need, as bodies ready to be written.
 *
 * A repository with packages in it is projected twice over: the root carries the
 * rules every package shares, and each package carries the profiles IT selects and
 * the root does not. A reader working in `apps/web` opens two files by walking up,
 * and gets the union; a reader who only reads the root still gets everything that
 * is not package-specific. Nothing is repeated, so nothing goes stale twice
 * (ADR-066).
 *
 * A package whose delta is empty gets no file. Writing an empty region into every
 * directory of a large monorepo would be noise the reader has to learn to skip,
 * and a file with nothing in it is not a projection, it is an absence with a
 * generated header on it.
 *
 * The rule set is the ROOT's - local profiles and packs are the repository's, and
 * a package that re-read them from its own directory would resolve a different
 * set in a directory that has no manifest.
 *
 * @returns {Promise<{regions: {path: string, ecosystem: string, stack: string[],
 *   facts: string[], profiles: string[], body: string, meta: {sha: string, sources: string[]}}[],
 *   notes: string[]}>}
 */
export async function packageRegions(root, flags, rootProfiles = null) {
  const shared = rootProfiles ?? (await desiredRegion(root, flags)).profiles;
  const { packages, notes } = await discoverPackages(root);
  if (packages.length === 0) return { regions: [], notes };

  const rules = await loadRules(root);
  const sha = await provenanceDigest();
  // The ROOT's proofs, not the package's. The rule set is the root's, so which lines it
  // already proves is a fact about the repository rather than about the directory a file
  // lands in — filtering a package by the package's own facts would keep a rule here and
  // drop it one directory up, which is the same rule treated as two.
  const { proofs } = await inferableEvidence(root, await fingerprint(root));
  const regions = [];
  for (const pkg of packages) {
    const fp = await fingerprint(join(root, pkg.path));
    const { selected } = select(rules, fp.stack ?? [], fp.facts ?? []);
    const delta = selected.filter((r) => !shared.includes(r.id));
    if (delta.length === 0) continue;
    const shipped = delta.map((r) => {
      const filtered = filterInferable(r.body, proofs);
      return filtered.changed ? { ...r, body: filtered.body } : r;
    });
    regions.push({
      path: pkg.path,
      ecosystem: pkg.ecosystem,
      stack: fp.stack ?? [],
      facts: fp.facts ?? [],
      profiles: delta.map((r) => r.id),
      // One sentence, because the file's whole purpose is to be found by a reader
      // who does not know it exists: without it, a nested region reads as a
      // complete set of rules and the shared half looks forgotten.
      body: `The rules this package selects on its own. Everything the repository shares with its other packages is in the region at the root.\n\n${render(shipped)}`,
      meta: { sha, sources: delta.map((r) => r.source) },
    });
  }
  return { regions, notes };
}

/**
 * Selection is pure set intersection: core always, then every profile whose
 * `simt-applies` intersects the repo's signals. `node` is the fallback, so it is only
 * chosen when nothing more specific matched — otherwise every JS repo would
 * receive both node and react-web.
 *
 * `signals` is stack tags ∪ facts (ADR-013). A profile may name either, and a
 * fact is the more durable choice because it survives the framework being
 * replaced.
 *
 * `shadowed` lists profiles that replaced one they outrank, so a caller can
 * report it rather than silently changing what a repo receives.
 */
export function select(rules, stack, facts = []) {
  const notes = [];
  const shadowed = [];
  const ids = new Map();
  for (const rule of rules) {
    if (rule.id === null) continue;
    const prior = ids.get(rule.id);
    if (prior === undefined) {
      ids.set(rule.id, rule);
      continue;
    }
    // A profile may replace one it outranks; two of the same origin are a defect
    // the caller must be able to see.
    //
    // Ranked rather than `=== 'local'` because there is now a third origin. The
    // ordering it encodes - the repository's own profile, then a pack it declares,
    // then what the tool ships - is the whole precedence rule, in one comparison
    // that cannot drift from the order the files were collected in.
    const localWins = ORIGIN_RANK[rule.origin] > ORIGIN_RANK[prior.origin];
    if (localWins) {
      ids.set(rule.id, rule);
      shadowed.push({
        id: rule.id,
        winner: rule.source,
        replaced: prior.source,
        ok: true,
      });
    } else {
      shadowed.push({
        id: rule.id,
        winner: prior.source,
        replaced: rule.source,
        ok: false,
      });
    }
  }
  const keep = new Set(ids.values());

  const effective = rules.filter((r) => r.id === null || keep.has(r));
  const effCore = effective.filter((r) => r.applies === 'always');
  const effProfiles = effective.filter((r) => Array.isArray(r.applies) && !r.fallback);
  const effFallbacks = effective.filter((r) => r.fallback);

  const signals = [...new Set([...(stack ?? []), ...(facts ?? [])])];
  const tags = new Set(signals);
  const matched = effProfiles.filter((r) => r.applies.some((tag) => tags.has(tag)));

  let usedFallback = false;
  const selected = [...effCore, ...matched];
  if (matched.length === 0) {
    for (const f of effFallbacks) {
      if (f.applies.some((tag) => tags.has(tag))) {
        selected.push(f);
        usedFallback = true;
        notes.push(
          `no specific profile matched ${signals.join(', ') || '(no signals)'}; using fallback ${f.id}`,
        );
      }
    }
  }
  if (matched.length === 0 && usedFallback === false) {
    notes.push(
      `no profile matched ${signals.length > 0 ? signals.join(', ') : '(no detected signals)'}; projecting shared rules only`,
    );
  }
  for (const s of shadowed.filter((x) => x.ok)) {
    notes.push(`local profile ${s.id} shadows ${s.replaced}`);
  }
  for (const s of shadowed.filter((x) => !x.ok)) {
    notes.push(`duplicate profile id ${s.id}: ignored ${s.replaced}, kept ${s.winner}`);
  }
  return { selected, fallback: usedFallback, notes, shadowed };
}

/** The region body. Stack profiles come after core so the general rule wins a
 *  conflict: a stack profile refines the shared rule, it does not replace it.
 *
 *  Each source is one `##` section. The source's own headings drop one level,
 *  so a profile's `##` cannot sit beside core's and look like the same document
 *  continuing (S34). */
export function render(selected) {
  // Strip again here: loadRules already does it, but render is the boundary the
  // region bytes pass through, and a stray frontmatter or duplicated H1 in the
  // output would be projected verbatim.
  return selected
    .map((r) => frameSource(r, stripFrontmatter(r.body).trim(), 'profile'))
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The projection mode this repository declared, or `full`.
 *
 * Absent means `full`, and `full` is the default rather than a fallback: no measurement
 * yet says a kernel does not lose compliance (plan 0003 R02), so the mode that changes
 * what a reader gets cannot be the one nobody chose.
 */
async function projectionMode(root) {
  const { manifest } = await readManifest(root);
  return manifest?.mode === 'kernel' ? 'kernel' : 'full';
}

/**
 * Deterministic kernel order: the class a rule declares, then its id.
 *
 * The tie-break is not decoration. Two rules of the same class packed in file order
 * would move when a file is added to the directory, and a projection that reorders
 * itself on an unrelated commit is a projection nobody can diff (ADR-013).
 */
function byPriorityThenId(a, b) {
  const classA = PRIORITY_CLASSES.indexOf(a.priority ?? 'style');
  const classB = PRIORITY_CLASSES.indexOf(b.priority ?? 'style');
  if (classA !== classB) return classA - classB;
  return String(a.id).localeCompare(String(b.id));
}

/**
 * One source, one `##` heading, then its body with every heading demoted.
 *
 * `Applies to` is already the first line of a stack profile once its H1 is gone,
 * so it lands directly under `## Stack: …` instead of under whatever section the
 * previous source ended on.
 */
function frameSource(rule, body, kind) {
  const text = demoteHeadings(body).trim();
  if (!text) return '';
  const title = sourceTitle(rule, kind);
  if (!title) return text;
  return `## ${title}\n\n${text}`;
}

function sourceTitle(rule, kind) {
  if (!rule?.id) return null;
  if (kind === 'process') return `Process: ${rule.id}`;
  if (rule.id === 'core') return 'Core';
  return `Stack: ${rule.id}`;
}

/** `##` becomes `###`. A fence is left alone: a heading in an example is an example. */
function demoteHeadings(text) {
  let fence = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^(```|~~~)/.test(line)) {
        fence = !fence;
        return line;
      }
      if (fence) return line;
      return line.replace(/^(#{1,5})(?=\s)/, '$1#');
    })
    .join('\n');
}

function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-zA-Z-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, raw] = kv;
    if (raw === 'always') out[key] = 'always';
    else if (raw === 'true') out[key] = true;
    else if (raw === 'false') out[key] = false;
    else if (raw.startsWith('[')) {
      out[key] = raw
        .slice(1, raw.lastIndexOf(']'))
        .split(',')
        .map((s) => s.trim())
        // A quoted item is a quoted item: the glob inside is the value, not the quotes
        // around it. A profile author quoting `\"src/**/*.ts\"` because their editor
        // colouring complains about a bare `*` would otherwise project a pattern the
        // surface matches nothing against.
        .map((s) => (s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s))
        .map((s) => (s.length >= 2 && s.startsWith("'") && s.endsWith("'") ? s.slice(1, -1) : s))
        .filter(Boolean);
    } else out[key] = raw.trim();
  }
  return out;
}

/** Frontmatter and the duplicated H1 are dropped: the region is embedded in a
 *  host document that already has a title, so repeating it wastes context. */
function stripFrontmatter(text) {
  // The frontmatter strip must also swallow the blank lines that follow it, or
  // the H1 strip's `^` anchor lands on a newline and silently matches nothing.
  return text
    .replace(/^---\n[\s\S]*?\n---\n*/, '')
    .replace(/^#\s+.*\n+/, '')
    .trim();
}

