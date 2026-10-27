// `simt shared` - carry a workspace's repeated rules once, in the reader's home directory.
//
// Plan 0003 R11. The estate measured 90 KB of always-on rules across seven repositories
// with 72% of it a paragraph an earlier root had already loaded (review 0002 S38), and the
// plan's answer was to install the repeated part once per harness and let each region carry
// a delta.
//
// Two subcommands and no more. `plan` answers "what would this do, and where", because a
// command that writes into `$HOME` without printing the plan first is the one command in
// this tool that can surprise somebody on their own machine. `install` does it. Staleness
// is `doctor`'s job rather than a third subcommand: a question asked about a repository is
// answered by the command that already reports on a repository (ADR-084).

import { EXIT, emit, emitJson, fail, isJson } from '../output/index.mjs';
import { CLI, MANIFEST_FILE } from '../name.mjs';
import { targetRoot } from '../workspace.mjs';
import { diffField, emitDiffs, readBefore } from '../diff.mjs';
import {
  injectShared,
  intersect,
  sharedBody,
  sharedCandidates,
  sharedCoverage,
  sharedMeta,
  sharedRoots,
  sharedState,
  sharedTargets,
  writeSharedFile,
} from '../projection/shared.mjs';
import { buildManifest, declaredShared, manifestPath, manifestText, readManifest, writeManifest } from '../projection/manifest.mjs';
import { desiredRegion } from '../projection/rules.mjs';

/**
 * Everything `plan` and `install` both need, computed once.
 *
 * One function because the two commands must not be able to disagree about what they are
 * about: an `install` that computed a different shared set from the one it printed is a
 * command that writes something the reader was not shown, into their home directory.
 */
async function gather(flags) {
  const target = await targetRoot(flags, []);
  const { roots, error } = await sharedRoots(target.root);
  if (error !== null) return { error: `${target.root}: ${error}` };
  if (roots.length === 0) {
    return {
      error: `${target.root} contains no git repositories`,
      remedy: `point --root at the directory holding the repositories, or run this in one repository with --root <path>`,
    };
  }
  const rows = await sharedCandidates(roots, flags);
  const { shared, divergent } = intersect(rows);
  const meta = await sharedMeta(shared);

  // The union of every root's surfaces: the reader's home carries one file per harness any
  // repository in the estate uses, because a reader works in more than one of these roots
  // and the file is per-machine rather than per-repository.
  const surfaces = [...new Set(rows.flatMap((row) => row.desired.surfaces))];
  const targets = await sharedTargets(surfaces);
  // Deduped across roots, in the order the first root names them: two roots that both
  // selected a rule and both refused to carry it are one line, not two identical ones.
  const excluded = [];
  for (const row of rows) {
    for (const entry of row.desired.excluded) {
      if (!excluded.some((e) => e.id === entry.id)) excluded.push(entry);
    }
  }
  return { target, rows, shared, divergent, excluded, meta, targets, roots };
}

/**
 * One sentence per rule the workspace cannot carry once, in the words its reason deserves.
 *
 * A rule every root carries but renders differently, a rule only some roots carry, and a
 * rule this repository selected and cannot hand over at all are three different events, and
 * a reader deciding whether to act on one needs to know which happened.
 */
function divergentNote(d, total) {
  if (d.reason === 'coverage') {
    return `${d.id}  carried by ${plain(d.roots.length)} of ${plain(total)} repositories, so each region keeps its own`;
  }
  return `${d.id}  rendered differently in ${plain(d.roots.length)} repositories, so each region keeps its own`;
}

/** Why a selected rule cannot leave any region, in the words its reason deserves. */
function excludedNote({ id, why }) {
  if (why === 'policy') return `${id}  is a repository's own profile or pack policy, which stays where it was written`;
  if (why === 'error') return `${id}  could not be read cleanly, so it stays where it was written`;
  return `${id}  renders to nothing, so there is nothing to carry`;
}

/**
 * What to say when the copy is larger than the harness's own limit on that file.
 *
 * Reported rather than prevented: the cap is a fact about the reader's harness and the
 * estate's rules are the reader's to choose, but a copy that Codex stops reading halfway
 * through is a failure the reader would otherwise discover as "the agent ignored my rules".
 */
function capNote(target, bytes) {
  if (target.path === null || target.cap === null || bytes <= target.cap.bytes) return null;
  return [
    `${target.surface}  ${plain(bytes)} B exceeds the ${plain(target.cap.bytes)} B it allows for ${target.cap.appliesTo}`,
    `  ${target.cap.why}`,
    `  the rules above that limit are not read; move rules this workspace does not share back into each region, or drop the shared copy for this surface`,
  ].join('\n');
}

