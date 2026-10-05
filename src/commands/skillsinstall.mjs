// `simt skills install` - pin a skill into a repo as a local copy.
//
// Plan 0002 section 8.3: installed skills are recorded in `simt-dev.json`
// `localSkills` and are excluded from central-drift accounting. The point is a
// deliberate pin - a repo-specific procedure the central registry should not
// carry, or a version pinned ahead of a rollout - not a bulk copy. So there is
// no `--all`: installing 928 KB of skills into a repo should never be something
// an agent does by accident.
//
// Three things here are not obvious:
//
//   1. A skill with `variants[]` must not install its canonical body by
//      default. `slice-commit` exists in two forms; installing the web body into
//      the API repo is precisely the drift the registry exists to prevent. So the
//      repo's signals pick the variant, and an ambiguous or unmatched stack is an
//      error rather than a guess.
//   2. A flat `<name>.md` skill is wrapped into `<name>/SKILL.md`, because ADR-009
//      requires that layout. Wrapping restructures a file, so it is reported,
//      never done silently.
//   3. References come with the skill. A skill whose reference files are missing
//      is worse than one that was never installed, because it looks installed.

import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { EXIT, emit, fail, isJson, note } from '../output/index.mjs';
import { loadRegistry, REGISTRY_PATH, measureSkill } from '../graph/load.mjs';
import { fingerprint } from '../resolve/fingerprint.mjs';
import { MANIFEST, buildManifest, readManifest, writeManifest } from '../projection/manifest.mjs';
import { headSha } from '../projection/project.mjs';
import { nearMatches } from '../resolve/near.mjs';
import { resolveWorkspace, WORKSPACE_REMEDY } from '../workspace.mjs';

/**
 * Where skills live in this repo. The estate already has a convention - a
 * canonical directory plus symlink fan-out - and it is not the same directory in
 * every repo (`.agents/skills` in five, `.cursor/skills` in simt-app). So the
 * existing layout is respected and only invented when there is none.
 */
export function skillsDir(root, entries) {
  if (entries.includes('.agents')) return '.agents/skills';
  if (entries.includes('.cursor')) return '.cursor/skills';
  if (entries.includes('.claude')) return '.claude/skills';
  return '.agents/skills';
}

