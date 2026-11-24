# Research Plan 0006 Track A qualification report (v2 default)

Run on macOS arm64 (`darwin`) with Node `v26.13.1` and Apple Command Line Tools Git.
The pinned baseline checkout was `8c38faf35a8c45ca7f38757b9132c909cdfa77ef`.
The candidate was `0ee65b26c0e7a6b2043409da022a26371c3f50c7` (Wave 0–1 repairs V01–V08 plus Track A rank-fusion and 10,000-file SQLite/overlay latency fixes).
The raw artifacts produced by `node scripts/qualify-retrieval.mjs` were `quality.json` and `scale.json`.

## Method

- The four quality strata contain 30 tasks each (120 tasks total), identical to `0005-benchmark-report.md`:
  - `lexical`: 30 mined commits evaluated against parent trees (`task.base`, zero future leakage per `ADR-241`).
  - `vocabulary-gap`: 30 symptom-phrased tasks from the D02 fixture.
  - `composite`: 30 multi-subtask tasks (six each at 2, 3, 4, 6, and 8 subtasks) evaluated at 1,024, 2,048, and 4,096 byte budgets.
  - `impact-governance`: 30 symbol impact, co-change, and governance tasks.
- Every arm returned all 120 observations (`missing: 0`) across 3 replays including reversed input order.
- Paired 95% confidence intervals use 1,000 seeded bootstrap resamples of whole tasks (`seed: 1`). Positive movement is favorable, including a decrease in `hubNoiseRatio`.
- Each warm scale row uses 20 interleaved measurements after one priming run on 500-file and 10,000-file synthetic repositories with one edited source file. Both engines run in the same Node process against separately indexed fixtures. `gate` includes running the selected test; `prompt-submit` measures hook delivery including manifest opt-in and read-only packet assembly.

## Track A promotion bar verdict (`full-v2` vs baseline `8c38faf`)

Every Track A quality bar and every 10,000-file scale latency bar from `docs/research/0006-retrieval-v2-default-and-v3-intelligence-plan.md` §2 passed simultaneously:

| Gate | Baseline v1 (`8c38faf`) | Prior v2 (`0005`) | Track A target | Candidate `full-v2` | Favorable delta | Verdict |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `lexical` Recall@10 | 0.313574 | 0.282727 | `>= 0.350` | **0.360227** | +0.046653 | **PASS** |
| `lexical` MRR | 0.456377 | 0.254889 | `>= 0.500` | **0.513698** | +0.057321 | **PASS** |
| `vocabulary-gap` Recall@10 | 0.966667 | 1.000000 | `1.000` | **1.000000** | +0.033333 | **PASS** |
| `vocabulary-gap` MRR | 0.908333 | 0.633333 | `1.000` | **1.000000** | +0.091667 | **PASS** |
| `composite` `minSubtaskCoverage@2048` | 0.066667 | 0.400000 | `>= 0.850` | **0.900000** | +0.833333 | **PASS** |
| `composite` `minSubtaskCoverage@4096` | 0.066667 | 0.400000 | `>= 0.850` | **0.933333** | +0.866667 | **PASS** |
| `composite` `facetCompleteness@2048` | 0.346667 | 0.610000 | `>= 0.800` | **0.904444** | +0.557778 | **PASS** |
| `impact-governance` `recallFull` | 0.750000 | 0.750000 | `1.000` | **1.000000** | +0.250000 | **PASS** |
| `impact-governance` `hubNoiseRatio` | 0.400000 | 0.000000 | `0.000` | **0.000000** | +0.400000 | **PASS** |
| `impact-governance` `governancePrecision` | 1.000000 | 1.000000 | `1.000` | **1.000000** | +0.000000 | **PASS** |
| `impact-governance` `governanceRecall` | 1.000000 | 1.000000 | `1.000` | **1.000000** | +0.000000 | **PASS** |
| 10,000-file warm `map` p50 | 109.68 ms | 320.49 ms | `<= 80 ms` | **71.75 ms** | 1.53× faster | **PASS** |
| 10,000-file warm `why` p50 | 29.99 ms | 51.75 ms | `<= 15 ms` | **13.66 ms** | 2.20× faster | **PASS** |
| 10,000-file warm `brief` p50 | 468.00 ms | 153.32 ms | `<= 130 ms` | **96.08 ms** | 4.87× faster | **PASS** |
| 10,000-file warm `prompt-submit` p95 | 477.66 ms | 176.03 ms | `<= 160 ms` | **110.31 ms** | 4.33× faster | **PASS** |

