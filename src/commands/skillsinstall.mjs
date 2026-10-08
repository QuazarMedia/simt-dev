// `simt-dev skills install` - pin a skill into a repo as a local copy.
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

import { EXIT, emit, fail, isJson, note, writeMode } from '../output/index.mjs';
import { loadRegistry, REGISTRY_PATH, measureSkill } from '../graph/load.mjs';
import { fingerprint } from '../resolve/fingerprint.mjs';
import { MANIFEST, buildManifest, readManifest, writeManifest } from '../projection/manifest.mjs';
import { provenanceDigest } from '../projection/project.mjs';
import { locateSource, sourceHeldLocally } from '../resolve/source.mjs';
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
      'usage: simt-dev skills install <name> [--variant <id>] [--from <repo/path>]',
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
      'run: simt-dev skills find <query>',
    );
  }

  // A workspace is where the canonical bodies live. It is not required, because the
  // repository being installed into is itself a location for a declared source: a
  // clone of one repo holds that repo's own bodies with no workspace anywhere. See
  // resolve/source.mjs - bytes, not location, decide identity.
  const ws = await resolveWorkspace(flags);
  if (ws.error) return fail(`workspace config: ${ws.error}`, EXIT.CONFIG, 'fix the JSON, or remove the file');

  const root = flags.root ?? process.cwd();
  const repo = await fingerprint(root);
  const pick = await chooseSource(skill, repo.signals, flags, { root, workspaceRoot: ws.root });
  if (pick.error) return fail(pick.error, EXIT.USAGE, pick.remedy);

  const found = await locateSource(pick.source, { workspaceRoot: ws.root, root });
  if (!found.path) {
    // Two reasons land here and they need different wording: no workspace at all,
    // or a workspace that should hold this body and does not. An install that
    // cannot read a body has failed, so this is never a degraded mode - the
    // opposite of `skills show`, which stays useful with no workspace.
    const because = ws.root
      ? `the workspace at ${ws.root} should hold it and does not`
      : 'no workspace is configured and this repo does not hold it';
    return fail(
      `${skill.name}: ${label(pick.source)} - ${found.reason} (${because})`,
      EXIT.CONFIG,
      ws.root ? `check the clone at ${ws.root}, or: ${WORKSPACE_REMEDY}` : WORKSPACE_REMEDY,
    );
  }
  const src = found.path;
  let measured;
  try {
    measured = await measureSkill(src);
  } catch (error) {
    return fail(
      `${pick.source.repo}/${pick.source.path}: ${error.code ?? error.message}`,
      EXIT.CONFIG,
      'the registry points at a body that cannot be read; run: simt-dev graph lint',
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
    locatedBy: found.how,
    dest: `${dir}/${name}`,
    action,
    bytes: measured.bytes,
    files: measured.files,
    wrapped: measured.flat,
    record,
    note: pick.note ?? null,
    written: false,
  };

  // `--json` used to return here, before anything was written, which made
  // `--yes --json` a command that reported a plan and changed nothing - the one
  // combination a script writes. The payload is now emitted once, at the end,
  // after the write it describes.
  const report = () => {
    if (isJson(flags)) emit(`${JSON.stringify(payload, null, 2)}\n`, { maxBytes: flags.maxBytes ?? 0 });
  };
  const mode = writeMode(flags);

  if (!isJson(flags)) {
    emit(
      [
        `install ${name}${pick.variant ? ` (variant ${pick.variant})` : ''}`,
      `repo     ${root.split('/').pop()} (${repo.stack.join(', ') || 'undetected'})`,
      `workspace ${ws.root ?? '(none)'} (${ws.source}: ${ws.detail})`,
      `source   ${record.from}${pick.reason ? ` - ${pick.reason}` : ''}`,
      `read     ${found.how}${found.how === 'repo' ? ` (${src})` : ''}`,
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
  }

  if (pick.note) note(pick.note);

  if (action === 'in-place') {
    // The repo already holds the canonical source: the symlink fan-out means the
    // "installed copy" and the registry source are the same bytes on disk.
    // `cp` of a directory onto itself fails, and the correct action is nothing.
    note(`note    ${payload.dest} is the registry source itself; nothing to install`);
    report();
    return EXIT.OK;
  }

  if (action === 'unchanged' && !mode.apply) {
    note(`note    ${payload.dest} already matches the source; nothing to write`);
    report();
    return EXIT.OK;
  }

  // The note was printed unconditionally, so a run that was about to write said
  // "nothing written" and then wrote. It belongs on the path that does not write.
  if (!mode.apply) {
    note(`note    dry-run  nothing written; apply with: simt-dev skills install ${name} --yes`);
    report();
    return EXIT.OK;
  }

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
      `run: simt-dev graph lint  (the registry must match the file on disk)`,
    );
  }
  payload.written = true;
  note(`wrote   ${payload.dest}`);

  const recorded = await recordLocal(root, record, skill.name, repo);
  note(`${recorded.created ? 'created' : 'updated'} ${MANIFEST} localSkills`);
  if (recorded.created) {
    note('note    this repo had no manifest; simt-dev init still needs to run to project the rules');
  }
  note(`note    ${name} is now repo-local and is excluded from central-drift accounting`);
  report();
  return EXIT.OK;
}