/** The per-root line: what this repository carries now, and what it would stop carrying. */
function perRoot(rows, shared) {
  const ids = new Set(shared.map((r) => r.id));
  return rows.map((row) => {
    const full = row.desired.shareable.filter((r) => ids.has(r.id));
    return {
      root: row.path,
      name: basename(row.path),
      surfaces: row.desired.surfaces,
      stack: row.desired.stack,
      mode: row.desired.mode,
      // The bytes the region gives up, measured as the frames themselves rather than as a
      // difference between two whole projections: the region's own header, card and index
      // stay, and a number that hid them would be a saving no reader would ever see.
      bytes: full.reduce((n, r) => n + Buffer.byteLength(`${r.rendered}\n\n`), 0),
      rules: full.map((r) => r.id),
    };
  });
}

export async function sharedPlanCommand(_args, flags) {
  const gathered = await gather(flags);
  if (gathered.error !== undefined) return fail(gathered.error, EXIT.CONFIG, gathered.remedy);
  const { target, roots, shared, divergent, excluded, meta, targets } = gathered;
  const rows = perRoot(gathered.rows, shared);
  const body = sharedBody(shared);
  const bytes = Buffer.byteLength(body);
  const save = rows.reduce((n, r) => n + r.bytes, 0);
  // Every id any root put forward, so the count cannot read as "and the rest were carried".
  const candidates = new Set([...shared, ...divergent, ...excluded].map((r) => r.id)).size;

  if (isJson(flags)) {
    emitJson({
      ok: true,
      command: 'shared plan',
      root: target.root,
      mode: 'plan',
      source: target.source,
      roots,
      shared,
      divergent,
      excluded,
      candidates,
      bytes,
      saving: save,
      targets,
      perRoot: rows,
      provenance: meta,
    });
    return EXIT.OK;
  }

  const lines = [
    `shared   ${target.root}  ${plain(roots.length)} repositories  (${target.source})`,
    `rules    ${plain(shared.length)} of ${plain(candidates)} ids carried once  ${plain(bytes)} B`,
  ];
  for (const r of shared) lines.push(`  ${r.id}  ${r.priority ?? 'unclassified'}  ${plain(Buffer.byteLength(r.rendered))} B  ${r.source}`);
  if (divergent.length > 0) {
    // Named, not summarised: a reader who expected a python rule here and did not get it
    // is owed the reason, and "divergent: 2" is not a reason.
    lines.push(`left in every region  ${divergent.length} rule(s) the roots do not carry identically:`);
    for (const d of divergent) lines.push(`  ${divergentNote(d, roots.length)}`);
  }
  if (excluded.length > 0) {
    lines.push(`left in every region  ${excluded.length} rule(s) no root can hand over:`);
    for (const e of excluded) lines.push(`  ${excludedNote(e)}`);
  }
  lines.push(`saves    ${plain(save)} B across ${plain(roots.length)} regions`);
  for (const r of rows) {
    lines.push(`  ${r.name}  ${plain(r.bytes)} B  ${r.mode}  ${r.rules.length > 0 ? r.rules.join(', ') : '(carries nothing extra)'}`);
  }
  lines.push('writes');
  for (const t of targets) {
    lines.push(
      t.path === null
        ? `  ${t.surface}  printed for you to paste - ${t.why}`
        : `  ${t.path}  ${t.why}`,
    );
  }
  lines.push(`manifest ${MANIFEST_FILE} in each repository  shared.level = user, shared.rules = the ids above`);
  for (const t of targets) {
    const over = capNote(t, bytes);
    if (over !== null) lines.push(`warn     ${over}`);
  }
  lines.push(`nothing written; re-run with: ${CLI} shared install --yes`);
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}

