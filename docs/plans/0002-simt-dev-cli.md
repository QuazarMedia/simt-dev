# Plan 0002 — `simt-dev`: the CLI that makes the ecosystem self-installing

Status: **proposed**
Created: 2026-10-05
Depends on: `0001-centralise-agent-rules.md`
Package: `@quazarmedia/simt-dev`, binary `simt-dev`
Runtime: Node >= 20, **zero runtime dependencies**

---

## 1. What this is

One binary that makes the SIMT rules ecosystem installable, verifiable and discoverable:

1. **Onboarding a repo is one command.** `simt init` adopts an existing repo or scaffolds a
   new one into the ecosystem - manifest, generated rule projection, hooks, gates, skills,
   CI check. Not a rewrite; a diff.
2. **Skills install into any repo locally**, for the cases a central rule cannot cover.
3. **An agent fetches only the skills it needs**, resolved deterministically from a declared
   graph and the repo it is standing in.

The third point is the interesting one and gets the most design attention.

### 1.1 The problem it actually solves

The estate carries 46 skill entries / 928 KB. Dumping that into any agent's context is
unusable. Dumping *nothing* means the agent does not know what exists. A naive "load
everything relevant" heuristic is either too broad (wasting context on a 552 KB Cloudflare
reference while adding a Room migration) or too narrow (silently missing the one skill that
encodes a hard rule).

The fix is the idea that makes skill systems work inside a single agent: **progressive
disclosure**. Descriptions are cheap. Bodies are expensive. Never conflate them.

**Critical framing: we optimise for model context, not for disk.** 928 KB on disk is
nothing. 928 KB in a 200 KB context window is fatal. Every decision below is about *what
enters the context*.

## 2. Design principles

| # | Principle | Consequence |
|---|---|---|
| 1 | **Deterministic, not probabilistic** | Same repo + same task = same answer, forever. No embeddings, no LLM in the resolution path. A rules system whose behaviour changes when the model changes is not a rules system. |
| 2 | **Explainable or it does not ship** | Every selection traces to a named signal. `simt skills why <name>` prints the chain. |
| 3 | **One manifest per repo** | `simt-dev.json` declares identity, stack, limits, gates and local pins. One file answers every question the tool needs. |
| 4 | **Never destroy hand-written work** | Generated regions only. Every mutation is `--dry-run`-able and reversible. |
| 5 | **Zero dependencies** | A DX tool that needs an install step is a DX tool that fails on a fresh machine. Node built-ins only. |
| 6 | **Output is designed for a reader, not a terminal** | One fact per line, stable field order, no colour when piped, no spinners, no boxes. See section 6. |
| 7 | **One call, not N** | The common case is a single tool call returning a pre-assembled brief. |
| 8 | **Dogfood** | `simt-dev` itself is the first adopter of its own gates. |

## 3. The skill graph

### 3.1 Why a declared graph, not inferred structure

Structure is **hand-authored and reviewable** in `graph/skills.graph.json`, validated by
`simt graph lint`. Inference produces surprising results that cannot be reviewed in a pull
request - fatal for a rules system.

Nodes are `capability` (a verb or topic: `test`, `commit`, `maps`, `a11y`, `migrate`) and
`skill` (a `SKILL.md`). Edges:

| Edge | Meaning | Effect on resolution |
|---|---|---|
| `covers` | capability -> skill | primary match signal |
| `requires` | skill -> skill | hard closure: always pulled in, even past budget |
| `alias-of` | skill -> skill | canonical target replaces the alias (`milestone-commit -> slice-commit`) |
| `variant-of` | skill -> skill | siblings; only one is eligible, chosen by stack tags |
| `supersedes` | skill -> skill | retired node; warns, excluded unless explicitly requested |
| `conflicts-with` | skill -> skill | mutually exclusive; resolution errors rather than guessing |

`variant-of` is what kills the 2-repo duplication problem cleanly: `web-security-review` and
`api-security-review` become variants of one `security-review` capability, and stack tags pick
the right body. Same for `complete-testing`, `bug-commit`, `slice-commit` and
`postflight-preview-check`.

### 3.2 Node record

```json
{
  "name": "d1-safe-change",
  "kind": "skill",
  "summary": "Create, review, test, or deploy a D1 schema change.",
  "stack": ["cloudflare-workers", "typescript", "d1"],
  "paths": ["migrations/**", "wrangler.jsonc"],
  "keywords": ["migration", "schema", "index", "trigger", "idempotency"],
  "bytes": 3534,
  "deferred": false,
  "requires": ["complete-testing", "observability-review"]
}
```

`deferred: true` means the body is large enough that the resolver returns a pointer plus the
exact fetch command instead of the content. `cloudflare` (552 KB, 81 references) and `wrangler`
are the first candidates.

### 3.3 Catalog - `simt skills index`

One line per skill, fixed field order, no wrapping, sorted by name:

```
name                bytes  stack           summary
add-country-galaxy  15604  cf-workers      Onboard a launch galaxy across api + web
api-contract-sync   2973   cf-workers react  Sync web code with the generated OpenAPI contract
```

~46 lines, cheap enough to hold in context permanently. This is tier 0.

## 4. Resolution - the core algorithm

```
resolve(repo, task, budget) ->
  1. fingerprint(repo)       -> stack tags          [deterministic]
  2. signal(task)            -> capability scores   [deterministic]
  3. score = weighted sum, gated by stack compatibility
  4. closure: walk `requires` transitively; resolve `alias-of`; pick `variant-of` by stack
  5. prune `supersedes`
  6. sort by score, take until budget exhausted; `requires` closure always included
  7. emit: selected + why + excluded + bytes
```

### 4.1 Fingerprinting

`repo` resolves to a stack tag set from two sources, manifest winning:

- **Declared** - `simt-dev.json` `stack: [...]`, committed and reviewable.
- **Detected** - marker files: `build.gradle.kts` -> `gradle`; `*.mc` / `monkey.jungle` ->
  `connectiq`; `wrangler.jsonc` -> `cloudflare-workers`; `pyproject.toml` -> `python`;
  `vite.config.*` -> `node-web`; `package.json` deps -> `react` / `firebase` / `maplibre` /
  `less`; `.kt` plus a `wear/` module -> `wear-os`.

