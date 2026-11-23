---
simt-affects: ["test/identifiers.test.mjs", "test/index-prf.test.mjs", "test/studio-server.test.mjs", "docs/decisions/ADR-254-the-gate-ceiling-sizes-to-the-slowest-runner.md"]
---

# ADR-255 — wall-clock bars size to the slowest qualifying host, not the authoring machine

Status: accepted · 2026-11-23

## Context

ADR-254 sized the `/api/check` gate ceiling to the slowest qualifying host because a
ceiling calibrated on the authoring machine fails on the host that ships. The same
exposure sat in every other suite wall-clock bar, calibrated on a single authoring
machine and never re-sized: the identifier tokenizer's 10 MB/s throughput floor, the
PRF feedback 15 ms overhead ceiling, and the studio read ceilings — including ADR-254's
own 300 ms `/api/check` number, which the same class of host settles well past.

The pre-push `test` gate runs on developer hosts, so a developer host is a qualifying
host. On an M4 Max development host (Mac16,9, 16 cores, arm64) the suite fails the bars
under both Node v26.7.0 and Node v24.19.0 — identical failures, so the class is the
host, not the interpreter:

- raw arithmetic at 40 G ops/s and 1 M small-object allocations in 48 ms: healthy;
- regex-heavy string paths roughly 2.5–3× slower than the calibrated host, and noisier
  under concurrent suite load — a route's median moves 1.2–1.6× between an isolated run
  and a concurrent one, so the bars size to the worst settle observed, not the median of
  medians;
- identifier tokenizer **5.9–8.4 MB/s** isolated, **4.2–4.4 MB/s** under concurrent
  load — a 1.4× spread even isolated — against the 10 MB/s floor;
- PRF feedback overhead **17.3 ms** (v26) / **21.7 ms** (v24), and a settle past the
  25 ms re-baseline under concurrent load, against the 15 ms ceiling;
- the evidence family — `/api/evidence` and its `/chains` endpoints, which collect
  the same records — **177.3–198.0 ms** against the 75 ms read ceiling it shares with
  the light routes; and in a later run, `/api/helm?path=status` — a route that held
  75 in every earlier run — settles at **303.2 ms**. Which light route spikes is
  per-run: the spikes are a property of this host under contention, not of any one
  route;
- `/api/check` **336.6–340.7 ms** isolated, **490.5 ms** under concurrent load, against
  the 300 ms ceiling ADR-254 sized from a 216.4 ms 2-vCPU CI measurement;
- `/api/status` **779.8 ms** (v26) / **286.2 ms** (v24) against the 75 ms read ceiling.

The tokenizer is already regex-optimal — a forward-only boundary rewrite measured
slower than the lookbehind split it would replace — so none of these gaps closes with a
code change. Only the bars can move.

## Rulings

1. **The throughput floor and the overhead ceiling size to the slowest qualifying host.**
   The identifier tokenizer floor is **3 MB/s** (was 10): the host settles at
   **4.4 MB/s** under concurrent load and varies 4.4–8.4 MB/s even isolated, so the
   floor sits a headroom factor below the worst concurrent settle, and a halved
   throughput (2.2 MB/s) still trips it. The PRF feedback overhead ceiling is
   **40 ms** (was 15): the host settles at 17.3–22.5 ms isolated and past 25 under
   concurrent load, and a doubled overhead of ~50 ms still trips it.
2. **The read ceiling absorbs the slow host's contention-spike class.** Since any light
   route can spike to **303.2 ms** under concurrent load and which one does is per-run,
   tiering each route that happens to spike would chase noise. The shared read ceiling
   is **400 ms** (was 75): it sits above the worst settle observed on the slow
   qualifying host, and a route that doubles its work still trips it (2 × 303.2 =
   606 ms). `/api/status`, a multi-slot aggregate — check cache, hook routing, ledger,
   leases, tracker, journal — is **1100 ms** (1.4× its 779.8 ms settle).
3. **ADR-254's 300 ms `/api/check` number is superseded by the same host measurement.**
   The suite ceiling under `--test-concurrency=4` is **700 ms**: 1.4× the 490.5 ms
   concurrent-load settle, on the headroom arithmetic ADR-254 itself used (300 over
   216.4). A route that doubles its work still trips it on the slowest qualifying host
   (2 × 490.5 = 981 ms), and it stays far above the fast-host settles (105.1 ms
   authoring machine per ADR-228, 216.4 ms CI runner).
4. **The statistic does not change.** Warm medians, the same sample counts, and the
   settled re-measure stand; only the numbers move. No route gets a softer statistic
   to hide behind.