export async function sharedInstallCommand(_args, flags) {
  const gathered = await gather(flags);
  if (gathered.error !== undefined) return fail(gathered.error, EXIT.CONFIG, gathered.remedy);
  const { roots, shared, divergent, meta, targets } = gathered;

  if (shared.length === 0) {
    // A workspace where every root carries different rules has nothing to share, and
    // writing an empty file into a reader's home directory is a thing that looks like an
    // install and is not one.
    return fail(
      `no rule is carried with identical bytes by all ${roots.length} repositories`,
      EXIT.UNSUPPORTED,
      divergent.length > 0
        ? `${divergent.map((d) => d.id).join(', ')} differ between repositories; each region keeps its own copy`
        : `every repository in ${roots.length === 1 ? 'this repository' : 'this workspace'} carries a different rule set`,
    );
  }

  // The declaration goes into every root that already has a manifest. A root without
  // one is skipped: adopting it is `init`'s job, and this command does not adopt a
  // repository in order to share its rules. The list is never empty — a workspace with
  // nothing to share was refused above — so the reader of the manifest sees a level and
  // a set of ids, which is what `doctor` checks the reader's copy against.
  const declaration = { level: 'user', rules: shared.map((r) => r.id) };
  const manifests = [];
  for (const root of roots) {
    const { manifest, exists } = await readManifest(root);
    if (!exists || manifest === null) {
      manifests.push({ root, action: 'skipped', detail: `no ${MANIFEST_FILE}; run ${CLI} init in it first` });
      continue;
    }
    if (JSON.stringify(manifest.shared ?? null) === JSON.stringify(declaration)) {
      manifests.push({ root, action: 'unchanged' });
      continue;
    }
    // `buildManifest` rather than a spread, so `shared` lands where `budget` and `mode`
    // land and a reviewer sees it in the declared block. Its own generated fields are
    // handed back the repository's existing pin rather than this build's: `shared install`
    // does not re-project anything, and a manifest whose pin silently became `null` would
    // be a repository that now claims no release produced its rules.
    const built = buildManifest({
      root,
      stack: manifest.stack ?? [],
      sha: manifest.projection?.simtDevSha ?? null,
      version: manifest.projection?.version ?? null,
      existing: { ...manifest, shared: declaration },
    });
    manifests.push({ root, action: 'declared', manifest: built });
  }

  // The `--diff` pairs, read before anything is written so the before side is
  // true in preview and in apply alike (R50). Home-directory copies through the
  // same `injectShared` the write applies, manifest declarations through
  // `manifestText`; paste targets carry no file and are printed in full below.
  let diffs = [];
  if (flags.diff === true) {
    for (const t of targets) {
      if (t.path === null) continue;
      const before = await readBefore(t.path);
      diffs.push({ path: t.path, before, after: injectShared(before ?? '', shared, meta).text });
    }
    for (const row of manifests) {
      if (row.action !== 'declared') continue;
      diffs.push({
        path: `${basename(row.root)}/${MANIFEST_FILE}`,
        before: await readBefore(await manifestPath(row.root)),
        after: manifestText(row.manifest),
      });
    }
  }

  if (flags.yes !== true) {
    // Nothing above this line writes, and nothing below it runs without the reader's
    // consent — because one of the two writes lands in their home directory and the other
    // edits repositories other people may be reviewing. The states printed here come from
    // the same `sharedState` `doctor` reads, so a preview cannot say "current" and then
    // have `install` write anyway.
    const states = [];
    for (const t of targets) {
      if (t.path === null) {
        states.push({ surface: t.surface, path: null, state: 'paste' });
        continue;
      }
      states.push({ ...t, ...(await sharedState(t.path, shared, meta)) });
    }
    if (isJson(flags)) {
      emitJson({
        ok: false,
        command: 'shared install',
        mode: 'preview',
        roots,
        shared,
        divergent,
        targets: states,
        manifests: manifests.map(({ root: r, action, detail }) => ({ root: r, action, detail: detail ?? null })),
        ...diffField(diffs, flags),
      });
      return EXIT.FAIL;
    }
    emit(
      [
        `shared   ${plain(shared.length)} rule(s), ${plain(Buffer.byteLength(sharedBody(shared)))} B`,
        ...states.map((s) =>
          s.path === null
            ? `  paste     ${s.surface}  no user-level file is recorded for it`
            : `  ${s.state.padEnd(9)}${s.path}`,
        ),
        `manifest ${manifests.map((m) => `${m.action}:${basename(m.root)}`).join(' ')}`,
        `nothing written; re-run with: ${CLI} shared install --yes`,
      ].join('\n'),
      { maxBytes: flags.maxBytes ?? 0 },
    );
    // After the report: the report says what, the diff shows it (R50).
    emitDiffs(diffs, flags);
    return EXIT.FAIL;
  }

  const written = [];
  for (const t of targets) {
    if (t.path === null) continue;
    written.push(await writeSharedFile(t.path, shared, meta));
  }

  const declared = [];
  for (const row of manifests) {
    if (row.action !== 'declared') continue;
    await writeManifest(row.root, row.manifest);
    declared.push(row.root);
  }

  const lines = [
    `shared   installed for ${plain(roots.length)} repositories`,
    `rules    ${plain(shared.length)} carried once  ${shared.map((r) => r.id).join(', ')}`,
  ];
  for (const w of written) {
    // `inject`'s word for a file with no region in it is "added"; the word for a file
    // that did not exist is "created", and printing "added" for a file this command
    // brought into existence would be true and unreadable.
    lines.push(`  ${w.created ? 'created' : w.action}  ${w.path}`);
  }
  for (const d of declared) lines.push(`  declared  ${d}/${MANIFEST_FILE}`);
  // Now the delta, so the reader knows what each region stopped carrying — and that the
  // next `simt sync` in each repository is what actually applies it.
  if (declared.length > 0) {
    lines.push(`regions  ${declared.length} repository region(s) change on their next ${CLI} sync`);
  }
  for (const t of targets) {
    if (t.path !== null) continue;
    lines.push(`paste into ${t.surface} (${t.why}) - the block below, markers included:`);
    lines.push('');
    lines.push(sharedBody(shared));
    lines.push('');
  }
  for (const t of targets) {
    const over = capNote(t, Buffer.byteLength(sharedBody(shared)));
    if (over !== null) lines.push(`warn     ${over}`);
  }
  lines.push(`verify   ${CLI} doctor  reports the copy as current, and ${CLI} tokens --repos --root . reports what is left`);
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  // After the report: the report says what, the diff shows it (R50).
  emitDiffs(diffs, flags);
  return EXIT.OK;
}