`simt doctor` reports manifest-vs-reality divergence. This also means **a new repo is
classifiable with no configuration at all** - detection alone gets you most of the way, and
the manifest exists to make the remainder explicit and reviewable.

### 4.2 Signals, in weight order

| Signal | Weight | Source |
|---|---|---|
| Path match against `paths` globs | highest | staged/dirty files, or `--paths` |
| Capability keyword hit in the task text | high | `keywords` + capability aliases |
| Stack compatibility | gate | `stack` tags |
| Always-on (`core` capability) | forced | pinned rules, never dropped |
| Explicit `--skill` | forced | escape hatch |

Files in the diff lift too: `wrangler.jsonc` in the staged set implies the Cloudflare stack
regardless of what the task text says.

### 4.3 Why not semantic search

Considered and rejected as the default:

- **Non-determinism.** Identical input can yield different selections. Unacceptable for a
  rules system; it makes "did the agent follow the rules?" unanswerable.
- **Needs a network round trip or a local model** on every resolution - the opposite of
  principle 5, and it fails closed exactly when a repo is offline.
- **Not reviewable.** A PR cannot meaningfully diff "the top-k nearest neighbours".
- **Recall is not the bottleneck.** The registry is 46 nodes. Keyword + path + stack signals
  resolve it with high precision. Semantic search solves a problem this registry does not have.

Offered as an explicitly non-canonical escape hatch: `--semantic` (requires an opt-in
provider), and it forces `--budget` to be explicit. Its output is labelled advisory and can
never satisfy a gate.

### 4.4 Progressive disclosure - three tiers

| Tier | Command | Typical size | When |
|---|---|---|---|
| 0 | `simt skills index` | ~6 KB | Optionally permanent. Every name, one-line summary, stack, size. |
| 1 | `simt skills brief --task "..."` | 4-20 KB | **The default.** Pre-resolved, pre-assembled, single call. |
| 2 | `simt skills show <name>` | 3-40 KB each | Only when the agent needs one specific body. |

Tier 1 is the product. One call returns:

```
RESOLVED 5 skills - 14.2 KB - repo simt-social-api (cf-workers, typescript)

RULE  simt-test-gate          1.1 KB  always
SKILL d1-safe-change          3.5 KB  path:migrations/**
SKILL complete-testing        6.3 KB  requires:d1-safe-change
SKILL api-feature-slice       4.5 KB  task:"route" stack:cf-workers
SKILL slice-commit            4.9 KB  task:"commit" stack:cf-workers

NOT SELECTED
  web-feature-slice   variant-of:api-feature-slice, stack react != cf-workers
  wrangler            deferred (18.4 KB) - simt skills show wrangler
  firebase-basics     stack mismatch

OVERRIDE  --skill <name> | --budget <bytes> | --all
```

The **NOT SELECTED** block matters as much as the resolved one: the agent can see what exists
and why it was excluded, and override in one token instead of guessing. Suppressing this block
is how discovery tools turn into black boxes.

## 5. Commands

```
simt init [path]              adopt or scaffold a repo into the ecosystem
simt doctor                   env + config health; manifest vs reality; hooks; drift
simt check                    the gate - projection drift, manifest validity, policy gates
simt sync [--check]           regenerate the projection (idempotent)
simt upgrade                  move every consumer to this simt-dev SHA, as one set
                             (dry-run unless --yes; moves a pin only, never adopts or
                             repairs a repo, never commits or pushes)

simt skills index             tier-0 catalog
simt skills brief --task      tier-1 pre-assembled brief  <- the common case
simt skills show <name>       tier-2 body (respects --max-bytes)
simt skills why <name>        the signal chain that selected it
simt skills find <query>      raw search across capability + keyword
simt skills install <name>    pin a skill into the repo as a local override
simt skills graph [--mermaid] capability/skill graph

simt rules list|show|why      rules with provenance back to the ADR that settled them
simt hooks install|status     install the shared dispatcher; report what it would run
simt compare                  org-wide matrix: every repo x rules SHA, hooks, gates, skills
simt mcp                      the read-only surface as MCP tools over stdio (optional)
```

`simt compare` is the org-level dashboard the 2026-10-05 audit had to reconstruct by hand.
Making drift visible in one command - instead of in a 40 KB read-only audit - is most of the
value.

### 5.1 `simt-dev.json` - the one manifest

```json
{
  "id": "bunnyland-server",
  "stack": ["python", "uv", "ecss"],
  "limits": { "coverage": 100, "fileLines": { "warn": 400, "error": 1000 } },
  "gates": { "preCommit": ["format", "lint", "i18n"], "prePush": ["coverage"] },
  "localSkills": ["coverage-hunt"],
  "projection": { "simtDevSha": "<pinned>", "syncedAt": "<iso>" }
}
```

`limits` is where ruling #6 from plan 0001 lands in code: the central rule mandates *evidence
discipline*; the numeric bar is a declared value in this file. `localSkills` is where a repo's
private skills live without touching the central registry. `projection` makes drift
detectable rather than invisible.

## 6. Output design - the part everyone gets wrong

Terminal tools optimise for human eyes: boxes, colour, aligned columns, spinners, progress
bars. **Agent tools optimise for tokens.** The data is identical; the rendering is not.

| Human default | Agent default |
|---|---|
| Boxed, coloured, aligned | One fact per line, fixed field order, no wrapping |
| Spinner while working | Silent; the exit code is the signal |
| Truncated with an ellipsis | Truncated with an explicit `TRUNCATED at N bytes` line |
| `--json` opt-in | Plain text default; `--json` for structure |
| Scrollable | Bounded; `--max-bytes` is a hard ceiling |

Tool-wide:

- No ANSI when stdout is not a TTY or `NO_COLOR` is set.
- Every non-zero exit carries a stable machine code plus a one-line remedy.
- `--dry-run` on every mutating command; `--yes` to skip prompts in automation.
- `--json` output is stable and documented, so agents parse it instead of scraping prose.
- Nothing prompts. An agent cannot answer a prompt; a prompt is a hang.

## 7. Installation and bootstrapping

| Method | Command | Use |
|---|---|---|
| Zero-install | `npx -y @quazarmedia/simt-dev@latest <cmd>` | CI, one-offs, no install |
| Global | `npm i -g @quazarmedia/simt-dev` | Local dev loop |
| Project dev-dep | `npm i -D @quazarmedia/simt-dev` | Pinned and reproducible in CI |

Bootstrapping is a **skill, not a README**. `~/.agents/skills/simt-dev/SKILL.md` (layer 0 from
plan 0001 section 8) documents the `npx` invocation, the three commands that matter
(`doctor`, `brief`, `check`) and the exit codes. An agent that reads that one file can drive
the whole ecosystem with no prior knowledge - which is the entire point, because an agent
landing in a new repo has no prior knowledge.

`simt mcp` exposes the same surface as MCP tools for editors that prefer tool calls to shell,
but the CLI stays the primary interface: it works in CI, in a hook and in a bare shell.

## 8. Onboarding flows

### 8.1 New repo

```
$ simt init
detected: connectiq (monkey.jungle, *.mc, manifest.xml)
created   simt-dev.json
created   AGENTS.md  (generated region: core + connectiq profile)
created   hooks/     (pre-commit wired to core/connectiq gates)
skipped   .prettierrc, .editorconfig - no JS/TS content detected
next: edit simt-dev.json to confirm stack, then: git commit
```

Every line is a decision the tool made, with a reason. Nothing is silent.

### 8.2 Adopting an existing repo

`simt init` on a repo that already has rules:

1. **Never overwrite.** Wrap existing hand-written content; the generated region goes inside
   markers.
2. **Report conflicts before writing.** simt-garmin has an autonomous-push rule that directly
   contradicts ruling #1; simt-social-media is missing `intake-questions` entirely. Print both
   sides, then require `--accept-conflicts` or a manual edit.
3. **Create a branch and a `backup-before-simt-dev` tag** before the first write, always.
4. **Show the full diff** - `--dry-run` is the default for adoption.

### 8.3 Skills into any repo

`simt skills install <name>` pins a skill locally - for a repo-specific procedure the central
registry should not carry, or to pin a version ahead of a rollout. Installed skills are
recorded in `simt-dev.json` `localSkills` and are excluded from central-drift accounting.

## 9. Correctness and trust

- `simt graph lint` - orphan nodes, dangling edges, cycles in `requires`, capability nodes with
  no `covers`, `variant-of` groups with no stack discriminator.
- `simt skills eval` - a corpus of real tasks x real repos with **gold** expected selections.
  Reports precision and recall and fails on regression. A resolver that is not measured is a
  resolver that is merely felt.
- `simt skills why` - every selection traces to a named signal, always.
- `simt check` in CI - the projection SHA in each consuming repo must match the simt-dev
  release it claims, and `graph lint` must pass on the registry itself.

## 10. Repo layout for the tool

```
simt-dev/
├── package.json          bin: { "simt-dev": "bin/simt-dev.mjs" }, no dependencies
├── bin/simt-dev.mjs      argv parse, dispatch, exit codes
├── src/
│   ├── commands/         init, doctor, check, sync, compare, skills/*, rules/*, hooks/*
│   ├── resolve/          fingerprint, signal, score, closure, budget
│   ├── graph/            loader + validator for graph/skills.graph.json
│   ├── projection/       marker-region injector (from plan 0001 section 2.2)
│   └── output/           tty detection, --max-bytes, --json, exit codes
├── graph/skills.graph.json
├── rules/ skills/ agents/ tooling/ hooks/    (canonical content, plan 0001)
└── test/
    ├── fixtures/         synthetic repos, one per stack
    └── gold/             tasks.json -> expected skill sets
```

Zero dependencies means argv parsing, glob matching and JSON Schema validation are all
hand-rolled or skipped. That is acceptable: the graph is small enough that a plain-JS
validator is ~150 lines, and dropping `dependencies` is what makes `npx` instant and
`npm audit` clean.

## 11. Implementation sequence

| Step | Deliverable | Done when | State |
|---|---|---|---|
| 1 | Package skeleton, argv dispatch, exit codes, output layer | `simt --help` and `simt nope` both behave | done |
| 2 | `graph/skills.graph.json` covering all 38 unique names | `simt graph lint` clean, no orphans | done |
| 3 | `fingerprint` + detector tests | all 16 repos classify correctly from marker files alone | done |
| 4 | `skills index` / `find` / `show` | index under 6 KB for the full registry | done (5 663 bytes for 38 skills) |
| 5 | `skills brief` + `why` + `install` | `eval` corpus passes; every selection traceable | done (`install` pins a skill into a repo and records its provenance) |
| 6 | Projection engine + `simt check` + `rules list\|show\|why` | drift detected in a deliberately stale repo | done (`rules why` closes the loop from a rule line back to the ADR that settled it) |
| 7 | `init` with conflict reporting | dry-run adoption produces a reviewable diff on all 3 pilots | done |
| 8 | `hooks` dispatcher | one pre-commit works across all 3 pilot stacks | **done** (141 tests; fail-closed, ADR-004 staged-only, ADR-010 no `npx`) |
| 9 | `compare` | replaces the hand audit | **done** (org matrix: adoption, region, hooks, gates; worktrees attributed not double-counted; exits non-zero only on defects, not on non-adoption) |
| 10 | `mcp`, `upgrade`, `upgrade --all` | round-trips simt-dev's own SHA | **done** (`upgrade` moves a pin and nothing else; `mcp` is a read-only stdio surface over the same modules; 307 tests) |
| 11 | Genericity: emitted facts + repo-local profiles | a repo can adopt an unknown ecosystem with no engine change | **done** (ADR-013; 20 facts, `KNOWN_TAGS` one vocabulary, local profiles, `container` profile on `has-dockerfile`) |
| 12 | Workspace as configuration; single repo is first class | a published install works with no workspace, and one repo is a supported shape | **done** (ADR-014; `--workspace` / env / config file / verified heuristic, `off` sentinel, degraded mode, 32 consumer-shaped tests) |
| 13 | A source is content; the repo is a location | a single-repo clone can install and show with no workspace | **done** (ADR-015; byte-verified lookup at the workspace location and the repo location, `sourceHeldLocally` as a resolution signal, contradiction refused / ambiguity decided) |

