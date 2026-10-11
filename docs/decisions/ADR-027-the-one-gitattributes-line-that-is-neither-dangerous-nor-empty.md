# ADR-027 — the one gitattributes line that is neither dangerous nor empty

Status: accepted · 2026-10-06
**Affects:** `src/projection/baselines.mjs` (`GITATTRIBUTES_BODY`, second `BASELINES` row),
`test/baselines.test.mjs`, `test/surfaces.test.mjs`.
**Supersedes:** ADR-025 ruling 9, which ruled `.gitattributes` out for now and required this
record. Settles the `.gitattributes` item in §3.1 row 5 of
`docs/plans/0001-centralise-agent-rules.md`.

## Context

ADR-025 shipped `.editorconfig` and, in ruling 9, ruled `.gitattributes` out for now. The
reason was not that the file cannot hold a region — `#` is a comment in gitattributes, so it
qualifies mechanically. The reason was that ruling 7 had just deferred `end_of_line` on the
grounds that line endings "are a claim about what belongs in the repository, and that claim
is made in `.gitattributes`", and every line in a shared `.gitattributes` region changes what
git does to the working tree. Ruling 9 concluded that such a region "is either dangerous or
empty", and deferred it to a record of its own.

The estate confirms the first half and not the conclusion. Thirteen of sixteen repositories
have no `.gitattributes` at all. The three that do disagree about almost everything:
`repo-05` declares only LFS filters for `.tif` and `.zip`; `repo-07` declares line
endings plus ConnectIQ binary markers; `repo-11` declares exactly one whitespace
suppression for hash-locked vendored content. There is no divergence here of the kind a
baseline fixes by being consistent. There is a file missing.

So the question ADR-025 deferred was the right one and it had a narrower answer than the one
it expected. It asked whether a *shared* set of attributes exists that is safe across every
repository. The answer is that almost none does — and that one line survives, and it happens
to be the line ruling 7 sent this file to make.

## Rulings

1. **`.gitattributes` is a region, not a copy, because git takes the last matching pattern.**
   The region goes at the top of the file and each repository's own patterns stay beneath it,
   where they win. This is the same mechanism ADR-025 chose for `.editorconfig` and for the
   same reason: a repository's LFS filters and binary declarations are per-repository claims,
   and the shared region must not be able to override them. The position is enforced by a
   test that compares line offsets, because a region that is merely present but misplaced
   would silently invert every rule it carries.

2. **The shared body is exactly one line: `* text=auto eol=lf`.** Two halves, and neither
   is decorative.

3. **`text=auto`, not `text`.** This is the half that makes the line safe, and it is why
   ruling 9's fear did not materialise. `text` is an instruction: git normalises every path
   it matches, and it will happily do it to a `.tif`, a `.zip` or a Garmin `.iq` image,
   because nothing in the pattern says those are binary. `text=auto` is a detection: git
   sniffs each path and applies normalisation only to files it concludes are text. This is
   the most common way a repository corrupts its own binaries, and it is invisible until
   someone diffs an image. `repo-07` had independently arrived at `text=auto eol=lf` on
   its first line, which is the strongest available evidence that the estate would pick the
   cautious form if asked — this ruling does not ask, it supplies.

4. **`eol=lf` is the claim ADR-025 ruling 7 sent here, and here it is safe to make.** Ruling
   7 refused `end_of_line` in `.editorconfig` because it "would change every checkout of
   every repository on the day it landed, and a repository that wanted CRLF could only opt
   out by deleting the region — losing the indentation baseline with it". Neither half
   applies. In `.editorconfig` the key is a property of an editor's save behaviour; in
   `.gitattributes` it is a property of the working tree, so a repository that wants CRLF
   adds one line beneath the region and wins, keeping its own indentation settings. And
   because the region is injected rather than applied, no file is rewritten at the moment it
   lands: the next checkout normalises, and nothing before that does.

