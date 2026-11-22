# Research Plan 0005 benchmark report

Run on macOS arm64 with Node v26.13.0 and Apple Command Line Tools Git. The
baseline checkout was `8c38faf35a8c45ca7f38757b9132c909cdfa77ef`. The quality
comparison used the candidate through D36 plus the D37 evaluator. The raw reports were
`quality.json`, `scale.json`, and `hooks.json`.

## Method

- The four strata contain 30 tasks each. Lexical tasks use the parent trees of
  commits mined from the pinned baseline. Other tasks use the D02 fixtures.
  The composite stratum contains six tasks each at 2, 3, 4, 6 and 8 subtasks.
- The runner replays each arm three times, including a reversed input order.
  All arms returned all 120 observations. The targeted structural repeat
  staged two actual changes in each co-change pair and returned all 30
  observations per arm. It supplies the structural estimates below.
- The paired intervals use 1,000 seeded bootstrap resamples of whole tasks.
  Each composite prompt contributes one observation per metric and budget,
  so its subtasks stay together in every resample. Positive movement is
  favorable, including a decrease in Hub-Noise Ratio.
- `+bm25f-ident` uses weighted lexical fields and entity anchors.
  `+guarded-prf` and `+directional-graph` activate their channels on that
  lexical foundation. `+decompose` uses the composite candidate pool and
  the legacy packer. `+submodular-pack` applies the new packer to the legacy
  pool. Interpret the decomposition result as the contribution of the
  decomposed candidate pipeline.
- Baseline impact receives the defining file. The baseline rejects the bare
  symbol when the definition and its re-export both match. The candidate
  receives the same file with its symbol qualified. The co-change-only arm
  adds observed co-change destinations to the baseline file closure.
- Each warm scale row uses 20 interleaved measurements after one priming run,
  with one edited source. The two engines run in the same Node process with
  separately indexed fixtures. Gate time includes the selected test.
  Prompt-submit measures the hook delivery function including manifest opt-in
  and its read-only packet, with process startup outside the timed interval. Other local checks
  overlapped part of the scale run, so its medians and tail measurements
  describe this host and run.

## Paired quality

