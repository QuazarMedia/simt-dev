# Review 0003 — simt-dev at `9904b69`: what to fix, merge and restructure before plan 0004

Status: open · 2026-10-28
Reviewed at: `9904b69` on `main` (clean, level with `origin/main`), plans 0001–0003 complete (R01–R55 all Complete).
Companion: `docs/plans/0004-knowledge-and-remote-work-intelligence-plan.md`, which this review gates.

**Verdict: do not start W01 yet.** The design holds and the suite is green (1373/1373, twice, from a
clone with no siblings, no flakes). But plan 0004 extends exactly the parts that are weakest today:
the agent policy (W40), leases (W37), the evidence ledger (W28), the index (W12/W18), the bench
(W01–W05) and MCP (W23). Each of those has a correctness bug and a missing seam. Plan 0004 also
adds four new command groups to a CLI with no command spec, a 23 KB help, and 42 top-level
words. Wave 0 and Wave 1 below are the prerequisites; Waves 2–3 can run alongside W01–W05.

**§3 is the only tracker of slice state.** When a row changes state, record the SHA and the exact
test command in it (same convention as review 0002).

## Summary

1. **Security and integrity holes that plan 0004 builds on.** The pre-tool-use policy is a regex:
   `git -C . push`, `sh -c 'git push'`, `git push;echo`, `git commit -n`, `git reset --har` and
   `git -c core.hooksPath=/dev/null commit` are all allowed (Q01). The secret scan returns zero
   findings when `diff.external` is set or a file has `-diff` (Q02). Leases are bypassed from a
   subdirectory and lose claims under concurrency (Q16, Q20). Evidence accepts a passing
   secret-scan as proof that tests passed (Q18).
2. **Wrong answers an agent acts on.** Reindexing a changed file deletes every edge pointing into
   it (Q07). JVM/Python/Go/Rust/C# imports never resolve, so `gate` reports green with nothing
   selected on a 3,457-file Kotlin repo (Q40). `bench variants` locks a winner while ignoring
   cost (Q45). A fresh `init --yes` in a TypeScript repo is red on its own next `check` (Q28).
3. **Release surface is behind.** Homebrew serves 0.4.0; the README pins 0.5.0; ten commands on
   `main` are documented as shipped but are in no release (Q04, Q05).
4. **No single source of truth for what a command is.** Help, completions, MCP schemas and the
   README are four hand-kept copies that already disagree; every flag is accepted by every
   command; MCP `check` returns 3 findings where CLI `check` returns 77 (Q15, Q60–Q66).
5. **Knowledge is in code, not data.** Ecosystems, harnesses, gate names, languages and test
   conventions each live in 4–6 code tables (Q70, Q71). About 30 modules spawn `git` with their
   own wrapper (Q72). Adding a harness or a language touches 4–6 files.
6. **Not ready for a UI or a harness.** Commands print and exit; output state is module-global;
   there is no `exports` map, no event model, no per-run context (Q63, Q67, Q73).

## 1. Scope and method

Read: every module under `src/` (156 modules, 48,359 lines), `bin/`, `rules/`, `templates/`,
`graph/`, `test/` (87 files), `scripts/`, `.github/`, `python/`, `Formula/`, README, AGENTS.md,
CHANGELOG, the four plans, two reviews and the ADR corpus (103 records + index).

Run: mutating commands only in scratch fixtures and copies outside the workspace (TS/pnpm,
Python/uv, Go, 3-package monorepo, docs-only, a copy of simt-dev, a clone of a 3,457-file Kotlin
repo). The estate repositories were not written to. `npm test` ran twice from a sibling-less clone.

| # | Probe | Result | Slice |
| --- | --- | --- | --- |
| 1 | `npm test` from isolated clone, ×2 | 1373/1373 pass, 155–231 s, no flakes, tree clean | Q57, Q92 |
| 2 | `simt --help \| wc -lc` | 320 lines, 23,165 B; `simt brief --help` byte-identical | Q61 |
| 3 | crafted pre-tool-use payloads (40+) | ~25 push/rewrite/hook-disable forms allowed | Q01 |
| 4 | staged AWS key + `diff.external=/usr/bin/true` | 0 findings (1 without) | Q02 |
| 5 | index → edit `src/a.mjs` → commit → index; read `edges` | `[]` — the `test → src` edge is gone | Q07 |
| 6 | 3 concurrent cold `simt index` | all `database is locked`; DB left with no tables | Q08 |
| 7 | `shared install --yes --dry-run` (HOME in scratch) | wrote `~/.config/opencode/AGENTS.md` | Q09 |
| 8 | `why --json --max-bytes 120` | unparseable JSON, exit 0 | Q10 |
| 9 | 12 concurrent `lease … --yes` | 12 printed LEASED, 7 in the file | Q20 |
| 10 | fresh TS `init --yes` then `check` | exit 1, `INERT tsconfig.json` | Q28 |
| 11 | `upgrade` (dry run) inside a scratch repo | targets 17 sibling repos of the real workspace | Q33 |
| 12 | MCP `check` vs CLI `check --json` on the same copy | 3 vs 77 findings | Q15 |
| 13 | `bench variants` fixture: a (R=1, $0.01) vs b (R=1, $5.00) | winner `b`, locked under `--yes` | Q45 |
| 14 | `gate` on a Kotlin type used in 9 files | `{"ok":true,"selected":[]}`; 0 of 22,220 edges resolve | Q40 |
| 15 | `curl` tap formula / `npm view simt-dev` | tap `main` = 0.4.0; npm has `1.0.0` placeholder | Q04, Q06 |

### 1.1 Limits (residual risk)

- Partway through, a harness hook in the review environment refused tool calls for the
  sub-reviews. Rows marked *(code-read)* were established by reading, not by reproduction.
- A follow-up pass over `projection/{targets,shared,conflicts,disclosure,lock,baselines,mdc}`,
  `kernel/{budget,variants,inferability}`, `ci/*`, `commands/{doctor,ignore,ci}`,
  `upgrade/plan.mjs`, `packs.mjs`, `monorepo.mjs`, `toolchain.mjs`, `resolve/{resolve,source,near,body,eval}`
  and `rules/stacks/*` was started and stopped before it reported. Those modules were covered
  only where other slices cross them. Q99 owns that pass.
- `treeId` cost on a 20k-file tree (Q75) and coverage % (Q92) were not measured.

## 2. Vocabulary

- **Severity**: **P0** breaks consumers, is a security hole, or blocks release; **P1** wrong
  behaviour an agent will hit and act on; **P2** misleads, or a maintainability/readiness cost;
  **P3** hygiene.
- **Group**: **F** must fix (bug or broken contract); **S** security; **A** architecture —
  needed so plan 0004, a UI or a harness can be added without rewrites; **C** cleanup/merge
  (remove, demote or fold low-value surface); **D** docs/tests/release.
- **Effort**: S ≤ ½ day, M ≤ 3 days, L > 3 days.
- **State**: Queued, In progress, Complete, Accepted (with the written reason).
- **Compatibility rule for every slice**: nothing an adopted repository runs today may break.
  Spellings written into consumer files — `simt agent-hook <event> --harness`, `simt hooks run
  <event>`, `simt check`, `simt sync --yes`, `simt evidence check`, `simt status --line` — are
  **locked** and stay permanent (hidden) aliases. Renamed flags and commands keep the old spelling
  for at least one minor release with a stderr `note` and a `deprecated` JSON field, never a
  change to stdout text.

## 3. Tracker

