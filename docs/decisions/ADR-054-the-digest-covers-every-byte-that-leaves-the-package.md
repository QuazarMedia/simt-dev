# ADR-054 — The digest covers every byte that leaves the package, and a cause is read off the body

Status: **accepted** · 2026-10-10 · amends [ADR-032](ADR-032-provenance-is-a-content-digest-not-a-commit.md)
**Affects:** `src/projection/rules.mjs`, `src/upgrade/plan.mjs`.

## Context

ADR-032 made the stamp a SHA-256 digest of `rules/` and `graph/`, and said why `src/` is
excluded: a refactor that changes no rule and no registry entry projects byte-identical
output, and stamping those consumers would report drift where there is none.

That reasoning is right and the boundary was drawn one level too low. ADR-032 excluded a
*directory*; the shared `.editorconfig` and `.gitattributes` blocks are not in a directory,
they are two string constants in `src/projection/baselines.mjs` — and every adopting
repository receives them. By ADR-015's own rule, a source is identified by its content rather
than by the file it happens to live in, so the body defined in `src/` is a source like any
other, and excluding `src/` as a path excluded content that leaves the package with it.

The finding arrived sideways, which is the only way this class gets found. Removing the
inert `[prettier]` block (S30) deleted seven lines from a shipped baseline — the first change
in this repository that moves bytes out of `src/` without moving the provenance digest.
Measured on a scratch repository with **only** that baseline body changed:

- `check` reported `DRIFT .editorconfig`, which is correct: the gate compares bytes, and the
  bytes were wrong.
- `upgrade` reported the pin as `(unchanged)` and named the cause as
  *"region restamped; the pin was already current (the rules changed)"*.

Both halves of that sentence are false. The pin was unchanged because the stamp could not see
the change, and the rules did not change — seven lines of an indentation setting did. The
first false statement made the second one reachable: with the stamp silent, the only cause
left to report was the one that was least true.

The severity is the estate's own: a report that names a cause which did not happen sends the
reader to diff `rules/` when the change is in `.editorconfig`. This is ADR-050's mistake one
layer up — a field read for the thing it was not — and ADR-036's, where an instruction that
is false in every repository is worse than one that is missing.

## Ruling

**One. The digest covers every byte string that leaves the package: `rules/` and `graph/` on
disk, plus the rendered baseline bodies.** The baselines enter keyed by the file each becomes
in the adopting repository (`baselines/.editorconfig`), not by the module that defines it,
because the stamp answers what content produced those bytes and `.editorconfig` is the name
a reader of a generated region recognises. `src/` remains excluded *as a directory*; the
ruling narrows ADR-032's exclusion from a path to a rule about content. Ruling 1 of ADR-032
and its "what the digest covers" section are superseded; ADR-032's framing, its framing
discipline and its other two consequences stand.

**Two. `provenanceInputs()` is exported, and `provenanceDigest()` hashes what it returns.**
"The digest covers the right things" is a claim about a set, and a set assembled only inside
the function that hashes it cannot be asserted from outside — the test would have to mutate
the package to get an answer. Reading the list and hashing it in one place is ADR-042's
ruling 3 applied to the stamp: the rendering is shared, so narrowing it narrows the test with
it, and the test passed with the rendering sabotaged is not evidence.

**Three. `upgrade`'s cause is read off the projected body, and the two kinds of content are
counted apart.** A baseline region is not a rule: `.editorconfig` and `.gitattributes` are
settings the repository owns. `rulesChanged` and `baselineChanged` are computed separately
and the sentence names one, both, or neither. The comparison is body to body rather than
byte to byte, because the region header carries the stamp and folding it in would make every
pin bump claim a change of policy — which is ADR-050's ruling, and it is why a target whose
seam moved reads as `updated` with no cause.

**Four. "Neither" is a real answer and is not collapsed into the nearest cause.** A seam
repair, a stamp-only move and a generated-field move are three different problems that one
command fixes, and the sentence distinguishing them is the whole reason the command exists.

## Consequences

- **Every adopted repo's stamp moves once more.** A repo pinned at a digest computed without
  the baselines reports `behind` the first time it runs this version and `simt-dev upgrade`
  fixes it. That is a pin doing its job, not a regression — the same reading as ADR-032's own
  first consequence.
- **`upgrade` can no longer report a cause it cannot see.** The two defects were independent
  and are now separately guarded: the digest test asserts the baselines are in the hashed set
  and that changing one changes the value; the planner test asserts a baseline body move
  produces "a baseline changed" and not "the rules changed".
- **The planner needed a `kind` it did not have.** Baseline targets already carried
  `kind: 'baseline'`; rule and primary targets carry none. That is the discriminator, and it
  is read from the targets `plan` produced rather than recomputed from the file list, so the
  two cannot disagree about which file is a baseline.
- **A `src/` refactor still moves nobody.** The exclusion was narrowed from a path to a rule
  about content, and the test asserts no `src/` entry appears in the hashed set — so the
  narrowing cannot be re-widened silently by a future import.

## Rejected

- **Hash `src/` as a directory.** The smallest diff and the wrong one: it puts every
  refactor, comment change and test edit into every consumer's stamp, which is precisely the
  false report ADR-032 ruled out.
- **Leave the stamp alone and fix only the wording.** The wording was the visible half. With
  the pin reporting `(unchanged)` beside a restamped region, `upgrade` would still be
  describing a move that did not happen — and the reader has no way to tell which line of
  the output to disbelieve.
- **Give baselines their own stamp field.** A second identity per repository, and the reader
  would have to know which of two values to compare against. One stamp, covering everything
  it stamps.
- **Call the baseline a "rule" in the message.** Cheaper than a discriminator, and it sends
  the reader to `rules/` — which is the defect.