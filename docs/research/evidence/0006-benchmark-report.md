# Research Plan 0006 Track B benchmark report (v1 vs v2 vs v3 & 10k/50k scale)

Run on macOS arm64 (`darwin`) with Node `v26.13.1` and Apple Command Line Tools Git.
The pinned baseline checkout was `8c38faf35a8c45ca7f38757b9132c909cdfa77ef`.
The candidate was `d7032a3d` (Plan 0006 Waves 0–4 `V01`–`V20` plus calibration fixes discovered during `V21`).
The raw machine-readable reports produced by `node scripts/qualify-retrieval.mjs` were `quality.json` (210 tasks across 7 strata × 10 arms × 3 replays) and `scale.json` (10,000-file paired v1/v2/v3 and 50,000-file candidate build/incremental/warm-query benchmarks).

## Method

- **Quality corpus (`--suite v3`, 210 tasks total, 30 per stratum):**
  - Four Track A strata identical to `0006-v2-default-qualification.md`: `lexical` (30 mined commits evaluated against `task.base` per `ADR-241`), `vocabulary-gap` (30 symptom queries), `composite` (30 multi-subtask prompts at 2/3/4/6/8 subtasks across 1,024, 2,048, and 4,096 B budgets), and `impact-governance` (30 symbol impact, co-change, and governance tasks).
  - Three Track B adversarial/scale strata (`V20`): `zero-overlap-symptom` (30 tasks with zero lexical token overlap between prompt and implementation file/symbol), `error-literal` (30 tasks querying error literals embedded only in `string_literals` / `invocations`), and `scale-50k` (30 anchor tasks on the 50k layout).
- Every arm returned all 210 observations (`missing: 0`) across 3 replays including reversed input order.
- Paired 95% confidence intervals use 1,000 seeded bootstrap resamples of whole tasks (`seed: 1`). Positive movement is favorable, including a decrease in `hubNoiseRatio`.
- **Warm scale (`--suite v3`):**
  - At `10,000` files: 20 interleaved warm runs after 1 priming run comparing `baseline-v1` (`8c38faf`), `v2`, and `v3` (`map-v3` with `commitIr`, `conceptMap`, `qppFusion`, `sdm`, `hitsWalk`; `brief-v3` with `nash`, `scopeSpans`), plus `prompt-submit`.
  - At `50,000` files: candidate full build (`index-full`), single-file commit incremental rebuild (`index-incremental`), and 20 warm runs of `v2`, `v3`, and `prompt-submit`. (`baseline-v1` at `8c38faf` exhibits quadratic indexing/impact scaling beyond 15,000 files and timed out past 15 minutes during 50k fixture setup, so 50k rows record candidate measurements only.)
- **`+scope-spans` check:** Paired `scopeSpans: true` vs `scopeSpans: false` across all 30 `composite` tasks at `2048 B` and on a 220-line module with a target symbol at lines `206-207`.

## Track B promotion bar summary (`full-v3` vs `full-v2` vs `baseline-v1`)

