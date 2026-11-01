// The desired region, in one place, so `plan` and `check` cannot disagree.
//
// Moved out of rules.mjs when that module crossed the ceiling. The projection it
// computes is one answer with one caller contract: `sync` writes it, `check` compares
// it, and a second copy of it would report drift on a tree `sync` had just written.

import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { fingerprint, KNOWN_TAGS } from '../resolve/fingerprint.mjs';
import { loadMdcRules, renderMdc } from './mdc.mjs';
import { foldsRules, resolveSurfaces, rulePath, canScope } from './surfaces.mjs';
import { ruleTargets } from './targets.mjs';
import { compose } from './markers.mjs';
import { declaredBudget, declaredShared, readManifest } from './manifest.mjs';
import { loadManifest } from '../manifest/schema.mjs';
import { commandCard, CARD_LIMIT_BYTES } from '../kernel/card.mjs';
import { packToBudget } from '../kernel/budget.mjs';
import { filterInferable, inferableDefect, inferableProofs } from '../kernel/inferability.mjs';
import { checkDefect, foldChecks } from '../kernel/checks.mjs';
import { foldVariants, readLockedVariants, variantsDefect } from '../kernel/variants.mjs';
import { BASELINES } from './baselines.mjs';
import { CLI, MANIFEST_FILE } from '../name.mjs';
import { installedSkills } from './disclosure.mjs';
import { PACK_DIR, resolvePacks } from '../packs.mjs';
import { discoverPackages } from '../monorepo.mjs';
import { KERNEL_CLASSES, ORIENTATION_POINTER, byPriorityThenId, crossRefProblems, frameSource, inferableEvidence, loadRules, mdcTargets, projectionMode, provenanceDigest, render, ruleBodies, select, sourceTitle, stableOrder, stripFrontmatter, toolRule } from './rules.mjs';