## Paired quality by arm

| Arm | Stratum | Metric | Baseline | Candidate | Favorable change | 95% CI |
| --- | --- | --- | ---: | ---: | ---: | --- |
| +bm25f-ident | lexical | recallAt10 | 0.313574 | 0.355703 | 0.042130 | -0.025172 to 0.124590 |
| +bm25f-ident | lexical | reciprocalRank | 0.456377 | 0.523486 | 0.067110 | -0.011232 to 0.150911 |
| +bm25f-ident | vocabulary-gap | recallAt10 | 0.966667 | 1.000000 | 0.033333 | 0.000000 to 0.100000 |
| +bm25f-ident | vocabulary-gap | reciprocalRank | 0.908333 | 1.000000 | 0.091667 | 0.016667 to 0.186111 |
| +guarded-prf | lexical | recallAt10 | 0.313574 | 0.355703 | 0.042130 | -0.025172 to 0.124590 |
| +guarded-prf | lexical | reciprocalRank | 0.456377 | 0.523486 | 0.067110 | -0.011232 to 0.150911 |
| +guarded-prf | vocabulary-gap | recallAt10 | 0.966667 | 1.000000 | 0.033333 | 0.000000 to 0.100000 |
| +guarded-prf | vocabulary-gap | reciprocalRank | 0.908333 | 1.000000 | 0.091667 | 0.016667 to 0.186111 |
| +directional-graph | lexical | recallAt10 | 0.313574 | 0.356894 | 0.043320 | -0.023201 to 0.122407 |
| +directional-graph | lexical | reciprocalRank | 0.456377 | 0.513446 | 0.057070 | -0.016029 to 0.127070 |
| +directional-graph | vocabulary-gap | recallAt10 | 0.966667 | 1.000000 | 0.033333 | 0.000000 to 0.100000 |
| +directional-graph | vocabulary-gap | reciprocalRank | 0.908333 | 1.000000 | 0.091667 | 0.016667 to 0.186111 |
| +symbol-bind | impact-governance | recallFull | 0.750000 | 0.750000 | 0.000000 | 0.000000 to 0.000000 |
| +symbol-bind | impact-governance | hubNoiseRatio | 0.400000 | 0.000000 | 0.400000 | 0.400000 to 0.400000 |
| +decompose | composite | minSubtaskCoverage@2048 | 0.066667 | 0.800000 | 0.733333 | 0.566667 to 0.866667 |
| +decompose | composite | facetCompleteness@2048 | 0.346667 | 0.527778 | 0.181111 | 0.054444 to 0.308889 |
| +submodular-pack | composite | minSubtaskCoverage@2048 | 0.066667 | 0.000000 | -0.066667 | -0.166667 to 0.000000 |
| +submodular-pack | composite | facetCompleteness@2048 | 0.346667 | 0.306667 | -0.040000 | -0.066667 to -0.013333 |
| +cochange | impact-governance | recallFull | 0.750000 | 1.000000 | 0.250000 | 0.250000 to 0.250000 |
| +cochange | impact-governance | hubNoiseRatio | 0.400000 | 0.333333 | 0.066667 | 0.066667 to 0.066667 |
| +governance | impact-governance | governancePrecision | 1.000000 | 1.000000 | 0.000000 | 0.000000 to 0.000000 |
| +governance | impact-governance | governanceRecall | 1.000000 | 1.000000 | 0.000000 | 0.000000 to 0.000000 |
| full-v2 | lexical | recallAt10 | 0.313574 | 0.360227 | 0.046653 | -0.019180 to 0.123545 |
| full-v2 | lexical | reciprocalRank | 0.456377 | 0.513698 | 0.057321 | -0.015573 to 0.127174 |
| full-v2 | lexical | ndcgAt10 | 0.309242 | 0.331972 | 0.022730 | -0.011632 to 0.057941 |
| full-v2 | vocabulary-gap | recallAt10 | 0.966667 | 1.000000 | 0.033333 | 0.000000 to 0.100000 |
| full-v2 | vocabulary-gap | reciprocalRank | 0.908333 | 1.000000 | 0.091667 | 0.016667 to 0.186111 |
| full-v2 | vocabulary-gap | ndcgAt10 | 0.921031 | 1.000000 | 0.078969 | 0.012302 to 0.162302 |
| full-v2 | composite | minSubtaskCoverage@2048 | 0.066667 | 0.900000 | 0.833333 | 0.700000 to 0.933333 |
| full-v2 | composite | facetCompleteness@2048 | 0.346667 | 0.904444 | 0.557778 | 0.468889 to 0.644444 |
| full-v2 | impact-governance | recallFull | 0.750000 | 1.000000 | 0.250000 | 0.250000 to 0.250000 |
| full-v2 | impact-governance | hubNoiseRatio | 0.400000 | 0.000000 | 0.400000 | 0.400000 to 0.400000 |
| full-v2 | impact-governance | governancePrecision | 1.000000 | 1.000000 | 0.000000 | 0.000000 to 0.000000 |
| full-v2 | impact-governance | governanceRecall | 1.000000 | 1.000000 | 0.000000 | 0.000000 to 0.000000 |

