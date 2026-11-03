---
simt-affects: ["src/coordination/leases.mjs", "test/work-leases.test.mjs"]
simt-supersedes: []
---

# ADR-174 — a lease is worth exactly what can enforce it, and fencing is checked before every effect

Status: accepted · 2026-11-03

## Context

Leases are the place where local tooling most often claims distribution it does not have:

- two sessions held the same exclusive lease because each wrote its own copy of a JSON file;
- an expired worker kept mutating, because nothing checked a fencing token;
- a local worktree was believed to isolate shared remote state;
- a lease was treated as a capability;
- two sessions acquired resources in opposite orders and deadlocked.

## Rulings

1. **A resource key says what it is.** A local key carries a path; a remote key carries the target,
   its incarnation, the type and either an object or a collection plus a logical create key. A
   reset target is a different resource, and a local worktree key can never equal a remote one.

2. **Acquisition is in one canonical order.** `orderResources` deduplicates and sorts, so two
   sessions acquire in the same order and cannot deadlock on each other.

3. **A held, unexpired lease excludes another owner.** The refusal names the holder; the owner may
   re-acquire; an expired lease may be taken by someone else.

4. **Fencing decides, not the TTL.** A token behind the lease's fencing token is invalid with that
   reason; the executor checks it before each mediated effect.

5. **Enforcement is reported, not assumed.** With a configured coordinator or target CAS the mode
   is `enforced`; on the same host without one it is `advisory-local` with the residual race named;
   across hosts it is `advisory-cross-host` with the reason that a local file is not a distributed
   lock.

6. **A lease grants nothing.** `grantsOf` is empty by construction: exclusion is not authorization,
   and privileges come from the platform's own check.

## Consequences

- The module is a value layer over a lease store; the store's atomicity is the caller's, and the
  mode field makes the difference visible instead of implicit.
- A worktree remains the unit of local isolation and is never offered as remote exclusion.
