---
simt-affects: ["src/actions/observe.mjs", "src/actions/review.mjs", "src/actions/retry.mjs", "src/coordination/handoff.mjs", "src/knowledge/debt.mjs", "src/agenthooks/normalize.mjs"]
simt-supersedes: []
---

# ADR-192 — an audit tightened four classifications in the work layer

Status: accepted · 2026-11-03

## Context

Every module in the work layer was written with its ruling stated in a comment, and each ruling
has a witness test. An audit of the whole layer found that four of the classifications those
rulings describe did not hold in every case, plus one rank that could not explain itself. Each
defect is small; each one silently produced the answer the module exists to prevent.

The rulings below name each module rather than locating it: this record ships with the package,
and a reader in another repository cannot resolve a path in this one (ADR-054, S54).

## Rulings

1. **Independence requires a declared backing store.** The observation module fell back to a
   channel's *name* when it declared no backing, so two differently named clients over one cache
   were reported independent. A channel that does not say what it reads cannot prove it is a
   second reading, and the honest verdict is `correlated`.

2. **A postcondition over an absent field fails.** Comparing `undefined` with `undefined` let a
   postcondition pass on a field the object never carried. Absence is not agreement.

3. **A numeric functional field is not an environment-local id.** The review-bundle module's
   promotion refused any change whose new value looked numeric, so a bundle carrying
   `quantity: 42` could not be promoted. The raw-id guard is about references, which the delta
   module already filtered on; promotion now agrees with it.

4. **A rejection is classified before the attempt budget.** The retry module reported a 400 on the
   last allowed attempt as an exhausted budget. The two call for different actions: one says the
   target refused, the other says try again later.

5. **A rank explains itself or it is not a rank.** The knowledge-debt module scored a raw row with
   no fields filled, and its reasons read "undefined obligation(s) affected". Items are normalised
   through the item constructor before scoring, so every number in a reason exists.

## Also corrected, with no ruling needed

- The handoff module tested for a missing approval with `!== null`, which is true for `undefined`,
  so a capsule that recorded no approval failed resume. It now requires an approval object before
  comparing digests.
- The hook normaliser carried an unreachable `return 'read'` branch.
- Array guards where a wrong type spread a string into characters or threw: target capabilities in
  the redacted report, an authorization's effect list, a fallback's effect set, a bundle's delta
  changes, a promotion plan's changes, and the postconditions and frame conditions of a
  verification.

## Consequences

- Each correction has a regression test naming the failure it prevents.
- The rulings restate what the modules already claimed; none widens a module's purpose, and no
  prose here quotes a location a reader outside this package could not resolve.
