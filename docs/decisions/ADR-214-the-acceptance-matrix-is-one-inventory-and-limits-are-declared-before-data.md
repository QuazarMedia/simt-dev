---
simt-affects: ["src/distribute/acceptance.mjs", "docs/reference/acceptance.md", "test/acceptance.test.mjs", "docs/decisions-index.md"]
simt-supersedes: []
---
# ADR-214 — the acceptance matrix is one inventory, and its limits are declared before data

Status: accepted · 2026-11-21 · filed as review 0005 PR37

## Context

A green source suite cannot establish installation, upgrade, configuration or enforcement in a
receiving repository. It proves the units agree in this checkout; it does not prove the tool
installs, upgrades, configures itself, or runs its gates where a reader runs it. The review
(0005, PR37) asks for evidence by capability and channel before a general-purpose support claim,
but the estate had no single place that stated what a release must prove, from where it proves
it, or which combinations it does not cover. The pieces were scattered: `test/pack.test.mjs`
qualifies the tarball, `test/binary.test.mjs` the binary channel, the release workflows the
promotion, and `docs/reference/support.md` the channels and floors — with no document that tied
them into a matrix a release engineer could sign off against.

Two failure modes were open. The first is drift: a fixture, a proof or an unsupported
combination stated in one place and not another, so the matrix a release is qualified against no
longer matches the artefact. The second is a performance bar set after the fact: a limit that
appears only once numbers exist, which is a bar declared to fit the data rather than a bound the
data must meet (ADR-183).

## Ruling

1. **One inventory, published.** `src/distribute/acceptance.mjs` holds the fixtures, the proofs
   with their reproducible commands, the surfaces, the limits and the unsupported combinations.
   `docs/reference/acceptance.md` is its publication, and `test/acceptance.test.mjs` fails when
   the two name different rows. A fixture, a proof or a limit gains a row, not a paragraph — the
   same shape ADR-206 gave the support table.

2. **Installed artefacts only, independently staged fixtures.** Every command in the matrix runs
   against the installed copy — the tarball, the wheel, the formula’s binary — never this
   checkout. A fixture is independent of the estate: no sibling repositories, no configured
   workspace, no path that resolves only here (ADR-031). A source-suite green is not evidence for
   a row; the rows are proved by `test/pack.test.mjs`, `test/binary.test.mjs` and the release
   jobs, which this matrix names.

3. **The channels and targets are reused, not restated.** The matrix is qualified against the
   four install channels and the release targets named in the support inventory. The accessors
   return those lists rather than typing a second one, so a channel or a target added in
   `support.mjs` or `release.mjs` reaches the matrix by the same test (ADR-206).

4. **Limits are declared before data is collected.** Each limit names what is measured, in which
   unit, against which direction — a positive number with a metric, subject and unit. The numbers
   are bounds a release must meet; collecting the data that proves it is a separate, named
   qualification job. A limit with no metric, unit or direction is a wish, and a bar declared
   after the numbers is not a bar (ADR-183).

5. **Unsupported combinations carry a reason, an exit and a remedy.** Each states why the
   combination is out of scope, the exit name in the table the tool reports for it
   (`UNSUPPORTED`), and a command a reader runs. A remedy is a command, never a place to read
   (ADR-206); the linux-arm64 and native-Windows rows are recorded, not omitted.

## Consequences

- `docs/reference/acceptance.md` and `acceptance.mjs` fail the suite when they drift; the cost is
  a test edit when a fixture, proof or limit changes, which is the point.
- The matrix is data and a publication; it is not imported by a command at runtime. It states
  what a release must prove, and the proof is the work of the qualification tests and the release
  jobs it names. Adding a runtime reader would make the matrix an input to a command, which is a
  change to what the tool believes and not a change to what it is qualified by.
- The performance numbers are bounds, not measurements. They are declared here so the data a
  release collects has something to be measured against; the measurement itself is out of scope
  for this slice and belongs to a named qualification job.

## Rejected

- **Write the matrix as prose in the review.** That is the state this rules on: the rows exist in
  `docs/reviews/0005-production-readiness.md`’s acceptance paragraph, and a paragraph cannot be
  checked against the artefact it qualifies. Data plus a publication plus a test is what makes
  drift fail loudly.
- **Import the matrix into a command at runtime.** The matrix is a specification a release is
  qualified against, not a value a command computes with. A runtime reader would couple every
  command to the qualification spec and change the tool’s behaviour when a limit is edited.
- **Declare the performance limits after measuring.** A bar set to fit the data is a description,
  not a bound. The numbers land before the data so the data can fail them.