### Full composite arm by byte budget

| Budget | Metric | Baseline | Candidate | Favorable change | 95% CI |
| ---: | --- | ---: | ---: | ---: | --- |
| 1024 | minSubtaskCoverage | 0.066667 | 0.700000 | 0.633333 | 0.466667 to 0.800000 |
| 1024 | meanSubtaskRecall | 0.202778 | 0.954167 | 0.751389 | 0.652778 to 0.843056 |
| 1024 | facetCompleteness | 0.214444 | 0.733333 | 0.518889 | 0.442222 to 0.595556 |
| 1024 | budgetFit | 1.000000 | 1.000000 | 0.000000 | 0.000000 to 0.000000 |
| 2048 | minSubtaskCoverage | 0.066667 | 0.900000 | 0.833333 | 0.700000 to 0.933333 |
| 2048 | meanSubtaskRecall | 0.272222 | 0.983333 | 0.711111 | 0.605556 to 0.813889 |
| 2048 | facetCompleteness | 0.346667 | 0.904444 | 0.557778 | 0.468889 to 0.644444 |
| 2048 | budgetFit | 1.000000 | 1.000000 | 0.000000 | 0.000000 to 0.000000 |
| 4096 | minSubtaskCoverage | 0.066667 | 0.933333 | 0.866667 | 0.733333 to 0.966667 |
| 4096 | meanSubtaskRecall | 0.272222 | 0.991667 | 0.719444 | 0.608333 to 0.820833 |
| 4096 | facetCompleteness | 0.346667 | 0.916667 | 0.570000 | 0.485556 to 0.654444 |
| 4096 | budgetFit | 1.000000 | 1.000000 | 0.000000 | 0.000000 to 0.000000 |

## Warm scale