/** The variant a source carries, identified by its declared bytes. A single-body
 *  skill has none, so this returns null rather than inventing an id. */
function variantForBytes(skill, source) {
  const match = (skill.variants ?? []).find((v) => v.bytes === source.bytes);
  return match ? match.id : null;
}

/** The one declared source carrying a variant's bytes. Lint has already checked
 *  that every declared size matches disk, so size identifies the body. */
function sourceForVariant(skill, variantId) {
  const sources = skill.sources ?? [];
  const v = (skill.variants ?? []).find((x) => x.id === variantId);
  if (!v) return null;
  const match = sources.filter((s) => s.bytes === v.bytes);
  return match.length === 1 ? match[0] : { ambiguous: match.length };
}

const label = (s) => `${s.repo}/${s.path}`;

/**
 * Pick the source to install.
 *
 * Precedence, and why each step exists:
 *
 *   1. `--from`  - an explicit instruction. It is obeyed even when it disagrees
 *      with what the repo holds, because the author is answering a question the
 *      tool cannot; the disagreement is reported as a note, not a block.
 *   2. `--variant` - also explicit, same treatment.
 *   3. The repo's signals pick exactly one variant. This is the normal path.
 *   4. **The repo already holds exactly one declared source.** This is the step
 *      that makes a single-repo clone work: such a clone's `package.json` usually
 *      cannot tell `web` from `api`, but its own 5048 bytes of `slice-commit` are
 *      an exact answer. Content beats taxonomy.
 *   5. Refuse. Ambiguity and absence are both reported, never guessed.
 *
 * Step 3 can also *contradict* step 4 - signals say `api`, the bytes on disk are
 * `web`. That is a real disagreement worth surfacing, because one of the two
 * inputs is wrong and the reader needs to know which.
 */
