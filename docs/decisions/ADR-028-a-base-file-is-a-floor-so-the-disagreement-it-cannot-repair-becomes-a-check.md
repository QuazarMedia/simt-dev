# ADR-028 — a base file is a floor, so the disagreement it cannot repair becomes a check

Status: accepted · 2026-10-07
**Affects:** `src/tsconfig.mjs`, `src/commands/init.mjs`, `src/projection/project.mjs`,
`test/tsconfig.test.mjs`. **Narrows:** ADR-026 ruling 2 (ownership does not depend on
content being mergeable) by applying it to a file whose mechanism is `extends` rather than
a copied byte range. Settles the `tsconfig.base.json` item of §3.1 row 5 and row 7 of
`docs/plans/0001-centralise-agent-rules.md`.

## Context

Row 5 promised eight baselines and named two problems among them that are not about a file
being missing: repo-08's seven absent strictness flags, and `moduleResolution` spelled
inconsistently across the workspace. ADR-025 ruled `tsconfig.base.json` out of the region
mechanism because JSON has no comments, and its consequences promised that "the next fix is
three more JSON files and therefore a different mechanism". ADR-026 supplied that mechanism
by saying ownership does not depend on mergeability.

What ADR-026 could not foresee is that this particular file inherits rather than copies,
and inheritance has a property that changes the design from the inside: **a child overrides
every key its parent sets.** `tsconfig.base.json` is not a shared copy of a config, it is a
floor that a child may decline to stand on.

That one fact decides the whole record, so it is worth being concrete about what it means.
A base file can repair a repository that is *missing* a flag. It is structurally incapable
of repairing one that spells a flag *differently*, because the child wins and the base is
inert for that key. Both of row 5's problems are of that kind or the other: the seven
missing flags are repairable by a base file, and the `moduleResolution` disagreement is not
repairable by any file at all.

The disagreement is also not really about disagreement. Three repositories write
`"Bundler"` and one writes `"bundler"`; TypeScript's parser is case-insensitive, so all four
compile and all four work. node.md:38 asks for it "spelled consistently across every repo in
the workspace", and the only spelling that can be checked in a repository on its own is the
one an external document uses.

## Rulings

1. **`tsconfig.base.json` is a whole file `init` writes once, and `check` never compares.**
   ADR-026's ownership rule unchanged. There is no refresh path, deliberately: ADR-026 gave
   simt-dev's own `.github` files a refresh because this repository authors the template,
   and this repository has no more use for a current copy of a base file than it has for a
   current copy of `.editorconfig`. A refresh path here would be a mechanism for making this
   repository's own gate green by rewriting the file the gate is judging.

2. **The floor is exactly the intersection of what the estate already wrote** — twelve
   `compilerOptions` keys, asserted by name in a test rather than by count. It is not a set
   of values anybody here has argued for; it is what four repositories independently wrote,
   and the outlier repository is the one with the gap.

3. **A key nobody can override safely is not in the floor.** `noEmit` is the sharp case:
   node.md:36 wants it for any project that bundles elsewhere, inheritance makes it
   inheritable, and a child can set `false`. It is still absent, because a base that hands
   `noEmit` to a repository nobody looked at is a build that stops emitting, and the two
   repositories here that bundle elsewhere did not ask for it. `target`, `lib`, `module`,
   `include`, `exclude`, `paths`, `jsx` and `types` are absent for the same reason in the
   other direction: `lib` is DOM+DOM.Iterable in two repositories and DOM+WebWorker in the
   other two, and a floor that chose would silence one of them.
4. **The test asserts those absences by name.** A future "harmless" addition that breaks a
   repository's build must fail in this repository's suite rather than in somebody's CI.

5. **`moduleResolution` is a check, not a key.** Shipping it in the floor would change
   nothing — every repository sets it, so the child overrides the base — which is exactly
   the definition of a line that looks configured and configures nothing.

6. **A base file that nothing extends is reported as inert**, and the finding names the line
   to add. The symptom is a strictness floor sitting in a repository looking adopted because
   the file is right there, with a `tsc` run contradicting it. Nothing else surfaces this.

7. **The file's own bytes cannot explain themselves, so `init` says the thing for it.** JSON
   has no comments, so a shipped file with no header owes its reader nothing about who wrote
   it or what to do next. This is the one place AGENTS.md's "every byte that leaves must be
   readable and actionable" cannot be met inside the file, and the obligation is met by
   `init` printing the `extends` line it requires and by ruling 6's finding.

8. **`tsconfig.json` is read as JSONC, and a parse failure produces no finding.** tsc strips
   comments before reading its own config, so a commented `tsconfig.json` is normal rather
   than a mistake, and `JSON.parse` would throw on it. A gate that throws on a file it did
   not write shows a reader a stack trace where the answer was one line, and `tsc` already
   reports the malformed file better than this tool could.

9. **The reader is a scanner, not a regex, for one reason:** `//` occurs inside every URL,
   and the commonest string near a tsconfig is a URL. A regex strips the rest of the line
   and then reports a parse error on a file that is perfectly valid. A test pins that case.

10. **A repository with no TypeScript is offered nothing.** A base file in a JavaScript
    repository is a file that claims to be an authority and is read by nothing. Detection is
    `fingerprint`'s existing `typescript` tag, so no new fact is declared (ADR-013).

11. **`simt-dev check` reports absence and the two inherited-from-nowhere problems, and never
    the contents.** The bytes belong to the repository from the first commit, and a finding
    that compared them would describe somebody's work as an error.

## Consequences

A TypeScript repository now gets twelve flags it did not have, and one of them — the floor
arriving through `extends` — is a behaviour change that can surface real type errors in
`repo-08`, which is the point of the record and also the reason adoption is one commit
with a `tsc` run rather than a silent upgrade. A base file is a floor, and a repository
that had not been standing on one is the case where raising it finds something.

`check` gains two findings that need no workspace to evaluate, which is what makes them
usable: a repository can be checked alone, and the estate-wide agreement that
node.md:38 asks for is expressed as agreement with an external document rather than with
each other.

What this does **not** settle: whether the two repositories that bundle elsewhere should
declare `noEmit`. It is a fact about a build, it is not derivable from anything this tool
reads, and neither repository asked. It stays a per-repo decision with no gate, and the
reason is written here so the omission is not later read as an oversight.

## Rejected

- **`moduleResolution` in the floor, with a check as well.** Rejected by ruling 5: the key
  would be inert in every repository in the estate, and a line in a config that no
  repository's resolution depends on is decoration.
- **A check that the estate agrees, by comparing across a workspace.** Rejected because
  `check` runs in one repository, and a cross-repository finding needs a workspace, a
  resolution order, and a rule for what happens when a repo is checked before the others
  exist. Agreement with the documented spelling gets the same guarantee from something that
  is already there.
- **A `noEmit` finding for Cloudflare Workers projects,** which `fingerprint` can identify.
  Rejected on the evidence rather than on taste: the finding would read a repository's root
  `tsconfig.json` and conclude that the whole project never emits, which is false of any
  repository that keeps a library in a sub-package with its own config. Two of two candidate
  repositories in the estate would satisfy it, which is exactly the situation where a check
  that has only ever been right looks correct.
- **Comment-stripping by regex, including trailing commas.** Rejected by rulings 8 and 9.
- **A region inside the JSON**, as a string key naming the real config. Rejected by
  ADR-025's grammar argument, and doubly here: the value would be a string where TypeScript
  expects an object, so the file would have to be rewritten by whatever read it.