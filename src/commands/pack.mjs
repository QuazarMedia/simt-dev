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
import { dirname, join, resolve } from 'node:path';

import { EXIT, emit, emitJson, fail, isJson, note, writeMode } from '../output/index.mjs';
import { CLI, MANIFEST_FILE, MANIFEST_LEGACY } from '../name.mjs';
import { PACK_DIR, packNameProblem } from '../packs.mjs';
import {
  BENCH_JSON,
  PACK_JSON,
  describeSourceProblem,
  lintPack,
  npmPackageOf,
  publishPack,
  readBench,
  scaffoldPack,
  writeScaffold,
} from '../packs/manage.mjs';
import { readManifest } from '../projection/manifest.mjs';

export async function packCommand(sub, args, flags) {
  if (sub === 'new') return packNew(args, flags);
  if (sub === 'lint') return packLint(args, flags);
  if (sub === 'publish') return packPublish(args, flags);
  return fail(`unknown pack subcommand ${sub ?? '(none)'}`, EXIT.USAGE, `run: ${CLI} pack lint [dir]`);
}

/**
 * Where a lint or publish resolves its pack: the positional directory, the
 * `--root`, or the working directory. `hooks` reads the same three in the same
 * order, so the two commands cannot disagree about which directory was meant.
 */
function packDir(args, flags) {
  return resolve(flags.root ?? args[0] ?? process.cwd());
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

  const dir = join(resolve(flags.root ?? process.cwd()), name);
  const files = scaffoldPack({ name, source });
  const { apply, dryRun } = writeMode(flags);

  if (isJson(flags)) {
    emitJson({
      ok: true,
      command: 'pack new',
      dir,
      dryRun: !apply,
      files: files.map((f) => f.path),
      packFile: PACK_JSON,
      benchFile: BENCH_JSON,
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
      { maxBytes: flags.maxBytes ?? 0 },
    );
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
    { maxBytes: flags.maxBytes ?? 0 },
  );
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
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
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
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  if (result.ok && apply && result.published) {
    note(`note     never committed or pushed by this tool (ADR-001); the registry now has the bytes, the repos still need vendoring`);
  }
  return result.ok ? EXIT.OK : EXIT.FAIL;
}