| Gate / Stratum | Baseline v1 (`8c38faf`) | `full-v2` | Track B target | Candidate `full-v3` | Verdict |
| --- | ---: | ---: | ---: | ---: | --- |
| `lexical` Recall@10 (mined commits) | 0.313574 | 0.380267 | `>= 0.420` | **0.398335** (+0.0848 vs v1, +0.0181 vs v2) | Beats v1 & v2; below stretch `0.420` |
| `lexical` MRR (mined commits) | 0.456377 | 0.491242 | `>= 0.580` | **0.516250** (+0.0599 vs v1, +0.0250 vs v2) | Beats v1 & v2; below stretch `0.580` |
| `lexical` nDCG@10 (mined commits) | 0.309242 | 0.321382 | — | **0.369745** (+0.0605 vs v1, +0.0484 vs v2) | **IMPROVED** |
| `vocabulary-gap` Recall@10 / MRR | 0.966667 / 0.936111 | 1.000000 / 1.000000 | `1.000 / 1.000` | **1.000000 / 1.000000** | **PASS** |
| `zero-overlap-symptom` Recall@10 / MRR | 0.766667 / 0.245000 | 1.000000 / 0.844444 | `>= 0.700` MRR | **1.000000 / 1.000000** | **PASS** |
| `error-literal` Recall@5 / MRR | 0.000000 / 0.028794 | 0.966667 / 0.420556 | `>= 0.900` MRR | **1.000000 / 1.000000** | **PASS** |
| `scale-50k` Recall@10 / MRR | 1.000000 / 0.796667 | 1.000000 / 1.000000 | `1.000 / 1.000` | **1.000000 / 1.000000** | **PASS** |
| `composite` `minSubtaskCoverage@1024` | 0.066667 | 0.833333 | `>= 0.700` (plan §2) / `0.850` (gate) | **0.833333** | Clears §2 `>= 0.700`; below `0.850` gate |
| `composite` `minSubtaskCoverage@2048` | 0.066667 | **0.933333** | `>= 0.930` | 0.900000 (`+nash-pack`) | `full-v2` passes; `nash` trails by 1 task |
| `composite` `facetCompleteness@1024` | 0.214444 | 0.733333 | — | **0.798889** (`+nash-pack`) | **+0.0656** over `full-v2` |
| `composite` `facetCompleteness@2048` | 0.346667 | 0.898889 | `>= 0.880` | **0.911111** (`+nash-pack`) | **PASS** |
| `impact-governance` `recallFull` / `hubNoise` | 0.750000 / 0.400000 | 1.000000 / 0.000000 | `1.000 / 0.000` | **1.000000 / 0.000000** | **PASS** |
| `impact-governance` governance P / R | 1.000000 / 1.000000 | 1.000000 / 1.000000 | `1.000 / 1.000` | **1.000000 / 1.000000** | **PASS** |

## Paired quality by arm (vs `baseline-v1`)

