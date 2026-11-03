---
simt-affects: ["src/coordination/workgraph.mjs", "test/workgraph.test.mjs"]
simt-supersedes: []
---

# ADR-175 — readiness needs current evidence, a cycle is not waiting, and the graph proposes rather than spawns

Status: accepted · 2026-11-03

## Context

A dependency graph is only as honest as its notion of "done":

- a predecessor's prose "done" was treated as evidence, so dependents started on unverified work;
- stale predecessor proof stayed valid, so dependents never reopened;
- two tasks writing the same document section or remote object ran together;
- a cycle was reported as "waiting", which reads like progress;
- a budget was exhausted while the run was reported as approved;
- independent research was serialized for no reason.

## Rulings

1. **Readiness requires current evidence.** A predecessor counts only when its evidence record says
   `current: true`; a missing or stale record leaves the dependent `waiting` with the exact missing
   entry named.

2. **Expired proof reopens dependents.** The same predicate is evaluated on every call, so a
   predecessor whose evidence went stale reopens everything that depends on it.

3. **Blockers and unknown predecessors are named.** A task with a declared blocker is `blocked`
   with that blocker; a dependency that is not in the graph is `waiting` on an unknown predecessor.

4. **A cycle is a cycle.** Strongly connected components are detected and reported with their
   members and the reason, and a task inside one is never dispatched as if it were waiting.

5. **Conflicting writes serialize; independent work runs in parallel.** Tasks that write the same
   resource are serialized in id order with the resource named; independent tasks up to capacity
   are dispatched together, and capacity-limited work is queued rather than dropped.

6. **An exhausted budget stops with state preserved.** `checkBudget` reports the exhausted limit,
   and a limited task never appears in a dispatch proposal as if it had succeeded.

7. **The graph proposes; it does not spawn.** The output is a dispatch proposal for the existing
   orchestrator, so the decision to run agents stays where it already lives.

## Consequences

- The graph is pure over supplied tasks and evidence, so a proposal can be diffed between runs.
- Task limits are the intent's limits (W32); this module reads them and never invents a larger one.
