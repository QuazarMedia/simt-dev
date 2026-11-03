---
simt-affects: ["src/actions/recovery.mjs", "test/action-recovery.test.mjs"]
simt-supersedes: []
---

# ADR-173 — recovery is not rollback, and a fallback that changes the effect is a new intent

Status: accepted · 2026-11-03

## Context

Recovery is where an operation stops being reviewable, unless the choices are named:

- a crash after a verified step replayed that step and duplicated its effect;
- a partial batch was reported as complete, or as failed, when half of it was unknown;
- a compensation was described as a guarantee that can succeed, when it can fail like anything
  else and needs its own actor, precondition and verifier;
- a UI fallback clicked blindly on a form that had changed;
- a protocol fallback was treated as the same intent while changing the effect;
- `simt undo` was described as restoring remote state it never touched;
- a destructive compensation was inferred from a failed create.

## Rulings

1. **Four recovery choices, and one of them is a person.** `none`, `retry-after-reconciliation`,
   `forward-repair`, `compensation`, `manual`. An unknown outcome that the target cannot reconcile
   is `manual`; nobody guesses.

2. **A verified step is skipped unless its evidence expired.** `resumePlan` reports `skip`,
   `replay` and `unknown` separately, and says why a step is replayed.

3. **A partial batch is stated exactly.** `done`, `remaining` and `unknown` are separate lists, and
   `complete` is true only when nothing remains and nothing is unknown.

4. **A compensation is declared, contracted and can fail.** `compensationContract` requires an
   actor, an explicit effect set and a verifier, and records `canFail: true`. A failure with no
   declared compensation is `manual`; one is never inferred.

5. **A UI target is bound before submission.** Form identity, semantic field locators and a widget
   structure signature are all required; an unbound target is refused as a blind click, a changed
   structure triggers bounded rediscovery, and exceeding the limit refuses.

6. **A protocol must prove it can perform the intent.** Selection requires the declared
   capabilities, so a UI path that cannot set a required flag is refused rather than attempted.

7. **A fallback that changes the effect is a new intent.** `fallbackIntent` reports the added and
   removed effects and says the fallback needs its own authorization.

8. **`simt undo` has local scope only.** It restores journaled local files and claims nothing
   about a remote effect, which needs its declared recovery procedure.

## Consequences

- Recovery decisions are values, so a review can compare what was possible with what was chosen.
- The module performs nothing: an executor (W33) carries out the chosen step, and the verifier
  (W35) decides whether it worked.
