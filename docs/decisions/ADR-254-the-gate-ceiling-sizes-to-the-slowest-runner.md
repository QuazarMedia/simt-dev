---
simt-affects: ["test/studio-server.test.mjs", "docs/decisions/ADR-228-the-studio-is-qualified-from-a-packed-install.md"]
---

# ADR-254 — the gate ceiling sizes to the slowest runner, not the authoring machine

Status: accepted · 2026-11-22

## Context

ADR-228 set the `/api/check` suite ceiling at 200 ms from an authoring-machine
measurement: a warm median of 105.1 ms (101.6–124.6 ms), with the 75 ms ceiling on
every other read already carrying four-way concurrency headroom. The v0.13.0 publish
run on the 2-vCPU GitHub runner measured a settled three-sample median of
**216.4 ms** under `--test-concurrency=4` — the suite's four files competing for two
cores is the runner's steady state, not a transient to filter out. A ceiling sized to
the authoring machine fails on the runner that ships, and the one settled re-measure
ADR-228 allows does not rescue it: the load persists past the re-measure window.

## Rulings

1. **The gate ceiling sizes to the slowest qualifying host.** The `/api/check` suite
   ceiling under `--test-concurrency=4` is **300 ms**. That is 39 % above the 216.4 ms
   CI measurement and 2.9× the authoring-machine median: a route that doubles its work
   trips it, a busy runner does not. This supersedes the 200 ms value in ADR-228; the
   method in ADR-228 stands.
2. **The 75 ms read ceiling stands.** Every other read route held its ceiling in the
   v0.13.0 run with margin, and a ceiling is not widened for a route that holds it.
3. **The statistic does not change.** The test still asserts a warm three-sample median
   with one settled re-measure. Only the gate's number moves; no route gets a softer
   measure to hide behind.

## Consequences

- ADR-228 records the 200 ms value in its rulings and latency section; this record
  supersedes that value, and ADR-228's status line names it.
- The 50 ms warm budget remains a target, not an assertion (ADR-228).
- A new qualifying host slower than the 2-vCPU runner re-opens the number the same way:
  measure it under `--test-concurrency=4`, and record the ceiling it needs here.