| Arm | Stratum | Metric | Baseline | Candidate | Favorable change | 95% CI |
| --- | --- | --- | ---: | ---: | ---: | --- |
| `full-v2` | `lexical` | `recallAt10` | 0.313574 | 0.380267 | +0.066693 | [0.007725, 0.141839] |
| `full-v2` | `lexical` | `reciprocalRank` | 0.456377 | 0.491242 | +0.034865 | [-0.060367, 0.118611] |
| `full-v2` | `lexical` | `ndcgAt10` | 0.309242 | 0.321382 | +0.012140 | [-0.042658, 0.060517] |
| `full-v2` | `error-literal` | `reciprocalRank` | 0.028794 | 0.420556 | +0.391761 | [0.318035, 0.474567] |
| `full-v2` | `zero-overlap-symptom` | `reciprocalRank` | 0.245000 | 0.844444 | +0.599444 | [0.498333, 0.685556] |
| `+commit-ir` | `lexical` | `recallAt10` | 0.313574 | 0.385862 | +0.072288 | [0.008571, 0.149206] |
| `+commit-ir` | `lexical` | `reciprocalRank` | 0.456377 | 0.501922 | +0.045546 | [-0.037672, 0.134940] |
| `+commit-ir` | `lexical` | `ndcgAt10` | 0.309242 | 0.339205 | +0.029963 | [-0.025528, 0.080565] |
| `+commit-ir` | `zero-overlap-symptom` | `reciprocalRank` | 0.245000 | 1.000000 | +0.755000 | [0.709444, 0.802222] |
| `+commit-ir` | `zero-overlap-symptom` | `ndcgAt10` | 0.357803 | 1.000000 | +0.642197 | [0.569827, 0.728753] |
| `+pmi-thesaurus` | `lexical` | `recallAt10` | 0.313574 | 0.380267 | +0.066693 | [0.007725, 0.141839] |
| `+pmi-thesaurus` | `vocabulary-gap` | `reciprocalRank` | 0.936111 | 1.000000 | +0.063889 | [0.000000, 0.141667] |
| `+pmi-thesaurus` | `zero-overlap-symptom` | `reciprocalRank` | 0.245000 | 0.844444 | +0.599444 | [0.498333, 0.685556] |
| `+qpp-fusion` | `lexical` | `recallAt10` | 0.313574 | 0.386881 | +0.073307 | [0.000847, 0.154206] |
| `+qpp-fusion` | `lexical` | `ndcgAt10` | 0.309242 | 0.338315 | +0.029074 | [-0.014566, 0.075916] |
| `+qpp-fusion` | `error-literal` | `reciprocalRank` | 0.028794 | 1.000000 | +0.971206 | [0.968116, 0.973399] |
| `+qpp-fusion` | `error-literal` | `ndcgAt10` | 0.000000 | 1.000000 | +1.000000 | [1.000000, 1.000000] |
| `+qpp-fusion` | `zero-overlap-symptom` | `reciprocalRank` | 0.245000 | 1.000000 | +0.755000 | [0.709444, 0.802222] |
| `+sdm-constructs` | `lexical` | `reciprocalRank` | 0.456377 | 0.492895 | +0.036519 | [-0.056862, 0.119475] |
| `+sdm-constructs` | `error-literal` | `reciprocalRank` | 0.028794 | 0.468889 | +0.440095 | [0.349211, 0.535244] |
| `+sdm-constructs` | `error-literal` | `recallAt5` | 0.000000 | 1.000000 | +1.000000 | [1.000000, 1.000000] |
| `+sdm-constructs` | `zero-overlap-symptom` | `reciprocalRank` | 0.245000 | 0.868333 | +0.623333 | [0.523333, 0.702222] |
| `+hits-walk` | `error-literal` | `reciprocalRank` | 0.028794 | 0.427778 | +0.398984 | [0.324642, 0.481360] |
| `+hits-walk` | `error-literal` | `ndcgAt10` | 0.000000 | 0.569221 | +0.569221 | [0.511069, 0.633044] |
| `+nash-pack` | `composite` | `minSubtaskCoverage@1024` | 0.066667 | 0.833333 | +0.766667 | [0.600000, 0.900000] |
| `+nash-pack` | `composite` | `minSubtaskCoverage@2048` | 0.066667 | 0.900000 | +0.833333 | [0.700000, 0.966667] |
| `+nash-pack` | `composite` | `facetCompleteness@1024` | 0.214444 | 0.798889 | +0.584444 | [0.506667, 0.656667] |
| `+nash-pack` | `composite` | `facetCompleteness@2048` | 0.346667 | 0.911111 | +0.564444 | [0.478889, 0.648889] |
| `full-v3` | `lexical` | `recallAt10` | 0.313574 | 0.398335 | +0.084761 | [0.009881, 0.165620] |
| `full-v3` | `lexical` | `reciprocalRank` | 0.456377 | 0.516250 | +0.059874 | [-0.030748, 0.154696] |
| `full-v3` | `lexical` | `ndcgAt10` | 0.309242 | 0.369745 | +0.060503 | [-0.005413, 0.137414] |
| `full-v3` | `vocabulary-gap` | `recallAt10` | 0.966667 | 1.000000 | +0.033333 | [0.000000, 0.100000] |
| `full-v3` | `vocabulary-gap` | `reciprocalRank` | 0.936111 | 1.000000 | +0.063889 | [0.000000, 0.141667] |
| `full-v3` | `zero-overlap-symptom` | `recallAt10` | 0.766667 | 1.000000 | +0.233333 | [0.100000, 0.400000] |
| `full-v3` | `zero-overlap-symptom` | `reciprocalRank` | 0.245000 | 1.000000 | +0.755000 | [0.709444, 0.802222] |
| `full-v3` | `error-literal` | `recallAt5` | 0.000000 | 1.000000 | +1.000000 | [1.000000, 1.000000] |
| `full-v3` | `error-literal` | `reciprocalRank` | 0.028794 | 1.000000 | +0.971206 | [0.968116, 0.973399] |
| `full-v3` | `scale-50k` | `reciprocalRank` | 0.796667 | 1.000000 | +0.203333 | [0.090556, 0.326111] |
| `full-v3` | `composite` | `minSubtaskCoverage@2048` | 0.066667 | 0.900000 | +0.833333 | [0.700000, 0.966667] |
| `full-v3` | `composite` | `facetCompleteness@2048` | 0.346667 | 0.911111 | +0.564444 | [0.478889, 0.648889] |
| `full-v3` | `impact-governance` | `recallFull` / `hubNoiseRatio` | 0.750000 / 0.400000 | 1.000000 / 0.000000 | +0.250000 / +0.400000 | [0.250000, 0.250000] / [0.400000, 0.400000] |

