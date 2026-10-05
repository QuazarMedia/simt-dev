# Plan 0001 — Centralise agent rules, skills and tooling in simt-dev

Status: **proposed**
Created: 2026-10-05
Scope: all 16 sibling repos under `/Users/said.elimam/code/simt`
Supersedes: nothing. Feeds into: `0002-simt-dev-cli.md`

---

## 1. Problem

The workspace has no single source of truth for agent behaviour. Sixteen repos each carry
their own `AGENTS.md`, `.cursor/rules/*.mdc`, `.agents/skills/*`, `.agents/agents/*`, git
hooks and tooling config, and they have drifted apart in ways no reviewer would catch.

An audit (2026-10-05, read-only, all 16 repos) found:

- **46 skill entries / 38 unique names / 928 KB**, of which only **1 of 8** skills shared by
  the two Social repos is byte-identical.
- **3 `.mdc` rule families, 8 files, 0 byte-identical.** One pair differs by a **single
  byte** while hiding three semantically loaded line changes — so no size-, hash-adjacency- or
  line-count-based dedup detector will ever flag it.
- **10 direct contradictions** between repos on commit/push, refactoring neighbours, test
  breadth, hook ownership, file length, coverage bar, section naming, verdict vocabulary,
  skill layout and test-runner invocation. Two of these are flatly incompatible
  philosophies and cannot both be org rules.
- **4 incompatible git-hook conventions**; 11 repos have no hooks at all; zero use
  husky/lefthook; one `pre-push` is 0 bytes (dead code); one gate is permanently red by
  design.
- **5 Prettier configs with a live contradiction** (`singleQuote` set in three repos,
  silently defaulted to `false` in the two that also run ESLint), **4 near-disjoint
  `.prettierignore`**, **10 repos with no `.editorconfig` at all** (precisely the entire
  JS/TS/Python side), **3 disagreeing `.nvmrc`**, **no `packageManager` anywhere**, no npm
  Dependabot anywhere.
- **9–10 repos have no `AGENTS.md` at all**, including two Android repos, the design-system
  repo and the whole static-site group.

The estate already contains the right pattern — committed symlink fan-out from a canonical
`.agents/` directory (simt-social, simt-social-api, simt-app, bunnyland-server) and one git
submodule (app-ui). It has simply never been pointed at a central repo.

## 2. Decision

**Single source of truth in `simt-dev`, delivered to every repo as a committed generated
projection, enforced by a drift gate. Never a runtime symlink or a runtime include.**

Agents do not "discover" simt-dev. They read the repo they are in. The agent surface is a
projection; the human and generator surface is canonical.

### 2.1 Why not the alternatives

| Option | Verdict |
|---|---|
| Committed generated copies + drift gate | **Chosen.** Portable in CI, in fresh clones, in Docker, for teammates. Drift is caught by a job, not by luck. Tool-agnostic. |
| Cross-repo symlink (`../../simt-dev/.cursor/rules`) | Rejected. Breaks in CI, in any clone that did not also clone simt-dev as a sibling, and in Docker. Same reason `git.config` needed a local fallback in simt-space. |
| Git submodule (the `app-ui` precedent) | Rejected. Correct for versioned product code; wrong for rules — every typo becomes a 16-repo SHA-bump. |
| User-level only (`~/.claude/CLAUDE.md`, `~/.agents/skills/`) | Kept as an **optional thin layer** (see §8). Invisible to teammates and CI, so never the source of truth. |

### 2.2 The load-bearing mechanism

**A generated region inside a hand-owned file.** Each repo keeps its own `AGENTS.md`;
`simt-dev sync` owns only the bytes between:

```
<!-- simt-dev:begin -->
...generated...
<!-- simt-dev:end -->
```

Same for `.editorconfig`, `.prettierrc`, `.gitattributes`. Local content is never clobbered;
shared content can never drift silently. The marker also records the source SHA, so a
half-applied sync is detectable rather than invisible.

## 3. What moves, what stays

### 3.1 Moves to simt-dev