| Arm | Stratum | Metric | Baseline | Candidate | Favorable change | 95% CI |
| --- | --- | --- | ---: | ---: | ---: | --- |
| +bm25f-ident | lexical | recallAt10 | 0.313574 | 0.322713 | 0.009139 | -0.058440 to 0.091414 |
| +bm25f-ident | lexical | reciprocalRank | 0.456377 | 0.238303 | -0.218074 | -0.368610 to -0.059802 |
| +bm25f-ident | vocabulary-gap | recallAt10 | 0.966667 | 1.000000 | 0.033333 | 0.000000 to 0.100000 |
| +bm25f-ident | vocabulary-gap | reciprocalRank | 0.908333 | 0.500000 | -0.408333 | -0.483333 to -0.313889 |
| +guarded-prf | lexical | recallAt10 | 0.313574 | 0.327475 | 0.013901 | -0.052210 to 0.096176 |
| +guarded-prf | lexical | reciprocalRank | 0.456377 | 0.207933 | -0.248444 | -0.383047 to -0.116116 |
| +guarded-prf | vocabulary-gap | recallAt10 | 0.966667 | 1.000000 | 0.033333 | 0.000000 to 0.100000 |
| +guarded-prf | vocabulary-gap | reciprocalRank | 0.908333 | 0.516667 | -0.391667 | -0.469444 to -0.294444 |
| +directional-graph | lexical | recallAt10 | 0.313574 | 0.268283 | -0.045291 | -0.129603 to 0.012235 |
| +directional-graph | lexical | reciprocalRank | 0.456377 | 0.234620 | -0.221756 | -0.361864 to -0.092341 |
| +directional-graph | vocabulary-gap | recallAt10 | 0.966667 | 1.000000 | 0.033333 | 0.000000 to 0.100000 |
| +directional-graph | vocabulary-gap | reciprocalRank | 0.908333 | 1.000000 | 0.091667 | 0.016667 to 0.186111 |
| +symbol-bind | impact-governance | recallFull | 0.750000 | 0.500000 | -0.250000 | -0.250000 to -0.250000 |
| +symbol-bind | impact-governance | hubNoiseRatio | 0.400000 | 0.000000 | 0.400000 | 0.400000 to 0.400000 |
| +decompose | composite | minSubtaskCoverage@2048 | 0.066667 | 0.400000 | 0.333333 | 0.166667 to 0.500000 |
| +decompose | composite | facetCompleteness@2048 | 0.346667 | 0.532222 | 0.185556 | 0.064444 to 0.297778 |
| +submodular-pack | composite | minSubtaskCoverage@2048 | 0.066667 | 0.000000 | -0.066667 | -0.166667 to 0.000000 |
| +submodular-pack | composite | facetCompleteness@2048 | 0.346667 | 0.306667 | -0.040000 | -0.066667 to -0.013333 |
| +cochange | impact-governance | recallFull | 0.750000 | 1.000000 | 0.250000 | 0.250000 to 0.250000 |
| +cochange | impact-governance | hubNoiseRatio | 0.400000 | 0.333333 | 0.066667 | 0.066667 to 0.066667 |
| +governance | impact-governance | governancePrecision | 1.000000 | 1.000000 | 0.000000 | 0.000000 to 0.000000 |
| +governance | impact-governance | governanceRecall | 1.000000 | 1.000000 | 0.000000 | 0.000000 to 0.000000 |
| full-v2 | lexical | recallAt10 | 0.313574 | 0.282727 | -0.030847 | -0.117050 to 0.031587 |
| full-v2 | lexical | reciprocalRank | 0.456377 | 0.254889 | -0.201487 | -0.340321 to -0.059349 |
| full-v2 | vocabulary-gap | recallAt10 | 0.966667 | 1.000000 | 0.033333 | 0.000000 to 0.100000 |
| full-v2 | vocabulary-gap | reciprocalRank | 0.908333 | 0.633333 | -0.275000 | -0.386111 to -0.155556 |
| full-v2 | composite | minSubtaskCoverage@2048 | 0.066667 | 0.400000 | 0.333333 | 0.166667 to 0.500000 |
| full-v2 | composite | facetCompleteness@2048 | 0.346667 | 0.610000 | 0.263333 | 0.166667 to 0.358889 |
| full-v2 | impact-governance | recallFull | 0.750000 | 0.750000 | 0.000000 | 0.000000 to 0.000000 |
| full-v2 | impact-governance | hubNoiseRatio | 0.400000 | 0.000000 | 0.400000 | 0.400000 to 0.400000 |
| full-v2 | impact-governance | governancePrecision | 1.000000 | 1.000000 | 0.000000 | 0.000000 to 0.000000 |
| full-v2 | impact-governance | governanceRecall | 1.000000 | 1.000000 | 0.000000 | 0.000000 to 0.000000 |

### Full composite arm by byte budget

| Budget | Metric | Baseline | Candidate | Favorable change | 95% CI |
| ---: | --- | ---: | ---: | ---: | --- |
| 1024 | minSubtaskCoverage | 0.066667 | 0.200000 | 0.133333 | 0.033333 to 0.266667 |
| 1024 | meanSubtaskRecall | 0.202778 | 0.361111 | 0.158333 | 0.022222 to 0.294444 |
| 1024 | facetCompleteness | 0.214444 | 0.268889 | 0.054444 | -0.003333 to 0.121111 |
| 1024 | budgetFit | 1.000000 | 1.000000 | 0.000000 | 0.000000 to 0.000000 |
| 2048 | minSubtaskCoverage | 0.066667 | 0.400000 | 0.333333 | 0.166667 to 0.500000 |
| 2048 | meanSubtaskRecall | 0.272222 | 0.745833 | 0.473611 | 0.331944 to 0.598611 |
| 2048 | facetCompleteness | 0.346667 | 0.610000 | 0.263333 | 0.166667 to 0.358889 |
| 2048 | budgetFit | 1.000000 | 1.000000 | 0.000000 | 0.000000 to 0.000000 |
| 4096 | minSubtaskCoverage | 0.066667 | 0.400000 | 0.333333 | 0.166667 to 0.500000 |
| 4096 | meanSubtaskRecall | 0.272222 | 0.784722 | 0.512500 | 0.397222 to 0.623611 |
| 4096 | facetCompleteness | 0.346667 | 0.665556 | 0.318889 | 0.227778 to 0.412222 |
| 4096 | budgetFit | 1.000000 | 1.000000 | 0.000000 | 0.000000 to 0.000000 |

