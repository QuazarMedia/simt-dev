// simt pack new | lint | publish - the author side of a pack.
//
// A pack is vendored bytes (ADR-065): the adopting repository carries them and
// pins a digest, and nothing renders from outside the repository. These three
// subcommands are how a pack comes to exist, how it is judged, and how its bytes
// become obtainable - without ever fetching at render time.
//
// Like every writer here, `new` and `publish` are previews by default and write
// (or publish) only with `--yes`. `lint` is a read: it judges and reports, and
// exits non-zero when the pack fails.

import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { EXIT, emit, emitJson, fail, isJson, note, writeMode } from '../output/index.mjs';
import { CLI, MANIFEST_FILE, MANIFEST_LEGACY } from '../name.mjs';
import { PACK_DIR, packNameProblem } from '../packs.mjs';
import {
  BENCH_JSON,
  PACK_JSON,
  describeSourceProblem,
  lintPack,
  migratePack,
  npmPackageOf,
  publishPack,
  readBench,
  scaffoldPack,
  writeScaffold,
} from '../packs/manage.mjs';
import { readManifest } from '../projection/manifest.mjs';
import { diffField, emitDiffs } from '../diff.mjs';
import { commandRoot } from '../repo-root.mjs';

export async function packCommand(sub, args, flags) {
  if (sub === 'new') return packNew(args, flags);
  if (sub === 'lint') return packLint(args, flags);
  if (sub === 'publish') return packPublish(args, flags);
  if (sub === 'migrate') return packMigrate(args, flags);
  return fail(`unknown pack subcommand ${sub ?? '(none)'}`, EXIT.USAGE, `run: ${CLI} pack lint [dir]`);
}

/**
 * Where a lint or publish resolves its pack: the positional directory, the
 * `--root`, or the working directory. `hooks` reads the same three in the same
 * order, so the two commands cannot disagree about which directory was meant.
 *
 * The positional wins, as this always said it did. The code read `--root` first,
 * so `pack lint .simt/packs/a --root ../b` judged `b` while the prose and the
 * command's own usage promised `a`.
 */
function packDir(args, flags) {
  return resolve(args[0] ?? commandRoot(flags));
}

/**
 * The manifest entry that declares this pack, when the directory is a vendored
 * copy inside an adopting repository. Lint then checks the two promises a
 * declaration makes - version and digest - against the bytes on disk, so a
 * pack that drifted from its pin is reported where it sits, not only in the
 * adopting repo's gate.
 */