| # | Content | Source | Note |
|---|---|---|---|
| 1 | 4 always-on rules | `intake-questions`, `test-gate`, `preview-postflight` (3-way divergent), plus a new `simt-core` | `test-gate` canonical **carries both halves** of the diverged BLOCK list — producer-side *and* consumer-side — plus social's `Partial pass (e.g. 6/8 pass)` worked example. media's deleted `Allowed Without Account` section and 4th BLOCK trigger are restored. |
| 2 | 4 process skills | `slice-commit`, `bug-commit`, `complete-testing`, `parallel-feature-team` (8 skills, 4 duplicated, only 1 identical) | Repos keep the existing `add-country-galaxy` stub pattern: a ~10-line local skill pointing at the canonical one. The audit judged this the cleanest pattern already in the estate. |
| 3 | 8 agent policies | Independently authored in 2–4 files each | one-writer-per-file · minimum viable team · never-weaken-security-controls · anti-overclaim · 70/30 quality-vs-perf · 12-state coverage list · matrix-trigger heuristic · strict review budget. Also fixes the 3-way verdict vocabulary split. |
| 4 | 8 stack profiles | Kotlin/Gradle/Compose, Monkey C/ConnectIQ, Python/uv/ruff, TypeScript-strict, Cloudflare Workers (JS + TS), React/RTL/WCAG, LESS/CSS, JVM | Separate files, **never inlined** into core — this is what stops the core degenerating into a lowest-common-denominator nobody's rules. |
| 5 | Tooling baselines | Prettier, `.editorconfig`, `tsconfig.base.json`, shared 6-rule ESLint block + `eslint-config-prettier`, `packageManager`/`engines`, `.nvmrc`, `.gitattributes`, commitlint | Resolves: the `singleQuote` contradiction; the 10 repos with no editorconfig; simt-goto's 7 missing strictness flags; 3 disagreeing nvmrc; no `packageManager`; eslint/prettier fighting in 3 of 5 configs. |
| 6 | Shared hook library | 4 incompatible conventions | A dispatcher + per-repo check list. Gives the 11 hook-less repos a pre-commit, and delivers the dead `simt-app/hooks/pre-push` fix for free. |
| 7 | `simt-dev init <repo>` | — | Scaffolds AGENTS.md, editorconfig, tsconfig.base, commitlint, hooks, CI check, dependabot. Repo #17 must be one command, not a rewrite. |
| 8 | Reusable CI workflow | — | `QuazarMedia/simt-dev/.github/workflows/sync-check.yml`, referenced by every consumer. Also the home for the missing npm Dependabot config. |

`graphify` (40 KB, byte-identical in 2 repos) also becomes a synced vendored copy. All other
vendored third-party skills (`cloudflare`, `wrangler`, `firebase-*`) stay where used.

### 3.2 Stays local — do not move

All product policy (gender/onboarding rules, country registries, capability crypto). All
stack-specific rule *bodies* (the Compose component catalogue, MapLibre chrome, Room
migrations, the 35-row Garmin platform-defect table, ECS modelling). All repo commands and
paths. The whole point of the stack profiles is that the *shape* is shared and the *content*
is not.

## 4. The 10 rulings

Six are syntheses that preserve both original positions as distinct tiers. Four are
mechanical. Every ruling lands in `docs/decisions/ADR-NNN.md` before any canonical file is
authored.