Steps 1-5 are useful with zero content migration and land first, because they deliver the
token win (tier 0/1/2 discovery) before any repo has changed. Step 6 then proved the
distribution mechanism against a scratch copy of a real repo: an unmanaged file, a body edit,
a stale-SHA-only edit and a malformed region each fail the gate with a distinct remedy, a
second `sync` is a byte-for-byte no-op, and hand-written content outside the markers survives
a round trip identically.

Step 11 was pulled **ahead of step 9** deliberately. It changes the tag vocabulary every
later step reads, so `compare` and `mcp` are both cheaper once it is settled. Its scope and
ruling are [ADR-013](../decisions/ADR-013-genericity-by-facts-and-local-profiles.md); the
design is §14.

Step 9 then made the estate's state readable in one command instead of by hand. Three of its
decisions are worth stating, because each one is a place where the obvious implementation
would have been quietly wrong:

- **A git worktree is attributed, not counted.** `.git` may be a directory (a repo) or a file
  (a worktree). A scan that only looked for directories omits every worktree, and an agent
  reads absence as "nothing there". A worktree is also not an independent consumer - its
  files are its parent's HEAD checked out elsewhere - so reporting it would double-count one
  repo's drift.
- **A non-repo directory is counted, not dropped.** `simt-space-review` is 25 PNGs. Hiding it
  would hide the fact that a workspace member is unmanaged, which is the class of finding this
  command exists to surface.
- **Non-adoption is not a defect.** The exit code is non-zero when something is *wrong* (drift,
  a malformed region, a gate the dispatcher cannot run) and zero when repos are merely not
  adopted yet. On day one of a migration 16 of 16 repos are unadopted; a command that went red
  for that would train everyone to ignore it, and the signal that matters would be lost.

Two findings it produces that a per-repo view cannot:

- **Declared stack vs detected stack.** `simt-dev.json` records what the repo claims to be;
  `fingerprint` records what the files prove. Selection uses detection, so a stale claim does
  not change what is projected - but it does mean the manifest misdescribes the repo, and a
  reader of the manifest is misled. Reported rather than silently reconciled, because picking
  a winner would hide the edit that caused it.
- **Which drift you have.** A region whose recorded SHA already matches this simt-dev was
  hand-edited; one whose SHA differs is simply behind. Both are fixed by `simt sync`, but they
  are different problems, and reporting "projection is X but this simt-dev is X" for a
  hand-edit sends the reader looking for a version problem that does not exist.

`rules list|show|why` and `skills install` completed the command surface without either
command growing a new mechanism. Four decisions are worth recording:

- **`rules why` runs in both directions.** Given a rule id it prints the decisions that settled
  it; given `ADR-NNN` it prints the rules that decision restsates. Only the first direction is
  obviously useful, but the second is the one a reviewer needs: the audit's problem was never
  "why does this rule exist", it was "which of these thirteen rules is this ADR talking about".
- **A rule that cites no ADR is reported, not passed over.** `react-web` prints
  `provenance NONE`. Returning an empty list would look identical to "no decisions involve
  this", which hides precisely the finding a reviewer needs — prose with no decision behind
  it is how the 2026-10-05 audit happened in the first place.
- **A superseded record is a warning, not a failure.** `rules why ADR-011` exits 0 and says the
  record was retained as evidence for [ADR-012](../decisions/ADR-012-drop-windows-support.md).
  A retained record is the supersession rule working; making it exit non-zero would pressure
  a future author into editing the ruling in place, which is the one thing that rule forbids.
- **`skills install` picks the variant from the repo's own signals and refuses on
  ambiguity.** It never guesses. That refusal immediately earned its keep: the `api` variants
  of the five duplicated skills declared `["cloudflare-workers", "hono"]`, and since
  `simt-social` ships its own `wrangler.jsonc` it *also* emits `cloudflare-workers` — so every
  variant matched both repos and install refused everywhere. Narrowing them to `["hono"]`, the
  tag that actually discriminates, fixed a registry defect that no structural lint could see.
  Lint can check that variants are pairwise disjoint; it cannot check that the tag is
  *discriminative in practice*.

## 12. Rulings on the open questions

Settled 2026-10-05. Recorded as ADRs in `docs/decisions/`.

1. **`brief` supports both.** Inlines resolved bodies by default, truncated at `--budget`
   (default 20 KB), so one call usually suffices. `--plan` emits a fetch plan for the large
   cases — `cloudflare` (552 KB, 81 references), `prototype-ui-fidelity` plus its 14 KB
   reference. Fewest round-trips without losing a floor on context.
2. **Monorepo: design for it, don't ship it.** The fingerprint accepts an explicit root,
   detection is a bounded recursive scan, and resolution takes an optional path filter — so a
   future workspace needs no resolver rewrite. No workspace manifest format, no monorepo UI,
   no tests for a thing no repo needs.
3. **The graph stays in simt-dev.** The apparent counter-argument does not hold: the tool reads
   `skills.graph.json` from whatever SHA a repo pins, so content edits require only a simt-dev
   commit and never an npm publish. Only tool *code* changes need a release. One repo, one pin,
   one CI.
4. **One pinned SHA for everything.** `projection.simtDevSha` pins rules, skills, agents and
   tooling together. Per-artifact pinning is rejected because skills hard-reference rule files
   — `postflight-preview-check` cites `.cursor/rules/preview-postflight.mdc` — so independent
   pins can produce rule+skill combinations nobody tested.
