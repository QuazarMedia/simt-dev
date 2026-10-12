// Where a rule actually lands: one body, many surfaces, plus the pointer files.
//
// Split out of project.mjs, which had grown past the 400-line review trigger in
// ADR-005 because this concern arrived with surface support (ADR-020) and had
// nowhere else to live. The split is by question, not by convenience: project.mjs
// answers *which rules apply*, this module answers *what files that produces*.
// Neither imports the other's decision, so neither can quietly change it.
//
// The load-bearing rule in here is that this is the SINGLE place a rule file is
// turned into bytes. `plan` writes what these functions return and `checkTargets`
// compares against the same construction. The step-6 defect was two places
// computing the desired region and the gate then reporting drift on a clean tree,
// which is the failure mode a PR cannot review because both places look right.

import { readdir, readFile, readlink, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { diff, parse, inject } from './markers.mjs';
import { ruleName } from './mdc.mjs';
import { foldsRules, frontmatterBlock, POINTERS, rulePath, SURFACES } from './surfaces.mjs';

/**
 * A managed rule file is a GENERATED FILE, unlike AGENTS.md.
 *
 * The body after the frontmatter is the region, full stop: there is no hand-owned
 * prose to preserve, because any prose there is exactly the divergent copy this
 * mechanism retires. Appending instead would leave two `## Requirements` sections
 * in one file — the duplication the estate's own review agent is instructed to
 * block, produced by the tool meant to remove it. So the existing frontmatter is
 * kept (the editor reads it before any rule text) and everything below it is
 * replaced.
 */
export async function ruleTargets(root, rule, body, sha, resolved, notes) {
  const targets = [];
  const name = ruleName(rule);

  const folding = foldsRules(resolved);

  for (const s of resolved.surfaces) {
    if (!s.rule) continue;
    // A reader that already loads AGENTS.md has the rule from the region. Writing the
    // file as well is the duplication S12 exists to remove: measured across the five
    // estate repos that select `opencode,cursor`, 17 rule files carrying 28 KB of text
    // an agent reads twice per session. ADR-021 ruled the opposite on the belief that
    // Cursor had no channel for AGENTS.md; cursor.com/docs/context/rules documents one.
    //
    // Skipped, never deleted. ADR-021 ruling 6: `sync` does not remove a file it once
    // generated, so `compare` reports the leftover with a remedy and a human removes it.
    if (folding && s.readsPrimary === true) {
      const rel = rulePath(s.id, name);
      if (rel) notes.push(`${rel}: not written; ${s.label} reads AGENTS.md, where the rule is already folded`);
      continue;
    }
    const rel = rulePath(s.id, name);
    if (!rel) continue;
    const path = join(root, rel);

    let existing = '';
    let exists = true;
    try {
      existing = await readFile(path, 'utf8');
    } catch {
      exists = false;
    }

    const mine = s.ruleFrontmatter(rule);
    // The frontmatter is re-derived, never inherited (S16).
    //
    // Two things were wrong and only the second was visible. The first was
    // `extractFrontmatter(existing) ?? frontmatterBlock(mine)`, where the file's own
    // block won whenever the file already had one. The second was this line's
    // neighbour: when the existing region parsed cleanly, `composed` was the whole
    // existing file, so `inject` replaced the region between the markers and left the
    // frontmatter above them exactly as it found it — whatever this tool emitted the
    // first time it saw this surface, forever. A surface that adds a key, or whose
    // `alwaysApply` flips, could never reach a repository that had already adopted it,
    // and no gate could report it: the file agrees with itself, so nothing is stale by
    // any comparison the tool makes.
    //
    // One asymmetry, deliberately: a surface that emits NO frontmatter leaves whatever
    // is there alone. This tool owns the block it writes and will replace it; deleting a
    // block it did not write is a different operation, and a surface with no frontmatter
    // of its own has no opinion about it.
    const frontmatter = mine.length > 0 ? frontmatterBlock(mine) : extractFrontmatter(existing) ?? '';
    const state = exists ? parse(existing) : { status: 'absent' };
    // A surface that wants no frontmatter must not get a blank line where the
    // frontmatter would have been: Claude's rule files opened with two empty lines
    // before the marker, which is untidy in a file the reader will open, and a
    // difference between surfaces that no check reported.
    //
    // Swapped in place rather than stripped and rejoined. My first attempt here was
    // `${frontmatter}\n${bodyAfterFrontmatter(existing)}`, which looked equivalent and
    // was not: that helper's trailing `\n*` swallows the blank line between `---` and
    // the region, so the reconstruction was one newline short of the file and `inject`
    // reported `updated` on every run forever while writing identical bytes. The file
    // was right; the verdict never settled, so `check` reported drift no reader could
    // see and `sync` rewrote a correct file on every invocation. Anything that rebuilds
    // a file has to reproduce the bytes it did not mean to touch, and the cheapest way
    // to guarantee that is not to rebuild them.
    const composed =
      state.status === 'ok'
        ? swapFrontmatter(existing, frontmatter)
        : frontmatter === ''
          ? ''
          : `${frontmatter}\n`;
    const result = inject(composed, body, { sha, sources: [rule.source] });

    // Report the prose being retired rather than letting it vanish into a diff the
    // reader has to notice. Silent deletion is the one thing a reviewer cannot audit.
    const retired = exists && state.status !== 'ok' ? bodyAfterFrontmatter(existing).trim() : '';
    if (retired !== '') {
      notes.push(
        `${rel}: retiring ${Buffer.byteLength(retired)} bytes of divergent hand-written rule text`,
      );
    }

    targets.push({
      file: rel,
      surface: s.id,
      path,
      exists,
      action: result.action,
      // As on every other target: the state the file was in, not the action taken on it.
      region: result.region,
      previousBody: result.previousBody,
      reason: result.reason,
      line: result.line,
      bytes: Buffer.byteLength(result.text),
      previousBytes: Buffer.byteLength(existing),
      sha,
      body,
      text: result.text,
      previous: existing,
    });
  }
  return { targets };
}


/**
 * Pointer targets: `CLAUDE.md` and `GEMINI.md` as symlinks to `AGENTS.md`.
 *
 * A pointer target carries `kind: 'pointer'` and no `text`. The writer makes the
 * link; the checker compares the link's target. Nothing else may write these two
 * paths, and an existing regular file at either path is reported as a conflict
 * rather than replaced, because both are files people wrote by hand — one of them
 * is the corpus's only byte-identical duplicate, and overwriting it silently is
 * the one outcome nobody would forgive.
 */
export function pointerTargets(root, resolved = null) {
  // Only the pointers whose surface was selected. `resolved` accepts the surface
  // objects `plan` returns or a bare id list; `null` means every surface, which is
  // what an unadopted caller means and what the unit tests pass.
  const ids =
    resolved === null
      ? null
      : new Set(resolved.map((s) => (typeof s === 'string' ? s : s.id)));
  return POINTERS.filter((p) => ids === null || ids.has(p.surface)).map((p) => ({
    file: p.path,
    surface: p.id,
    owner: p.surface,
    kind: 'pointer',
    path: join(root, p.path),
    to: p.to,
    readers: p.readers,
    verified: p.verified,
  }));
}

/**
 * Read the current state of one pointer, for both the writer and the gate.
 *
 * Three answers, not two: absent, already pointing where it should, or something
 * else entirely. "Something else" carries the byte count of a regular file so the
 * refusal names what it would have destroyed.
 */
export async function pointerState(root, pointer) {
  // `pointer.path` is already root-joined by `pointerTargets`. Re-joining it here
  // would look in `<root><root>/CLAUDE.md` and report every live pointer as absent
  // — which is what happened the first time this ran, and which a unit test that
  // passes the root twice would never catch.
  const path = pointer.path;
  let link = null;
  try {
    link = await readlink(path);
  } catch (e) {
    // EINVAL, not ENOENT, is what readlink returns for a path that exists and is not
    // a symlink. Treating only ENOENT as "not a symlink" made every hand-written
    // CLAUDE.md report `unreadable` instead of `foreign` — which is precisely the
    // file this function exists to protect, and the one the corpus actually
    // contains. Both codes mean "no link here"; anything else is a real fault.
    if (e.code !== 'ENOENT' && e.code !== 'EINVAL') {
      return { file: pointer.file, state: 'unreadable', detail: e.code };
    }
    // Not a symlink. Either nothing is there, or a regular file is — or a DIRECTORY,
    // which is neither. A directory at `CLAUDE.md` is a real thing a repository has: it
    // is where per-project Claude instructions live, and the corpus contains one. Read
    // as "absent" it is invisible: `check` reported nothing at all, and `sync` crashed
    // with `EEXIST` on the `symlink()` call *after* writing every other target, so the
    // run left a half-migrated repo and named `simt-dev doctor` as the remedy, which
    // reports nothing about it either. `stat` is what tells a directory from a file, and
    // it is asked before the read because reading a directory as utf8 throws EISDIR.
    try {
      const st = await stat(path);
      if (st.isDirectory()) {
        let entries = 0;
        try {
          entries = (await readdir(path)).length;
        } catch {
          entries = 0;
        }
        return {
          file: pointer.file,
          state: 'foreign',
          bytes: null,
          entries,
          detail: 'a directory, not a pointer',
        };
      }
      const text = await readFile(path, 'utf8');
      return {
        file: pointer.file,
        state: 'foreign',
        bytes: Buffer.byteLength(text),
        detail: 'a file, not a pointer',
      };
    } catch {
      return { file: pointer.file, state: 'absent' };
    }
  }
  if (link === pointer.to) return { file: pointer.file, state: 'current', link };
  return { file: pointer.file, state: 'mispointed', link, detail: `points at ${link}` };
}

// The per-surface path lives in surfaces.mjs next to the row that justifies it;
// re-exported so a caller building a target never has to know which module owns
// path construction as opposed to frontmatter construction.
export { rulePath };

export function extractFrontmatter(text) {
  const m = /^---\n[\s\S]*?\n---\n?/.exec(text);
  return m ? m[0].trimEnd() : null;
}

/**
 * Put `frontmatter` where a frontmatter block already is, and leave every other byte
 * exactly where it was.
 *
 * The block match deliberately stops at the closing `---` and not past it, so the
 * replacement starts at the newline that follows — the blank line a formatter requires
 * before an HTML comment survives belongs to the file, not to the block, and consuming
 * it here is what made `inject` report `updated` forever on files whose bytes never
 * changed.
 *
 * A file with no block gets one above its content. The separator below it is left to
 * `inject`'s `seam`, which is the one place that knows what the surrounding document
 * format requires.
 */
function swapFrontmatter(text, frontmatter) {
  if (frontmatter === '') return text;
  const m = /^---\n[\s\S]*?\n---/.exec(text);
  return m === null ? `${frontmatter}\n${text}` : `${frontmatter}${text.slice(m[0].length)}`;
}

function bodyAfterFrontmatter(text) {
  return text.replace(/^---\n[\s\S]*?\n---\n*/, '');
}