async function declaredEntry(dir) {
  let cursor = dir;
  for (;;) {
    if (existsSync(join(cursor, MANIFEST_FILE)) || existsSync(join(cursor, MANIFEST_LEGACY))) {
      const { manifest, exists, error } = await readManifest(cursor);
      if (!exists || error !== null || manifest === null) return null;
      const packs = Array.isArray(manifest.packs) ? manifest.packs : [];
      const here = join(cursor, PACK_DIR);
      if (dir === here || dir.startsWith(`${here}/`)) {
        const name = dir.slice(here.length + 1).split('/')[0];
        return packs.find((p) => p?.name === name) ?? null;
      }
      return null;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

async function packNew(args, flags) {
  const name = args[0];
  if (!name) {
    return fail(
      'pack new needs a name',
      EXIT.USAGE,
      `run: ${CLI} pack new <name> --source <npm:<package>|git+https://…>`,
    );
  }
  const nameProblem = packNameProblem(name);
  if (nameProblem !== null) {
    return fail(nameProblem, EXIT.USAGE, 'a pack name is the directory name its bytes vendor under');
  }
  const source = flags.source;
  if (!source) {
    return fail(
      'pack new needs --source',
      EXIT.USAGE,
      `run: ${CLI} pack new ${name} --source <npm:<package>|git+https://…>`,
    );
  }
  const sourceProblem = describeSourceProblem(source);
  if (sourceProblem !== null) {
    return fail(sourceProblem, EXIT.USAGE, 'a pack source names where the bytes come from: `npm:<package>` or `git+https://…`');
  }

  const dir = join(resolve(commandRoot(flags)), name);
  const files = scaffoldPack({ name, source });
  const { apply, dryRun } = writeMode(flags);
  // A scaffold always creates into a directory that must not exist, so every
  // before side is empty and each pair is a whole file .
  const diffs = flags.diff === true ? files.map((f) => ({ path: `${name}/${f.path}`, before: null, after: f.text })) : [];

  if (isJson(flags)) {
    emitJson({
      ok: true,
      command: 'pack new',
      dir,
      dryRun: !apply,
      files: files.map((f) => f.path),
      packFile: PACK_JSON,
      benchFile: BENCH_JSON,
      ...diffField(diffs, flags),
    });
    return EXIT.OK;
  }

  if (!apply) {
    emit(
      [
        `pack     ${name} -> ${dir}`,
        `source   ${source}`,
        '',
        ...files.map((f) => `PLAN     ${f.path}`),
        '',
        dryRun ? 'DRY-RUN  no files written' : `PLAN     nothing written; apply with: ${CLI} pack new ${name} --source ${source} --yes`,
      ].join('\n'),
    );
    // After the report: the report says what, the diff shows it .
    emitDiffs(diffs, flags);
    return EXIT.OK;
  }

  try {
    await writeScaffold(dir, files);
  } catch (error) {
    return fail(error.message, EXIT.FAIL, 'pick a name whose directory does not exist yet');
  }
  emit(
    [
      `pack     ${name} -> ${dir}`,
      `source   ${source}`,
      ...files.map((f) => `WRITE    ${f.path}`),
      '',
      `WROTE    ${files.length} scaffold file(s); write the rule, then: ${CLI} pack lint ${dir}`,
    ].join('\n'),
  );
  // After the report: the report says what, the diff shows it .
  emitDiffs(diffs, flags);
  return EXIT.OK;
}

async function packLint(args, flags) {
  const dir = packDir(args, flags);
  const declared = await declaredEntry(dir);
  const { pack, ok, findings } = await lintPack(dir, {
    requireMeasured: flags.requireMeasured === true,
    declared,
  });

  // The one-line answer first, because a gate that failed should say what it
  // judged before it says why: the pack, its version, and the digest the
  // adopting manifest would pin.
  const headline = pack === null ? `pack     ${dir} (no ${PACK_JSON})` : `pack     ${pack.name} ${pack.version}  digest ${pack.digest}`;

  if (isJson(flags)) {
    emitJson({ ok, command: 'pack lint', dir, pack, findings });
    return ok ? EXIT.OK : EXIT.FAIL;
  }

  const lines = [headline];
  if (pack !== null) {
    const summary = await summaryLine(dir);
    if (summary !== null) lines.push(summary);
  }
  if (declared !== null && pack !== null) {
    lines.push(`declared ${declared.version ?? '(no version)'}  pinned ${declared.digest ?? '(unpinned)'}`);
  }
  for (const f of findings) {
    lines.push(`${f.status.toUpperCase().padEnd(24)} ${f.file}  ${f.detail}`);
    lines.push(`                        remedy: ${f.remedy}`);
  }
  lines.push('', ok ? 'PASSED   the pack is well-formed' : `FAILED   ${findings.length} finding(s)`);
  emit(lines.join('\n'));
  return ok ? EXIT.OK : EXIT.FAIL;
}

/**
 * The measured ΔR, in the pack's own words. Reported, never judged, here:
 * judging is `lint`'s with `--require-measured`; this line is what a reader
 * who asked \"what is this pack worth\" reads either way.
 */
async function summaryLine(dir) {
  const { bench } = await readBench(dir);
  if (bench === null) return null;
  if (bench.measured !== true) return `measured unmeasured (no ΔR recorded in ${BENCH_JSON})`;
  const dR = typeof bench.dR === 'number' ? (bench.dR >= 0 ? `+${bench.dR}` : `${bench.dR}`) : '(no dR)';
  return `measured dR ${dR} over ${bench.tasks ?? '?'} tasks (${bench.run ?? 'unrecorded run'})`;
}

/**
 * Leave the experimental pack path without retyping its rules (ADR-208).
 *
 * The pack directory is not removed: it is the provenance record a reader audits the
 * move against, and deleting vendored bytes is the repository's decision, not a
 * migration's. What changes is which of the two the projection reads first - local
 * profiles outrank packs - and the rules themselves are copied byte for byte.
 */
async function packMigrate(args, flags) {
  const name = args[0];
  if (!name) {
    return fail('pack migrate needs a pack name', EXIT.USAGE, `run: ${CLI} pack migrate <name>  (name one declared under packs in the manifest)`);
  }
  const nameProblem = packNameProblem(name);
  if (nameProblem !== null) return fail(nameProblem, EXIT.USAGE, 'a pack name is the directory name its bytes vendor under');

  const root = resolve(commandRoot(flags));
  const { apply, dryRun } = writeMode(flags);
  const result = await migratePack(root, name, { apply });
  const profiles = result.files.map((file) => relative(root, file.dest));
  const diffs = flags.diff === true ? result.files.map((file) => ({ path: file.dest, before: file.before ?? null, after: file.text })) : [];

  if (isJson(flags)) {
    emitJson({
      ok: result.ok,
      command: 'pack migrate',
      root,
      name,
      applied: apply,
      profiles,
      pack: result.pack,
      findings: result.findings,
      ...diffField(diffs, flags),
    });
    return result.ok ? EXIT.OK : EXIT.FAIL;
  }

  const lines = [`pack     ${name}${result.pack?.version ? ` ${result.pack.version}` : ''}`];
  if (result.pack !== null) lines.push(`digest   ${result.pack.digest}`);
  for (const file of result.files) lines.push(`PLAN     ${relative(root, file.dest)}  <- ${PACK_DIR}/${name}/${file.rel}`);
  if (result.ok) lines.push(`PLAN     ${MANIFEST_FILE} packs -= ${name}`);
  for (const finding of result.findings) {
    lines.push(`${finding.status.toUpperCase().padEnd(24)} ${finding.file}  ${finding.detail}`);
    lines.push(`                        remedy: ${finding.remedy}`);
  }
  if (result.ok) {
    lines.push(
      '',
      apply
        ? `WROTE    ${result.files.length} profile(s); ${PACK_DIR}/${name} stays in place as the provenance record`
        : dryRun
          ? 'DRY-RUN  nothing written'
          : `PLAN     nothing written; apply with: ${CLI} pack migrate ${name} --yes`,
    );
    if (apply) lines.push(`NEXT     re-render the region: ${CLI} sync --yes`);
  } else {
    lines.push('', `FAILED   ${result.findings.length} finding(s)`);
  }
  emit(lines.join('\n'));
  // After the report: the report says what, the diff shows it .
  emitDiffs(diffs, flags);
  return result.ok ? EXIT.OK : EXIT.FAIL;
}

async function packPublish(args, flags) {
  const dir = packDir(args, flags);
  const { apply, dryRun } = writeMode(flags);
  const result = await publishPack(dir, { apply });

  if (isJson(flags)) {
    emitJson({
      ok: result.ok,
      command: 'pack publish',
      dir,
      pack: result.pack,
      published: result.published,
      skipped: result.skipped,
      planned: result.planned,
      findings: result.findings,
    });
    return result.ok ? EXIT.OK : EXIT.FAIL;
  }

  const name = result.pack === null ? dir : `${result.pack.name} ${result.pack.version}`;
  const lines = [`pack     ${name}`, `source   ${result.pack?.source ?? '(unknown)'}`];
  if (result.skipped) {
    lines.push(`SKIPPED  ${npmPackageOf(result.pack.source)}@${result.pack.version} is already live; nothing to publish`);
  }
  for (const step of result.planned) lines.push(`${apply ? 'RUN      ' : 'PLAN     '}${step}`);
  for (const f of result.findings) {
    lines.push(`${f.status.toUpperCase().padEnd(24)} ${f.file}  ${f.detail}`);
    lines.push(`                        remedy: ${f.remedy}`);
  }
  if (result.ok && !result.skipped) {
    lines.push(
      '',
      apply
        ? `PUBLISHED ${result.pack.name}@${result.pack.version}`
        : dryRun
          ? 'DRY-RUN  nothing published'
          : `PLAN     nothing published; apply with: ${CLI} pack publish ${dir} --yes`,
    );
  } else if (result.ok) {
    lines.push('');
  } else {
    lines.push('', `FAILED   ${result.findings.length} finding(s)`);
  }
  emit(lines.join('\n'));
  if (result.ok && apply && result.published) {
    note(`note     never committed or pushed by this tool (ADR-001); the registry now has the bytes, the repos still need vendoring`);
  }
  return result.ok ? EXIT.OK : EXIT.FAIL;
}