export async function installCommand(args, flags) {
  const name = args[0];
  if (!name) {
    return fail(
      'install needs a skill name',
      EXIT.USAGE,
      'usage: simt skills install <name> [--variant <id>] [--from <repo/path>]',
    );
  }

  const { registry, errors, ok } = await loadRegistry(REGISTRY_PATH, flags);
  if (!ok) return fail(errors[0], EXIT.REGISTRY);

  const skill = registry.skills.find((s) => s.name === name);
  if (!skill) {
    const near = nearMatches(name, registry.skills.map((s) => s.name));
    return fail(
      `no skill named "${name}"${near.length > 0 ? ` (did you mean ${near.join(', ')}?)` : ''}`,
      EXIT.USAGE,
      'run: simt skills find <query>',
    );
  }

  const root = flags.root ?? process.cwd();
  const repo = await fingerprint(root);
  const pick = chooseSource(skill, repo.signals, flags);
  if (pick.error) return fail(pick.error, EXIT.USAGE, pick.remedy);

  // Installing a body you cannot read is not a degraded mode, it is a failed
  // install, so this one genuinely refuses rather than degrading. The difference
  // from `skills show` is the point: `show` can still be useful without a
  // workspace (it prints metadata), `install` cannot.
  const ws = await resolveWorkspace(flags);
  if (ws.error) return fail(`workspace config: ${ws.error}`, EXIT.CONFIG, WORKSPACE_REMEDY);
  if (!ws.root) {
    return fail(
      `no workspace, so ${name} has no body to install from`,
      EXIT.CONFIG,
      WORKSPACE_REMEDY,
    );
  }

  const src = join(ws.root, pick.source.repo, pick.source.path);
  let measured;
  try {
    measured = await measureSkill(src);
  } catch (error) {
    return fail(
      `${pick.source.repo}/${pick.source.path}: ${error.code ?? error.message}`,
      EXIT.CONFIG,
      'the registry points at a path that does not exist; run: simt graph lint',
    );
  }

  const dir = skillsDir(root, await dirEntries(root));
  const dest = join(root, dir, name);
  const inplace = await samePath(src, dest);
  const action = inplace ? 'in-place' : await compare(dest, src, measured.flat, name);

  const record = {
    name,
    from: `${pick.source.repo}/${pick.source.path}`,
    variant: pick.variant,
    bytes: measured.bytes,
    sha: await fileSha(src),
  };

  const payload = {
    ok: true,
    command: 'skills install',
    root,
    skill: name,
    variant: pick.variant,
    source: record.from,
    dest: `${dir}/${name}`,
    action,
    bytes: measured.bytes,
    files: measured.files,
    wrapped: measured.flat,
    record,
    written: false,
  };

  if (isJson(flags)) {
    emit(`${JSON.stringify(payload, null, 2)}\n`, { maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }

  emit(
    [
      `install ${name}${pick.variant ? ` (variant ${pick.variant})` : ''}`,
      `repo     ${root.split('/').pop()} (${repo.stack.join(', ') || 'undetected'})`,
      `workspace ${ws.root} (${ws.source}: ${ws.detail})`,
      `source   ${record.from}${pick.reason ? ` - ${pick.reason}` : ''}`,
      `dest     ${payload.dest}`,
      `size     ${measured.bytes} bytes in ${measured.files} file${measured.files === 1 ? '' : 's'}`,
      `status   ${action}`,
      measured.flat ? 'wrapped  flat .md installed as <name>/SKILL.md (ADR-009)' : null,
      '',
      'PROVENANCE',
      `  name    ${record.name}`,
      `  from    ${record.from}`,
      `  variant ${record.variant ?? '(none - single body)'}`,
      `  sha     ${record.sha}`,
      `  bytes   ${record.bytes}`,
    ]
      .filter((l) => l !== null)
      .join('\n'),
    { maxBytes: flags.maxBytes ?? 0 },
  );

  if (action === 'in-place') {
    // The repo already holds the canonical source: the symlink fan-out means the
    // "installed copy" and the registry source are the same bytes on disk.
    // `cp` of a directory onto itself fails, and the correct action is nothing.
    note(`note    ${payload.dest} is the registry source itself; nothing to install`);
    return EXIT.OK;
  }

  if (action === 'unchanged' && !flags.yes) {
    note(`note    ${payload.dest} already matches the source; nothing to write`);
    return EXIT.OK;
  }

  note(`note    dry-run  nothing written; apply with: simt skills install ${name} --yes`);

  if (!flags.yes) return EXIT.OK;

  await mkdir(dirname(join(dest, 'SKILL.md')), { recursive: true });
  try {
    if (measured.flat) {
      await writeFile(join(dest, 'SKILL.md'), await wrapFlat(src, name), 'utf8');
    } else {
      // References come with the skill: a skill whose reference files are missing
      // is worse than one that was never installed, because it looks installed.
      await cp(src, dest, { recursive: true });
    }
  } catch (error) {
    return fail(
      `${pick.source.repo}/${pick.source.path}: ${error.code ?? error.message}`,
      EXIT.CONFIG,
      `run: simt graph lint  (the registry must match the file on disk)`,
    );
  }
  note(`wrote   ${payload.dest}`);

  const recorded = await recordLocal(root, record, skill.name, repo);
  note(`${recorded.created ? 'created' : 'updated'} ${MANIFEST} localSkills`);
  if (recorded.created) {
    note('note    this repo had no manifest; simt init still needs to run to project the rules');
  }
  note(`note    ${name} is now repo-local and is excluded from central-drift accounting`);
  return EXIT.OK;
}

/**
 * Pick the source to install.
 *
 * With variants, the repo's own signals decide which body applies - and an
 * ambiguous or absent match is an error, because guessing here produces exactly
 * the two-repo divergence the variants exist to prevent.
 */
function chooseSource(skill, signals, flags) {
  const sources = skill.sources ?? [];

  if (flags.from) {
    const found = sources.find((s) => `${s.repo}/${s.path}` === flags.from);
    if (!found) {
      return {
        error: `--from ${flags.from} is not a declared source of ${skill.name}`,
        remedy: `declared: ${sources.map((s) => `${s.repo}/${s.path}`).join(', ')}`,
      };
    }
    return { source: found, variant: flags.variant ?? null, reason: 'chosen with --from' };
  }

  const canonical = sources.find((s) => s.role === 'canonical') ?? sources[0];

  if (!skill.variants?.length) {
    return { source: canonical, variant: null, reason: 'single body' };
  }

  if (flags.variant) {
    const v = skill.variants.find((x) => x.id === flags.variant);
    if (!v) {
      return {
        error: `${skill.name} has no variant "${flags.variant}"`,
        remedy: `variants: ${skill.variants.map((x) => x.id).join(', ')}`,
      };
    }
    // A variant declares bytes, not a path. The source carrying those bytes is
    // the body that variant describes - and `graph lint` has already verified
    // every declared byte count against the file on disk.
    const match = sources.filter((s) => s.bytes === v.bytes);
    if (match.length !== 1) {
      return {
        error: `variant ${v.id} (${v.bytes} bytes) does not identify exactly one source (${match.length} matched)`,
        remedy: `choose explicitly: simt skills install ${skill.name} --from <repo/path>`,
      };
    }
    return { source: match[0], variant: v.id, reason: 'chosen with --variant' };
  }

  const tags = new Set(signals);
  const matched = skill.variants.filter((v) => v.stack.some((t) => tags.has(t)));
  if (matched.length === 0) {
    return {
      error: `${skill.name} has ${skill.variants.length} variants and none matches this repo (${signals.join(', ') || 'no signals'})`,
      remedy: `choose explicitly: simt skills install ${skill.name} --variant <${skill.variants.map((v) => v.id).join('|')}>`,
    };
  }
  if (matched.length > 1) {
    return {
      error: `${skill.name}: variants ${matched.map((v) => v.id).join(', ')} all match this repo`,
      remedy: `choose explicitly: simt skills install ${skill.name} --variant <id>`,
    };
  }

  const v = matched[0];
  const match = sources.filter((s) => s.bytes === v.bytes);
  if (match.length !== 1) {
    return {
      error: `variant ${v.id} (${v.bytes} bytes) does not identify exactly one source (${match.length} matched)`,
      remedy: `choose explicitly: simt skills install ${skill.name} --from <repo/path>`,
    };
  }
  return {
    source: match[0],
    variant: v.id,
    reason: `repo signals select ${v.stack.join('/')}`,
  };
}

/** `added` | `updated` | `unchanged`, decided by comparing what is on disk.
 *  A wrapped flat skill is compared against the WRAPPED form, because that is
 *  what install writes - comparing it against the raw source made every rerun
 *  report `updated` and re-write a file that was already correct. */
async function compare(dest, src, flat, name) {
  if (!existsSync(dest)) return 'added';
  if (!existsSync(join(dest, 'SKILL.md'))) return 'updated';
  const installed = await readFile(join(dest, 'SKILL.md'), 'utf8');
  const wanted = flat ? await wrapFlat(src, name) : await readFile(join(src, 'SKILL.md'), 'utf8');
  // Compare normalised so a trailing-newline difference is not reported as a
  // change that requires rewriting a file the author may have since edited.
  return installed.trimEnd() === wanted.trimEnd() ? 'unchanged' : 'updated';
}

/** Realpath comparison: the canonical source can BE the destination, because the
 *  estate resolves `.agents/skills` through symlinks into the source repo. */
async function samePath(a, b) {
  const { realpath } = await import('node:fs/promises');
  try {
    const [ra, rb] = await Promise.all([realpath(a), realpath(b)]);
    return ra === rb;
  } catch {
    return false;
  }
}

async function dirEntries(root) {
  const { readdir } = await import('node:fs/promises');
  try {
    return await readdir(root);
  } catch {
    return [];
  }
}

/** Flat `.md` skills become `<name>/SKILL.md`, and gain the `name:` ADR-009 requires. */
async function wrapFlat(src, name) {
  const text = await readFile(src, 'utf8');
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!fm) return `---\nname: ${name}\n---\n\n${text.trim()}\n`;
  const keys = fm[1]
    .split('\n')
    .filter((l) => !/^name:/.test(l))
    .join('\n');
  return `---\nname: ${name}\n${keys}\n---\n\n${text.slice(fm[0].length).trim()}\n`;
}

async function fileSha(path) {
  const { createHash } = await import('node:crypto');
  const entry = (await stat(path)).isDirectory() ? join(path, 'SKILL.md') : path;
  const digest = createHash('sha256');
  digest.update(await readFile(entry));
  return digest.digest('hex').slice(0, 12);
}

/**
 * Record the pin in the manifest. A hand-written string entry is kept as-is
 * rather than normalised away: the author's declaration is not the tool's to
 * rewrite, and the record is additive.
 *
 * When the repo has no manifest at all, one is written in the FULL canonical
 * shape via `buildManifest` rather than a `{localSkills}` stub. A partial manifest
 * would read as authoritative while omitting `gates`, which is the field the hook
 * dispatcher runs from - so a repo whose manifest came from `skills install`
 * would install hooks with nothing to enforce.
 */
async function recordLocal(root, record, name, repo) {
  const { manifest, error } = await readManifest(root);
  if (error) return { written: false, reason: error };

  const base =
    manifest ?? (await buildManifest({ root, stack: repo.stack, sha: await headSha() }));
  const existing = Array.isArray(base.localSkills) ? base.localSkills : [];
  const kept = existing.filter((e) => (typeof e === 'string' ? e : e?.name) !== name);
  await writeManifest(root, { ...base, localSkills: [...kept, record] });
  return { written: true, created: manifest === null };
}