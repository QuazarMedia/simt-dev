// What each harness actually reads at session start — one row per reader, with the
// document every claim came from.
//
// `surfaces.mjs` answers "where do we WRITE a rule". That is half of a reader, and the
// half that is convenient: writing a file needs a path and nothing else. Reading one
// needs more. Claude Code concatenates every `CLAUDE.md` from the filesystem root down
// and expands `@path` imports four hops deep. Codex walks project root to cwd, takes at
// most one file per directory, and *stops adding files* once the merged chain reaches
// `project_doc_max_bytes` — so a repository can be inside the limit on every single file
// and past it as a chain. Antigravity scans `.agents/rules/` flat and ignores nested
// files. Three of those facts change what a byte count means, and none of them is in
// the surface table, which is why the byte count had to be blocked on this one.
//
// WHAT THIS TABLE IS NOT. It is not a second opinion about any harness, and it does not
// re-verify `surfaces.mjs`: a path that appears here and there is one fact written twice
// because two consumers read it, not because either was guessed. `verified` is on every
// row and cites the page the row was read from, because a loader row with no provenance
// is worse than no row: it would be a number in a report that nobody can check, and
// context cost is exactly the number people will not check twice.
//
// FOUR DECISIONS, each with a cost.
//
//   1. A ROW IS A READER, NOT A PRODUCT. `claude` is Claude Code's loader; Codex and
//      opencode are separate rows even though all three read `AGENTS.md`, because they
//      disagree about what to do with a second one of anything. Keying by product would
//      force those disagreements into a field called "notes".
//
//   2. `atStart` IS A BOOLEAN, NOT A RANK. A file either is loaded before the first
//      message or it is not. `cursor` is the case that makes the alternative untenable:
//      a `.mdc` with `alwaysApply: false` costs nothing until a matching file is in
//      context, and a meter that counted it would report a cost the reader does not pay.
//      Ordering the always-on files among themselves is `order`, and it is a sentence
//      because that is what the vendor docs are.
//
//   3. A CAP IS NAMED WITH ITS SCOPE. Codex's 32 KiB applies to the *merged chain* and
//      Antigravity's 24,000 B applies to *one rule file* — a difference that decides
//      whether a finding belongs to a file or to a repository, so `cap.scope` is a
//      required field rather than a comment. A reader that publishes no cap has
//      `cap: null`, which means "checked, none found", not "not checked".
//
//   4. UNDOCUMENTED IS ITS OWN ANSWER. Copilot has no documented hooks file. Those cells
//      are `null` with a `note` saying what was looked for. An empty string would read
//      as "no hooks" and an invented path would read as a fact. Gemini CLI spent a
//      season here too — its configuration reference 404ed until it was re-checked on
//      2026-10-26 and found live, which moved it from a thin row to a full one; the rule
//      is unchanged, the example is.

import { harnessLoaders } from '../harness/records.mjs';

/**
 * One row per reader. Ordered by how widely the reader is deployed, so a truncated
 * report loses the rows nobody could have acted on.
 *
 * `start` entries, each one a file the reader may load:
 *
 *   scope       `project` (in the repository) or `user` (in the reader's home)
 *   path        the path, relative to the repository root; `dir` entries carry the
 *               directory instead and are enumerated by `tree`
 *   tree        `single`  the named path only
 *               `chain`   root to cwd; `chainMerge: 'first'` keeps one file per
 *                         directory, `chainMerge: 'all'` keeps every candidate
 *               `flat`    immediate children of `dir` only
 *               `nested`  recursive under `dir`
 *   atStart     loaded before the first message; `false` costs nothing until a
 *               matching file or a mention pulls it in
 *   absent      the entry is skipped when any of these paths exists at the root —
 *               the documented precondition, evaluated where the vendor documents it
 *   why         one line naming the document the entry came from
 *
 * `order` is concatenation order as the vendor states it, in words.
 */
// The rows are the records' loader facets: one file per harness under
// `harnesses/`, read by src/harness/records.mjs. The order is the records' loaderOrder,
// which is the order this table used to spell out, so a truncated report loses the same
// rows it always lost.
export const LOADERS = harnessLoaders();

export const LOADER_IDS = LOADERS.map((l) => l.id);

/** Loader row `id` or null. */
export function loader(id) {
  return LOADERS.find((l) => l.id === id) ?? null;
}

/**
 * The cap that applies to one row, or null — with `alsoCaps` folded in.
 *
 * Callers ask for "the limits this reader enforces", not for the shape of the cell. A
 * cap stated as prose in `capNote` and enforced in code somewhere else is the drift this
 * table was built to stop, so the enumeration is one function both the meter and the
 * report call.
 */
export function caps(row) {
  const out = [];
  if (row.cap) {
    out.push({
      bytes: row.cap.bytes,
      scope: row.cap.scope,
      config: row.cap.config ?? null,
      // Named from the scope rather than written per row, because the two answer
      // different questions and a reader who saw only one of them would misattribute
      // the finding: a chain cap fails on the repository, a file cap fails on the file.
      appliesTo: row.cap.scope === 'chain' ? 'the merged chain' : 'a single file',
      drop: row.cap.drop ?? null,
      why: row.cap.why,
    });
  }
  for (const extra of row.alsoCaps ?? []) {
    out.push({
      bytes: extra.bytes,
      scope: extra.scope,
      config: extra.config ?? null,
      appliesTo: extra.appliesTo,
      why: extra.why,
    });
  }
  return out;
}