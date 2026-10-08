# ADR-034 — A staged tool refuses a partially staged file rather than staging around it

Status: **accepted** · 2026-10-08 · affects every repo with a `pre-commit` hook

## Context

`src/hooks/gates.mjs` defines a `staged` gate as one that "run[s] a formatter over the STAGED
FILES ONLY, then re-stage[s] them", and gives the reason: whole-repo formatting from a
pre-commit hook "would rewrite unstaged work the author did not ask to touch". (The rule
that hooks own format and lint for staged files is ADR-004; this record settles what the
dispatcher does when "staged files" is ambiguous, which ADR-004 does not say.)

The dispatcher did not implement that promise. After a passing `format` gate it ran
`git add` on **every** path from `git diff --cached --name-only`, and reported success
whenever anything was staged.

Two defects, both measured against the shipped dispatcher rather than reasoned about:

- **A partial stage was destroyed outright.** With `a.md` staged as `one\nSTAGED\n` and the
  working tree at `one\nSTAGED\nUNSTAGED-WORK\n`, a formatter that rewrites its inputs left
  **both** the index and the working tree as `FORMATTED`. The author's unstaged hunk was not
  merely committed — it was replaced. This is the promise above, broken on the one path that
  runs on every commit in every adopted repo, and it is silent.
- **A staged deletion silently skipped the restage.** `--name-only` with no `--diff-filter`
  lists deleted paths, `git add -- <deleted>` fails, and the `catch` returned `false`. A
  commit containing a deletion plus a formattable file recorded the **unformatted** bytes and
  printed no restage line at all.

A third, smaller one: restage reported "re-staged files the formatter rewrote" whenever
anything was staged, whether or not a byte moved.

## Ruling

**1. A staged gate refuses to run when a file it would format also has unstaged changes.**
It fails the commit and names the file. It does not stash, and it does not format anyway.

The author staged part of a file deliberately; `git add -p` is how you say "this commit is
part of that file". A hook cannot know which part, so any answer it picks is a guess about
someone's intent, and a guess that rewrites their working tree is the one they cannot see
coming. Failing closed with a remedy the author can act on — `stage the whole file`, or run
the formatter yourself and stage the result — costs one command. Guessing costs work.

**2. Restage covers the files the formatter was actually given, and only those.** The
resolved staged tool's `argv` already holds the paths; nothing needed re-deriving them from
the index. For a gate declared through `gates.commands`, the command line is arbitrary and may
take a directory or a glob rather than paths, so ruling 1 applies to **every** staged file with
unstaged changes, because there is no way to know which files it will open. That is the
conservative reading, and being wrong in that direction fails a commit the author can retry.

**3. Restage reports a file only when that file's staged bytes actually moved**, compared as
the blob hash before and after. A restage line that fires on every commit is a line nobody
reads; the ones that fire are the ones that will be read.

A path staged as **deleted** is not a partial stage. The index and the working tree agree it
is gone, so there is no unstaged work to protect and nothing to refuse.

## Consequences

- `restage` returns the files it staged rather than a boolean, and a failed `git add` is now
  reported as a `restage` **failure** with a remedy. It was previously swallowed by a `catch`
  that returned `false`, which is what made defect 2 invisible.
- `resolveGate` now returns `declared: true` for a `gates.commands` resolution. The dispatcher
  needed to distinguish argv it chose from words it was handed, and sniffing the `detail`
  string would have let the guard in ruling 2 quietly stop working the day that wording
  changed.
- Repos whose authors habitually commit partially staged files will now see the gate refuse
  once, with a remedy naming the file, and not again. That is the intended cost: it is
  visible, and it is a command they choose to run.
- `rules/core.md` inherits nothing new — this changes when a hook runs, not what an agent is
  told to do — so the provenance digest is unaffected and no repo needs re-stamping.

## Rejected

- **Stash the unstaged changes, format, restore.** The review offered this as an alternative.
  It is a hook making the same guess by a longer route: it assumes the stash will apply
  cleanly after a formatter has rewritten the file underneath it, and a conflict there
  leaves the author with a stash and no working copy.
- **Format the staged content rather than the working tree** (e.g. piping `git show :file`
  through the formatter and updating the index). Correct in principle, and it does not destroy
  unstaged work — but it leaves the index holding a file the working tree no longer matches,
  so the next commit sees a phantom edit. Worth revisiting only with a real consumer of the
  format, which no repo in this estate has.
- **Skip the restage for deleted paths.** Treating a deletion as a restage failure would make
  the common case of a renamed-or-deleted file block every commit that also formats.
- **Keep the boolean return and just filter the file list.** That leaves defect 2's swallowed
  `catch` in place: the command would silently record unformatted bytes again the next time
  any `git add` fails.

Review 0001 §`S08` attributes the "would rewrite unstaged work" promise to ADR-004. It is in
`src/hooks/gates.mjs:7`, the gate definition; ADR-004 settles who runs what, not what the
dispatcher does with an ambiguous index.