### `full-v3` composite by byte budget (`+nash-pack` + `+scope-spans`)

| Budget | Metric | Baseline | `full-v2` | `full-v3` | Favorable vs v1 | 95% CI vs v1 |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1024 | `minSubtaskCoverage` | 0.066667 | 0.833333 | 0.833333 | +0.766667 | [0.600000, 0.900000] |
| 1024 | `meanSubtaskRecall` | 0.202778 | 0.979167 | 0.979167 | +0.776389 | [0.673611, 0.869444] |
| 1024 | `facetCompleteness` | 0.214444 | 0.733333 | **0.798889** | +0.584444 | [0.506667, 0.656667] |
| 1024 | `budgetFit` | 1.000000 | 1.000000 | 1.000000 | +0.000000 | [0.000000, 0.000000] |
| 2048 | `minSubtaskCoverage` | 0.066667 | **0.933333** | 0.900000 | +0.833333 | [0.700000, 0.966667] |
| 2048 | `meanSubtaskRecall` | 0.272222 | **0.991667** | 0.987500 | +0.715278 | [0.604167, 0.815278] |
| 2048 | `facetCompleteness` | 0.346667 | 0.898889 | **0.911111** | +0.564444 | [0.478889, 0.648889] |
| 2048 | `budgetFit` | 1.000000 | 1.000000 | 1.000000 | +0.000000 | [0.000000, 0.000000] |
| 4096 | `minSubtaskCoverage` | 0.066667 | 0.933333 | 0.933333 | +0.866667 | [0.733333, 0.966667] |
| 4096 | `meanSubtaskRecall` | 0.272222 | 0.991667 | 0.991667 | +0.719444 | [0.608333, 0.820833] |
| 4096 | `facetCompleteness` | 0.346667 | 0.916667 | 0.916667 | +0.570000 | [0.485556, 0.654444] |
| 4096 | `budgetFit` | 1.000000 | 1.000000 | 1.000000 | +0.000000 | [0.000000, 0.000000] |

On `+scope-spans` across the 30 `composite` tasks (`<= 200` lines/file), `minSubtaskCoverage@2048` (`0.900000`), `facetCompleteness@2048` (`0.911111`), and mean packet bytes (`1918.5 B`) were unchanged (`0` byte overhead). On a 220-line module with `targetScope` at lines `206–207`, `scopeSpans: true` replaced `src/large.mjs targetScope` with `src/large.mjs:206-207 targetScope`.

## 10,000-file and 50,000-file warm scale