## Warm scale

| Files | Surface | Baseline p50 ms | Baseline p95 ms | Candidate p50 ms | Candidate p95 ms | p50 speedup |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 500 | `brief` | 71.97 | 75.87 | 21.55 | 23.16 | 3.34× |
| 500 | `map` | 28.61 | 32.48 | 29.03 | 40.94 | 0.99× |
| 500 | `impact` | 39.07 | 41.33 | 21.16 | 25.28 | 1.85× |
| 500 | `why` | 11.40 | 12.25 | 19.87 | 22.73 | 0.57× |
| 500 | `check` | 175.09 | 185.73 | 69.85 | 79.04 | 2.51× |
| 500 | `gate` | 202.85 | 215.48 | 203.49 | 221.14 | 1.00× |
| 500 | `prompt-submit` | 68.38 | 80.36 | 28.30 | 33.12 | 2.42× |
| 10000 | `brief` | 431.56 | 456.29 | 153.32 | 176.12 | 2.81× |
| 10000 | `map` | 103.74 | 111.11 | 320.49 | 342.61 | 0.32× |
| 10000 | `impact` | 7649.99 | 8172.80 | 133.84 | 147.27 | 57.16× |
| 10000 | `why` | 18.22 | 19.69 | 51.75 | 55.19 | 0.35× |
| 10000 | `check` | 916.67 | 1034.83 | 211.57 | 232.67 | 4.33× |
| 10000 | `gate` | 7427.68 | 8187.82 | 325.07 | 364.04 | 22.85× |
| 10000 | `prompt-submit` | 397.49 | 415.36 | 155.92 | 176.03 | 2.55× |

## Decisions

| Lever | Decision | Basis |
| --- | --- | --- |
| L1 — BM25F and entities | keep-opt-in | Mined Recall@10 reached 32.27%, below 75%. Vocabulary-gap MRR declined. |
| L2 — directional expansion and feedback | keep-opt-in | Directional expansion increased vocabulary-gap MRR from 0.9083 to 1.0000, a 10.1% relative gain. Mined Recall@10 fell by 4.5 points with that arm. |
| L3 — lexical symbol binding and overlay | keep-opt-in for precision | Symbol binding cut hub-only results to zero and missed a test reached through a module-level exported initializer. The default file-level answer still covers that test. |
| L4 — composite decomposition | keep-opt-in | Full composite MSC reached 40% and MFC reached 61% at 2,048 bytes. Even if every eight-task result scored zero, the corresponding 2–6-task rates could reach at most 50% and 76.25%. |
| L5 — submodular packing | reject as a standalone legacy-pool replacement | The same legacy pool lost MSC and MFC when repacked. The combined composite pipeline remains available by opt-in. |
| L6 — precise impact and co-change | keep-opt-in | Precision removed hub noise. Full structural recall and the evidence for regression-catching test selection are below the preregistered promotion bar. The measured initializer miss is a compatibility follow-up. |
| L7 — governance and structural checks | promote the qualified governance answer, keep structural policies opt-in | Governance precision and recall were both 100% on this corpus and the targeted check suite passed. Repositories own the architectural and structural policies that affect check exit status. |

At 10,000 files, the warm brief median was 153.32 ms against a 150 ms
target, and hook delivery was 176.03 ms at p95 against a 300 ms bar.
Impact and gate cleared the 3× median speedup at 10,000 files. At
500 files, impact was 1.85× faster and gate was unchanged at the
precision shown here. Map v2 was slower at 10,000 files.

Full-v2 mined Recall@10 declined by 3.1 points. A full-v2 default therefore
fails the one-point non-regression rule independently of hook timing. The
synthetic strata share vocabulary and fixture structure. Their intervals
describe variation across these tasks and give no production recall guarantee.

## Reproduce

With the baseline checked out in a separate directory, run the paired
evaluator from this checkout. The output directory receives isolated Git
fixtures and machine-readable reports.

```sh
node scripts/qualify-retrieval.mjs "$baseline_checkout" "$empty_output_dir"
```

The macOS measurements qualify this run only. The installed-consumer slice
records package and platform evidence separately.