| # | Conflict | Ruling |
|---|---|---|
| 1 | garmin **autopushes** (DoD #8 "Committed and pushed") vs social pair **forbids** push | Commit locally, report the SHA, **push only on explicit approval**. garmin's DoD #8 is the single outlier and changes. 4:1 majority, and it is also the safe direction. |
| 2 | social: "extract at 2nd use, a 3rd copy is a defect" vs bunnyland §2: "do not refactor neighbouring code" | **Synthesis.** Never refactor code outside the current change's blast radius. Within it, a second real use extracts, and the extraction is finished — no orphaned imports, exports, styles or files. A third copy is a defect; a single-caller abstraction is a defect. Both halves survive verbatim. |
| 3 | social pair: "running a full suite is a defect, not diligence" vs bunnyland: `fail_under=100` + full gate pre-push | **Synthesis.** Focused is the default. The full suite is a *trigger*, not a sin. Triggers: phase exit, release, cross-system behaviour, a repo-declared numeric gate, explicit request, pre-push on a protected branch. Re-running it as a progress meter is a defect (bunnyland already says exactly this). |
| 4 | social-api: "lint/format are enforced by the pre-commit hook — do not run them manually" vs bunnyland: run ruff + `git diff --check` by hand | **Synthesis.** The hook owns format and lint for staged files — do not re-run what the hook just ran. Manual runs are correct when the hook is not installed, when something failed, or when the check is not hook-covered. |
| 5 | 1000-line hard split vs 400-line "smell threshold, not a hard gate" | **Tier both.** 400 = review trigger. 1000 = hard ceiling. Generated files exempt. Nothing is lost. |
| 6 | `fail_under=100` vs garmin memory budgets vs *no number at all* | **Evidence discipline is central; the number is declared per repo.** Central mandates the qualitative bar — 100 % pass, no unjustified skips, behavioural test delta, named commands. The numeric threshold is a repo-declared constant. The central file specifies *how to declare it*, never the value. |
| 7 | 3 capitalisation variants of section headings | One canonical skeleton. Mechanical. |
| 8 | `BLOCK` only vs `APPROVE / APPROVE WITH RESIDUAL RISK / BLOCK` | Adopt the 3-value vocabulary everywhere; update the `.mdc` files to match. |
| 9 | `<name>/SKILL.md` vs flat `.md` missing `name:` | Central mandates `<name>/SKILL.md`. Wrap bunnyland's `coverage-hunt.md`. |
| 10 | "no `npx`/`npm exec`" vs "no `uv run pytest`" | Already agrees — same rule, two ecosystems, same rationale (console entrypoint loses the import path). Pure promotion. |

## 5. Target layout

```
simt-dev/
├── README.md
├── docs/
│   ├── decisions/          ADR-001 … ADR-010, the rulings above
│   └── plans/              this plan, 0002 (the CLI)
├── rules/                  canonical, one .mdc-ready file per rule
│   ├── simt-core.mdc
│   ├── simt-intake-questions.mdc
│   ├── simt-test-gate.mdc
│   ├── simt-preview-postflight.mdc
│   └── stacks/             kotlin, gradle, connectiq, python,
│                          typescript, cloudflare-workers, react-rtl, less-css
├── skills/<name>/SKILL.md  canonical shared process skills
├── agents/<name>.agent.md  canonical + symmetric-pair agents
├── tooling/                prettier, editorconfig, tsconfig.base, eslint,
│                          gitattributes, nvmrc, commitlint, dependabot
├── hooks/{pre-commit,pre-push}
├── scripts/sync.mjs        the generator — zero runtime deps, node + git only
├── .github/workflows/simt-dev-sync-check.yml
└── git.config              (already here)
```

`scripts/sync.mjs` is deliberately **zero-dependency Node**: the lowest common denominator
across six engines-less repos, and it matches an existing house pattern (simt-space already
ships zero runtime deps).

## 6. Phases

Each phase has an exit criterion. Phases 4–6 are per-repo and independently revertable.

**Phase 0 — Rulings.** Blocking. Get sign-off on the 10 contradictions, especially #6.
Written into `docs/decisions/`. Nothing else starts; every canonical file is a direct edit
of one of these positions.

**Phase 1 — Scaffold.** README, ADRs, directory skeleton, `sync.mjs` v0 (marker-region
injector + `--check` mode). No consuming repo touched.

**Phase 2 — Author canonical content.** The 4 always-on rules, 8 stack profiles, 4 process
skills, 8 agent policies, tooling baselines, hook library. Each canonical file records which
files it replaces and why.

**Phase 3 — Prove the engine.** `sync.mjs --check` exits non-zero on drift. Reusable workflow
live.

**Phase 4 — Pilot, 3 repos: one web, one API, one mobile.** One per consumer surface, so the
pilot proves the three shapes the estate actually ships rather than three shapes that happen
to be easy to find.

| Repo | Surface | Why this one |
|---|---|---|
| `simt-space` | web | **Zero agent configuration at all** — no `AGENTS.md`, no `.agents`/`.cursor`/`.claude`, so `init` scaffolds from nothing (`0 -> 6387` bytes). A hand-written `.git/hooks/pre-commit` (4 KB, the best prose in the estate) sits in the *default* location with `core.hooksPath` unset, so adopting the dispatcher means taking over a hook nobody declared. The only `printWidth: 120` prettier config, prettier installed with **no script invoking it**, no `.editorconfig`, and the only repo with a two-entry `git.config` include. `wrangler.jsonc` makes it a Workers repo, so it selects `core + cloudflare-workers` rather than the `node` fallback |
| `simt-social-api` | API | The only pilot that **adopts an existing `AGENTS.md`** (`12850 -> 19238`, hand-written content preserved outside the markers) and the largest agent surface in the estate: 6 agents + **18 skills** + 3 `.mdc`. Canonical owner of `add-country-galaxy` (the 238-line cross-repo playbook), so retiring the web stub has to happen here. Holds the producer-side `BLOCK` bullet that `simt-social` is missing, the credential-handling prohibition that conflicts with the web copy's build-config bullet, `has-migrations-dir`, and a `pre-push` with a 90-line Cloudflare API Shield publish block. A production-branch push is a production deploy with D1 migrations, so ADR-001 is load-bearing here. Reports 1 duplicate (`AGENTS.md:29`, ADR-005) — reported, not blocking |
| `simt-app` | mobile | Also **no `AGENTS.md`** (`0 -> 5667`), but with **12 `.mdc` + 7 skills already in place**, so it is the case where a scaffolded central region has to coexist with a repo's own hand-written rules rather than be the only rules. Proves the Kotlin/Compose/Wear profile, including the Wear `applicationId` invariant. `core.hooksPath hooks` points at a directory whose `pre-push` was deleted in `ca0e803b4`, leaving the real git-lfs `pre-push` in `scripts/hooks/` unreferenced |

Three routes that are genuinely different: **scaffold with nothing to collide with**
(`simt-space`), **adopt an existing `AGENTS.md`** (`simt-social-api`), and **scaffold beside
an existing rules layer** (`simt-app`). A mechanism that survives all three has no fourth
shape to meet in this estate.

**What this trio no longer covers, stated rather than hidden.** The earlier draft picked
`bunnyland-server` for its byte-identical `CLAUDE.md`, the `python` profile and the estate's
only declared numeric coverage bar (`fail_under = 100`), and `simt-social-media` for having
the worst `.mdc` drift. Swapping to one-web/one-API/one-mobile drops both, which means:

- `rules/stacks/python.md` and `rules/stacks/container.md` are **not** exercised in the
  pilot. `bunnyland-server` is the sole Python repo and the only Dockerfile holder besides
  `simt-goto`; both adopt in Phase 5, and both profiles are already verified by `simt init`
  dry-run today.
- The duplicate-`CLAUDE.md` repair stays in Phase 6, where it already had a line.
- `simt-social-media`'s missing `intake-questions.mdc` and its 3-trigger `test-gate.mdc` are
  **unmeasured by the pilot**. That is the largest remaining risk in this swap: media is a
  Cloudflare Worker with the *least* process scaffolding in the estate, so if adoption
  depends on scaffolding already being present, the pilot would not reveal it. Mitigation
  without changing the trio — `simt-social-api` adopts the same three `.mdc` families, so
  retiring the drifted twins in Phase 6 covers media, and media's two missing rules are
  restored by the canonical `intake-questions` it never had rather than by migrating its own.

Three web repos against one Python repo is the shape the estate actually has, which is why
this trade is worth stating rather than arguing.

**Phase 5 — Roll out the remaining 13**, grouped by stack so one set of decisions covers a
group: Workers/TS (social, social-media, api, goto, jobs) · static/LESS (blog, landing,
social-landing) · JVM (garmin, wakt-app) · Python (bunnyland-server) · bare (app-ui,
space-review). `simt-app`, `simt-social-api` and `simt-space` are the Phase 4 pilots and are
not repeated here; `simt-dev` is the tool and never adopts itself.

**Phase 6 — Retire the duplication.** Delete the 13 tracked `git.config` copies (keep
simt-space's local fallback — it already works and is proven). Replace bunnyland's
byte-identical `CLAUDE.md` with a pointer. Collapse the 7 drifted Social skill twins to
canonical + stub. Add `git.config` and `graphify-out/` to `.prettierignore`.

**Phase 7 — Defect sweep.** Independent of centralisation, do it while the context is fresh:
garmin's malformed ```bash fence, broken DoD numbering and permanently-red `memcheck` gate
· simt-app's orphaned git-lfs `scripts/hooks/pre-push`, unreferenced since `hooks/pre-push`
was deleted in `ca0e803b4` · simt-space's dead prettier install (no script invokes it) ·
the 8 dangling references (`web-perf`, `pages/`, `workers-ai/`, 5 firebase files) ·
`app-ui-submodule.mdc`'s hardcoded `/Users/said.elimam/...` absolute path · npm Dependabot ·
`packageManager` · the 3 `.nvmrc` files.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Marker parsing corrupts a hand-edited `AGENTS.md` | Markers are idempotent; `--check` diffs before writing; every repo gets a branch + `backup-before-simt-dev` tag before its first sync |
| Teams bypass the gate | The reusable workflow is required-status-check-able; the pre-commit hook runs `sync --check` too |
| Canonical files grow a lowest-common-denominator that fits nobody | Stack profiles are separate files, never inlined into `simt-core.mdc`; core stays ~200 lines and stack-agnostic |
| simt-dev churn cascades into 16 repos | The marker stores the source SHA, so a broken sync is *detected*, not silently half-applied. `simt-dev upgrade --all` raises all pins as one reviewable operation |
| Everything at once | Phases 4–6 are per-repo, independently revertable |

## 8. Optional thin layer (layer 0)

A global `~/.claude/CLAUDE.md` and `~/.agents/skills/simt-dev/` entries carrying only the
rules that apply *outside* a repo — never `--no-verify`, read scripts before running them,
`simt-dev check` before claiming done. Explicitly documented as **not** a source of truth so
it can never become a divergent fourth copy. See `0002-simt-dev-cli.md` §8.

## 9. The doctrine that keeps this from rotting

Promote the review agent's checklist item 5 — which today exists in exactly one file and is
aimed at precisely this problem — into a first-class central rule:

> Every shared rule has exactly **one** canonical home. Every other location is either a
> generated region or a thin pointer. Repeated policy text, duplicated source-of-truth,
> verbose prose and redundant examples are **review blockers**, not style nits.

Then point the consolidated review agent at the drift check. The gate and the rule defend
each other.