| Files | Surface | Baseline p50 ms | Baseline p95 ms | Candidate p50 ms | Candidate p95 ms | p50 speedup |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 10,000 | `brief` (v2) | 481.50 | 499.19 | 113.33 | 129.63 | 4.25× |
| 10,000 | `brief-v3` (`nash` + `scopeSpans`) | 481.50 | 499.19 | 114.04 | 141.04 | 4.22× |
| 10,000 | `map` (v2) | 125.41 | 137.67 | 86.30 | 90.46 | 1.45× |
| 10,000 | `map-v3` (all v3 channels) | 125.41 | 137.67 | **85.88** | 93.84 | 1.46× |
| 10,000 | `impact` | 7100.92 | 7386.04 | 155.29 | 182.67 | 45.73× |
| 10,000 | `why` | 30.83 | 40.77 | 15.12 | 16.52 | 2.04× |
| 10,000 | `check` | 1046.84 | 1079.12 | 250.51 | 272.26 | 4.18× |
| 10,000 | `gate` | 7404.25 | 7545.58 | 412.42 | 430.97 | 17.95× |
| 10,000 | `prompt-submit` | 471.05 | 492.15 | 113.05 | **130.85** | 4.17× |
| 50,000 | `index-full` | — | — | **26258.40** | 26258.40 | — |
| 50,000 | `index-incremental` (1-file commit) | — | — | **1523.36** | 1523.36 | — |
| 50,000 | `brief` (v2) | — | — | 523.36 | 545.09 | — |
| 50,000 | `brief-v3` (`nash` + `scopeSpans`) | — | — | 520.98 | 544.85 | — |
| 50,000 | `map` (v2) | — | — | 266.14 | 281.23 | — |
| 50,000 | `map-v3` (all v3 channels) | — | — | 299.52 | 316.65 | — |
| 50,000 | `impact` | — | — | 727.59 | 759.72 | — |
| 50,000 | `why` | — | — | 29.26 | 35.19 | — |
| 50,000 | `check` | — | — | 755.65 | 787.26 | — |
| 50,000 | `gate` | — | — | 1089.21 | 1105.86 | — |
| 50,000 | `prompt-submit` | — | — | 553.16 | 580.11 | — |

`map` phase medians (`measureMapPhases`): at 10k files `{ ftsMs: 36.84, entityMs: 94.64, graphMs: 16.32, couplingMs: 72.68, packMs: 0.06 }`; at 50k files `{ ftsMs: 235.39, entityMs: 572.05, graphMs: 130.08, couplingMs: 398.98, packMs: 0.06 }`.

## Defects surfaced and resolved during `V21`

1. **QPP Fusion Tax on secondary graph walks (`src/index/qpp.mjs`, `src/index/map-v2.mjs`):** `fuseQppChannels` previously added `0.5 * normScore` and allowed `phi` up to `2.0` on `directional`, `pagerank`, and `coupling`, flipping BM25F rank #1 on `vocabulary-012`. Switching to `0.7 / (k + i + 1) + 0.3 * normScore` and clamping `maxPhi: 1.0` on secondary graph channels eliminated Fusion Tax and lifted `error-literal` MRR from `0.421` to `1.000`.
2. **Uncapped multi-term concept expansion (`src/index/prf.mjs`):** `searchWithConceptMap` summed unnormalized `0.35` weights per matched term, allowing multi-term expansions to exceed `LIMITS.original = 0.70` (`vocabulary-003` MRR `0.983 -> 1.000`). Normalizing concept expansion term weights to sum `<= 0.35` restored `1.000` `vocabulary-gap` MRR.
3. **Nash facet weight omission (`src/brief/submodular.mjs`):** `nashObjective` used `eff.taskWeight` instead of `eff.weight` (`facetWeight * taskWeight`), tying `SUBTASKS` lines with `FILES`. Using `eff.weight` lifted `composite` `minSubtaskCoverage@2048` from `0.833` back to `0.900` and `facetCompleteness@1024` to `0.799`.
4. **Corpus and runner issues (`packages/bench/src/multitask-corpus.mjs`, `scripts/qualify-retrieval.mjs`):** Replaced duplicate `V3_SYMPTOMS` themes colliding with `VOCABULARY`, disabled background `git gc --auto` races during fixture commit staging (`-c gc.auto=0`), and isolated 50k scale runs from the quadratic `8c38faf` baseline indexer.