export async function desiredRegion(root, flags) {
  const { stack, facts, manifest } = await fingerprint(root);
  const lockedVariants =
    flags?.variants !== undefined ? flags.variants : await readLockedVariants(root);
  const all = await loadRules(root);
  const { selected, fallback, notes } = select(all, stack, facts);
  const { resolved, bodies, problems, notes: ruleNotes } = await ruleBodies(
    root,
    manifest,
    { ...(flags ?? {}), variants: lockedVariants },
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
      const vf = foldVariants(r.body, r.id ?? '', lockedVariants);
      scoped.push(vf.changed ? { ...r, body: vf.body } : r);
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
  // An explicit `mode` flag overrides the declared one. The caller is the MCP
  // `simt://kernel` resource, which by name promises the kernel's bytes for any
  // repository: the declared mode governs what `sync` writes to disk, not what a read
  // path may look at, so the read renders in the mode the URI names instead of
  // re-reading a manifest it must not obey (ADR-002).
  const mode = typeof flags?.mode === 'string' ? flags.mode : await projectionMode(root);
  const packed = [];
  const deferred = [];
  for (const r of inRegion) {
    if (mode === 'kernel' && (r.error !== null || !KERNEL_CLASSES.has(r.priority))) deferred.push(r);
    else packed.push(r);
  }
  // The command card leads the region. The exact commands for this repository are the
  // bytes a reader cannot infer from rules that are identical everywhere,
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
  // Inferability . A marked line leaves when the repository proves the evidence it
  // names. `shipped` is a separate list from `packed` because they are separate decisions:
  // the kernel is about which classes cost a reader nothing to skip, and this is about
  // which lines the reader already knows.
  const inferable = [];
  const shipped = [];
  const variantsSelected = [];
  let enforced = 0;
  for (const r of packed) {
    const variantFolded = foldVariants(r.body, r.id ?? '', lockedVariants);
    const filtered = filterInferable(variantFolded.body, proofs);
    const folded = foldChecks(filtered.body);
    enforced += folded.enforced.length;
    variantsSelected.push(...variantFolded.selected);
    if (!variantFolded.changed && !filtered.changed && !folded.changed) {
      shipped.push(r);
      continue;
    }
    for (const x of filtered.removed) inferable.push({ rule: r.id, text: x.text, expr: x.expr });
    shipped.push({ ...r, body: folded.body });
  }
  // A body that points the reader at a profile they cannot reach is a rule-text defect:
  // the region renders, but the reference dangles. Kept out of `problems` because that
  // array is the mdc list `sync` already reports, and one fault must not print twice.
  const crossRefs = [];
  const selectedIds = new Set(selected.map((r) => r.id));
  for (const r of shipped) {
    for (const p of crossRefProblems(r.body, all, selectedIds)) {
      crossRefs.push(`${r.id}: ${p}`);
    }
  }
  const lockedNonDefault = variantsSelected.filter((v) => v.locked && v.winner !== v.baseline);
  if (lockedNonDefault.length > 0) {
    notes.push(
      `variants: applied ${lockedNonDefault.length} locked variant(s) (${lockedNonDefault.map((v) => `${v.slotId}=${v.winner}`).join(', ')})`,
    );
  }
  if (enforced > 0) {
    notes.push(
      `enforced: ${enforced} line(s) left the region because a checker runs them`,
    );
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

  // The workspace-shared rules this repository declared (ADR-084).
  //
  // Read from the manifest and never from the reader's home directory, because this
  // function is what `sync` and `check` both call: a region that depended on what
  // somebody had installed would render differently on a machine where they had not,
  // and CI would report drift on a tree `sync` had just written. The ids travel in the
  // manifest so the answer to "what leaves this region" is a fact about the repository.
  const declared = declaredShared(manifest);
  const carriedIds = new Set(declared.level === null ? [] : [...declared.rules]);

  // Every rule the workspace carries, as the rule objects the index below names. Both
  // lists, because a surface that folds its rules into the primary document carries the
  // canonical process bodies in that document too — and a reader who cannot find
  // `slice-commit` anywhere near their repository will look for it in AGENTS.md.
  const carried = [
    ...shipped.filter((r) => carriedIds.has(r.id)).map((rule) => ({ rule, kind: 'profile' })),
    ...bodies.filter(({ rule }) => carriedIds.has(rule.id)).map(({ rule }) => ({ rule, kind: 'process' })),
  ];

  // The rules this root would carry in its region, with the bytes it would carry them
  // in — the input ADR-084's workspace intersection compares.
  //
  // Computed from `shipped` rather than from what the region ends up carrying, and that
  // is the whole reason it is computed at all: a rule already declared shared must still
  // appear here, or a second `shared install` would intersect against a list that no
  // longer contained it and shrink the shared file every time anybody ran the command.
  // The declaration is an input to the region; it is not an input to what is shareable.
  const shareable = [
    // Only the rules this package ships. A repository's own profile, or a pack it
    // installed, is policy somebody chose to write: carrying it into a shared home file
    // would mean editing that file to change a repository's rules, and the copy would
    // reach every other repository in the estate that declared the same id. A rule
    // somebody can override must stay somewhere they own.
    ...shipped
      .filter((r) => r.error === null && toolRule(r) && typeof r.id === 'string' && r.id !== '')
      .map((r) => ({
        id: r.id,
        source: r.source,
        priority: r.priority ?? null,
        rendered: frameSource(r, stripFrontmatter(r.body).trim(), 'profile'),
      })),
    // The folded process bodies, and only while they are folded. A surface that writes
    // one file per rule expects that file at a path inside the repository, so a
    // user-level copy cannot stand in for it — but when the surface folds the whole region
    // into the primary document, those bytes are as repeated across a workspace as the
    // profiles are, and `tokens --repos` named them as the last duplicate block in a
    // two-repository measurement.
    ...bodies
      .filter(({ rule }) => folded.includes(rule.id) && toolRule(rule))
      .map(({ rule, body }) => ({
        id: rule.id,
        source: rule.source,
        priority: rule.priority ?? null,
        rendered: frameSource(rule, body, 'process'),
      })),
  ].filter((r) => r.rendered !== '');

  // The selected rules that are not shareable, with the reason. `shared plan` reporting
  // only what it carries would imply every profile in the workspace had been accounted
  // for, and a reader whose own house rule is missing from the list would conclude it
  // moved — so the names it did not take, and why, are data rather than an omission.
  const shareableIds = new Set(shareable.map((r) => r.id));
  const excluded = selected
    .filter((r) => typeof r.id === 'string' && r.id !== '' && !shareableIds.has(r.id))
    .map((r) => ({
      id: r.id,
      why: r.error !== null ? 'error' : toolRule(r) ? 'empty' : 'policy',
    }));

  // The budget, and the bytes held back for what loads beside the region.
  //
  // Read from the manifest rather than from the plan's spelling of it. Plan 0003 R08
  // wrote `projection.budget.bytes`, and ADR-072 moved the key to the top level because
  // `projection` is a generated key `upgrade` replaces wholesale - a budget that reset
  // itself on upgrade would reset the reader's context size without anyone asking. The
  // plan is not edited: the key it names is wrong, and a ruling that supersedes it is
  // the record of why.
  const budget = declaredBudget(manifest);
  // Names and triggers only. Read once, outside the packer, because a skill does not
  // change as rules are cut and reading its body here would put the cost back into the
  // region the index exists to keep it out of (ADR-085).
  const skills = await installedSkills(root);

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
   * rather than by two functions agreeing. The card, the inferability notes, the folded
   * process bodies and the disclosure index are not candidates for a cut: a budget is a
   * decision about rules, and dropping the index would hide the rules the cut removed.
   */
  const assemble = (cut) => {
    // A rule the workspace carries once leaves the region, and so does a rule the packer
    // could not afford. Both are exclusions from the same list, so the section below can
    // name all three reasons — which is the only reason the section exists: a reader who
    // opens AGENTS.md and does not find a rule they know is there will look for it.
    const kept = shipped.filter((r) => !cut.has(r.id) && !carriedIds.has(r.id));
    // Stable bytes first (ADR-086). Core, then the profiles this package ships, then
    // everything this repository added — the card, its own profiles, the process
    // bodies. A line the repository edits then changes only the tail, and the prefix
    // a reader has cached stays byte-identical. The card used to lead (ADR-077 ruling
    // 1); it now leads the tail, because a command this repository owns is the thing
    // an edit is most likely to move.
    const stable = kept.filter((r) => toolRule(r)).sort(stableOrder);
    const repoRules = kept.filter((r) => !toolRule(r)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    let text = render(stable);
    if (card.text) text += `${text === '' ? '' : '\n\n'}${card.text}`;
    // The pointer follows the card: the card says what this repository runs, and the
    // pointer says how the tool serves a task. Adjacent, they read as one block of
    // repo-facing advice instead of two facts the reader has to connect.
    text += `${text === '' ? '' : '\n\n'}${ORIENTATION_POINTER}`;
    const repoText = render(repoRules);
    if (repoText) text += `\n\n${repoText}`;
    const sources = [...stable, ...repoRules].map((r) => r.source);

    // Every reason a rule is missing lands in this one section, and each line says which
    // it was. A rule deferred by its class, a rule cut to reach a byte count and a rule
    // the workspace carries once are three different decisions, but they are the same fact
    // to a reader — it is not in this file — and three headings would spend region bytes
    // on structure nobody can act on. The line names the command that shows the rule,
    // because for all three the remedy is the same single read.
    //
    // The label is the rule's own frame title, which is why each entry carries the kind it
    // is rendered as: a canonical rule that the surface folds in is `Process: <id>` in the
    // shared file, and an index that calls it `Stack:` sends the reader looking for the
    // wrong thing.
    const omitted = [
      ...deferred.map((r) => ({ rule: r, kind: 'profile', why: `${r.priority ?? 'unclassified'}, deferred in kernel mode` })),
      ...shipped
        .filter((r) => cut.has(r.id))
        .map((r) => ({
          rule: r,
          kind: 'profile',
          why: `${r.priority ?? 'unclassified'}, cut to fit the declared budget of ${budget} bytes`,
        })),
      ...carried.map(({ rule, kind }) => ({
        rule,
        kind,
        // No path here, deliberately. This text is rendered by `sync` in CI, where the
        // reader's home directory is somebody else's, and a path is the one thing in a
        // remedy that cannot be true on both. The remedy is a command that works on the
        // machine the reader is on.
        why: `${rule.priority ?? 'unclassified'}, carried once per workspace in your reader's user-level rules file instead; if your reader has no copy, run: ${CLI} shared install`,
      })),
    ];
    if (omitted.length > 0) {
      // The pointer is the same shape as the scoped one above, and for the same reason:
      // a reader who opens AGENTS.md and does not find a rule they know is there will
      // look for it. What it costs to find it has to be one command, named per rule.
      const lines = omitted
        .sort((a, b) => byPriorityThenId(a.rule, b.rule))
        .map(
          ({ rule, kind, why }) =>
            `- ${sourceTitle(rule, kind)} — ${why}. Show it with: ${CLI} rules show ${rule.id}`,
        );
      // `## Rules not in this region`, not `## Deferred rules`. The heading was written
      // when there was one reason to be here (ADR-073) and it is region text a reader
      // reads, so a heading that names one of three reasons misdescribes the two others
      // (ADR-084).
      text += `\n\n## Rules not in this region\n\n${lines.join('\n')}`;
      for (const { rule } of omitted) sources.push(rule.source);
    }

    if (folded.length > 0) {
      for (const { rule, body: ruleBody } of bodies) {
        // A body the workspace carries once is not folded in here either. The heading is
        // about how the surface loads the region, so it stays; the rule under it does not,
        // and a region that carried the same bytes twice is the redundancy ADR-084 exists
        // to remove — reintroduced by the feature that removes it.
        if (carriedIds.has(rule.id)) continue;
        // `## Process:`, not `### id`. The body already uses `##`, and a third-level
        // heading in front of a second-level one is the break a reader cannot repair.
        text += `\n\n${frameSource(rule, ruleBody, 'process')}`;
        sources.push(rule.source);
      }
    }

    // Last, because this is the index of what the file deliberately does not contain
    // (ADR-085). A scoped profile keeps the pointer ADR-071 requires — its patterns and
    // the files it moved to — and a skill keeps its name and the description that says
    // when to open it. The body of either is the thing that was moved out.
    const disclosure = [];
    if (scoped.length > 0 && narrowing) {
      for (const r of scoped) {
        disclosure.push(
          `- ${sourceTitle(r, 'profile')} — loads only when a matching file is in play (${r.scope.join(', ')}): ${scopedPaths(r, resolved).join(', ')}`,
        );
        sources.push(r.source);
      }
    }
    const skillNames = new Map();
    for (const skill of skills) skillNames.set(skill.name, (skillNames.get(skill.name) ?? 0) + 1);
    for (const skill of skills) {
      const label = skillNames.get(skill.name) > 1 ? `${skill.name} (${skill.dir})` : skill.name;
      disclosure.push(
        skill.trigger === ''
          ? `- ${label} — no description, so nothing says when to open it. Show it with: ${CLI} skills show ${skill.name}`
          : `- ${label} — ${skill.trigger}`,
      );
    }
    if (disclosure.length > 0) text += `\n\n## Disclosure\n\n${disclosure.join('\n')}`;

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
      //
      // The workspace-shared rules are not candidates, and that is not a rounding: cutting
      // one cannot make the region smaller by more than the index line it adds to the
      // section below, because the rule is carried once per workspace whatever this region
      // does. A packer that spent its budget on them would report a saving it did not make.
      candidates: shipped
        .filter((r) => !carriedIds.has(r.id))
        .sort((a, b) => -byPriorityThenId(a, b)),
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
    // What the workspace carries once per reader instead of here (ADR-084), as ids. The
    // declaration is what `check` and `sync` both read to decide the region, so the ids
    // that actually left are reported for the same reason the budget's cuts are: a rule
    // that disappeared needs a name in the output, or a reader looks for it in vain.
    carried: carried.map(({ rule }) => rule.id),
    // What this root could contribute to a workspace's shared file, with the bytes it
    // would contribute. Read by `simt shared`, never by the projection — which is why
    // computing it costs a frame per rule and buys nothing on `sync`.
    shareable,
    // What it selected and cannot contribute, with the reason. Reported so that a rule
    // staying in the region is always a decision somebody can see rather than an absence.
    excluded,
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
    crossRefs,
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


