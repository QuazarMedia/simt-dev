---
simt-affects: ["src/verify/select.mjs", "test/verify-selection.test.mjs"]
simt-supersedes: []
---

# ADR-164 — gate selection keeps the import closure, and an empty selection is not a pass

Status: accepted · 2026-11-03

## Context

`simt gate --changed` selects the tests that import a changed file, directly or through other
files. That is a good answer to a code question and no answer at all to a documentation change:
a modified requirement, template, claim or recipe has no importer, so the selection is empty —
and an empty selection rendered next to a green build reads as "verified".

The two ways out of that are both wrong. Running the whole suite on every document change makes
the gate expensive enough that it is skipped, which is worse than a narrow gate that says what
it did not check. Treating a co-change hint as proof of a dependency turns a correlation into a
contract.

## Rulings

1. **The existing code selection is unchanged.** The source closure is the same `coverage` call
   the gate command makes, and a caller may hand in the closure it already computed. A
   repository that opts into nothing sees exactly yesterday's selection.

2. **A typed obligation adds validators, not a suite.** Changed documents, templates, claims,
   recipes and object selectors name the validators that can discharge them. Mandatory
   validators are taken first; the rest are covered greedily by uncovered obligations per unit
   cost, ties by id.

3. **Independence is preserved through the cover.** An obligation that requires two independent
   validators is satisfied only by validators from two providers; two cheap ones from the same
   provider leave it `insufficient-independent-validators`.

4. **An unknown dependency expands to the declared scope.** A changed path no obligation claims
   expands to the validators declared for a prefix covering it, and the result says it expanded.
   The full suite is never the fallback.

5. **The status is one of three, and only one is green.** `no-op` on a clean diff, `ok` when
   something was selected, `unverified` when a non-empty opted-in change has no admissible
   validator. `claimsGreen` is false for anything but `ok` with a non-empty selection.

6. **The three classes are reported apart.** Source tests, document checks and remote checks
   have separate lists and counts, because they run in different places and a reader needs to
   know which one is missing.

7. **A Git hook never runs a remote validator.** `checkVerifyRun` refuses it with a remedy
   naming `simt verify run`, and always reports that the repository's own runner is used.

## Consequences

- The module reuses `src/index/coverage.mjs` rather than reimplementing closure, so the two
  selections cannot disagree about which tests import a file.
- Selection is a plan, not an execution: it produces the checks, their costs and the
  environments they need, and `checkVerifyRun` decides whether the invocation may run them.
- A scope entry is a path prefix, not a glob. A second matching language would be a second
  thing to keep consistent with the one the rubric matrix already uses.