| ID | Slice | Sev | Grp | Area | Effort | Depends on | State | SHA / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Wave 0 — security, data loss, release** | | | | | | | | |
| Q01 | Pre-tool-use policy is a regex; ~25 push/rewrite/hook-disable forms pass | P0 | S | agenthooks | M | — | Complete | `a25e168`; ADR-104; `npm test` — 1375/1375, also from a sibling-less copy |
| Q02 | Secret scan blind under `diff.external`, `-diff`, binary; mis-attributes paths | P0 | S | secrets | S | — | Complete | `1190937`; `npm test` — 1376/1376, also from a sibling-less copy |
| Q03 | `simt plugin` packages the consumer's cwd instead of simt | P0 | F | plugins | S | — | Complete | `678ca26`; `node --test test/plugins.test.mjs` — 6/6 + consumer-cwd repro (ships simt-dev runtime, no consumer leak) |
| Q04 | Homebrew tap still serves 0.4.0; release job never lands on tap `main` | P0 | D | release | S | — | Complete | `7ae125e`; `node --test test/packaging.test.mjs` — 15/15 (tap push lands on main + verify job; owner still merges the stale 0.4.0 tap to current) |
| Q05 | README pins 0.5.0; unreleased commands documented as shipped; `main` reports 0.6.2 | P0 | D | docs/release | S | — | Complete | `1c50475`; `node --test test/version-pin.test.mjs` — 7/7 (0.6.1 marked never-published; release cut stays an owner action) |
| Q06 | npm `1.0.0` and `0.0.0-stage` placeholders are live and not deprecated | P1 | D | release | S | — | Complete | `762a599`; `node --test test/packaging.test.mjs` — 16/16 (RELEASING.md records the burn + deprecate commands; `npm deprecate` itself stays an owner action) |
| Q07 | Reindexing a changed file deletes every edge pointing into it | P1 | F | index | S | — | Complete | `ba6767e`; `node --test test/index.test.mjs` — 8/8 (importer owns outgoing edges; removed files still drop dangling incoming) |
| Q08 | Concurrent `index` → `database is locked` and an empty DB | P1 | F | index | S | — | Complete | `1bf064b`; `node --test test/index.test.mjs` — 9/9 (WAL + busy_timeout + cold temp+rename; INDEX_BUSY maps its own remedy) |
| Q09 | `shared install --yes --dry-run` writes into `$HOME` | P1 | F | cli | S | — | Complete | `705018e`; `node --test test/shared.test.mjs` 13/13 + `test/init.test.mjs` 59/59 (dedicated `--yes --dry-run` rehearsal tests; contract matrix covered by the stronger per-command tests) |
| Q10 | `--json --max-bytes` emits invalid JSON with exit 0 | P1 | F | output | S | — | Complete | `91111b0`; `node --test test/unit.test.mjs test/jsoncontract.test.mjs` — 18/18 + review repro parses (ADR-105 amends ADR-070 r5) |
| Q11 | Parse errors and "no command" ignore `--json` | P1 | F | cli | S | — | Complete | `c628655`; unit 15/15 + help/jsoncontract 11/11; review repro answers JSON on stdout with empty stderr |
| Q12 | MCP: an internal error is answered as a parse error with `id:null`; client hangs | P1 | F | mcp | S | — | Complete | `353d5d8`; `node --test test/mcp.test.mjs` — 43/43 (parse and handle fail on separate paths) |
| Q13 | MCP `federation_query` executes commands but is labelled read-only | P1 | S | mcp | S | — | Complete | `abe035b`; `node --test test/federation.test.mjs` 12/12 + `test/mcp.test.mjs` 43/43 (readOnlyHint:false/openWorldHint:true; root fenced to cwd+workspace; user config names servers) |
| Q14 | MCP server memoises the first call's workspace for its lifetime | P1 | F | mcp/graph | S | — | Complete | `1de80cb`; `node --test test/graph.test.mjs` 23/23 + install/compile/brief/resolve 89/89 (memo keyed on flag+env+config inputs) |
| **Wave 1 — wrong behaviour an agent hits** | | | | | | | | |
| Q15 | MCP and CLI answer different questions under the same name | P1 | F | mcp | M | Q60 (full) | Complete | `7cdb883`; `node --test test/mcp.test.mjs test/parity.test.mjs` — 50/50 (parity holds all eight tools) |
| Q16 | Lease policy bypassed via subdir cwd, case, symlink, `NotebookEdit`, `apply_patch` move | P1 | S | agenthooks | S | — | Complete | `bb09b90`; `node --test test/lease.test.mjs test/agenthooks.test.mjs` — 48/48 + full suite 1403/1403 |
| Q17 | `generated` policy blocks edits outside the region | P1 | F | agenthooks | M | — | Complete | `2daabb0`; `node --test test/agenthooks.test.mjs` — 28/28 |
| Q18 | Evidence: any passing command proves "tests pass"; worktree vs index tree; narrow claim regex | P1 | F | ledger | S | Q75 | Complete | `8ca6477`; `node --test test/ledger.test.mjs` — 7/7 |
| Q19 | Machine-local state under `.simt/` changes the evidence tree and gets committed | P1 | F | state | M | — | Complete | `c656113`; `npm test` — 1402/1406 (four failures: the gate-raw, `brief.md` and `ablation.json` expectations still point at the pre-`.simt/local` paths, and deadcode flags nine exports) |
| Q20 | Leases: lost claims under concurrency, no release, session id from env only | P1 | F | lease | M | Q19 | Complete | `8982b72`; `node --test test/lease.test.mjs test/agenthooks.test.mjs` — 42/42 |
| Q21 | Agent-hook command assumes `simt` on PATH; Cursor `failClosed` then blocks everything | P1 | F | agenthooks | S | — | Complete | `588c3e6`; ADR-106; `node --test test/agenthooks.test.mjs` — 30/30 |
| Q22 | Journal/undo: `core.hooksPath` not restored, binary-unsafe, double-write refused | P1 | F | journal | M | Q68 | Complete | `7e11827`; `node --test test/undo.test.mjs test/hooks.test.mjs` — 107/107 |
| Q23 | `slice finish` runs gates twice and commits on any branch | P1 | F | slice | S | — | Complete | `f80f04b`; `node --test test/slice.test.mjs test/ledger.test.mjs test/plan.test.mjs` — 42/42 |
| Q24 | Secret scan false positives (lockfile SRI) and false negatives (`DB_PASSWORD`, unquoted, glpat…) | P1 | F | secrets | S | Q02 | Complete | `c222d9f`; `node --test test/secrets.test.mjs` — 22/22 |
| Q25 | Tracker: `In progress (note)` → state `in`; `plan done` corrupts rows with a pipe | P1 | F | plan | S | — | Complete | b06aca6 · test: node --test test/plan.test.mjs |
| Q26 | `projection.place: "top"` cannot work, yet it is the BEYOND-READ-LIMIT remedy | P1 | F | projection | S | — | Complete | 7223225 · test: node --test test/markers.test.mjs test/init.test.mjs |
| Q27 | `surfaces: []` silently drops every process rule | P1 | F | surfaces | S | — | Complete | e96b539 · test: node --test test/surfaces.test.mjs |
| Q28 | Fresh TS `init --yes` then `check` exits 1 (tsconfig base nothing extends) | P1 | F/C | tsconfig | S | — | Complete | f95481e · test: node --test test/tsconfig.test.mjs |
| Q29 | Lock written outside the plan; `sync` says "nothing written"; `init` never writes it | P1 | F | projection | S | Q68 | Complete | 3c571d7 · test: node --test test/lock.test.mjs |
| Q30 | Init side effects (`.gitignore`, `include.path`) hidden from plan and survive `undo`; pins `surfaces:["opencode"]` | P1 | F | init | S | Q68 | Complete | 150b91e · test: node --test test/identity.test.mjs |
| Q31 | `npm run` in a pnpm repo; CI workflow fails without the devDependency; seeds and card disagree | P1 | F | ecosystem | M | Q70 | Complete | 1b1ebdd · test: node --test test/node-runner.test.mjs test/card.test.mjs test/ci.test.mjs test/hooks.test.mjs test/init.test.mjs test/install.test.mjs test/checks.test.mjs test/project.test.mjs test/compare.test.mjs test/genericity.test.mjs test/shipped.test.mjs test/toolchain.test.mjs |
| Q32 | Shipped rule text: `simt-dev.json`, lost thresholds, `.ts` example in Go, dangling profile refs | P1 | F | content | S | — | Complete | 04ac274 · test: node --test test/checks.test.mjs test/mdc.test.mjs test/genericity.test.mjs test/shipped.test.mjs test/project.test.mjs |
| Q33 | `upgrade` with no args targets the whole heuristic workspace | P1 | F | upgrade | M | — | Complete | e4b5211 · test: node --test test/upgrade.test.mjs |
| Q34 | `rules why --root` replaces shipped decisions with the repo's; no command lists decisions | P1 | F | rules | M | Q55 | Complete | a150aad · test: node --test test/decisions.test.mjs test/decide.test.mjs test/rules.test.mjs test/undo.test.mjs test/shipped.test.mjs test/mcp.test.mjs test/compare.test.mjs test/explain.test.mjs test/checks.test.mjs test/project.test.mjs test/install.test.mjs test/doctor.test.mjs test/help.test.mjs test/skills.test.mjs test/federation.test.mjs test/brief.test.mjs test/contract.test.mjs |
| Q35 | `graph lint`: `ok:true` with errors; spec noise; diamond reported as cycle; crashes on malformed | P1 | F | graph | S | — | Complete | a448bb0 · test: node --test test/graph.test.mjs test/skills.test.mjs test/workspace.test.mjs test/pack.test.mjs test/packcli.test.mjs test/skillsinstall.test.mjs test/surfaces.test.mjs test/jsoncontract.test.mjs test/mcp.test.mjs test/help.test.mjs test/ci.test.mjs test/kernel.test.mjs |
| Q36 | Lessons: `list` writes; `review` re-promotes; O(n²) unlocked store; expiry never read; `**` paths | P1 | F | memory | M | Q73 | Complete | 7de2af6 · test: node --test test/lessons.test.mjs test/diff.test.mjs test/deadcode.test.mjs |
| Q37 | Skills commands cannot name a registry; every body "unavailable" outside the estate | P1 | F | skills | S | — | Complete | `f769cb3`; `node --test test/graph.test.mjs test/help.test.mjs test/completions.test.mjs test/mcp.test.mjs test/parity.test.mjs` — 94/94 + new Q37 precedence test |
| Q38 | `compare` takes 48 s (MCP clients time out at ~60 s); no progress/cancel | P1 | F | compare/mcp | M | — | Queued | |
| Q39 | Non-ASCII paths break `why`/`impact`/`gate` (no `-z`); `tracked()` ×4 | P1 | F | index | S | Q72 | Queued | |
| Q40 | JVM/Python/Go/Rust/C# imports never resolve; `gate` green with nothing (or a nonexistent path) selected | P1 | F | index | M | Q70 | Queued | |
| Q41 | Multi-line JS imports missing; `./x.js` never resolves to `x.ts`; two extractors | P1 | F | index | S | — | Queued | |
| Q42 | A stale index is served with no warning | P1 | F | index | S | — | Queued | |
| Q43 | FTS drops text past 24k chars / 600 tokens and all non-Latin text; `kind`/`ref` searchable; no LIMIT | P1 | F | index | M | Q44 | Queued | |
| Q44 | Index DB has no versioning/migration; read errors look like an empty index | P1 | A | index | M | — | Queued | |
| Q45 | `bench variants` ranks on a NaN cost and locks the winner | P1 | F | bench | S | — | Queued | |
| Q46 | Bench stats: reps paired as independent, missing cost = $0, harness/model pooled, no multiplicity control | P1 | F | bench | M | Q45 | Queued | |
| Q47 | Bench timeouts don't kill grandchildren and aren't recorded; one failure aborts the batch | P1 | F | bench | S | Q72 | Queued | |
| Q48 | Bench corpus not portable; re-mine silently replaces it; Gradle/Maven graders read nothing | P1 | F | bench | M | — | Queued | |
| Q49 | Bench arms measure the wrong thing: `brief` arm, probes, `gold` default, agent can reach the vault | P1 | F | bench | M | — | Queued | |
| Q50 | `compare` learning reads ablation from the wrong path | P1 | F | compare | S | — | Queued | |
| Q51 | zsh completion never completes flags | P1 | F | completions | S | — | Queued | |
| Q52 | Brief/map noise: 47 false "unresolved" commands, false "generated" cautions, `distill` crash, silent no-match | P2 | F | brief | S | — | Queued | |
| Q53 | Git dispatcher/shim robustness: no gate timeout, 8 MB buffer = fail, no `-z`, spaces, no `node` check | P2 | F | hooks | M | — | Queued | |
| Q54 | No runtime Node version check (npm only warns, pip never checks) | P2 | F | bin | S | — | Queued | |
| Q55 | Decisions: duplicate numbers pass, `\d{3}` limit, 4 readers hard-code `docs/decisions`, heuristic parse | P2 | F | decisions | M | — | Complete | 69d9d60 · test: node --test test/decisions.test.mjs test/decide.test.mjs test/rules.test.mjs test/undo.test.mjs test/shipped.test.mjs test/mcp.test.mjs test/compare.test.mjs test/explain.test.mjs test/checks.test.mjs test/project.test.mjs test/install.test.mjs test/doctor.test.mjs |
| Q56 | MCP protocol hardening: id/jsonrpc/args validation, line cap, `skills_show` contract, contradictory instructions | P2 | F | mcp | S | — | Queued | |
| Q57 | Own CI: 32 s from its 5-min timeout; no push trigger; no hook wired; pre-push breaks ADR-031 | P1 | D | ci | S | — | Queued | |
| Q58 | Packs: preview hits the network; symlinks unpinned; argument order inverted | P2 | F | packs | S | — | Queued | |
| Q59 | Small bench bugs: `p2p` prints f2p, probe reps overwrite, regrade inconsistent, stale `.simt-dev` paths | P3 | F | bench | S | — | Queued | |
| **Wave 2 — architecture: one source of truth, ready for plan 0004, a UI and a harness** | | | | | | | | |
| Q60 | Declarative command spec as the single source for dispatch, help, completions, MCP, README, UI | P1 | A | cli | M | — | Queued | |
| Q61 | Tiered, generated help: ≤ 2 KB top level, `help <cmd>`, `-h`, `help --json`; no plan jargon | P1 | A | help | M | Q60 | Queued | |
| Q62 | Per-command flag and positional validation, typed values, repeatable lists, deprecation window | P1 | A | argv | M | Q60 | Queued | |
| Q63 | Core/presentation split: `run(ctx, input) → result`, renderers, no output globals, `exports` + `src/api.mjs` | P1 | A | arch | L | Q60 | Queued | |
| Q64 | Lazy command loading (registry costs 70 ms on every call) | P2 | A | cli | S | Q60 | Queued | |
| Q65 | One JSON envelope, one root resolver, `--max-bytes` applied once, declared `writes` tier | P2 | A | output | M | Q63 | Queued | |
| Q66 | MCP generated from the spec; progress, cancel, subscribe, roots, pagination, two-step writes | P2 | A | mcp | L | Q60, Q63 | Queued | |
| Q67 | Per-run `RepoContext` memo (fingerprint ×11, manifest ×13, digest ×6 per `check`) | P2 | A | projection | M | — | Queued | |
| Q68 | One write-plan/apply engine (change records) for every writer | P2 | A | write | L | — | Queued | |
| Q69 | Manifest schema module: versioned, namespaced (`work`), one loader; lock gets a version | P2 | A | manifest | M | — | Queued | |
| Q70 | Ecosystem/language data records (runner, gates, card, test conventions, extraction, resolution) | P2 | A | genericity | L | Q69 | Queued | |
| Q71 | Harness data records (surface, pointer, loader, hook dialect, payload keys, plugin) | P2 | A | genericity | M | — | Queued | |
| Q72 | Shared utilities: one git/process module, `spawnBounded`, frontmatter, tokenizer, small helpers | P2 | A | sys | M | — | Queued | |
| Q73 | One local-state directory and one append-only event log for ledger/journal/leases/lessons/check | P2 | A | state | M | Q19 | Queued | |
| Q74 | Lease v2: resource kinds, fencing token, renew/release, `LeaseStore` interface (W37 seed) | P2 | A | lease | M | Q20, Q73 | Queued | |
| Q75 | Ledger v2: gate kind, index tree, rotation, fast `treeId` (W28 seed) | P2 | A | ledger | M | Q73 | Queued | |
| Q76 | Index storage v4: generic nodes/edges with ownership, `openIndex()` API, indexes, O(n) PageRank | P2 | A | index | L | Q44 | Queued | |
| Q77 | One `coverage()` and one `governs()` for `tests`/`gate`/`impact`/`brief`/`why` | P2 | A | index | M | Q76 | Queued | |
| Q78 | Bench architecture: arm registry, task schema v2 (stratum/oracle), adapter v2, record v2, report-as-data, stats module | P2 | A | bench | L | Q46, Q47 | Queued | |
| Q79 | Decouple production code from the bench; bench becomes an optional package | P2 | A | bench | L | Q78 | Queued | |
| Q80 | Split modules over the repo's own 1000-line ceiling (src and tests) | P2 | A | structure | M | Q60, Q68 | Queued | |
| **Wave 3 — cleanup, merges, docs, tests** | | | | | | | | |
| Q81 | Command taxonomy: 42 → ~22 top-level words, with aliases | P2 | C | cli | M | Q60, Q62 | Queued | |
| Q82 | `status` becomes the aggregate snapshot; `explain` covers policy ids | P2 | C | cli | S | Q81 | Queued | |
| Q83 | Remove dead code (STEPS map, unreachable entries, double dispatch, unused helpers, dead columns) | P3 | C | cleanup | S | Q60 | Queued | |
| Q84 | Retire or demote low-value features from earlier plans (see table) | P2 | C | cleanup | M | — | Queued | |
| Q85 | Merge the two context meters; merge `review` and `bench critic` into one `critique()` | P2 | C | measure | M | — | Queued | |
| Q86 | Replace ~300 plan-row references in `src/` comments; delete comments that restate code | P3 | C | hygiene | M | — | Queued | |
| Q90 | Scalable docs architecture: short README, generated reference, guides, contributor how-tos, archive | P2 | D | docs | M | Q60 | Queued | |
| Q91 | Doc drift: AGENTS.md, plan/review headers, ADR index, CHANGELOG, SECURITY, repo hygiene | P2 | D | docs | S | — | Queued | |
| Q92 | Tests: shared helpers, `process.execPath`, temp cleanup, tiers, corpus-free fixtures, unit gaps | P2 | D | tests | M | — | Queued | |
| Q93 | npm scripts (`lint` lints nothing), tarball trims | P3 | D | packaging | S | — | Queued | |
| Q99 | Finish the review of the modules listed in §1.1 | P2 | D | review | M | — | Queued | |

