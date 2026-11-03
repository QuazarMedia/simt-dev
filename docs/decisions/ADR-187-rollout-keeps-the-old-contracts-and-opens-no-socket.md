---
simt-affects: ["test/work-rollout.test.mjs"]
simt-supersedes: []
---

# ADR-187 — the rollout keeps the old contracts intact and opens no socket

Status: accepted · 2026-11-03

## Context

Twenty slices added behaviour to a tool other repositories already depend on. The risk is not that
the new behaviour is wrong; it is that shipping it changes what an existing repository reads, and
that a feature nobody enabled changes a resolution answer.

## Rulings

1. **Old consumer contracts are unchanged.** `simt.closure/1` keeps exactly `schema`, `version`,
   `complete`, `sha` and `checks`; the v2 fields live only in v2. The test asserts the key set, so a
   field added to v1 fails it.

2. **A legacy ledger line keeps its local-tree meaning.** A line without the evidence schema is v1,
   local-only, about the tree it names — and is `stale` when the tree moved.

3. **A v2 receipt survives the feature being disabled.** Turning `work` off removes new behaviour
   and keeps historical receipts; the record still validates against its own tree.

4. **New behaviour is opt-in.** An absent adapter leaves the default operation intact with the
   reason stated; no repository is moved onto the new path by adoption.

5. **Core resolution opens no socket.** `src/resolve`, `src/index/coverage.mjs`,
   `src/knowledge/rank.mjs` and `src/verify/select.mjs` contain no network import and no `fetch`, so
   a default run cannot make a request.

## Consequences

- The rollout is a set of checks rather than a promise: each ruling above is a test, and a change
  that breaks one fails the suite rather than a consumer's upgrade.
- Statistical non-inferiority on code work is not demonstrated here; until it is, the new ranking
  and selection stay experimental and off by default.