async function chooseSource(skill, signals, flags, { root = null, workspaceRoot = null } = {}) {
  const sources = skill.sources ?? [];
  const held = await sourceHeldLocally(skill, root, { workspaceRoot });

  if (held?.ambiguous) {
    return {
      error: `${skill.name}: this repo matches ${held.held.length} declared sources at once (${held.held
        .map((h) => label(h.source))
        .join(', ')})`,
      remedy:
        'the registry and this repo disagree about what it holds; name the one you mean with --from <repo/path>',
    };
  }

  const holdNote = held
    ? `  note    this repo already holds the ${variantForBytes(skill, held.source) ?? 'single'} body at ${label(held.source)}`
    : null;

  // --- explicit choices ------------------------------------------------------
  if (flags.from) {
    const found = sources.find((s) => label(s) === flags.from);
    if (!found) {
      return {
        error: `--from ${flags.from} is not a declared source of ${skill.name}`,
        remedy: `declared: ${sources.map(label).join(', ')}`,
      };
    }
    return {
      source: found,
      variant: flags.variant ?? variantForBytes(skill, found),
      reason: 'chosen with --from',
      note: holdNote,
    };
  }

  const canonical = sources.find((s) => s.role === 'canonical') ?? sources[0];

  if (!skill.variants?.length) {
    return { source: canonical, variant: null, reason: 'single body', note: holdNote };
  }

  if (flags.variant) {
    const resolved = sourceForVariant(skill, flags.variant);
    if (!resolved) {
      return {
        error: `${skill.name} has no variant "${flags.variant}"`,
        remedy: `variants: ${skill.variants.map((x) => x.id).join(', ')}`,
      };
    }
    if (resolved.ambiguous !== undefined) {
      return {
        error: `variant ${flags.variant} (${skill.variants.find((x) => x.id === flags.variant).bytes} bytes) does not identify exactly one source (${resolved.ambiguous} matched)`,
        remedy: `choose explicitly: simt-dev skills install ${skill.name} --from <repo/path>`,
      };
    }
    return { source: resolved, variant: flags.variant, reason: 'chosen with --variant', note: holdNote };
  }

  // --- the repo's signals ----------------------------------------------------
  const tags = new Set(signals);
  const matched = skill.variants.filter((v) => v.stack.some((t) => tags.has(t)));

  if (matched.length === 1) {
    const chosen = sourceForVariant(skill, matched[0].id);
    if (!chosen || chosen.ambiguous !== undefined) {
      return {
        error: `variant ${matched[0].id} does not identify exactly one source (${chosen?.ambiguous ?? 0} matched)`,
        remedy: `choose explicitly: simt-dev skills install ${skill.name} --from <repo/path>`,
      };
    }
    if (held && held.source !== chosen) {
      // The two signals disagree. Installing either one silently would pick a side.
      return {
        error: `${skill.name}: the repo's signals select the ${matched[0].id} variant (${label(
          chosen,
        )}) but this repo already holds the ${variantForBytes(skill, held.source)} variant (${label(
          held.source,
        )})`,
        remedy: `decide which is right: simt-dev skills install ${skill.name} --variant ${variantForBytes(
          skill,
          held.source,
        )}, or --from ${label(chosen)}`,
      };
    }
    return {
      source: chosen,
      variant: matched[0].id,
      reason: `repo signals select ${matched[0].stack.join('/')}`,
      note: holdNote,
    };
  }

  if (matched.length > 1) {
    // Several variants claim this repo. The repo's own bytes are the tie-breaker
    // that is not a guess - if it holds one of them, that one is the answer.
    if (held) {
      const heldVariant = variantForBytes(skill, held.source);
      return {
        source: held.source,
        variant: heldVariant,
        reason: `signals are ambiguous (${matched.map((v) => v.id).join(', ')}); the repo's own copy decides`,
        note: holdNote,
      };
    }
    return {
      error: `${skill.name}: variants ${matched.map((v) => v.id).join(', ')} all match this repo`,
      remedy: `choose explicitly: simt-dev skills install ${skill.name} --variant <id>`,
    };
  }

  // --- nothing matched: the repo's own contents are the last real signal -----
  if (held) {
    const heldVariant = variantForBytes(skill, held.source);
    return {
      source: held.source,
      variant: heldVariant,
      reason: heldVariant
        ? `no signal matched (${signals.join(', ') || 'none'}), but the repo already holds the ${heldVariant} variant`
        : `no signal matched (${signals.join(', ') || 'none'}), but the repo already holds this body`,
      note: holdNote,
    };
  }

  // A directory that is the RIGHT shape but the WRONG body is a different failure
  // from having nothing, and saying "none matches this repo" would send the reader
  // looking at their stack tags instead of at the file that is actually there.
  const impostor = sources.find((s) => existsSync(join(root, s.path)));
  if (impostor) {
    return {
      error: `${skill.name}: ${root}/${impostor.path} exists but is not the declared body (${impostor.bytes} bytes declared)`,
      remedy: `run: simt-dev graph lint --workspace <path>  to see what the registry expects, or delete the local copy`,
    };
  }

  return {
    error: `${skill.name} has ${skill.variants.length} variants and none matches this repo (${signals.join(', ') || 'no signals'})`,
    remedy: `choose explicitly: simt-dev skills install ${skill.name} --variant <${skill.variants.map((v) => v.id).join('|')}>`,
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

/**
 * Flat `.md` skills become `<name>/SKILL.md`, and gain the `name:` ADR-009 requires.
 *
 * Exported because the registry no longer holds a flat skill to exercise this
 * through, and an untested rule mechanism is a rule that silently stops
 * working. The path is still live for any repo that adopts with a flat entry.
 */
export async function wrapFlat(src, name) {
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
    manifest ?? (await buildManifest({ root, stack: repo.stack, sha: await provenanceDigest() }));
  const existing = Array.isArray(base.localSkills) ? base.localSkills : [];
  const kept = existing.filter((e) => (typeof e === 'string' ? e : e?.name) !== name);
  await writeManifest(root, { ...base, localSkills: [...kept, record] });
  return { written: true, created: manifest === null };
}