5. **POSIX only: macOS and Linux.** `package.json` declares `"os": ["darwin", "linux"]`, so npm
   refuses the install on Windows with a clear message rather than failing obscurely inside a
   git hook. Initially ruled as Windows-v1 support and reversed the same day — see
   [ADR-011](../decisions/ADR-011-windows-support.md) and
   [ADR-012](../decisions/ADR-012-drop-windows-support.md). No repo in the estate has a
   Windows developer or a Windows-ready toolchain, so the CLI would have been the only
   Windows-ready artefact serving nobody, at the cost of three permanent obligations on the
   hook dispatcher and the projection injector. The projection injector still normalises line
   endings, which is a cross-POSIX problem: 10 of 16 repos have no `.editorconfig`.
6. **Package is `@quazarmedia/simt-dev`, binary `simt-dev`.** Publish requires npm org
   membership with publish rights on the QuazarMedia scope; first publish is a one-off manual
   step by the org owner.

## 13. What this deliberately does not do

- **Does not auto-commit or auto-push.** `simt init` proposes; the human or agent commits.
  Ruling #1 from plan 0001 applies to the tool that enforces it.
- **Does not merge repos or move content between them.** `add-country-galaxy` stays in
  simt-social-api as the canonical owner with a stub in simt-social; that pattern is a
  content decision, not a tooling one.
- **Does not run tests.** `simt check` verifies policy and projection. Executing a repo's test
  suite is the repo's own gate, declared in `simt-dev.json`.
- **Does not become a package manager.** `packageManager` and `engines` land in the tooling
  baseline; `simt` does not install them.



## 14. Genericity — emitted facts, local profiles, and where a hosted service is allowed

The tool is named for SIMT; the mechanisms are not. Measured: `argv.mjs`, `resolve.mjs` and
`graph/load.mjs` contain **zero** non-comment, non-string SIMT references. What is coupled to
SIMT is the *vocabulary* — `fingerprint()`'s three detection tables are keyed by curated
product names (`connectiq`, `hono`, `maplibre`, `react-router`). Library names as stack
identity age badly: a profile selecting on a library breaks the day the library is swapped.

Ruling: [ADR-013](../decisions/ADR-013-genericity-by-facts-and-local-profiles.md).

### 14.1 Two kinds of signal

| | `stack` | `facts` |
|---|---|---|
| Meaning | "this repo is a Cloudflare Worker" | "this tree has a `pyproject.toml`" |
| Source | curated tables keyed by product and library names | evidence observed in the working tree |
| Grows with | new ecosystems (needs a code change) | nothing — the fact was already observed |
| Use it when | precision about a platform matters | you need to survive the framework being replaced |

`fingerprint()` returns both. Selection is the union, so `applies: [has-cargo-toml]` and
`applies: [cloudflare-workers]` are equally valid. Existing profiles keep their `stack` tags —
they are *good* tags; new profiles are expected to prefer a fact where a fact will do. The
observable promise is unchanged and is already tested: **every tag a profile may name is one
the engine emits**, and the registry validator plus the profile loader read that vocabulary
from one derived export so they cannot desynchronise.

`facts` names are `has-*` and are deliberately boring: a manifest, a lockfile, a directory
convention, a container file. None of them encodes an opinion.

### 14.2 Profiles may live in the repo

`simt init` prints where local profiles live, and the manifest gains `profiles: [<id>, …]`
so a reviewer reads the repo's intent rather than inferring it. The directory itself needs no
creation: the first file in it creates it, and an empty directory would not survive git
anyway. Central profiles ship in `rules/stacks/`; **local profiles are read from
`.simt-dev/profiles/*.md`** with the same frontmatter contract (ADR-009) and the same matcher.
A local profile may declare `fallback: true`.

The central directory is still called `stacks/`, which is now historical: a profile is selected
by *signal*, and `container` is not a stack at all.

Local profiles are **additive and shadowing**: a local `id` replaces the central profile of
the same id, and otherwise both are candidates. Central content is never silently overwritten
in place — it is superseded by an explicit, reviewable file. A repo that ships its own
profile has decided something about its own conventions; when that decision is wrong, the fix
is a one-file PR in the repo that is wrong, which is the correct blast radius (ADR-002).

### 14.3 A hosted service may serve authoring; it may never serve resolution

| | Authoring | Resolution |
|---|---|---|
| Hosted MCP is useful | yes — finding profiles, learning an ecosystem, publishing findings | **no** |
| Non-determinism | tolerable: a human reviews the output | fatal: "did the agent follow the rules?" becomes unanswerable |
| Offline | irrelevant | required: a hook and a gate must not depend on a network call |
| Diffable in a PR | partially | required: `simt check` output is the gate's whole product |
| On failure | loudly, at authoring time | must fail **closed**, with a remedy |