5. **No other attribute is shared.** Not `filter=lfs`, not `binary`, not `-text`, not
   `linguist-generated`, not `export-ignore`, not `diff=` or `merge=`. Each is a claim about
   what a specific file *is*, and a wrong attribute is obeyed silently — a `filter=lfs` line
   for a path that is not in LFS produces checkout failures in thirteen of sixteen
   repositories, and a `binary` line for a text file produces a diff nobody can read. Ruling
   9's "dangerous or empty" is accurate about all of them. It was wrong that the file itself
   had no non-dangerous content.

6. **A test asserts the absence of the dangerous form by name.** `text=auto eol=lf` and
   `* text eol=lf` differ by one word, that word is the entire safety argument, and a later
   reader who tidies the line would have no way to know. The assertion is
   `assert.doesNotMatch(/^\* text eol=lf$/m)`, so the simplification fails as a test rather
   than as a corrupted binary in someone's repository.

7. **The property is verified against git itself, not against the string.** A test creates a
   repository, writes the shipped region, commits a text file and a binary one, and asserts
   through `git check-attr` that `text` resolves to `auto`, `eol` to `lf`, and that no
   `diff` attribute is set on the binary, plus that the working tree contains no `\r\n`.
   Reading the rendered bytes back would pass for a line git ignores, and the whole claim is
   about what git does with it.

## Consequences

`.gitattributes` joins `.editorconfig` as the second baseline, and the row-table guard in
`test/baselines.test.mjs` — every row carries a real style, a reason and a record number —
now covers two files instead of one.

Ruling 9's deferral is answered rather than repeated, and the generalisation it reached for
does not survive contact with the estate: this was not "a shared `.gitattributes` region is
impossible", it was "no shared region is safe except the one line that does not claim to know
what any file is". A future baseline for a per-stack attribute would have to arrive as a
different row with its own record, which is what §3.2's keep-it-local rule asks for anyway.

The repositories with an existing `.gitattributes` are the interesting case and they are not
in conflict: `repo-05`'s LFS filters, `repo-07`'s binary markers and
`repo-11`'s whitespace suppression all stay beneath the region and all keep winning,
because git takes the last match. No repository loses a line it wrote.

This repository adopts neither baseline for itself, and the reason is the same one that keeps
its `AGENTS.md` hand-written. The region's marker records the simt-dev SHA it was rendered
from, so a copy committed here would name a commit that stops being `HEAD` the moment it
lands — `check` would report drift on the next commit and the fix would be a sync that
chases its own tail. `test/baselines.test.mjs` asserts this rather than leaving it to
restraint: the failure was made once while writing this very record, which is exactly the
condition under which a guard earns its place.

## Rejected

- **`* text eol=lf`, the forcing form.** Rejected by ruling 3. It is one word shorter and
  it is the single most common way to corrupt binaries in a repository that has them, and two
  repositories here do.
- **A per-repository table of attributes,** driven by detection the way ADR-026's ecosystem
  table is. Rejected because the mapping would be a guess: nothing in the tree says whether
  a `.tif` is LFS-tracked, and `.gitattributes` has no `has-*` fact to hang a decision on.
  Writing an attribute the repository did not ask for is worse than writing none, because
  git obeys it without complaint.
- **Putting `end_of_line = lf` back into `.editorconfig` as well,** on the grounds that two
  files agreeing is more robust than one. Rejected by ruling 4: the `.editorconfig` copy
  cannot be overridden without losing the indentation rules, so it would be the claim that
  cannot be escaped. One place for the claim is better than one place that cannot be
  overruled.
- **Shipping `.gitattributes` as a whole-file copy,** on ADR-026's mechanism, since it has
  no region in the strict sense. Rejected because the mechanism fits a file that cannot
  merge, and this one can: there is a real region, it composes with existing content by
  ordering, and taking the file over whole would clobber three repositories' LFS filters.
  ADR-026's ruling 2 asks whether the grammar holds a region, and here it does.