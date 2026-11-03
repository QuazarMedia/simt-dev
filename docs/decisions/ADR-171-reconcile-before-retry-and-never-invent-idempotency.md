---
simt-affects: ["src/actions/retry.mjs", "test/action-retry.test.mjs"]
simt-supersedes: []
---

# ADR-171 — reconcile before retry, and never invent an idempotency the target does not offer

Status: accepted · 2026-11-03

## Context

A timeout means nobody knows what happened, and every convenient assumption about it is wrong:

- a retry after a lost response created a second object;
- a stale precondition was retried with a blind overwrite, discarding someone else's edit;
- an ambiguous name match was resolved by taking the first result;
- a duplicate callback caused a second effect;
- backoff had no cap, deadline or jitter, so every client retried in step;
- a hidden retry layer exceeded the intent's action budget;
- an exit code or a UI submit was treated as proof of idempotency.

## Rulings

1. **Classification is by target guarantee, never by surface.** `read`, `server-deduplicated`,
   `conditional-mutation`, `reconcilable-create`, `non-retryable`. An unspecified write is
   `non-retryable`: guessing it safe would repeat a mutation on the strength of a default.

2. **Reconcile before retry.** A lost response, timeout or 5xx on a reconcilable create returns
   `reconcile` and the reason says to query the outcome by idempotency key first.

3. **A precondition that no longer holds halts.** A 412 is a decision, not a transient failure;
   retrying it would overwrite the edit that caused it.

4. **An ambiguous match halts.** Reconciling by identity is the only admissible next step.

5. **The idempotency key is scoped to intent, step and target,** so the same attempt of the same
   intent gets the same key until the intent changes. A duplicate callback is detected by that
   key and produces no second effect.

6. **Backoff is deterministic, capped and deadline-aware.** Jitter is derived from a seed, so a
   simulated schedule can be diffed; the attempt budget and the deadline stop the run with its
   state preserved, and a stop is never reported as success.

7. **No surface proves idempotency.** A UI submit and a shell exit code report that an action was
   accepted, not that the target applied it once.

## Consequences

- The module is pure, so a schedule is reproducible in a test and in review.
- Retry policy stays in the adapter; this decides whether a retry is admissible, and the budget
  it must respect is the intent's (W32).