Conflating the two yields a tool nobody trusts in CI. Community extensibility therefore
ships as a **registry of portable profile files** in a git repository, fetched and pinned by
the same single-SHA mechanism (ruling #4) that already pins rules — same trust model, no
hosted runtime, and the diff a reviewer sees is the diff of a profile file.

### 14.4 What that looks like in the tree

`rules/stacks/container.md` is the worked example and the only profile keyed purely on a
fact:

```yaml
---
id: container
title: Containers
applies: [has-dockerfile]
---
```

It reaches exactly two of the sixteen repos — `bunnyland-server` and `simt-goto`, the two that
have a `Dockerfile` — and no others. That is the whole claim: a portable profile written
against an observable fact, selected with no engine change, no release, and no central table
entry. Written the other way round, as a `stack` entry keyed on "this repo is a Docker
project", it would have needed a code change and would have gone stale the day a repo switched
to Podman or built with `ko`.

### 14.5 What still genuinely needs an agent

Not detection — detecting Django is one line, and an agent doing it is an agent we had to
trust not to get it wrong. **First-time profile authoring** is the judgement part: deciding
which four rules matter for an ecosystem nobody has written a profile for yet. It stays
bounded because the agent writes *one profile file*, not the engine. That is the whole
extensibility story, and it is why no code contribution is required to support a new stack.

## 15. Where the workspace comes from, and why a single repo is a supported shape

ADR-013 made the *vocabulary* generic. It did not touch the filesystem, and the filesystem was
where the tool was still quietly SIMT-shaped: `WORKSPACE_ROOT` was `resolve(HERE, '..', '..',
'..')` — three levels up from a source file. That is `/code/simt` in the checkout and
`node_modules/@quazarmedia` in an installed package. Every `skills` command and `graph lint`
failed outside the checkout with 38 `ENOENT`s and a remedy (`run: simt graph lint`) that named
a workspace the reader did not have.

Ruling: [ADR-014](../decisions/ADR-014-workspace-is-configuration.md).

### 15.1 Four sources, one answer, and the answer is always printed

| Precedence | Source | Form |
|---:|---|---|
| 1 | `--workspace <path>` | explicit, per invocation |
| 2 | `SIMT_DEV_WORKSPACE` | explicit, per shell or CI job |
| 3 | user config file | persistent, per machine |
| 4 | sibling heuristic | **last, and only if it verifies** |

The config file is read in the OS-appropriate place, first existing candidate winning:
`$XDG_CONFIG_HOME/simt-dev/config.json`, then `$HOME/.config/simt-dev/config.json`, then
`~/Library/Application Support/simt-dev/config.json` on macOS, then `%APPDATA%/…` on Windows.

The heuristic is the parent of the installed package, accepted **only if it actually looks
like a workspace** — a child directory with a `.git` in it. Without that check the heuristic
would "succeed" in `node_modules` and produce a confidently wrong answer, which is worse than
no answer.

Every command that consults the workspace prints which source answered (`workspace /code/simt
(heuristic: sibling of this package)`). An invisible configuration is a configuration nobody
can debug, and the first version of this bug was invisible in exactly that way.

Any source may **decline** with `off` (also `none`, `no`, `0`, `-`). That exists mostly for
tests: without a way to decline the heuristic, no test running from the checkout could reach
the unconfigured path, and the degraded mode would have shipped untested.

### 15.2 Absent, wrong and moved are three different facts

All three produce a warning rather than an error, because none of them is a defect in the tool
— but they need different remedies, so they are not collapsed into one message.

| Fact | Message names | Exit |
|---|---|---|
| absent | how to set one, per source, with the config path for this OS | 0 |
| set but missing | the path **and** which source named it | 0 |
| set but wrong | the path **and** the repos the registry expects in it | 0 |

A workspace that exists but holds none of the repositories the registry names is the case that
matters most: it is what a moved or renamed checkout looks like, and reporting it as "missing"
sends the reader to the wrong place.

### 15.3 The honest boundary

`upgrade` needs to find every repo that consumes this simt-dev, and there is still **no consumer
registry** — the only knowledge of siblings is a one-level-deep scan of the workspace, which
does not exist at all in an npm install. The `compare` row that says `manifest pins simt-dev X,
this is Y; run: simt upgrade` therefore names a command that will land on step 10. That step
has to decide where the consumer set comes from — a workspace root recorded in `simt-dev.json`
is the honest answer for the SIMT estate, and `--root` is the honest answer for everyone else.

## 16. A source is content, and the repo is a location

Section 15 made the workspace optional. It did not make lookup work, and the user who asked for
section 15 found the next defect immediately: someone who cloned **only `simt-social`** has the
`simt-social` body of `slice-commit` at `.agents/skills/slice-commit`, with no workspace, and both
`skills install` and `skills show` said the body was unavailable while it sat in the working tree.

Ruling: [ADR-015](../decisions/ADR-015-a-source-is-content-not-a-location.md).

Three things were wrong, and only the first is a filesystem problem:

1. `sources: [{repo, path, bytes, role}]` resolved at exactly one place, `join(workspaceRoot, …)`.
   The second place is `<root>/<path>` — the repository being operated on *is* a location for a
   declared source when the registry's `repo` is that repository.
2. Variant selection asked the wrong question. A single-repo clone's `package.json` says `node`,
   which matches neither the `web` nor the `api` variant of `slice-commit`, so selection refused —
   while the clone's own 5048 bytes were an exact answer. **The tool asked the manifest a question
   the manifest could not answer and ignored the evidence in front of it.**
3. A byte count can decide identity and a stack tag cannot. Every source declares its size and
   `graph lint` already verifies each declared size against disk, so `locateSource` accepts a
   candidate location *only* when the measured size equals the declared size, and
   `sourceHeldLocally` becomes a resolution signal rather than a fallback.

`chooseSource` precedence, and each step's reason:

| Order | Signal | Why it is here |
|---|---|---|
| 1 | `--from` | Explicit. Obeyed even when it contradicts the repo; the disagreement is a note. |
| 2 | `--variant` | Explicit, same treatment. |
| 3 | the repo's stack signals name one variant | the normal path |
| 4 | **the repo already holds exactly one declared source** | settles both an unmatched repo and an ambiguous one, from evidence rather than a guess |
| 5 | refuse, naming the reason | a refusal must be actionable |

Two rules that look alike and are deliberately opposite: signals naming one variant while the repo
holds another is a **refusal** (one of two inputs is wrong, and installing silently would pick a
side); signals naming several variants while the repo holds one of them **installs that one** (the
bytes are not a guess). And a right-shaped-but-wrong-body file gets its own message — `<path>
exists but is not the declared body (5048 bytes declared)` — because "none of the variants matches
this repo" is true and sends the reader to the wrong place.

`skills show` reads a repo-local body and prints which location answered (`body repo <path>`);
`skills install` prints a matching `read` line. Install still **fails** when it cannot read a body
while `show` still answers, because a catalogue plus a pointer is useful with no workspace and a
half-installed skill is not.

## 17. Step 10 — moving a pin, and a second front door

### 17.1 `simt upgrade` moves a pin and nothing else

One simt-dev commit changes the **rules**, not the mechanism, so every consumer is behind at
once. Plan 0001 named the risk ("simt-dev churn cascades into 16 repos") and answered it with
`upgrade --all`: one operation, one reviewable diff, instead of 16 commands and 16 reviews.

A pin lives in **two** places that must agree, so `upgrade` moves both: the
`<!-- simt-dev:sha=… -->` stamp inside the generated region, and `projection.simtDevSha` in
`simt-dev.json`. The region is written **first**, because the reverse order leaves a window in
which the manifest names a simt-dev whose rules are not on disk yet — and `check` would report
`CURRENT` against a stamp that does not describe the bytes next to it.

The narrowness is the design. `upgrade` does not adopt a repo, does not repair one, and does not
add a region to a repo that never had one:

| state | action | remedy it prints |
|---|---|---|
| no `simt-dev.json` | skip | `simt init` |
| unparseable `simt-dev.json` | skip | fix the JSON, or `simt init` |
| malformed region | skip | fix the markers at `AGENTS.md:<line>`, then `simt sync` |
| manifest but no region | skip | `run: simt sync` |
| pin behind | **update** | — |
| rules changed, pin current | **update** | — |

Those four skips are `FAULT_STATES`; only they fail the run. An unadopted repo is the expected
mid-migration state, and the same doctrine `compare` already applies: a command that goes red
for it teaches people to ignore its exit code, and the signal that matters is lost. The exit
code reports whether **this run** was correct, not how far the migration has got.

Two other things it deliberately does not write:

- **`projection.syncedAt`.** Plan 0002 §5.1 shows it in the manifest. It is not written: a
  timestamp in a file that is reviewed as a diff turns an upgrade that changed nothing into one
  that shows a one-line change, and git already records when a file was modified — strictly
  better than a timestamp inside the file.
- **Commits and pushes.** ADR-001 applies to the tool that enforces it. The diff is left
  uncommitted in each repo, for a human to review and message.

`--root` names one repo (or one workspace); `--all` claims the whole workspace and therefore
**fails** when there is none, because "all of nothing" is a contradiction and defaulting it to
the current directory would make the flag mean nothing. Worktrees are reported and never stamped:
a worktree is its parent's HEAD elsewhere, so writing a pin into it forks one repo's drift across
two directories.

`targetRoot()` in `src/workspace.mjs` now owns the `--root` → workspace → cwd precedence, so
`compare` and `upgrade` cannot disagree about which source named the directory.

### 17.2 `simt mcp` is a transport, not a second implementation

Optional in §5 and it stays optional: the CLI works in CI, in a hook and in a bare shell, and
MCP adds a route to the same answers rather than new ones. Newline-delimited JSON-RPC 2.0 on
stdio, `PROTOCOL_VERSION = 2025-06-18`, hand-rolled to keep the zero-dependency requirement.

Three decisions, each a place the obvious implementation is wrong:

- **stdout is the protocol channel.** Every tool returns a value; nothing writes to the process
  streams. One byte of prose on stdout corrupts the stream, and the client then shows nothing
  and reports no error — because from its side the stream is merely malformed.
- **A tool failure is a result, not a protocol error.** "This repo has no region" is a
  successful call whose answer says the region is unmanaged. An MCP client renders an exception
  as an error dialog and never shows the answer, and the answer is the useful part. Only a
  malformed request and an unknown method are JSON-RPC errors.
- **No mutating tool is exposed.** `init`, `sync`, `upgrade`, `hooks install` and
  `skills install` are absent on purpose: each is meant to be read as a diff by a human before it
  touches anything (ADR-001, ADR-004), and a model can call a tool but cannot review a diff it
  never showed you. `test/mcp.test.mjs` enforces this by name, so a future tool cannot drift in.

The ten exposed tools are `doctor`, `skills_index`, `skills_brief`, `skills_show`,
`skills_find`, `skills_why`, `rules_list`, `rules_why`, `check`, `compare`. They build their own
payloads from the same modules the commands use rather than calling the command functions: the
commands render for terminals, these return JSON for a model, and forcing one renderer through a
transport it was not written for is how a clean abstraction starts lying about bytes. What is
shared is the **logic** — fingerprint, registry, resolver, region planner — because two
resolvers would be two answers to one question.

`skills_brief` never inlines a body: tier 1 is a set of pointers and reasons, and the body is a
separate `skills_show` call. A 384 KB reference inlined into a tool result is exactly the failure
progressive disclosure exists to prevent, and a transport makes it easier to cause by accident
because the caller cannot see the size until it has paid for it.

`--list` prints the surface and exits without reading stdin, because an editor that has
misconfigured the command must be able to ask what it exposes without hanging on a pipe nobody
is writing to.

### 17.3 The acceptance criterion

"Round-trips simt-dev's own SHA" is met in both directions. `upgrade --root <simt-dev>` reports
simt-dev as `not-adopted` and writes nothing — the repo that produces pins is not a consumer of
them. And a repo pinned at an old SHA has both halves moved, `check` returns `CURRENT`, and a
second run is a byte-for-byte no-op. `test/upgrade.test.mjs` asserts all of it against real
repositories adopted by the real `init`.

## 18. Where hooks actually are, and what installing one costs

ADR-018's ruling in full; this section is the operational version, and it exists because the
defect it describes was found by running `hooks install` against a real repository rather than by
running anything at all in the earlier phases.

### 18.1 The two rules, and why git's own answer is not usable

`core.hooksPath` set → that directory, with a relative value resolved against the top of the
working tree. `core.hooksPath` unset → `<git-common-dir>/hooks`. The second rule is the one that
matters, because unset is the default and the default is not empty.

`git rev-parse --git-path hooks` answers this in one call and answers it wrong: it returns
`.git/hooks` in a normal repository, `hooks` in a linked worktree, and `./` in a linked worktree
with the setting unset — because a worktree's `.git` is a file. Trusting it would enumerate a
worktree's entire root as its hooks directory and report every file in the repository as a hook.
Measured on `.wt-wear-redesign`, the difference is between five real hooks and every file in the
repository.

### 18.2 What the estate actually runs

After the fix, `compare` reports what each repository runs today:

| Repository | `core.hooksPath` | Hooks simt-dev did not write |
|---|---|---|
| `simt-space` | unset | `pre-commit` (4088 B, `.git/hooks`) |
| `simt-app` | `hooks` | `pre-commit`, `post-checkout`, `post-commit`, `post-merge` |
| `simt-social` | `scripts/git-hooks` | `pre-commit` (2961 B), `pre-push` (542 B) |
| `simt-social-api` | `scripts/git-hooks` | `pre-commit` (1444 B), `pre-push` (3824 B) |
| `simt-landing` | `.githooks` | `pre-push` (617 B) |
| `.wt-wear-redesign` | `hooks` | the five above plus `pre-push` (350 B, `git-lfs`) |
| `bunnyland-server`, `simt-social-media`, and the rest | unset / absent | none |

Six consumers would have been taken over without a word. The `.wt-wear-redesign` entry is the one
that most rewards the fix: that `git-lfs` `pre-push` is the hook the phase-4 notes recorded as
orphaned, and it is a worktree's hook, which is the only case where `--git-path` is actively
misleading rather than merely awkward.

### 18.3 What each command now does with that knowledge

`hooks status` names the foreign hooks in text and in JSON (`foreign[]`, `hooksDir`), and the
header says `git default: <path>` rather than `(none)`.

`hooks install` refuses without `--yes` when a foreign hook would stop running, naming the file and
its size, and writes nothing. With `--yes` it reports each hook it stopped running and notes that
the file is still on disk.

`hooks install` refuses when no event declares a runnable gate, because a shim with an empty gate
list enforces nothing while still displacing what was there.

`compare` reports foreign hooks as a **note**, never a problem. Six of sixteen repositories run
their own hooks and all six are unadopted, which is the normal state of a migration; a dashboard
that goes red on the day it is introduced is a dashboard everybody stops reading.

### 18.4 A missing shim is only a defect when a gate needs it

A repository that declares no `preCommit` gates has no reason to want a `pre-commit` shim, and its
absence is the correct end state. A repository with no manifest is a different case: we do not know
what it wants, so we cannot rule the shim out. Absence of knowledge is not a decision.

## 19. Which editors get the rule, and which get a pointer to it

### 19.1 The question that was answered wrong

`simt init` wrote two files: the `AGENTS.md` region and `.cursor/rules/*.mdc`. That is not two
surfaces of support, it is **one surface of support and one accident**. Codex, opencode, Cursor,
the DeepSeek harness, Windsurf, Zed, Amp and Jules read `AGENTS.md`, so they were served by the
accident. Claude Code reads `CLAUDE.md` and only falls back to `AGENTS.md` when no `CLAUDE.md`
exists anywhere above the working directory. Copilot's editor and code-review surfaces read
`.github/copilot-instructions.md` and `.github/instructions/*.instructions.md`. Antigravity's
native surface is `.agents/rules/*.md` with a required `trigger:` key it **silently discards** if
it does not recognise.

So the three always-on process rules — the ones a reader most needs — existed for Cursor, and
everybody else received only what happened to be in the `AGENTS.md` region. The rule's own
conflict scanner had been reading `.github/instructions/` for a whole release, because a detector
that reads a surface is half a promise to write it.

### 19.2 The table

`src/projection/surfaces.mjs` is the whole answer, and each row names the document it rests on:

| Surface | Rule file | Frontmatter emitted | Pointers | Readers |
|---|---|---|---|---|
| `agents` | — (the region) | — | — | Codex, opencode, Cursor, DeepSeek, Windsurf, Zed, Amp, Jules, Copilot CLI |
| `cursor` | `.cursor/rules/{name}.mdc` | `description`, `alwaysApply` | — | Cursor |
| `claude` | `.claude/rules/{name}.md` | *none* | `CLAUDE.md -> AGENTS.md` | Claude Code |
| `antigravity` | `.agents/rules/{name}.md` | `trigger: always_on`, `description` | `GEMINI.md -> AGENTS.md` | Antigravity, Gemini CLI |
| `copilot` | `.github/instructions/{name}.instructions.md` | `applyTo: "**"` | — | Copilot editor and code review |

Four decisions in that table are not obvious:

- **A pointer is not a copy.** Both vendors document the symlink, POSIX-only is already in scope
  (ADR-012), and DeepSeek's harness documents the opposite failure: byte-identical candidates
  collapse, so a symlink renders once — while **a real copy that has drifted loads in full
  alongside** `AGENTS.md`. A copy is not a second copy of the rule; it is a second rule.
- **Rule files are generated, not linked.** Symlink support is documented only for
  `.claude/rules/`; writing one into `.agents/rules/` would be a guess with a mode bit. A
  machine-written file derived from one canonical source and verified by `check` is a build
  output, and nobody can hand-edit one and survive a sync.
- **An always-on rule emits no scoping frontmatter.** Claude documents that a rule with no
  `paths:` loads eagerly, and carries a published parser defect where quoted values and YAML
  sequences in `paths:` silently fail to lazy-load. Emitting a scope we do not need, on an editor
  where a malformed scope fails silently, buys nothing.
- **The default is every surface**, narrowed per repo with `"surfaces"` in `simt-dev.json`.
  `--surfaces` wins over the manifest; an empty list is a real choice meaning `AGENTS.md` only.
  Every command prints the set and **where it came from** — ADR-014's ruling, applied again.

### 19.3 What `compare` now reports

One row per repository cannot show four files, so it shows a count: `rules 6/6 current`, and the
stale filenames when they disagree. It is a defect only in an **adopted** repository — an
unadopted one has no rule files at all, and reporting them as "not current" would redden the whole
estate at the normal mid-migration state, which is ADR-018's mistake repeated one layer over. A
missing pointer is likewise not failing; a pointer simt-dev did not write **is** reported, because
overwriting a human's `CLAUDE.md` silently would destroy prose nobody backed up.