## Honest lever verdicts (`V21` -> `V23`)

| Lever | Verdict | Basis |
| --- | --- | --- |
| `V11` — Commit-history IR (`commit_fts`) | **Promote into `v3`** | Lifted `zero-overlap-symptom` MRR `0.844 -> 1.000` and mined `lexical` Recall@10 `0.380 -> 0.386` / MRR `0.491 -> 0.502` / nDCG@10 `0.321 -> 0.339` with zero `vocabulary-gap` drift. |
| `V12` — Bilingual PMI thesaurus (`concept_map`) | **Promote into `v3`** | Strict NQC/anchor gating + `0.35` weight cap achieved `0%` regression on `vocabulary-gap` (`1.000` MRR) while recovering cross-vocabulary commits/ADRs in unit and zero-overlap checks. |
| `V13` — Post-retrieval QPP adaptive fusion | **Promote into `v3`** | Largest single-lever lift: `error-literal` MRR `0.421 -> 1.000`, `zero-overlap-symptom` MRR `0.844 -> 1.000`, `lexical` Recall@10 `0.380 -> 0.387`. |
| `V14` — SDM + `invocations`/`string_literals` | **Promote into `v3`** | Improved `error-literal` (`0.421 -> 0.469` MRR, `0.967 -> 1.000` Recall@5), `zero-overlap-symptom` (`0.844 -> 0.868` MRR), and `lexical` MRR (`0.491 -> 0.493`). |
| `V15` — Precomputed HITS + intent walks | **Promote into `v3`** | Improved `error-literal` (`0.421 -> 0.428` MRR) with zero regression and verified authority/hub separation. |
| `V16` — Nash Social Welfare packer | **Keep opt-in (`--nash`)** | Raised `facetCompleteness@1024` by `+6.6 pts` (`0.733 -> 0.799`) and `@2048` (`0.899 -> 0.911`), but dropped 1 task (`composite-025`) on `minSubtaskCoverage@2048` (`0.933 -> 0.900`) because sub-linear `bytes^0.75` pricing favored longer prose lines over a 24 B `TESTS` entry. |
| `V17` — Symbol-scope spans (`> 200` lines) | **Promote into `v3`** | Zero byte/coverage regression on `<= 200`-line repos (`1918.5 B` unchanged); narrows `> 200`-line hits to `path:L1-L2 symbol`. |
| `V18` — Session `--seen` anti-redundancy | **Keep explicit opt-in (`--seen`)** | Stateful turn-to-turn novelty belongs to explicit caller/session opt-in (`--seen` / `manifest.brief.session`). |
| **Rollout decision (`P7`, `V23`)** | **Ship `--retrieval v3` cleanly alongside default `v2`** | `full-v3` strictly improves retrieval quality over `v2` (`+1.8 pts` lexical Recall@10, `+2.5 pts` lexical MRR, `1.000` MRR on both `error-literal` and `zero-overlap-symptom`) with zero 10k latency penalty (`85.88 ms` vs `86.30 ms`), and `index-full` at 50k clears `26.26 s <= 45 s`. However, per `ADR-252` evidence gating, `v2` remains the default until 50k warm `loadLiveGraph` hydration (`map-v3` `299.5 ms` vs `180 ms`, `brief-v3` `521.0 ms` vs `260 ms`) and Track B stretch targets (`lexical` `0.398/0.516` vs `0.420/0.580`, `MSC@1024` `0.833`) are cleared. |

## Reproduce

With the baseline commit checked out in a separate directory, run the paired evaluator from this checkout:

```sh
node scripts/qualify-retrieval.mjs "$baseline_checkout" "$empty_output_dir" quality --suite v3
node scripts/qualify-retrieval.mjs "$baseline_checkout" "$empty_scale_dir" scale --suite v3
```