Count: 89 slices — 5 P0, 52 P1, 30 P2, 2 P3 (severity is the row's worst item).

Suite state at `7e11827` (2026-10-29): 1416/1421 — five failures, all expectation drift left by
the Q17–Q22 work above: `test/compact.test.mjs:164`, `test/bench.test.mjs:624` and
`:1361` still expect the gate log, `brief.md` and `ablation.json` under `.simt/`, where Q19 moved
them to `.simt/local/`; `test/deadcode.test.mjs:84` flags nine exports with no caller outside
their own file (`touchesRegion`, `generatedFact`, `isTestKind`, `readCandidates` and the five
`*_FILE_LEGACY` constants); `test/rules.test.mjs:246` needs ADR-106 in its S54 list.

## 4. Wave 0 — security, data loss, release

### Q01 — Pre-tool-use policy is a regex (P0, security)
- **Where:** `src/agenthooks/policy.mjs:64` (push), `:72-73` (rewrite); `src/agenthooks/decide.mjs:54-57`.
- **Evidence (VERIFIED, `agent-hook pre-tool-use --harness claude` with crafted payloads):** allowed
  (exit 0): `git -C . push`, `git -c x=y push`, `git --no-pager push`, `/usr/bin/git push`,
  `\git push`, `"git" push`, `sh -c 'git push'`, `` `git push` ``, `$(git push)`, `(git push)`,
  `git push;echo`, `git push&&echo ok`, alias `git p`, `git send-pack`; `git commit -n`,
  `--amen`, `--no-verif`, `git reset --har`, `git reset -q --hard`, `git -C . commit --amend`,
  `git pull --rebase`; with `SIMT_ALLOW=push`: `git push -fu`, `git push origin +main`. Not
  covered at all: `git -c core.hooksPath=/dev/null commit`, `git config core.hooksPath …`,
  `rm -rf .simt-hooks`. False positives: `echo --no-verify`, `grep -r "git rebase" docs`.
- **Fix:** a POSIX shell-word tokenizer (`src/agenthooks/shell.mjs`) handling quotes, `\`,
  `; && || | &`, newlines, `() {}`, backticks, `$()`; descend into `sh|bash|zsh|dash -c`, `eval`,
  `env [VAR=]`, `command`, `exec`, `xargs`, `nice`, `time`, `sudo`. Emit a normalised fact
  `{kind:'git', globals:{C, c[], gitDir}, sub, opts, refspecs}`. Match long options by git's
  unique-prefix rule, expand short clusters, treat `+refspec` as force. New `hooks-disable` policy.
  Resolve aliases with one `git config --get-regexp ^alias\.` only for non-builtin subcommands.
  On tokenizer failure (heredoc, unbalanced quotes) fall back to today's regex so nothing weakens.
  Table-driven test corpus of allowed/denied commands.
- **Compat:** policy ids and messages unchanged. This is W40's normaliser, built now. **Effort:** M.

### Q02 — Secret scan blind spots (P0, security)
- **Where:** `src/secrets.mjs:152-155`.
- **Evidence (VERIFIED):** staged `AKIA…` key → 1 finding; with `diff.external=/usr/bin/true` → 0;
  with `*.env -diff` in `.gitattributes` → 0; binary files never scanned; `diff.mnemonicPrefix`
  attributes to `i/key.env`; non-ASCII names C-quoted.
- **Fix:** `git -c core.quotePath=false diff --cached --no-ext-diff --no-textconv --text --unified=0
  --no-color --src-prefix=a/ --dst-prefix=b/`. Add the two configurations to `test/secrets.test.mjs`.
- **Effort:** S.

### Q03 — `simt plugin` packages the consumer (P0)
- **Where:** `src/plugins.mjs` `packageFiles`/`buildPackage`; `src/commands/plugin.mjs:30`.
- **Evidence (VERIFIED):** in a repo with no `package.json` → `ENOENT …/package.json`; with a consumer
  `package.json` (`9.9.9`, `files:["dist"]`) the plan ships the consumer's `dist` as the runtime.
- **Fix:** read `package.json`/`files` from `PACKAGE_ROOT` (`src/package-version.mjs`); use `root`
  only for `desiredRegion`. Test from an installed copy at a sibling-less path (ADR-031).
- **Effort:** S.

### Q04 — Homebrew tap at 0.4.0 (P0, release)
- **Where:** `.github/workflows/publish-channels.yml:283-308`; `Formula/simt-dev.rb:1-5`; README Homebrew section.
- **Evidence (VERIFIED):** tap `main` formula URL is `simt-dev-0.4.0.tgz` with `depends_on "node"`;
  branches `release/simt-dev-0.5.0` and `release/simt-dev-0.6.2` were pushed and never merged.
- **Fix:** (owner action) merge `release/simt-dev-0.6.2` into the tap. Change the job to push to the
  tap's `main` (or open a PR with auto-merge), and add a final job that fails unless the tap's
  formula version equals the tag. Pick one tap name (`QuazarMedia/tap` vs `QuazarMedia/homebrew-tap`).
- **Effort:** S.

### Q05 — README and version are behind (P0, docs/release)
- **Where:** `README.md:29,34,37,40,71` (0.5.0), `README.md:344-353` ("R46–R55 shipped"), `CHANGELOG.md:7-52` ([Unreleased]), `package.json:3`.
- **Evidence (VERIFIED):** npm `latest` is 0.6.2; `git show v0.6.2:src/commands/index.mjs` has none of
  `explain`, `undo`, `pr-body`, `lease`, `ignore`, `completions`, `slice`. `main` (26 commits
  past the tag) prints `simt-dev 0.6.2`. CHANGELOG lists 0.6.1, which was never published.
- **Fix:** remove literal versions from prose (or test them against `package.json`, extending
  `test/ci.test.mjs:463`); a `since` field per command in the spec (Q60) feeds the reference; cut
  0.7.0; bump to `0.7.0-dev` after each release or append `git describe` when run from a checkout;
  mark 0.6.1 "not published".
- **Effort:** S.

### Q06 — Placeholder npm versions (P1, release)
- **Evidence (VERIFIED):** `npm view simt-dev versions` includes `0.0.0-stage` and `1.0.0` (272 B, no bin).
  `npx simt-dev@1` and any `^1` range install nothing usable; 1.0.0 can never be reused.
- **Fix (owner action):** `npm deprecate simt-dev@1.0.0 "placeholder — use 0.x"` and the same for
  `0.0.0-stage`; record in a `RELEASING.md` (or ADR) that 1.0.0 is burned and the first stable is 1.0.1+.
- **Effort:** S.

### Q07 — Reindex deletes incoming edges (P1, data loss in the index)
- **Where:** `src/index/persist.mjs:58,70` (`delete from edges where src = ? or dst = ?`), `:112` (JSONL backend, same); `src/index/store.mjs:123-155` re-extracts only changed files.
- **Evidence (VERIFIED in this review):** fixture `src/a.mjs` + `test/a.test.mjs` importing it;
  `simt index`; edit and commit `src/a.mjs`; `simt index`; `select * from edges` → `[]`. `simt
  tests` still answers because it re-parses test blobs, which masks the loss; `map`, `brief`,
  `impact` and PageRank read the edges table and lose the links of exactly the files being edited.
- **Fix:** delete only `where src = ?` (an importer owns its outgoing edges); with Q76, store
  `owner_source_id` on each edge and invalidate by owner. Regression test: index → edit → index → edge present.
- **Effort:** S.

### Q08 — Concurrent `index` corrupts the cache (P1)
- **Where:** `src/index/persist.mjs:51-53` (schema outside the transaction, no busy timeout, no WAL); `src/index/store.mjs:111`.
- **Evidence (VERIFIED):** 3 concurrent cold runs → all `ERROR 5 … database is locked`, remedy "run
  this inside a git repository" (wrong); DB left with no tables. The prompt hook, `map`/`tests`
  auto-build and a future UI all race here.
- **Fix:** `PRAGMA journal_mode=WAL`, `busy_timeout=5000`, `BEGIN IMMEDIATE`; build a cold index into
  a temp file and `rename` it in; map `SQLITE_BUSY` to its own message and remedy.
- **Effort:** S.

### Q09 — `shared install --yes --dry-run` writes (P1)
- **Where:** `src/commands/shared.mjs:267` checks `flags.yes` and ignores `--dry-run`; `src/commands/init.mjs:111-113` has another inline copy.
- **Evidence (VERIFIED):** with HOME in scratch, the command created `~/.config/opencode/AGENTS.md` and exited 0 — the S10/ADR-035 defect, back.
- **Fix:** `const mode = writeMode(flags)` in both; add `shared install` to the dry-run matrix in `test/contract.test.mjs`. Q68 makes this structural.
- **Effort:** S.

### Q10 — `--max-bytes` cuts JSON (P1)
- **Where:** `src/output/index.mjs:156-161` (compact JSON has no `\n`, so `lastIndexOf` is -1 and the raw slice is written); ~20 call sites pass `maxBytes` to `emitJson`.
- **Evidence (VERIFIED):** `simt why --json --max-bytes 120` → `…"token":"BASETRUNCATED 1062 bytes omitted`; `JSON.parse` fails; exit 0.
- **Fix:** never cut JSON bytes. Trim arrays to fit and add `truncated:{field, omitted, limit}`, or
  return `{ok:false, error:{code:'MAX_BYTES'}}`. Amend ADR-070 ruling 5. One remedy wording for
  text and JSON. Q65 applies it once in the renderer.
- **Effort:** S–M.

### Q11 — Parse errors ignore `--json` (P1)
- **Where:** `bin/simt.mjs:12-25`; `fail()` inside `src/argv.mjs:224,231,239,245,262` runs before `jsonFailMode()`.
- **Evidence (VERIFIED):** `simt explain drift --json --nonsense` → text on stderr, empty stdout (breaks ADR-070 ruling 4).
- **Fix:** `parse()` returns `{ok:false, message, code}` as data; `bin` sets JSON mode from a raw scan for `--json` before `--`, then renders the failure.
- **Effort:** S.

### Q12 — MCP error path loses the request id (P1)
- **Where:** `src/mcp/server.mjs` `serve()` ≈383-390: `JSON.parse` and `handle()` share one `try`.
- **Evidence (VERIFIED):** a throw inside `tools/list` returned `{"id":null,"error":{"code":-32700,…}}` for request 7; the client waits forever.
- **Fix:** parse in its own `try` (→ -32700, `id:null`); wrap `handle` separately (→ -32603 with the request's id). Test with an injected throwing handler.
- **Effort:** S.

### Q13 — `federation_query` runs commands, labelled read-only (P1, security)
- **Where:** `src/mcp/tools.mjs` ≈950-1000; `describe()` in `server.mjs` ≈300 stamps `readOnlyHint:true` on every tool; `src/federation/config.mjs:71`.
- **Evidence (code-read):** the tool spawns the `command`/`args` declared in `<root>/simt.json`, and
  `root` is a model-supplied argument. A prompt-injected agent can point it at a directory with a
  crafted manifest; the read-only hint invites auto-approval.
- **Fix:** `readOnlyHint:false, openWorldHint:true`; restrict `root` to the server's cwd/workspace
  roots; require the federation server to be named in user-level config, not only repo config.
- **Effort:** S.

### Q14 — MCP workspace memoised (P1)
- **Where:** `src/graph/load.mjs` ≈118-122 (`let workspacePromise`).
- **Evidence (VERIFIED in-process):** `skills_index({workspace: ws})` then `skills_index({})` both return `ws`.
- **Fix:** memoise per resolved-flags key, or pass the resolved workspace from the caller (Q67 `RepoContext`).
- **Effort:** S.

## 5. Wave 1 — wrong behaviour an agent hits

### Q15 — MCP/CLI drift under the same names (P1)
- **Where:** `src/mcp/tools.mjs` (whole file; header ≈8-14 defends building payloads separately), vs `src/commands/sync.mjs:527+`, `doctor.mjs`, `rules.mjs:50-86`, `skills.mjs` ≈305-490.
- **Evidence (VERIFIED):** MCP `check` 3 findings vs CLI 77 (MCP skips manifest, gates, pin, file
  length, lock); MCP `doctor` is a fingerprint only; MCP `rules_list` 20 rules vs CLI 24 (no
  per-surface rules) and `rules_why test-gate` fails; skills payloads disagree in field names
  (`resolved`/`selected`, `reasons`/`why`, `skills` array vs number, `body` path vs text); MCP brief budget hard-coded 20480.
- **Fix now:** extract `checkRepo(ctx)`, `diagnose(ctx)`, `rulesCatalogue(ctx)`, `skillsBrief(ctx)`
  as core functions both surfaces call. **Fix fully:** Q60 + Q66 (MCP generated from the spec).
  Keep old CLI field names for one minor release or bump `schemaVersion`. Parity test: for every
  MCP tool, `tools/call` structured content equals the CLI `--json` result minus the envelope.
- **Effort:** M.
- **Done (Q15):** the four cores live beside their commands — `checkRepo` (`sync.mjs`),
  `diagnose` + `serialisedFindings` (`doctor.mjs`), `rulesCatalogue` + `rulesWhyFacts`
  (`rules.mjs`), `skillsBriefFacts` + `skillsFindFacts` + `skillsShowFacts` + `skillsWhyFacts`
  (`skills.mjs`) — and the eight MCP tools call them. CLI keeps its names and its `--json`
  shapes (purely additive: `adrs`/`optIn` on list entries, `id`/`direction`/`others` on why,
  `summary`/`reason`/`inlineBytes`/`facts`/`bodyText` on skills docs); the tools adopt them
  (`selected`→`resolved`, `notSelected`→`excluded`, `decisions`→`adrs`, `why`→`reasons`/`signals`,
  `readFrom`→`bodyFrom`, `body` path instead of text plus `bodyText`, full catalogue incl.
  per-surface rules, full gate incl. manifest/gates/pin/lock/declared checks, full doctor
  findings). `test/parity.test.mjs` holds all eight to the review's criterion. Q60/Q66 remain.

### Q16 — Lease bypasses (P1, security)
- **Where:** `src/agenthooks/render.mjs:89,92-94,128-131,154,177,208` (root = payload cwd; path keys); `decide.mjs:150`; `src/lease.mjs:62`.
- **Evidence (VERIFIED):** Write to a leased file with `cwd` = a subdirectory → allowed; `NB.ipynb`
  on case-insensitive APFS → allowed; via a symlinked directory → allowed; Claude `NotebookEdit`
  (`notebook_path`) → allowed; Codex `apply_patch` `*** Move to:` → allowed.
- **Fix:** root = `git rev-parse --show-toplevel` from the cwd (fallback: walk up to `.simt`/`simt.json`);
  `realpath` the parent directory; case-fold when `core.ignorecase=true`; per-tool path-key lists in
  harness data (Q71); parse `Move to:`. Shell writes (`>`, `tee`, `sed -i`, `mv`, `cp`, `rm`) come
  from the Q01 tokenizer. Same root for `.gitmodules` detection and `prompt-submit`.
- **Effort:** S (+M for shell writes, with Q01).

### Q17 — `generated` policy blocks repo-owned text (P1)
- **Where:** `src/agenthooks/decide.mjs:100-107,127-137`; `policy.mjs:78-87`.
- **Evidence (VERIFIED):** an `Edit` replacing text *outside* the `simt:begin…simt:end` region of `AGENTS.md` → exit 2.
- **Fix:** Edit/MultiEdit: locate `old_string`; deny only on overlap with the region span. Write:
  deny only if the region bytes change. `apply_patch`: map hunks to line ranges. Keep denying when
  the region is malformed. Reuse the region parser in `src/projection/markers.mjs`.
- **Effort:** M.

### Q18 — Evidence proves the wrong thing (P1)
- **Where:** `src/commands/evidence.mjs:77,82`; `src/ledger/index.mjs:29`; `src/hooks/dispatcher.mjs:216-227`.
- **Evidence (VERIFIED):** test gate failed, `builtin:secret-scan` passed → "All tests pass." with
  `gates.evidence: block` → `supported:true`, exit 0. Claim regex misses "tests passing", "npm test
  passes", "the suite is green". commit-msg compares the worktree tree, so `git add -p` commits can
  be "supported" by bytes not committed *(code-read)*.
- **Fix:** ledger records `gate` and `kind` (test, lint, format, builtin); a test claim needs a
  passing `test`-kind run for the tree and no later failure of the same command; record both
  `worktreeTree` and `indexTree` and match commit-msg on `indexTree`; widen the claim matcher,
  ignore trailers. v1 lines keep today's reading. Lands with Q75.
- **Effort:** S.

### Q19 — Local state pollutes the evidence tree (P1)
- **Where:** `src/ledger/index.mjs:47` (`treeId` excludes only ledger and lessons); `src/journal.mjs:187-192` (only `.simt/journal/` ignored); `src/commands/slice.mjs:82` (worktrees in `.simt/worktrees/`).
- **Evidence (VERIFIED):** `simt check` writes `.simt/check.json` and changes the tree id, so
  `evidence` reports nothing for the tree it just ran on; `leases.json`, `index.sqlite`,
  `brief.md` do the same; a slice worktree is added to the main checkout as an embedded gitlink.
- **Fix:** all machine-local state under `$(git rev-parse --git-common-dir)/simt/` (shared by
  worktrees, never in a tree) or one ignored `.simt/local/`; keep only committed content
  (`packs/`, `bin/`, bench tasks) in `.simt/`; read old paths as a fallback for one release;
  `treeId` excludes the whole local area. Worktrees move out of the tree.
- **Effort:** M. Prerequisite for W28, W37, W39.

### Q20 — Lease concurrency and release (P1)
- **Where:** `src/lease.mjs:106-113`; `src/commands/lease.mjs:34,56-103`; `src/agenthooks/policy.mjs:46,94`.
- **Evidence (VERIFIED):** 12 concurrent claims → 7 stored; `lease x --release` → unknown flag,
  although the denial tells the blocked agent to "ask the holder to release it". Session id comes
  only from `SIMT_SESSION`, which harness hook processes rarely set, so an agent is session `''`
  and is blocked by its own lease *(code-read)*.
- **Fix:** `O_EXCL` lockfile with stale timeout, write tmp+rename, re-read under the lock;
  `lease release`, `lease renew`; session = env, else the adapter's payload `session_id`, recorded
  with the harness name. Schema generalisation is Q74.
- **Effort:** M.

### Q21 — Agent hooks need `simt` on PATH (P1)
- **Where:** `src/agenthooks/render.mjs:62-64` (`simt agent-hook …`), `:351-356` (Cursor `failClosed:true`).
- **Evidence (code-read):** a devDependency install puts `simt` in `node_modules/.bin`, not on a
  harness's PATH. Claude: non-2 exit = silent no enforcement. Cursor: every tool call blocked.
- **Fix:** render a `.simt-hooks/agent-hook` shim with the same `renderLocator` the git shim uses
  (`src/locate.mjs`) and point every harness config at it; keep `failClosed` only with the shim;
  record the trade-off in an ADR.
- **Effort:** S.

### Q22 — Journal and undo gaps (P1)
- **Where:** `src/commands/hooks.mjs:276-312` (config not journaled); `src/journal.mjs:84-89,132-146,279-311`; `src/plan/index.mjs:623`, `slice.mjs:189`, `skillscompile.mjs` ≈101-114, `lessons`, `plugin` write unjournaled.
- **Evidence:** VERIFIED — after `hooks install --yes` then `undo --yes`, `core.hooksPath` still
  points at the removed `.simt-hooks`, so the repo's own hooks stop running. Code-read —
  `beforeBytes` stored as utf8 (binary corrupt), two writes to one path refuse undo, restore runs forward.
- **Fix:** journal entry kinds `file` (base64 bytes + mode) and `git-config` (key, before, after);
  coalesce per path (first before, last after); restore in reverse; write-ahead marker. Every
  writer goes through Q68.
- **Effort:** M.

### Q23 — `slice finish` (P1)
- **Where:** `src/commands/slice.mjs:287,312,44,78-84,188-189`.
- **Evidence (VERIFIED):** the test gate ran twice for one `slice finish --yes` (dispatcher, then
  the commit hook); finish from `main` commits onto `main`. Code-read: `'In progress'` hard-coded
  although the comment says it comes from the template; no abandon; brief written untracked into
  the worktree; no lease taken.
- **Fix:** skip gates that already have a passing ledger entry for the same tree (also the W33
  cache seed); refuse unless `HEAD` is `slice/<id>`; read the "started" state from the template
  (`states[].role: started`); add `slice abandon`; brief outside the tree (Q19); take a
  `slice`-kind lease (Q74).
- **Effort:** S (+M for lifecycle).

### Q24 — Secret scan precision and recall (P1)
- **Where:** `src/secrets.mjs:39-67,119-128`.
- **Evidence (VERIFIED):** `package-lock.json` `"integrity": "sha512-…"` → `high-entropy`, blocking
  every dependency bump; missed: `DB_PASSWORD = "…"` (`\b` after `_`), unquoted `.env`/YAML values,
  `BEGIN ENCRYPTED PRIVATE KEY`, `glpat-`, `https://user:pw@host`, low-entropy AWS secret, any value
  containing "example".
- **Fix:** allow-list `sha(1|256|384|512)-<base64>`; skip lockfiles by default; `gates.secretScan.ignore`
  globs and a `simt:allow-secret` pragma; prefix-aware key names, quoted or unquoted values;
  generic `PRIVATE KEY`, `glpat-`, `npm_`, URL-userinfo patterns; placeholder only when the whole
  value is placeholder-shaped. Corpus test both ways.
- **Effort:** S.

### Q25 — Tracker parser and writer (P1)
- **Where:** `src/plan/template.mjs:293-298`; `src/plan/index.mjs:599-624`.
- **Evidence (VERIFIED):** `In progress (since Monday)` counted as state `in`, dependents blocked;
  `plan done S5 --yes` on a row with a pipe inside a code span wrote "Complete" into the wrong cell.
- **Fix:** strip parenthetical notes (`stripNotes`) and match the longest alias prefix; split cells
  respecting code spans and `\|`; refuse when the cell count differs from `columnCount`; atomic,
  journaled write; preserve CRLF.
- **Effort:** S.

### Q26 — `place: "top"` (P1)
- **Where:** `src/projection/manifest.mjs:729,745-749` (`GENERATED_KEYS` replaces `projection` wholesale); `src/commands/sync.mjs:437-461`; `src/projection/markers.mjs:364`; `project.mjs:631` (the remedy); `project.mjs:97,127` vs `:566` (`regionOpts` from package dir vs repo root).
- **Evidence (VERIFIED):** set `place:"top"` → `check` reports `STALE-GENERATED-FIELD`; `sync --yes`
  deletes the key and leaves the region at the bottom.
- **Fix:** merge sub-keys in `withGenerated` and compare only `simtDevSha`/`version` (or move `place`
  to a repo-owned key, Q69); when `top`, "region is not first" is drift; pass the repo root to `regionOpts`.
- **Effort:** S.

### Q27 — `surfaces: []` (P1)
- **Where:** `src/projection/surfaces.mjs:334-336`; documented meaning at `manifest.mjs:482-487`.
- **Evidence (VERIFIED):** `AGENTS.md 11619 → 4488` bytes, 0 `Process:` sections, `check` CURRENT.
- **Fix:** `foldsRules` is true when no selected surface has a `rule` path.
- **Effort:** S.

### Q28 — Fresh TS adoption is red (P1, also cleanup)
- **Where:** `src/commands/init.mjs:122,458-463` creates `tsconfig.base.json`; `checkTsconfig` (`project.mjs:219`) raises blocking `inert`.
- **Evidence (VERIFIED):** `init --yes` → `check` exit 1, `INERT tsconfig.json … does not extend`.
- **Fix:** stop creating the base file for fresh adoptions (Q84); keep the strictness checks as
  non-blocking findings; existing base files stay repo-owned. Test: fresh init → check exit 0 for
  every fixture ecosystem.
- **Effort:** S.

### Q29 — The lock is outside the plan (P1)
- **Where:** `src/commands/sync.mjs:315-326,387,404`; `init.mjs` (no lock write).
- **Evidence (VERIFIED):** after `rm simt-dev.lock.json`, `sync --yes` prints `wrote simt-dev.lock.json`
  then `already current; nothing written`; preview shows nothing; `check --frozen` after `init` → `LOCK-ABSENT`.
- **Fix:** the lock is a target produced by `plan()`; preview, `--diff`, journal, idle test and init inherit it (Q68).
- **Effort:** S.

### Q30 — Init side effects and pinned surfaces (P1)
- **Where:** `src/commands/init.mjs:108,129,411-423`; `src/identity.mjs:172,187-205`; `manifest.mjs:867`.
- **Evidence (VERIFIED):** dry run says `created git.config` and omits the `.gitignore` edit and
  `include.path`; `init --yes; undo --yes` leaves `?? .gitignore` and `include.path` pointing at a
  deleted file. Every fresh manifest gets `"surfaces": ["opencode"]`, freezing today's default.
- **Fix:** plan rows (action `create`) for the `.gitignore` edit and `include.path`; journal both
  (`git-config` kind, Q22); write `surfaces` only when `--surfaces` was passed or the key exists.
- **Effort:** S.

### Q31 — Package manager and runner (P1)
- **Where:** `src/kernel/card.mjs:117,157,161`; `src/projection/manifest.mjs:83-192,240,293-324`; `src/resolve/fingerprint.mjs:153-167`; `src/ci/workflow.mjs`.
- **Evidence (VERIFIED):** `packageManager: pnpm@9` → card says `npm run test`; generated CI looks for
  `node_modules/simt-dev`, which init never adds, and installs with `npm ci` → fails on the first
  PR; docs-only and Go-without-go fixtures get remedies proposing npm/prettier gates; a uv repo gets
  no seeded gates while the card says `uv run -m pytest` — two tables, two answers. Dead
  `remedy='…'` assignment in the rendered shell.
- **Fix:** facts `has-pnpm-lock`, `has-yarn-lock`, `has-bun-lock`; read `packageManager`; one runner
  resolver fed by the ecosystem records (Q70) that the card, gate seeds, remedies and CI install
  step all consume. Init's plan row states "needs `<pm> add -D simt-dev`"; `check` reports when the
  workflow exists and no resolution path can succeed. Missing tool → remedy "install X, then `simt init --yes`".
- **Effort:** M.

### Q32 — Shipped rule text (P1, content)
- **Where:** `rules/core.md:49,62-63`; `rules/stacks/node.md:46`, `python.md:33`, `connectiq.md:29`; `src/kernel/checks.mjs:76`; `rules/mdc/test-gate.mdc:7-12`; stack profile cross-refs.
- **Evidence (VERIFIED on rendered regions):** "declared per repo in `simt-dev.json`" (the file is
  `simt.json`); `Enforced: max-file-lines` replaces the 400/1000 thresholds and the exemption with a
  checker id; Go region shows `path/to/the.changed.test.ts`; a region without uv says "See the `uv`
  profile"; "Applies to: `has-go-mod`" leaks internal vocabulary.
- **Fix:** `{manifest}` render token + genericity assertion; each checker supplies a one-line human
  summary ("Enforced by `simt check`: >400 lines warns, >1000 fails (`limits.fileLines`)");
  substitution defaults may read card/ecosystem values; cross-references as `simt rules show <id>`;
  lint for referenced-but-not-co-selected profiles. Per AGENTS.md this changes shipped text and
  the digest: state it as a breaking change and expect one drift per repo.
- **Effort:** S.

### Q33 — `upgrade` scope (P1, safety)
- **Where:** `src/commands/upgrade.mjs:44-56` (`--all` validated, never selects); `src/workspace.mjs:268-280`.
- **Evidence (VERIFIED, dry run):** inside a scratch repo it planned 16 sibling repos of the real workspace; `--yes` would write them.
- **Fix:** default scope = the enclosing adopted repo; workspace needs `--all` or an explicit
  workspace root; one-release note when the old default would have differed.
- **Effort:** M.

### Q34 — Decisions namespaces (P1)
- **Where:** `src/commands/rules.mjs:217-234`.
- **Evidence (VERIFIED):** in a consumer with its own ADR-001/002, `rules why core --root .` reports
  core as "settled by ADR-001 First thing" and ADR-003…009 MISSING; `rules why ADR-050` → "no
  decision record", remedy `simt rules list`, which lists no ADRs.
- **Fix:** shipped rules resolve against the package's decisions; repo records are an overlay with
  `origin: repo|package`; add `simt rules decisions` (or `decide list`) backed by the Q55 index and
  point remedies at it.
- **Effort:** M.

### Q35 — `graph lint` (P1)
- **Where:** `src/commands/graph.mjs:32-38,46`; `src/graph/load.mjs` ≈279, ≈345, `checkRequires` ≈418-437, ≈637.
- **Evidence (VERIFIED):** `--json` → `ok:true`, exit 0 with 2 errors (text: `FAIL 2`, exit 4); the
  spec pass runs without `--spec` (37 warnings on the real registry, payload says `spec:null`);
  diamond a→{b,c}→d reported as `cycle a -> b -> c -> d -> d`; missing `capabilities` → `not iterable` crash.
- **Fix:** recompute `ok` after merging spec results; spec pass only with `--spec` and when
  `verified`; DFS with a recursion stack; `?? []` guards and early return after shape errors;
  remove the no-op `files === 1 ? '' : ''`.
- **Effort:** S.

### Q36 — Lessons store (P1)
- **Where:** `src/commands/lessons.mjs:25-26`; `src/memory/lessons.mjs:29,171-234,488,547,621-640`; `src/commands/agenthook.mjs:118-132`.
- **Evidence (VERIFIED):** `lessons --json` creates `.simt/lessons.jsonl`; three `lessons review --yes`
  without id produce 0001/0002/0003 from one candidate; 23 lines accumulated in a never-adopted
  repo from hook denials. Code-read: each append reads and rewrites the file (O(n²)), ids are
  `c-${length+1}` (duplicates under concurrency or a bad line), `simt-expires` written but never
  read, path-less candidates promoted with `paths:['**']`, raw commands (possibly tokens) stored,
  revert `fixDiff` unbounded.
- **Fix:** explicit `lessons capture`; `list` and preview pure; "nothing to promote" when empty;
  append with `O_APPEND` to the Q73 event log, content-hash/ULID ids, cap `fixDiff`, redact with
  `scanText`; filter by `expires` in list/recall/why/hook; default expiry relative to promotion;
  no `**` default; hook capture only when the repo is adopted; journal promotions.
- **Effort:** M. Prerequisite for W43.

### Q37 — Skills registry location (P1)
- **Where:** every `skills *` command calls `loadRegistry(null, flags)`.
- **Evidence (VERIFIED):** the shipped registry's sources are `repo-02…repo-07`; outside that estate
  `verified:false` and all 38 bodies are "(body unavailable …)"; the error says "name it
  explicitly" but no flag exists.
- **Fix:** `--registry <path>` and `SIMT_REGISTRY` on every skills command and the MCP `registry`
  argument; resolution order documented in `simt help skills`.
- **Effort:** S.

### Q38 — `compare` latency (P1)
- **Evidence (VERIFIED):** 48,256 ms over MCP for 17 repos; `pr_body` 1,273 ms, `check` 854 ms, `resources/list` 771 ms. `compare` also loads every bench run and bootstraps 1,000 samples per ablated arm per repo (`src/compare/learn.mjs:182-189,416-420`).
- **Fix:** rows built in parallel with a concurrency cap; cache learning by record digest; MCP
  `progressToken` → `notifications/progress`, honour `notifications/cancelled`, `limit`/`cursor`.
- **Effort:** M.

### Q39 — Non-ASCII paths (P1)
- **Where:** `src/commands/gate.mjs:130-159`, `impact.mjs:192-205`, `why.mjs:68-81`, `src/kernel/checks.mjs:326` (four `tracked()` copies, none with `-z`); the index itself uses `-z` (`store.mjs:402`).
- **Evidence (VERIFIED):** `simt impact 'src/ünï.mjs'` → "not a file or an export"; `simt why` → "not in the tree".
- **Fix:** one `trackedPaths(root)` with `-z` in the Q72 git module, or read paths from the index; `git diff --name-only -z`.
- **Effort:** S.

### Q40 — Imports outside JS/TS never resolve; empty gate is green (P1)
- **Where:** `src/index/extract.mjs:69-71,186-317`; `src/commands/gate.mjs:32-54`.
- **Evidence (VERIFIED):** on a 3,457-file Kotlin repo 0 of 22,220 edges point at a tracked file;
  `impact` lists no importers for a type used in 9 files; `tests` finds 0 of 325 Kotlin tests;
  `gate` → `{"ok":true,"selected":[],"code":0}`; `gate no/such/file.mjs` → same, exit 0.
- **Fix:** a resolve pass after extraction with one strategy per language (JVM `package`+type →
  path; Python module under source roots; Go `go.mod` prefix; Rust `crate::`/`mod`; C# namespace),
  declared in the language records (Q70); unresolved specs kept as `dst_key` (Q76). `gate`:
  nonexistent untracked path → usage error; add `unmatched:[…]`, `graph:'unresolved'` when a
  language has zero resolved edges, `verdict:'nothing-selected'`; leave `ok` as is until W27's opt-in.
- **Effort:** M.

### Q41 — JS/TS import extraction (P1)
- **Where:** `src/index/extract.mjs:75-81,149-156`; `src/index/tests.mjs:63-92` (`scriptSpecifiers`, the better parser, used only by tests/gate/impact).
- **Evidence (VERIFIED):** no edge `store.mjs → persist.mjs` (its import spans lines 15-27); `./b.js` stored raw although `src/b.ts` exists.
- **Fix:** use `scriptSpecifiers` in `extract.script` and delete the second path; try extension swaps (`.js→.ts/.tsx`, `.mjs→.mts`, `.cjs→.cts`).
- **Effort:** S.

### Q42 — Stale index served (P1)
- **Where:** `src/commands/map.mjs:102-126` (`loadGraph` rebuilds only when empty); `src/commands/tests.mjs:85-102`.
- **Evidence (VERIFIED):** after `git rm docs/de.md` + commit, `map` and `brief` still rank it first.
- **Fix:** store a digest of `git ls-files -s` (or `git write-tree`) in `meta`; on load compare, then
  rebuild incrementally (~100 ms) or return `stale:true` plus a CAUTION. Gives a UI its freshness signal.
- **Effort:** S–M.

### Q43 — Full-text indexing loses content (P1)
- **Where:** `src/index/store.mjs:60-83` (24,000-char cap :70, ASCII regex :72, 600-token cap :79), query side `store.mjs:94-103`, `map.mjs:558-565`, `resolve/resolve.mjs:67-72`; `persist.mjs:18` (`fts5(kind, ref, body)`).
- **Evidence (VERIFIED):** a term past the cap → no match; Japanese doc stored as `"docs jp md"`;
  German `Straße` → `stra`. Code-read: `kind`/`ref` are searchable, so "docs"/"skills"/"lessons"
  matches every row of that kind; path tokens double-counted; no LIMIT (657 hits on one repo);
  the JSONL backend scores differently.
- **Fix:** index whole documents chunked into sections (the W12 seam); one Unicode tokenizer
  (`\p{L}\p{N}`, NFKC) shared everywhere (Q72); FTS5 `unicode61 remove_diacritics 2` + a trigram
  table for CJK; `fts5(body, kind UNINDEXED, ref UNINDEXED)`; `LIMIT 200`; record skipped binaries.
- **Effort:** M.

### Q44 — Index schema versioning (P1, architecture)
- **Where:** `src/index/persist.mjs:12-21` (`SCHEMA_V='3'` + `create table if not exists`), `:196-199` (every SQLite error → `[]`); `store.mjs:115-119,240-284`.
- **Evidence (code-read):** a column cannot be added; an older simt meeting a newer DB rewrites it
  and two pinned versions flip-flop (ADR-059); "locked", "no such column" and "corrupt" all look
  like "no results".
- **Fix:** `PRAGMA user_version` with an ordered migration list; any mismatch rebuilds (it is a
  cache), a newer version is never overwritten (open `index.v<N>.sqlite` alongside); readers return
  `{rows, error}`. Must land before W18.
- **Effort:** M.

### Q45 — `bench variants` cost is NaN (P1)
- **Where:** `src/bench/variants.mjs:165,381-422,438-440` sums `x.costUsd`; `evaluateRunRecord` (`report.mjs:211-227`) returns `C`.
- **Evidence (VERIFIED):** a (R=1, $0.01) vs b (R=1, $5.00) → winner `b`, written to the lock under `--yes`.
- **Fix:** use the shared per-task aggregation (`collapseArmByTask`); lock only when significant
  and non-inferior; never lock from a built-in (`gold`/`noop`) harness.
- **Effort:** S.

### Q46 — Bench statistics (P1)
- **Where:** `src/bench/report.mjs:155,265-266,370,591-608,661,840-845`; `run.mjs:119-124,195`; `ablate.mjs:344-351,472-501`; `variants.mjs:303`; `compare/learn.mjs:356-364`.
- **Evidence (VERIFIED):** 1 task × 10 reps → `pairedRuns 10, mcnemar p 0.00195`; a claude run with
  usage but no prices → `C $0.0000 | CPI $0.0000`; gold+noop runs of `current` pooled into one arm
  (`50.0%`). Code-read: ablation tests ~N sections at α 0.05 with no correction; CPI CIs drop
  undefined resamples.
- **Fix:** pair at task level only (sign/permutation on task-mean R, Wilcoxon on task-mean C),
  task- and repo-clustered bootstrap, "insufficient tasks" when n is small; `costUsd:null` +
  `costSource: reported|priced|missing`, arm C null when any cost is missing, CPI = Σcost /
  resolved, null when undefined; group by (harness, model, arm, experiment) and refuse
  cross-group compares unless asked; Holm/BH correction; one-sided non-inferiority bound
  (ΔR > −2 pp) and an `inconclusive` verdict (plan 0004 §1). Keep reading v1 records.
- **Effort:** M.

### Q47 — Bench process control (P1)
- **Where:** `src/bench/run.mjs:56-98,674-677,687-701,805-876`; `grade.mjs:20-62`; the correct pattern is `mine.mjs:495-536`.
- **Evidence (VERIFIED):** adapter `sh -c "(sleep 15 &); sleep 60"` with `timeoutMs: 2000` ran 62.6 s and
  was graded normally; with the vault missing, one failure exits 3 and leaves a half-written run.
  Code-read: `finally` deletes `parentDir` while other workers may still use it.
- **Fix:** one `spawnBounded` (detached, kill the process group, destroy streams) in Q72, used by
  run, grade, probes, critic, federation; record `agent:{exitCode, timedOut, wallMs}`; per-run
  catch writes `status:"error"`; settle all before cleanup; report counts errors as exclusions.
- **Effort:** S.

### Q48 — Bench corpus (P1)
- **Where:** `src/bench/mine.mjs:343-374,391-409,473-475,562-565,638-639,678,688,763-771`; `grade.mjs:194-197`.
- **Evidence (VERIFIED):** the 20 committed tasks fail from any clone (`ENOENT …/vault/repo-ca1b5891/…/gold.patch`,
  vault keyed on the absolute path); `mineTasks(target 3)` deleted all 20 and wrote 3 others;
  Gradle (`reportDir`) and Maven (nothing) graders never read results. Code-read: 7-char ids with a
  fixed `-01` can collide; `test/pack.test.mjs` excluded by name; 5 s per-test timeout under 4-way
  concurrency makes validity load-dependent; jest and the `test` script are ignored.
- **Fix:** vault key = stable repo identity (root commit or remote) + task id; record
  `corpus:{minedFrom, target, simtVersion}`; append-only unless `--replace`; sealed `bench
  export/import`; parse every JUnit XML under `build/test-results/test/` and `target/surefire-reports/`;
  12-char ids with collision check; `bench.mine.{exclude, timeoutMs}` config; runner from the
  repo's declared test command.
- **Effort:** M. W01/W02 depend on it.

### Q49 — Bench arms and isolation (P1)
- **Where:** `src/bench/run.mjs:48-54,474-481`; `probes.mjs:1248-1263`; `commands/bench.mjs:260,366`; `ablate.mjs:384-390`; `mine.mjs:391-402,473-475`.
- **Evidence:** VERIFIED — the `brief` arm reads `registry.skills` (the skills are at
  `.registry.skills`): 38 skills, "(none matched)"; it re-implements the brief instead of calling
  `assembleBrief`. Code-read — probes never run an agent (gold scripts comply, violator/noop
  scripts violate), so per-arm compliance is constant; `ablate`/`variants` default to `gold`, which
  applies the patch regardless of rules, yet results are labelled measured; the full environment
  (incl. `SIMT_DEV_VAULT_DIR`, HOME, credentials) reaches the agent and the vault path is
  deterministic; the prompt is the full commit body, which often narrates the fix.
- **Fix:** call `assembleBrief` and deliver via an adapter placeholder or prompt prefix; route
  non-built-in harnesses through `executeAdapter` in probes and label built-ins "grader
  calibration"; built-in harnesses produce `measured:false`; `--yes` requires an explicit
  `--harness`; per-adapter env allowlist, HOME = slot, vault 0700, `isolation: none|env|sandbox`
  recorded (W05); subject-only or curated prompts.
- **Effort:** M.

### Q50 — `compare` reads the wrong ablation path (P1)
- **Where:** `src/compare/learn.mjs:26,165-200`; `ablate.mjs:173-203,619`.
- **Evidence (code-read):** reads `.simt/ablation.json`, written at `.simt/bench/ablation.json`; third copy of arm-name parsing and of `DEL_R_TOLERANCE`; ADR drafts cite `rules/core.md`, a path that only exists in simt-dev.
- **Fix:** import `parseAblationArmName` and the constant; fix the path; `affects` as section ids.
- **Effort:** S.

### Q51 — zsh completion (P1 for zsh users)
- **Where:** `src/completions.mjs:127` (`local cur prev` never assigned).
- **Evidence (VERIFIED under `zsh -f` with stubbed `compadd`):** `simt --pre<TAB>` offers commands; `simt skills --root <TAB>` offers subcommands instead of files. bash is correct.
- **Fix:** assign `cur=${words[CURRENT]} prev=${words[CURRENT-1]}` (or `_arguments`); per-command flags and enum values from the spec (Q60); test that sources the script under `zsh -f`.
- **Effort:** S.

### Q52 — Brief and map noise (P2)
- **Where:** `src/brief/assemble.mjs:74-100,228-232`; `src/commands/distill.mjs:30`; `distill/distill.mjs:66,101,192-204`; `map.mjs:156,175-177`.
- **Evidence (VERIFIED):** brief CAUTION lists ~47 "unresolved" tokens including `simt init`
  (command-card strings passed where `why` passes registry names); "generated" caution on any file
  mentioning `simt:begin` (`git grep -lF`); `distill` with a cached unverified proposal → `Cannot
  read properties of undefined (reading 'map')`; `map --task zebracorn` returns the graph hub with no signal.
- **Fix:** pass registry command names; match a real begin/end pair at line start (record at index
  time); `result.faults ?? []` and store faults in the proposal; `matched:0, basis:'graph-only'`
  plus a brief CAUTION.
- **Effort:** S.

### Q53 — Git hook robustness (P2)
- **Where:** `src/hooks/dispatcher.mjs:303,306,381,385,405,422,433`; `src/locate.mjs:42-48,66-68`; `src/commands/agenthook.mjs:77` vs `:88`; `src/agenthooks/prompt.mjs`.
- **Evidence (code-read):** no per-gate timeout (a hung test blocks the commit forever); `maxBuffer`
  8 MB — a passing gate that prints more is reported failed; `--name-only` without `-z`; gates run
  on the worktree, not the staged tree; `SIMT_DEV_BIN` with a space refused; `exec node` without a
  `command -v node` check (GUI clients with nvm → 127, no remedy); `prompt-submit` ignores `--root`.
- **Fix:** `-z`; `gates.timeout`; bounded tail buffer instead of failing on size; opt-in
  staged-tree mode (checkout-index into a temp dir); allow spaces; node check with a remedy; pass
  `flags.root` through (shares Q16's root resolver).
- **Effort:** M.

### Q54 — Runtime Node check (P2)
- **Where:** `bin/simt.mjs` (static imports, no `process.versions` check); `python/simt_dev/cli.py:109-152`.
- **Fix:** a tiny bootstrap in `bin/` that checks `>= 22.20.0` and then dynamically imports the CLI
  (fits Q64); the same check in the Python launcher. *(Not verified: no older Node available.)*
- **Effort:** S.

### Q55 — Decisions index (P2)
- **Where:** `src/decisions/index.mjs:28,87,249,340-470,545,580,600`; `src/memory/decide.mjs:44,230,341,420,455`; `src/commands/why.mjs:83-100`; `src/prbody.mjs:27`; `rules.mjs:222`; `sync.mjs:598`; `resolve/fingerprint.mjs:150`; `docs/decisions/README.md`.
- **Evidence:** VERIFIED — two `ADR-002-*.md` pass `decide --check` and `loadDecisions`, `byId` keeps one;
  97 of 103 records have no frontmatter; every call re-parses all records (`rules_why` 44 ms; part of
  `resources/list` 771 ms); four supersessions recorded only on one side, index row for ADR-058
  says "accepted" while `rules why` says narrowed/superseded. Code-read — `\bADR-(\d{3})\b`, lexical
  sort, `repo-\d{2}`; `ESTATE`/`ESTATE_NAME` same regex twice; `VERB` a hand list missing
  `pack`, `decide`, `plugin`, `lease`; `lintDecision` hard-codes `num <= 96`; detection knows
  `docs/adr`, `docs/adrs`, `adr` but every reader hard-codes `docs/decisions`.
- **Fix:** one `decisionsDir(root)` (manifest key, fallback to detection) and one loader; lint
  duplicate ids; create with `O_EXCL` and retry the next number; `\d{3,}` + numeric sort; merge the
  regexes; derive `VERB` from the command spec; `decide` scaffold writes `simt-rulings`/`status`
  frontmatter and the cutoff lives in config, not `96`; cache `decisions.index.json` keyed on
  name/size/mtime; generate `docs/decisions/index.md` with a computed status column and backfill
  `simt-supersedes` (Q91).
- **Effort:** M.

### Q56 — MCP protocol hardening (P2)
- **Where:** `src/mcp/server.mjs` (`INSTRUCTIONS` ≈262, `contentOf` ≈340); `tools.mjs` ≈520-555; `prompts.mjs` `SIMT_BRIEF`.
- **Evidence (VERIFIED):** object `id` accepted and echoed; messages without `jsonrpc:"2.0"` accepted;
  a 40 MB line buffered (RSS 274 MB); arguments never checked against `inputSchema` although
  `schema.mjs` exists; non-standard `bytes` field; `remedy:null` on many errors; `skills_show`
  returns `body:"(body unavailable …)"` where the schema says null, and `maxBytes` truncates only
  the text block; instructions name the CLI command `simt skills brief` as "the one to call
  first", the tool says it is THE entry point, the prompt says `brief` is, and `brief` fails cold.
- **Fix:** validate `id`, `jsonrpc` and arguments with `check()` → -32602; cap line size; `body:null`
  + `reason`, truncate structured content too with `truncated`; one entry point named by tool name,
  `brief` falls back to `skills_brief` when the index is cold.
- **Effort:** S.

### Q57 — simt-dev's own CI and hooks (P1, release)
- **Where:** `.github/workflows/simt-dev-check.yml:28-29,49`; `src/ci/workflow.mjs:209`; `.githooks/pre-push:31,37`; local `core.hooksPath`.
- **Evidence (VERIFIED):** macOS job 4 min 28 s against `timeout-minutes: 5`; gate triggers on
  `pull_request` only while `main` receives direct merges; `core.hooksPath=.simt-hooks` which does
  not exist, so `.githooks/pre-push` never runs; the hook runs the suite in the checkout (with
  siblings), discards output, and runs `shipped.test.mjs` twice.
- **Fix:** timeout 15 min and shard (`--test-shard`) or tier (Q92); add `push: branches:[main]` or
  branch protection; `CONTRIBUTING.md` with `git config core.hooksPath .githooks`; the hook clones
  into a temp dir, runs there, prints the log tail on failure; drop the duplicate run.
- **Effort:** S.

### Q58 — Packs (P2)
- **Where:** `src/commands/pack.mjs:44`; `src/packs/manage.mjs`; `src/packs.mjs`.
- **Evidence (VERIFIED):** no sibling repo uses packs. Code-read: `pack publish` without `--yes` runs
  `npm view` (network in a preview); `packDigest` skips symlinks while the loader follows them (a
  symlinked rule is projected unpinned); `--root` checked before the positional, contrary to its comment.
- **Fix:** offline preview; hash or reject symlinks; fix the argument order; mark the group
  experimental and freeze features (Q84).
- **Effort:** S.

### Q59 — Small bench bugs (P3)
- `commands/bench.mjs:67` prints `p2p=${task.f2p.length}` → `task.p2p.length`.
- `probes.mjs:1301-1313`: results keyed by probe overwrite across reps; stored records not filtered by harness.
- `run.mjs:664` vs `:975`: regrade uses `git apply --binary`, gold uses plain `apply`, and regrade compares only resolved/gates/diff counts — align both and compare the f2p set.
- `report.mjs:3-4,70,700`, probes header: `.simt-dev/…` paths; `grade.mjs:139-151` comment/code mismatch; `mine.mjs:688` literal `.simt` instead of `STATE_DIR`; `measure/session.mjs:57,64` literal `simt tokens` instead of `CLI`.
- **Effort:** S.

## 6. Wave 2 — architecture

### Q60 — Declarative command spec (P1, the root of ~20 other findings)
- **Where:** `src/commands/index.mjs:87-224` (GROUPS, IMPLEMENTED, empty STEPS), `src/commands/help.mjs:7-311` (hand-written template), `src/argv.mjs:28-194` (one global flag table, 60+ flags), `src/completions.mjs:27-31` ("flags are global"), `src/mcp/tools.mjs:453-1002` (hand-written schemas), `README.md:85-165`.
- **Evidence (VERIFIED):** four copies of the command list already disagree: README lacks
  `bench critic`, `ci`, `plugin`; help lists 7 `--reader` values (binary knows 8) and 4 harnesses
  (binary accepts 5); `--version` is described as printing the SHA, it does not.
- **Fix:** `src/commands/spec.mjs`, one entry per path:
  ```js
  { path: 'status', summary: 'gate state from the last check', group: 'repo',
    tier: 'core'|'advanced'|'internal', stability: 'stable'|'experimental'|'deprecated',
    since: '0.7.0', writes: 'none'|'state'|'repo'|'home'|'remote', json: true,
    mcp: 'status' | null, args: [{ name: 'path', arity: '?' }],
    flags: { line: { type: 'bool', help: '…' } }, aliases: [], locked: false,
    exitCodes: {}, load: () => import('./status.mjs').then(m => m.statusCommand) }
  ```
  Global flags (`json`, `pretty`, `root`, `max-bytes`, `help`, `version`) declared once; `yes`,
  `dry-run`, `diff` added automatically when `writes !== 'none'`. Generated from it: `GROUPS`,
  `COMMANDS`, dispatch, help (Q61), flag validation (Q62), completions, MCP `inputSchema` (Q66),
  README/`docs/commands` (Q90), `simt help --json` for a UI or harness. `test/help.test.mjs`'s
  both-directions assertion moves onto the spec. A plan 0004 group (`work`, `knowledge`,
  `verify`, `action`) becomes spec rows plus modules — no edits to dispatch, help or completions.
- **Compat:** no behaviour change on its own; introduced first with a test that the spec equals today's registry.
- **Effort:** M.

### Q61 — Tiered, generated help (P1)
- **Evidence (VERIFIED):** `simt --help` 320 lines / 23,165 B (~6k tokens per ask);
  `simt help explain`, `simt explain --help`, `simt skills --help` all print all of it; `simt -h` →
  `unknown command '-h'`; ten lines exceed 80 columns; help cites "R02 transcripts", "(R25)",
  "Appendix A", ADR numbers — plan vocabulary a consumer cannot resolve (`AGENTS.md:14`).
- **Fix:**
  - `simt --help`: one line per `core`-tier command, grouped, ≤ 2 KB, enforced by a byte test; footer `simt help <command>` and `simt help --all`.
  - `simt help <group|cmd>` and `<cmd> --help`: usage, args, flags, `writes`, one example, ≤ 1.5 KB.
  - `simt help --all` adds advanced/internal tiers; `simt help --json` emits the spec; `-h` alias.
  - Enumerations generated from data (`adapters()`, loader table, `PLUGIN_KINDS`).
  - Test banning `\bR\d{2}\b|plan 000\d|Appendix` in help and remedy strings (extend `shipped.test.mjs`).
- **Effort:** M.

### Q62 — Per-command argument validation (P1)
- **Where:** `src/argv.mjs:28-179,255-258`; `flags.root ?? positional[0]` in `agenthook.mjs:140`, `ci.mjs:46`, `bench.mjs:23,83,210,258,309,360,407`, `doctor.mjs:228`, `hooks.mjs:37`, `local.mjs:58`, `init.mjs:58`, `pack.mjs:45`, `sync.mjs:107,527`, `status.mjs:18`, `upgrade.mjs:42`, `undo.mjs:21`.
- **Evidence (VERIFIED):** `status --line --frozen --cochange --labels x` exits 0; `explain drift extra
  junk` exits 0; `harness detect /tmp` ignores the argument; `simt doctor local` (typo of `local
  doctor`) → "unreadable-root, run: simt init"; `--root a --root b` keeps `b`; `--paths a --paths b`
  keeps `b`; `--budget 1e3` accepted. Same flag, different meaning: `--session` (path vs id),
  `--harness` (bench adapter vs hook dialect), `--check` (dry run vs ADR lint), `--all` (three caps),
  `--compare a b` (steals a positional).
- **Fix:** validate against the spec's flags + globals; typed values `int|enum|path|duration|list`
  with enum values from functions; `repeatable` lists accumulate, other repeats are a usage error;
  surplus positionals rejected (only documented ones, e.g. `init [path]`, `pack lint [dir]`);
  a flag name may repeat across commands only with the same type — rename conflicts with aliases
  (`decide lint`, `lease --owner`, repeatable `--compare`); structured remedies `{run?, hint?}`;
  unreadable root → "check the path", not `simt init`.
- **Compat:** release N prints a stderr `note` and a JSON `warnings[]` entry for each ignored
  flag/positional; release N+1 exits `EXIT.USAGE`.
- **Effort:** M.

### Q63 — Core/presentation split and a library API (P1 for UI/harness)
- **Where:** every command calls `emit`/`emitJson` and returns an exit code; `src/output/index.mjs:43,132` (module-global `jsonFailure`, `prettyDefault`); 48 copies of `flags.root ?? process.cwd()`; `distill.mjs:16`, `review.mjs:22` engines return "a number (already printed) or a result"; `brief/assemble.mjs:49-51` imports command modules; `map.mjs:107-115` and `local/config.mjs:267-286` call `fail()` (prints) from library code; `toolwords.mjs:24` imports `mcp/prompts.mjs`; no `exports` in `package.json`.
- **Fix:** contract `run(ctx, input) → { exitCode, result, diffs?, notes[], warnings[] }` with
  `ctx = { root, cwd, env, io, now, cache }`; library code returns `{ok, data | error:{code,
  message, remedy}}` and never prints; renderers `text(result)`, `json(envelope)`, `mcp(result)`;
  the dispatcher owns envelope, `--max-bytes` and `--pretty`. Migrate the 15 MCP-covered reads
  first, then writers (their plan/apply halves exist). `exports: { ".": "./src/api.mjs",
  "./package.json": "./package.json", "./src/*": "./src/*" }` — keeping `./src/*` avoids breaking
  deep importers and the plugin runtime; deprecate it later. `src/api.mjs` exposes brief, check,
  doctor, plan, rules, why, decide (policy), with JSDoc types.
- **Effort:** L.

### Q64 — Lazy command loading (P2)
- **Where:** `src/commands/index.mjs:9-77`; `bin/simt.mjs:27-41` (agent-hook special case).
- **Evidence (VERIFIED):** registry import 69.6 ms; `status --line` 120–130 ms wall (status module
  5.7 ms; `node -e 0` ~90 ms); README promises < 50 ms.
- **Fix:** the spec's `load()`; the dispatcher imports only the matched module. The agent-hook fast
  path falls out of it and can be removed as a special case. Also stop importing install-only
  modules (`journal`, `diff`) on the agent-hook path (~4.6 ms).
- **Effort:** S.

### Q65 — One envelope, one root resolver, declared writes (P2)
- **Evidence (VERIFIED, 50 commands):** `command` missing from `skills index/find/brief`,
  `rules show`, `graph lint`, `mcp --list`; `plugin` → `command:'plugin claude'`, sync →
  `'sync --check'`; `upgrade` `ok:false` with exit 0; `shared install` preview `ok:false`/exit 1
  while `hooks install` preview is `ok:true`; failure envelope has no `command`; ~15 sites force
  `pretty: flags.pretty === true` against ADR-070's TTY default; `--max-bytes` ignored by `explain`,
  `upgrade`, `init`, `ci`, `status`, `hooks`; `"root":"."` vs absolute; `status --root src` → "no
  cache" instead of finding the toplevel; `brief --root /nonexistent` → `spawn git ENOENT`;
  `index`, `map`, `brief`, `check` (`.simt/check.json`), `distill`, `review --local` write state
  without declaring it.
- **Fix:** the dispatcher builds `{schemaVersion, ok, command:<canonical path>, exitCode, …result,
  error?:{code, message, remedy}, warnings?, deprecated?}` with `ok === (exitCode === 0)` — additive,
  no schema bump; remove the pretty overrides; one `resolveRoot()` (absolute, exists, optional walk
  to git/manifest root, declared per command as `root:'repo'|'workspace'|'any'`); spec `writes`
  tier: `--yes` required for `repo|home|remote`, MCP exposes only `none`, a UI/harness sets
  permissions from it. Document the agent-hook exit-code exception (1, never 2) in the EXIT table.
- **Effort:** M.

### Q66 — MCP from the spec, and MCP as the UI/harness API (P2)
- **Evidence (VERIFIED):** `resources/subscribe` → -32601, `listChanged:false`, `cursor` ignored,
  progress/cancellation/`logging/setLevel`/`completion/complete` → -32601, resources take no root and
  `roots/list` is never used, tools re-read everything per call, no event stream, no write path.
- **Fix:** `tools/list` generated from spec rows with `mcp` set and `writes:'none'`; one `why` tool
  (aliases `rules_why`, `skills_why`); `fs.watch`-backed change notifications on rules, decisions,
  plans, ledger and leases with `resources/subscribe`; `roots`; pagination; progress and cancel;
  two-step writes: a `*_plan` tool returns the diff plus a token, applying needs elicitation or a
  human (keeps ADR-001). Keep the ≤ 2 KB `tools/list` budget by tiering.
- **Effort:** L.

### Q67 — Per-run `RepoContext` (P2, perf)
- **Evidence (VERIFIED, instrumented copy):** `check` on TS: fingerprint ×11, `desiredRegion` ×3,
  `readManifest` ×13, `provenanceDigest` ×6, ~1.0 s; monorepo ×14/×3/×15/×7, ~1.3 s. Each
  fingerprint spawns `git ls-files` and walks the tree once per glob candidate
  (`fingerprint.mjs:246-253`); each digest re-reads and re-hashes `rules/`.
- **Fix:** `RepoContext` memo (fingerprint, manifest, rules, digest, tracked paths, git facts),
  created once per command and passed as `ctx.cache` (Q63); per-process digest memo; one walk for
  all glob facts. Also fixes Q14.
- **Effort:** M.

### Q68 — One write engine (P2)
- **Evidence:** 14 writer modules hand-roll plan → `readBefore` → apply → `journaledWriteFile` →
  `commitJournal` → invalidate; `init.mjs` repeats six writer branches in `--diff` (`:291-340`) and
  apply (`:398-509`); sync's JSON labels `.editorconfig` as `surface:"agents"` (`sync.mjs:213`,
  VERIFIED); unjournaled writers: lock, `.gitignore`, `include.path`, tracker, brief, `skills
  compile`, lessons, plugin, `core.hooksPath`.
- **Fix:** `src/write/plan.mjs` change record `{path, kind: region|file-once|json-merge|symlink|gitconfig|lock|tracker,
  before, after, action, owner, reason}` and one `applyPlan(ctx, changes, {mode, label})` covering
  mkdir, journal, symlink, cache invalidation, emit and diff. Every writer returns a plan; the
  dispatcher applies it. Migrate init and sync first. This is also the shape a UI renders as
  "review changes" and an MCP two-step write returns (Q66).
- **Effort:** L.

### Q69 — Manifest schema (P2)
- **Where:** `src/projection/manifest.mjs:846-859` (bare `JSON.parse`); `fingerprint.mjs:337-343` returns `{error}` *as* the manifest; `rules.mjs:251-264` swallows parse errors; `hooks/capability.mjs:160`; `commands/why.mjs:169` (skips the legacy-name fallback); `src/projection/lock.mjs`.
- **Evidence:** 29 files call `readManifest`, 41 read keys ad hoc; W07 says "extend manifest validation" — none exists.
- **Fix:** `src/manifest/schema.mjs`: declarative key table `{key, owner: tool|repo, type, validator,
  since}`; one `loadManifest(root) → {manifest, problems, version}`; `version: 1` (absent = 1);
  derive `GENERATED_KEYS` from the table; namespaces register validators, so plan 0004's `work`
  touches two files; the lock gets `version` and a contributing-namespaces field. Fixes the
  substitution-key check across rules (`rules.mjs:381-395`) and `describeDefect` skipping
  `always` rules (`rules.mjs:196-199`).
- **Effort:** M.

### Q70 — Ecosystem and language records as data (P2, ADR-013)
- **Where:** `manifest.mjs:83-192,313-324` (`GATES_BY_STACK`, `TAG_GATES`, `ECOSYSTEMS`, `runnerName`), `kernel/card.mjs` command tables, `fingerprint.mjs:28-193,304-308` (an estate-specific `wear-os` rule), `ci/dependabot.mjs`, editorconfig body, `index/store.mjs:33-37`, `extract.mjs:9-21,319-331`, `index/tests.mjs:236-252`, `bench/mine.mjs:42-60`, `hooks/gates.mjs:42-102` (closed gate vocabulary with ConnectIQ `memory`, `i18n-completeness`, `codegen-drift`).
- **Evidence:** adding PHP (`has-composer` exists) needs 4–5 code edits; a declared `build` or `e2e` gate fails as "unknown gate".
- **Fix:** `ecosystems/<id>.json` (or profile frontmatter): `{facts, runner, packageManagers, gates,
  card:{build,test,focusedTest,lint,format,typecheck}, ci:{install}, dependabot, languages:[{exts,
  importPatterns, defPatterns, exportRule, resolver, testConventions}]}`, loadable from repo-local
  `.simt/ecosystems/`. Any key in `gates.commands` is a valid command gate; the built-in names
  become data defaults kept as aliases. Remove the estate special case. W06 facets extend the same records.
- **Effort:** L.

### Q71 — Harness records as data (P2)
- **Where:** `projection/surfaces.mjs:83,357` (5 surfaces + `POINTERS`, `SCOPE_KEYS`), `projection/loaders.mjs:70-723`, `agenthooks/render.mjs:82-228,303-329,351-356`, `plugins.mjs:34-65`, `measure/context.mjs:216,245,384,410`.
- **Evidence (code-read):** a new harness touches ~4 files and 6 functions; the tables carry different id sets.
- **Fix:** `harnesses/<id>.json`: `{surface, pointer, loader:{order, cap, provenance}, scopeKey,
  hooks:{configShape: nested|flat|named, events:{pre, prompt, post}, denyExit, timeoutUnit, deny
  template, failClosed}, payload:{toolKey, inputKey, shellTools, writeTools, rootKeys, sessionKey},
  plugin:{rootVar, projectVar, hooksPath, runtimeDir}}`. Only `apply_patch` keeps a named custom
  extractor. Existing modules become views over the records.
- **Effort:** M.

### Q72 — Shared low-level utilities (P2)
- **Evidence:** ~30 modules import `child_process` and roll their own `git()`/`run()`
  (`identity.mjs:51`, `hooks/where.mjs:29`, `index/store.mjs:390`, `commands/slice.mjs:54`,
  `commands/init.mjs:610`, `bench/probes.mjs:40`, …); 5 spawn wrappers and 3 `sanitizedEnv` in the
  bench; ~9 frontmatter regexes, some without CRLF (`memory/decide.mjs:44`, `graph/spec.mjs:171`,
  `projection/mdc.mjs:136,161,195`, `projection/targets.mjs:279,299,304`, `projection/rules.mjs:1337,1370`,
  `packs/manage.mjs:314`); five tokenizers and four stopword lists (`store.mjs:72,94-103,322-325`,
  `map.mjs:33-39,558-565`, `resolve/resolve.mjs:44-72`, `memory/lessons.mjs:31`); `cmp` ×7;
  `tracked()` ×4; `readIfExists` ×2 + `diff.mjs:31`; `plain()` ×2; package version read ×3
  (`package-version.mjs:32`, `help.mjs:352-359`, `mcp.mjs:67-76`); skill body read ×4 and Agent
  Skills limits ×2 (`spec.mjs:22-25`, `compile.mjs:18-21`); `extname` reimplemented
  (`hooks/resolve.mjs:204`, wrong for `src.d/Makefile`); ledger path hard-coded
  (`ledger/index.mjs:25`); lock filename ×2 (`kernel/variants.mjs:14`, `projection/lock.mjs:19`).
- **Fix:** `src/sys/git.mjs` (one runner, `-z` helpers, `core.quotePath=false`, structured errors,
  optional trace for perf), `src/sys/proc.mjs` (`spawnBounded`), `src/text/frontmatter.mjs`,
  `src/text/tokens.mjs`, `src/util/{fs,sort}.mjs`, one skills-body locator and one limits module.
  Per ADR-002, migrate the copies in the same change that extracts.
- **Effort:** M.

### Q73 — Local state and one event log (P2)
- **Evidence:** five stores with three version keys — ledger (`v`), journal (`version`), leases
  (`schemaVersion`), lessons, `check.json`; hooks print only vendor JSON; nothing a UI can tail.
- **Fix:** one envelope `{v, id: ULID, ts, kind, session, harness, tree, subject, data}` appended
  (`O_APPEND`) to `events.jsonl` in the Q19 local-state area; kinds `gate.started/finished`,
  `policy.decided`, `lease.acquired/released/expired`, `slice.transitioned`,
  `write.committed/undone`, `lesson.captured`; the ledger and lessons become projections of it;
  export the pure `decide()` and the fact normaliser so a simt-native harness decides in-process.
- **Effort:** M.

### Q74 — Lease v2 (P2, W37 seed)
- **Fix:** schema `{resource:{kind: path|dir|branch|slice|object, id}, holder:{session, harness},
  fence: <monotonic int>, acquiredAt, expiresAt}`; `acquire/renew/release` behind a `LeaseStore`
  interface (file store now; remote store and server clock later); directory-prefix leases; v1 reader kept.
- **Effort:** M.

### Q75 — Ledger v2 (P2, W28 seed)
- **Where:** `src/ledger/index.mjs:37-62`.
- **Evidence (code-read, not measured):** a fresh private index has no stat cache, so `git add -A`
  hashes every file on each gate run, `evidence`, commit-msg and `pr-body`; `recordRun` re-reads the
  whole, unbounded ledger.
- **Fix:** seed the temp index by copying `$(git rev-parse --git-path index)`; record `{gate, kind,
  command, worktreeTree, indexTree, exit, outputDigest, wallMs}`; incremental tail read; rotation.
  Gate-run cache keyed by tree (used by Q23).
- **Effort:** M.

### Q76 — Index storage v4 and an `openIndex()` API (P2)
- **Where:** `src/index/persist.mjs`, `store.mjs:40-50,129,185-295,496`, `map.mjs:119-124,410-412,452-454`.
- **Evidence (VERIFIED):** PageRank with no task is quadratic — 3k files 72 ms, 10k 463 ms, 30k
  3,503 ms; `loadGraph` loads every FTS body and embedding (7.5 MB, 87 ms on one repo) though BM25
  runs in SQLite; each read re-probes the backend; `countSqlite` opens the DB 3×; blob reading
  concatenates per chunk; no indexes on `edges(src)`, `edges(dst)`, `symbols(path)`.
- **Fix:** keep views `files`/`symbols`/`edges` so readers keep working, over:
  ```sql
  PRAGMA user_version = 4;
  sources(id, kind /*blob|overlay|observation*/, path, revision, lang, bytes,
          status /*indexed|binary|too-large|denied*/, UNIQUE(kind, path))
  nodes(id, key UNIQUE /*file:p | sym:p#name@line | sec:p#anchor | claim:id | adr:ADR-089*/,
        kind, source_id, name, line, span_start, span_end, digest,
        trust /*observed|declared|proposed|reviewed*/, props JSON)
  edges(src_id, kind, dst_key, dst_id NULL, weight, owner_source_id, trust, props JSON,
        PRIMARY KEY(src_id, kind, dst_key))
  -- indexes on edges(dst_id, kind), edges(owner_source_id), nodes(source_id), nodes(kind, name)
  fts USING fts5(body, node_id UNINDEXED, kind UNINDEXED, tokenize='unicode61 remove_diacritics 2')
  vectors(node_id PRIMARY KEY, model, dims, vec BLOB)
  meta(key PRIMARY KEY, value)   -- tree digest (Q42), tool version
  ```
  Edge ownership fixes Q07 structurally; `dst_key` + a resolve pass fixes Q40; `sources` separates
  base and working-tree overlay (W18); sections and claims are new `kind` values (W12/W13), not
  new tables. API: `const ix = await openIndex(root, {build, refresh})` → `status()`, `search()`,
  `rank()`, `coverage()`, `impact()`, `governs()`, `close()` — pure data, structured errors.
  Dangling rank summed once per iteration (O(n), same output); bodies and vectors loaded lazily;
  blobs streamed with a size cap.
- **Effort:** L.

### Q77 — One `coverage()` and one `governs()` (P2)
- **Evidence (VERIFIED):** `simt tests src/index/persist.mjs` → 1 test; `simt gate` on the same file
  selects dozens (95 s). Four selection paths: `tests` direct via edges + re-parse
  (`commands/tests.mjs:45-52`), `gate` transitive over a re-read worktree (`index/gate.mjs:23-89`),
  `impact` transitive (`index/impact.mjs:53`), `brief` direct (`assemble.mjs:216-225`). Governance:
  `impact` counts decisions+rules (`commands/impact.mjs:90-96`), `why` adds skills, gates, lessons
  (`why.mjs:104-117`), `brief` top-3 decisions; `why.mjs:29,84-87,144` hard-codes simt-dev's own
  `rules/`, `rules/stacks`, `rules/mdc`, `graph/skills.graph.json`, `docs/decisions`. `impact` and
  `gate` ignore the index and re-read every tracked file (`commands/impact.mjs:41-44,109-158`, `gate.mjs:45`).
- **Fix:** `coverage(graph, paths, {transitive, cochange})` and `governs(path, corpus)` in
  `src/index/`; corpus locations from the manifest and profile data; commands keep their output
  shapes with `transitive` defaulting to today's behaviour; contracts marked at index time.
- **Effort:** M.

### Q78 — Bench architecture (P2)
- **Evidence:** `run.mjs:21-22` imports ablate and variants, which dynamic-import `run.mjs` back;
  `parseArmSpec` chains prefix parsers (`:279-364`), `materialiseArm` is an if/else chain
  (`:529-546`); task JSON unvalidated with no stratum or oracle (`tasks.mjs`, `mine.mjs:642-654`),
  "resolved" hard-coded in `grade.mjs:204-218`; adapters keep `template` and `args`, Gemini and
  event counting special-cased (`run.mjs:197-264,659-670,829-834`), transcripts parsed in three
  places; record has no provenance and run id omits the model (`run.mjs:683-685,836-850`);
  Markdown built in the core (`report.mjs:761-810`), map recall bolted on in the command
  (`commands/bench.mjs:229-246`); duplication: task loading ×3, manifest set/plan/restore ×3,
  per-task aggregation ×2 (Q45 hid in the second), formatters ×2, record loaders ×2.
- **Fix:** arm registry `{kind, match, materialise, describe}` (custom-arm JSON is the data format;
  ablation/variants become arm generators); task schema v2 `{stratum, agentVisible,
  oracle:{type: tests|predicates|rubric|world-state}}` with a grader registry (v1 = source/tests);
  adapter v2 `{prompt delivery: argv|stdin|file, env allowlist, timeout, usage counters,
  transcript extractors}`, gold/noop as `kind:"oracle"` adapters — the natural seam for "simt as
  a harness"; record v2 with `experiment{simtVersion, rulesDigest, adapterVersion, corpusDigest,
  seed, hardware, isolation}` and model in the run id; `src/bench/stats.mjs` (Q46);
  report-as-data `{reportSchema:"simt.bench.report/2", experiment, strata[], arms[], comparisons[],
  exclusions[], warnings[]}` with separate renderers; skip a corrupt record with a warning
  (`report.mjs:716`); reuse one base tree per task (`run.mjs:579-640`).
- **Effort:** L. Base for W01–W05, W45, W46.

### Q79 — Decouple production code from the bench (P2)
- **Where:** `index/gate.mjs:11`, `index/map.mjs:12`, `index/impact.mjs:8`, `index/tests.mjs:9`, `commands/tests.mjs:15`, `commands/gate.mjs:15` import `isTestPath`/`detectTestRunner` from `bench/mine.mjs`; `skillscompile` and `advice` import bench modules; `simt gate` on pytest leaves `.bench-junit.xml` in the package dir (`mine.mjs:331-337` via `gate.mjs:82`, code-read).
- **Fix:** `src/testing/{paths,runners,parsers}.mjs` fed by Q70 records; report files to a temp
  dir; then move `bench/{run,grade,report,ablate,variants,probes,tasks}`, the mining half of
  `mine`, `criticBench` and the ablation half of `compare/learn` (~6K lines) to an optional
  package (ADR-090 pattern); keep a `bench` stub that prints the install step and a v1 record
  reader for `advice` and `skillscompile`.
- **Effort:** L.

### Q80 — Split oversized modules (P2)
- **Evidence (VERIFIED `wc`):** src over the repo's own 1000-line ceiling (ADR-005):
  `projection/rules.mjs` 1374 (`desiredRegion` alone ~450 lines, `:464-914`; variants → inferable →
  checks pipeline duplicated at `:548-560` and `:1137-1144`), `bench/probes.mjs` 1348,
  `bench/run.mjs` 1034, `mcp/tools.mjs` 1007; near it: `projection/manifest.mjs` 873 (gate planning
  inside the manifest module), `bench/report.mjs` 897. Tests: `hooks` 1590, `bench` 1486, `init` 1064, `compare` 1057.
- **Fix:** `rules/{load,select}.mjs`, `region/{transform,assemble}.mjs` with one `transformBody`,
  kernel packing on its own; gate planning to `src/gates/`; one module per MCP tool (falls out of
  Q66); probes as data fixtures (W05); tests split by subcommand. `checkTargets` becomes `plan()`
  plus one `targetFinding(t)` mapper (today it is a hand-built second copy: `project.mjs:157-404`),
  making "the gate equals the writer" true by construction.
- **Effort:** M.

## 7. Wave 3 — cleanup, merges, docs, tests

### Q81 — Command taxonomy (P2)
Today: 69 command paths, 42 top-level words. Target: ~22 words, with every current spelling kept
as an alias (locked ones permanent and hidden). Plan 0004's groups slot in as spec rows.

| Current | Target | Action |
| --- | --- | --- |
| `init`, `sync`, `check`, `doctor`, `undo` | same | keep (`check`, `sync --yes` locked) |
| `sync --check` | `sync` | deprecate (bare sync already checks, ADR-036) |
| `status --line` | `status [--line]` | keep `--line` (locked); bare = aggregate (Q82) |
| `hooks status`, `agent-hooks status` | sections of `status` + same paths | alias |
| `hooks install`, `hooks run` | same | keep (`hooks run` locked) |
| `agent-hooks install` | `harness install` | alias |
| `agent-hook <event>` | `harness hook <event>` | permanent hidden alias (locked) |
| `plugin <kind>` | `harness plugin <kind>` | alias |
| `tokens` | `harness cost` | alias; one engine with `harness loaders` (Q85) |
| `why`, `rules why`, `skills why`, `explain` | `why <subject>` (path, ADR-NNN, rule id, `skill:<name>`, FINDING-CODE; later claim id) | merge; all four stay as aliases; ambiguity is an error naming prefixes |
| `skills index` | `skills list` | alias (matches `rules list`, `lessons list`) |
| `skills brief` | `skills select` (= `brief --only skills`) | alias; one budget; needs an ADR superseding ADR-035/052 |
| `graph lint` | `skills lint` (with `--spec` and compile conformance) | alias; tier advanced |
| `skills compile`, `skills eval` | same (`eval` → `bench`-tier) | tier advanced |
| `gate` | `tests --run` | keep `gate` as alias |
| `decide --check` | `decide lint` | flag becomes alias |
| `slice start/finish` | `plan start/finish` (+ `plan abandon`) | alias |
| `evidence`, `evidence check` | real group: `evidence [show]`, `evidence check` (locked) | fix unreachable registry entry |
| `compare`, `upgrade`, `shared plan/install` | `workspace compare/upgrade/share` | alias |
| `local doctor` | same | keep |
| `bench` (default `mine`, a writer) | `bench` (default `report`) | change default; every group default must be `writes:'none'` (bare `slice` too) |
| `bench critic`, `review` | one `critique()` engine (Q85) | keep both paths |
| `pack *` | same | tier advanced, experimental |
| `ci` | internal script, not in `files` | remove from consumer surface (Q84) |
| `mcp`, `completions`, `help` | + `help <cmd>`, `help --json`, `-h` | extend |

- **Fix:** aliases in the spec; deprecated spellings print one stderr `note` and add
  `deprecated:{use}` to JSON; hidden from help after one minor release. Test that every alias
  resolves and every group default writes nothing.
- **Effort:** M.

### Q82 — `status` and `explain` (P2)
- **Evidence (VERIFIED):** bare `simt status` → ERROR 2 (`status.mjs:19-21`); its comment says it
  errors "the way `plan` without a subcommand is", but `simt plan` exits 0.
- **Fix:** bare `status` (and `--json`) = one snapshot: last check, git hooks, agent hooks, evidence
  for HEAD's tree, active leases, in-progress slices, last journal set — the payload a UI's home
  view and a harness status line need. `--line` unchanged. `explain` also covers policy ids
  (`push`, `rewrite`, `generated`, `lease`, `hooks-disable`) and gate statuses, so a denial says
  `run: simt explain push`.
- **Effort:** S.

### Q83 — Dead code (P3)
- `STEPS` map and its branches (`commands/index.mjs:79-89,263-273,301`) and the regex test that guards it (`test/deadcode.test.mjs:129-140`) → a `stability:'planned'` value in the spec.
- Unreachable `'evidence check'` entry (`index.mjs:186`).
- Double dispatch: registry lambdas → `hooksCommand(sub)`, `planCommand`, `sliceCommand`, `packCommand`, `agentHooksCommand` switch again with unreachable "unknown subcommand" branches (`hooks.mjs:41`, `agenthook.mjs:144`).
- `parse()` runs three times per call (`bin:12`, `index:233`, `help:321`); JSON modes set twice (`bin:24-25`, `index:243-244`); unreachable `parseOrExit` failure branch.
- `unresolved()` (`hooks/gates.mjs:118-149`) never imported; `knownGates()` (`hooks/resolve.mjs:21`) duplicates `gateNames()`; `checkTarget` (`project.mjs:522`) dead wrapper; `brief.mjs` re-validates `--budget`.
- `pkg` index column stale and unread (`store.mjs:143`); `local/client.mjs:17-49` re-validates config already validated in `local/config.mjs:77-167`; orphan doc comment `assemble.mjs:74-83`; unpruned `.simt/gate/gate-<ms>.log` (`gate.mjs:118-128`); `queue.shift` BFS (`impact.mjs:37`); dead `remedy=` in the rendered CI shell; `defaultLimits(stack)` ignores its argument.
- `graph/skills.graph.json:2-6` points at a nonexistent `skills.graph.schema.json`, `version` never checked, `stackVocabularySource` names a simt-dev path — ship the schema (from `mcp/schema.mjs`) or drop the field; reject unknown versions.
- **Effort:** S.

### Q84 — Retire or demote low-value features (P2)

| Feature | Value today | Recommendation |
| --- | --- | --- |
| `simt ci` (309 lines + `project.mjs:200-212` branch reachable only here) | maintains simt-dev's own `.github`; refuses everywhere else | move to `scripts/`, out of `files` |
| `tsconfig.base.json` creation (`tsconfig.mjs`, 314 lines) | creates a file nothing extends, then blocks `check` (Q28) | stop creating for fresh adoptions; keep read-only strictness hints as non-blocking findings |
| `.editorconfig` / `.gitattributes` baselines | hashed into the digest (edits drift every repo); ship Go/Make/Python sections into TS repos; `eol=lf` renormalisation diffs | opt-in for fresh adoptions; kept for repos that already carry the region |
| `sync --check` | duplicates bare `sync` | silent alias |
| JSONL index backend | justified when the Node floor lacked `node:sqlite` (ADR-089); floor is now 22.20.0 | supersede ADR-089 ruling 1, remove after confirming FTS5 on 22.20.0 in CI; keep an export format for W23 bundles; fix ADR's `.simt-dev/` path |
| Embeddings (`store.mjs:185-237`, `map.mjs:74-112,251-264,334-362`, `local/client.mjs:265-343`) | off by default; "+10 pts recall" bar never shown met; input is token soup | isolate in `src/index/vectors.mjs`, stop loading in `loadGraph`, drop duplicate recall branch; revisit in W19 |
| `distill` | bar unmeasured; outline engine = heading + first line | hide from default help; rebuild on W12 sections; keep `--local` |
| Variant machinery (`kernel/variants.mjs` 353, `bench/variants.mjs` 454) | `grep simt-variants rules/` → nothing | keep the marker fold (consumer profiles may use it); move the experiment runner to the optional bench package or retire R35 by ADR |
| Packs (~1,000 lines) | no repo uses them | freeze, mark experimental, fix Q58; remove in a later plan if still unused |
| Federation | seed of W23 adapters | keep; parallelise (`Promise.all` keeps order), spawn detached and kill the group, check the `initialize` reply, cap answer size |

- **Compat:** existing files remain repo-owned; only fresh adoptions change. Each removal gets an ADR (AGENTS.md: a change to what the tool believes is a ruling).
- **Effort:** M.

### Q85 — Merge duplicate engines (P2)
- **Context meters:** `measure/context.mjs` (`tokens`) and `measure/loaderView.mjs` (`harness loaders`)
  each define `bytes`, `frontmatter`, `filesUnder`, `readText` differently (dotfiles skipped vs kept,
  `line === '---'` vs `trim()`, depth 6 vs 8), and `context.mjs` hard-codes harness branches its own
  header forbids. Build `tokens` on `viewOf`/`viewAll`; keep only aggregation and redundancy in
  `context.mjs`; byte totals must stay equal on fixtures.
- **Critic:** `review` and `bench critic` re-implement the model path (`critic.mjs:310` vs `:460`);
  the bench diffs with `git show --unified=2` (commit message included), production with
  `git diff --staged` (3 lines) — the bench measures a different prompt; governance looked up at
  HEAD, not the labelled commit; `METRIC_NOTE` says "unmeasured" forever; the `write` option exists
  for a caller that never uses it. One `critique({root, diff, files, at, endpoint, budget})`.
- **Hooks:** `hooks install|status` and `agent-hooks install|status` have two report shapes; two
  `EVENTS` exports mean different things (`hooks/shim.mjs:37`, `agenthooks/policy.mjs:33`). One
  `hooks install [--git|--agent|--all]` plan shape; `agent-hooks` stays an alias.
- **Effort:** M.

### Q86 — Plan-row references in code (P3)
- **Evidence:** ~300 `plan 000N`/`Rnn` references across ~93 of 156 `src` files; header pointers
  (`commands/index.mjs:3`, `output/index.mjs:7`, `projection/markers.mjs:4`, `doctor.mjs:3`) go
  dead when plans are archived; ~7 comments in `index.mjs` restate "a bare command: no group and
  no default subcommand to resolve" (against AGENTS.md "never write a comment that could be deleted").
- **Fix:** keep ADR references (they ship and `rules why` resolves them); replace plan-row
  references with the reason or drop them; a lint that rejects new `\bR\d{2}\b` in `src/`.
- **Effort:** M (mechanical, one module group per commit).

### Q90 — Documentation architecture that scales (P2)
- **Evidence (VERIFIED):** README 431 lines / 33 KB; command information in four places (README
  block 85-165, playbook 188-315, module table 329-342, `help.mjs`); playbook repeats its own steps;
  "Where the plan finishes" (344-364) is a status report with a typo at 361; no `CONTRIBUTING.md`,
  no architecture overview; adding a command touches eight places (registry, help, three README
  sections, MCP, explain table, CHANGELOG, contract test).
- **Fix:**
  ```
  README.md                ≤150 lines: pitch, install (no literal version), 10-command quick start, links
  AGENTS.md                contributor rules only (≤80 lines) → docs/architecture/
  CONTRIBUTING.md          hooksPath, isolated test run, test tiers, release checklist
  docs/
    getting-started.md
    guides/                agent-playbook, workspace-shapes, monorepo, local-models, federation
    commands/              index.md + <group>.md          ← generated from the spec (Q60)
    reference/             manifest.md (from Q69 table), findings.md (explain table), mcp.md,
                           exit-codes.md, files-written.md ← generated
    architecture/          overview (module map), pipeline (detect → resolve → project → gate),
                           storage (index, state, events), testing, release, history
    contributing/          add-a-command, add-a-stack-profile, add-an-ecosystem, add-a-harness,
                           add-an-mcp-tool, add-a-finding-code, write-an-adr
    decisions/             ADR-*.md (shipped) + index.md (generated, not shipped)
    plans/                 0004 (active)        archive/0001–0003
    reviews/               0003 (active)        archive/0001–0002
  scripts/gen-docs.mjs + a "docs are current" test (same pattern as the ci-copy check)
  ```
  Before archiving: confirm the tracker template reads subdirectories (`manifest.mjs:75`) and
  rewrite the ~20 internal links.
- **Effort:** M.

### Q91 — Doc drift and repo hygiene (P2)
- `AGENTS.md:28` ("the binary is `simt-dev`", "`simt sync` does not exist" — both now false), `:102` ("the two plans" — four), layout table covers 8 of 27 `src/` dirs and omits `docs/reviews`.
- `docs/plans/0003…:3` says "in progress — R01–R10…" while the tracker is 55/55; `docs/reviews/0002…:3` "open" with 60 Complete + 1 Accepted → derive headers from trackers (`plan status --check`).
- `docs/decisions/README.md` (56 KB, 590 hand-written lines, never read at runtime, shipped) → generated index + `architecture/history.md`; exclude from `files` and the wheel.
- CHANGELOG 981 lines (0.2.2 entry 200 lines) → one bullet per change with an ADR link.
- `SECURITY.md`: no supported versions, public issues as first channel; add private vulnerability reporting and response time.
- `res/9ce4e49e-….jpg` (160 KB) tracked and unreferenced; rename the hero image; empty `state/`; template `FUNDING.yml`; README binary snippet without `.sha256` verification.
- **Effort:** S.

### Q92 — Test suite maintainability (P2)
- **Evidence (VERIFIED):** helpers copied — `run` ×25 files, `scratch` ×22, `runCli` ×11, `capture`
  ×10, `git` ×8; bench's `runCli` omits `SIMT_DEV_WORKSPACE: 'off'` and 38 CLI-spawning files never
  set it (in the isolated clone `doctor` reported a heuristic sibling workspace — the ADR-031 class
  of bug is one directory away); 38 files spawn `'node'` instead of `process.execPath`; ~346 `simt-*`
  temp dirs leaked per run (1,302 accumulated); `test/rules.test.mjs:130-154` hard-codes the live
  ADR corpus (broke the v0.6.1 tag run) and `why-snapshot.test.mjs:22` needs commit `4c27514`, so the
  suite fails from a tarball or shallow clone; 26 of 156 modules have no direct test (largest:
  `brief/assemble` 367, `commands/slice` 354, `commands/doctor` 350, `plan/template` 332,
  `measure/session` 268, `prbody` 252, `mcp/resources` 232, `brief/packet` 201); one tier of
  1,373 tests, 2.5–4 min.
- **Fix:** `test/helpers/{cli,scratch,git}.mjs` (workspace off by default, `process.execPath`,
  `t.after` cleanup) and migrate; fixture corpus under `test/fixtures/decisions` plus one "the real
  corpus parses" test; build the snapshot repo inside the test; unit tests for `brief/assemble`
  and `brief/packet` first (a UI will call them); `test:unit` / `test:integration` (pre-push runs
  unit + `simt gate --changed`, CI runs all); `npm run test:coverage`.
- **Effort:** M.

### Q93 — npm scripts and tarball (P3)
- **Evidence (VERIFIED):** `npm run lint` = `simt doctor`, which here prints "run: simt init … --yes"
  (forbidden by AGENTS.md) and exits 0; release scripts have no npm entries; CI, pre-push and
  `package.json` list checks separately; tarball 906 KB / 2.83 MB unpacked / 291 files including the
  56 KB decisions README and the CHANGELOG, also embedded in the wheel and every SEA binary.
- **Fix:** `lint` = `graph lint` + `shipped.test.mjs` + gen-docs check; `build:sea`, `verify:wheel`;
  CI and the hook call npm scripts; exclude `docs/decisions/README.md` (mirror in `pyproject.toml`).
- **Effort:** S.

### Q99 — Finish the review (P2)
Read and probe the modules in §1.1 against this review's slices: render every `rules/stacks/*`
profile for a fixture and read it as that repo's agent; run `doctor --fix`, `ignore --diff`,
`upgrade` planning and monorepo detection on fixtures; check `ci/workflow` and `ci/dependabot`
output per ecosystem. Add findings as new rows here, not a new review.

## 8. Order of work

1. **Wave 0 (≈1 week, all small):** Q01–Q14. Q04 and Q06 are owner actions (tap merge, npm deprecate).
2. **Wave 1 bug fixes**, in parallel streams that touch disjoint files:
   - hooks/state: Q16, Q17, Q19 → Q18, Q20, Q21, Q22, Q23, Q24, Q25, Q53
   - projection: Q26, Q27, Q28, Q29, Q30, Q32, Q33, then Q31 with Q70
   - index: Q39, Q41, Q42 → Q44 → Q43, Q40
   - bench: Q45, Q47 → Q46, Q48, Q49, Q50, Q59
   - skills/mcp/docs: Q15 (core functions), Q34, Q35, Q36, Q37, Q38, Q51, Q52, Q54–Q58
3. **Wave 2 spine:** Q60 → Q61, Q62, Q64 → Q63 → Q65, Q66. In parallel: Q72, Q67, Q69, Q68, Q73 →
   Q74, Q75; Q76 → Q77; Q78 → Q79; Q70, Q71; Q80 last.
4. **Wave 3:** Q81–Q86 once Q60/Q62 exist (aliases need the spec); Q90 once the spec can generate
   the reference; Q91–Q93 any time.
5. **Plan 0004 entry:** W01 may start when Wave 0, Wave 1, Q44, Q60, Q63, Q69 and Q73 are Complete.
   W06–W11 need Q69/Q70; W12–W23 need Q76/Q77; W24–W29 need Q75; W30–W42 need Q01, Q73, Q74;
   W01–W05 and W45–W46 need Q78; W48 needs Q63/Q71.

## 9. Decisions this review needs

| Slice | Ruling to record |
| --- | --- |
| Q01 | The pre-tool-use policy matches normalised command facts, not text; fallback to text on parse failure |
| Q10 | ADR-070 ruling 5 amended: JSON is never byte-truncated |
| Q19/Q73 | Machine-local state lives outside the tree; one event envelope |
| Q21 | Agent hooks call a repo shim; `failClosed` only with the shim |
| Q33 | `upgrade` defaults to the enclosing repo |
| Q44/Q76 | Index schema is migrated by `user_version`; storage is nodes/edges with ownership |
| Q46 | Statistical unit is the task; missing cost is missing; non-inferiority and `inconclusive` |
| Q60/Q62/Q81 | The command spec is the source of truth; deprecation window; locked spellings |
| Q63 | Library API and `exports` map; `./src/*` deprecated later |
| Q69 | Manifest is versioned and namespaced |
| Q70/Q71 | Ecosystems and harnesses are data records (extends ADR-013) |
| Q79/Q84 | Bench and research features move to optional packages; JSONL backend retired (supersedes ADR-089 r1); fresh adoptions no longer get tsconfig/editorconfig/gitattributes baselines; `ci` leaves the package |

## 10. What is solid and must be kept

- **Determinism and data-over-code where it exists:** sorted sampling, explainable resolver scores, `selectWithinBudget`, RRF tie-breaks, `brief/packet.mjs` packing with an explicit cut line and `--explain`.
- **Content-addressed provenance** (`provenanceDigest()`, ADR-032) and the region grammar that refuses to write anything when any region is malformed.
- **Safe writers:** dry-run unless `--yes` via one `writeMode()`, `--diff` everywhere, journal + verify-before-restore undo. Extend, do not replace.
- **Fail-closed git dispatcher:** unrunnable gates fail with a remedy, partial-stage refusal, blob-compared restage, shared shim locator, chained foreign hooks with self-chain protection.
- **Pure `decide()`** that reports every matching policy; agent-hook latency at bare-Node cost (~140–150 ms, 11 modules).
- **In-process secret scan** with redacted previews (once Q02/Q24 land).
- **Git-blob-keyed index cache** via `ls-files -s -z` + streamed `cat-file --batch`; `index.parsers` adapter slot; precision-first test mapping; `govern.mjs` unresolved-token reporting.
- **MCP protocol core:** revision negotiation, notifications never answered, output schemas on every tool, strict `mcp/schema.mjs`, `..` refused in resource URIs, read-only invariant.
- **Bench design:** hidden tests split from gold, RED/GOLD run twice, single-commit `git archive` exports, exact McNemar and Wilcoxon (hand-checked), seeded bootstrap, `mine.mjs` `runProcess` group kill.
- **Release safeguards:** SHA-pinned actions with a test, tag = `package.json`, served-bytes verification, wheel/npm parity test.
- **Test isolation:** `test/fixture.mjs`; the suite passes from a sibling-less clone, no flakes, tree clean.
- **Naming discipline:** `CLI` from `name.mjs` plus `test/naming.test.mjs`; `shipped.test.mjs` leak guard.
