---
simt-affects: ["src/index/retrieval-mode.mjs", "src/index/store.mjs", "src/commands/repoindex.mjs", "src/commands/map.mjs", "src/commands/brief.mjs", "src/commands/knowledge.mjs", "src/commands/impact.mjs", "src/brief/assemble.mjs", "src/agenthooks/prompt.mjs"]
simt-supersedes: [{ adr: "ADR-252", ruling: 1, kind: "superseded" }]
---
# ADR-256 — Retrieval v2 is the default

Status: accepted · 2026-11-24 · V10

## Context

ADR-252 ruling 1 kept retrieval v2 opt-in because the initial 120-task benchmark
against pinned baseline `8c38faf` lost 3.1 percentage points on mined lexical
Recall@10, reached 40 percent minimum subtask coverage on composite prompts at
2,048 bytes, and slowed 10,000-file `map` and `why` relative to v1.

Plan 0006 Waves 0–1 (V01–V08) repaired the six root defects behind those
regressions: calibrated Tier-1/Tier-2 entity anchors and guarded PRF, default
`!isTestPath` filtering with intent-aware kind priors, per-field BM25F length
normalization (`B_f`), intent-projected composite subtask retrieval, fair
submodular budget accounting with a round-robin subtask floor, and SQLite-native
10,000-file acceleration for `map`, `brief`, and `why`.

The paired Track A qualification report on candidate `0ee65b2` against the same
pinned baseline `8c38faf` (`docs/research/evidence/0006-v2-default-qualification.md`)
cleared every quality and 10,000-file warm latency bar simultaneously:

- **Lexical (30 mined commits):** Recall@10 rose from `0.3136` to `0.3602`
  (`+0.0467`, target `>= 0.350`); MRR rose from `0.4564` to `0.5137`
  (`+0.0573`, target `>= 0.500`).
- **Vocabulary-gap (30 symptom queries):** Recall@10 and MRR both reached
  `1.0000` (vs `0.9667` and `0.9083` in baseline v1, target `1.000`).
- **Composite (30 multi-subtask prompts):** `minSubtaskCoverage@2048` rose from
  `0.0667` to `0.9000` (`+0.8333`, target `>= 0.850`), `@4096` to `0.9333`
  (target `>= 0.850`), and `facetCompleteness@2048` from `0.3467` to `0.9044`
  (target `>= 0.800`) at `budgetFit = 1.000`.
- **Impact & governance (30 tasks):** `recallFull = 1.0000` (vs `0.7500`),
  `hubNoiseRatio = 0.0000` (vs `0.4000`), `governancePrecision = 1.0000`,
  `governanceRecall = 1.0000`.
- **10,000-file warm scale (20 interleaved samples):** `map` p50 `71.75 ms`
  (`<= 80 ms`, `1.53×` faster than v1), `why` p50 `13.66 ms` (`<= 15 ms`,
  `2.20×` faster), `brief` p50 `96.08 ms` (`<= 130 ms`, `4.87×` faster), and
  `prompt-submit` p95 `110.31 ms` (`<= 160 ms`, `4.33×` faster).

## Rulings

1. **Retrieval v2 is the default across ranking, indexing, and brief delivery.**
   `retrievalMode()` defaults to `"v2"`. `simt index`, `simt map`, `simt brief`,
   `simt knowledge rank`, `simt impact`, `simt why`, and opted-in prompt
   delivery (`simt.json` `"brief": {}`) use retrieval v2 without requiring
   `--retrieval v2` or `"brief": { "retrieval": "v2" }`. `simt index` populates
   fielded FTS rows and lexical term statistics by default unless
   `--retrieval v1` is passed. This supersedes ADR-252 ruling 1.

2. **Legacy v1 rollback stays available on the same cache without rebuild.**
   Passing `--retrieval v1` to `simt map`, `simt brief`, `simt knowledge rank`,
   `simt impact`, `simt why`, or `simt index` — or setting
   `"brief": { "retrieval": "v1" }` in `simt.json` — restores legacy v1 ranking
   and packet assembly on the existing SQLite index without deleting or
   downgrading it. Single-clause unconstrained prompts on `simt brief` keep the
   single-task packet path while multi-clause or explicitly constrained prompts
   use composite decomposition.

3. **ADR-252 rulings 2, 3, and 4 remain in force.**
   File coverage remains the default for test selection (`simt gate --changed`,
   `simt tests --run --changed`), with `--precise` opting into symbol hunk
   selection and `--conservative` forcing file closure. Architecture and graph
   structural limits remain repository opt-ins.

## Consequences

- Consumers adopting `simt` receive v2 retrieval, composite multi-task briefs,
  and 10,000-file SQLite acceleration out of the box with no extra manifest or
  CLI flags.
- Any consumer needing the prior v1 behavior can pass `--retrieval v1` or set
  `"brief": { "retrieval": "v1" }` in `simt.json` immediately on the same cache.
- Historical ADR-252 stays intact with ruling 1 marked superseded by ADR-256.

## Rejected

- **Removing `--retrieval v1` on promotion.** Rejected: ADR-252 ruling 4
  guarantees zero-rebuild rollback on the same SQLite cache so repositories can
  isolate or verify any ranking difference without cache churn.
- **Promoting symbol-level test selection to default in `gate`/`tests`.**
  Rejected: conservative file coverage remains the CI safety bar under ADR-252
  ruling 2 until a repository explicitly opts into `--precise`.