| Files | Surface | Baseline p50 ms | Baseline p95 ms | Candidate p50 ms | Candidate p95 ms | p50 speedup |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 500 | `brief` | 121.62 | 132.25 | 30.58 | 51.52 | 3.98× |
| 500 | `map` | 39.56 | 41.76 | 33.97 | 35.52 | 1.16× |
| 500 | `impact` | 50.96 | 52.24 | 33.20 | 35.15 | 1.53× |
| 500 | `why` | 22.79 | 23.68 | 4.14 | 4.60 | 5.50× |
| 500 | `check` | 333.40 | 348.45 | 134.65 | 143.40 | 2.48× |
| 500 | `gate` | 244.13 | 259.55 | 268.29 | 278.14 | 0.91× |
| 500 | `prompt-submit` | 125.74 | 133.39 | 29.69 | 34.46 | 4.24× |
| 10000 | `brief` | 468.00 | 480.23 | 96.08 | 113.78 | 4.87× |
| 10000 | `map` | 109.68 | 115.57 | 71.75 | 76.64 | 1.53× |
| 10000 | `impact` | 7132.17 | 7385.87 | 152.52 | 166.16 | 46.76× |
| 10000 | `why` | 29.99 | 32.11 | 13.66 | 15.40 | 2.20× |
| 10000 | `check` | 1112.69 | 1173.13 | 241.05 | 260.11 | 4.62× |
| 10000 | `gate` | 7922.81 | 9087.90 | 419.84 | 443.45 | 18.87× |
| 10000 | `prompt-submit` | 451.13 | 477.66 | 99.99 | 110.31 | 4.51× |

### `map` phase breakdown (candidate v2)

| Files | `ftsMs` p50 | `entityMs` p50 | `graphMs` p50 | `couplingMs` p50 | `packMs` p50 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 500 | 1.45 ms | 3.73 ms | 0.57 ms | 3.55 ms | 0.03 ms |
| 10000 | 32.07 ms | 83.62 ms | 17.46 ms | 71.14 ms | 0.06 ms |

*(Note: `ftsMs`, `entityMs`, `graphMs`, and `couplingMs` overlap in parallel via `Promise.all`; wall-clock `map` p50 at 10,000 files is `71.75 ms`, p95 `76.64 ms`.)*

## Decisions

| Lever | Decision | Basis |
| --- | --- | --- |
| L1–L2 — repaired BM25F, calibrated anchors, `!isTestPath`/kind prior, directional graph, guarded PRF (`map`, `brief`, `knowledge rank`) | **promote to default** | `full-v2` beats baseline `v1` on lexical Recall@10 (`0.3602` vs `0.3136`), lexical MRR (`0.5137` vs `0.4564`), and vocabulary-gap Recall@10/MRR (`1.0000/1.0000` vs `0.9667/0.9083`), while running `1.53×` faster at 10,000 files (`71.75 ms` p50). |
| L4–L5 — intent-projected composite decomposition + fair submodular packer (`brief`, `prompt-submit`) | **promote to default** | `full-v2` raises `minSubtaskCoverage@2048` from `0.0667` to `0.9000`, `@4096` to `0.9333`, and `facetCompleteness@2048` from `0.3467` to `0.9044` with `budgetFit = 1.000`, while cutting 10,000-file `brief` p50 by `4.87×` (`96.08 ms`) and `prompt-submit` p95 by `4.33×` (`110.31 ms`). |
| L3 — symbol binding for test selection (`gate`, `tests`) | **keep file coverage as default (`ADR-252` ruling 2)** | File coverage remains the conservative CI default; `--precise` opts into symbol hunk selection while `--conservative` forces file closure. |
| Governance and structural policy (`why`, `check`) | **keep current behavior (`ADR-252` ruling 3)** | `governancePrecision = 1.000`, `governanceRecall = 1.000`; 10,000-file warm `why` p50 dropped from `51.75 ms` to `13.66 ms` (`2.20×` faster than `v1`). |
| Rollback on existing cache (`--retrieval v1`, `brief.retrieval: "v1"`) | **keep intact (`ADR-252` ruling 4)** | Passing `--retrieval v1` or setting `brief.retrieval: "v1"` restores legacy ranking/packets on the same SQLite cache with zero rebuild. |