/**
 * What `doctor` says about the reader's copy of this repository's shared rules (ADR-084).
 *
 * Silent for a repository that declared nothing — the overwhelmingly common case — because
 * a `doctor` line every repository carries is a line every reader learns to skip. Reported
 * when there is a declaration, and never blocking: the region is correct either way, and
 * what is wrong is the reader's machine.
 *
 * @returns {Promise<{declared: boolean, state: string, rules: string[], targets: object[],
 *   detail: string|null}>}
 */
export async function sharedWarning(root, manifest, flags) {
  const declared = declaredShared(manifest);
  if (declared.level === null) {
    return { declared: false, state: 'none', rules: [], targets: [], detail: null };
  }
  const desired = await desiredRegion(root, flags ?? {});
  // What this repository expects to find in the copy: the declared ids it still carries.
  // An id the repository no longer selects is simply not checked, because there is nothing
  // this repository could do about it — a sibling declares it and `shared plan` reports it.
  const rules = desired.shareable.filter((r) => declared.rules.has(r.id));
  const targets = [];
  for (const t of await sharedTargets(desired.surfaces)) {
    if (t.path === null) continue;
    targets.push({ surface: t.surface, path: t.path, ...(await sharedCoverage(t.path, rules)) });
  }
  const worst =
    targets.find((t) => t.state === 'absent') ??
    targets.find((t) => t.state === 'stale') ??
    targets.find((t) => t.state === 'unreadable') ??
    targets[0];
  const state = targets.length === 0 ? 'no-target' : (worst?.state ?? 'none');
  return {
    declared: true,
    state,
    rules: [...declared.rules],
    targets,
    detail: describeShared(state, targets),
  };
}

function describeShared(state, targets) {
  if (state === 'no-target') {
    return 'this repository declares shared rules, but no surface it selects has a user-level file this tool can write; paste the block from `simt shared plan` into each reader';
  }
  if (state === 'absent') {
    return `no copy of the workspace rules at ${targets.find((t) => t.state === 'absent').path}; run: ${CLI} shared install --yes`;
  }
  if (state === 'stale') {
    const stale = targets.find((t) => t.state === 'stale');
    return `${stale.path} is missing ${stale.missing.join(', ')}; run: ${CLI} shared install --yes`;
  }
  if (state === 'unreadable') {
    return `${targets.find((t) => t.state === 'unreadable').path} could not be read: ${targets.find((t) => t.state === 'unreadable').reason}`;
  }
  return `${targets.length} user-level file(s) carry every rule this repository handed over`;
}

/** `1234567`, never `1,234,567`: two machines must print the same bytes (ADR-013). */
function plain(n) {
  return String(n);
}

/** The directory name, for a line that has to name several repositories at once. */
function basename(path) {
  return path.split('/').filter(Boolean).pop() ?? path;
}