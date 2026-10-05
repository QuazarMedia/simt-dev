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
simt upgrade                  bump every consumer to this simt-dev SHA, as one reviewable set

simt skills index             tier-0 catalog
simt skills brief --task      tier-1 pre-assembled brief  <- the common case
simt skills show <name>       tier-2 body (respects --max-bytes)
simt skills why <name>        the signal chain that selected it
simt skills find <query>      raw search across capability + keyword
simt skills install <name>    pin a skill into the repo as a local override
simt skills graph [--mermaid] capability/skill graph

simt rules list|show|why      rules with provenance back to the ADR that settled them
simt hooks install|status     shared hook dispatcher + this repo's gate list
simt compare                  org-wide matrix: every repo x rules SHA, hooks, gates, skills
simt mcp                      expose everything as MCP tools (optional)
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

| Step | Deliverable | Done when |
|---|---|---|
| 1 | Package skeleton, argv dispatch, exit codes, output layer | `simt --help` and `simt nope` both behave |
| 2 | `graph/skills.graph.json` covering all 46 existing entries | `simt graph lint` clean, no orphans |
| 3 | `fingerprint` + detector tests | all 16 repos classify correctly from marker files alone |
| 4 | `skills index` / `find` / `show` | index under 6 KB for the full registry |
| 5 | `skills brief` + `why` | `eval` corpus passes; every selection traceable |
| 6 | Projection engine + `simt check` | drift detected in a deliberately stale repo |
| 7 | `init` with conflict reporting | dry-run adoption produces a reviewable diff on all 3 pilots |
| 8 | `hooks` dispatcher | one pre-commit works across all 3 pilot stacks |
| 9 | `compare` | replaces the hand audit |
| 10 | `mcp`, `upgrade`, `upgrade --all` | round-trips simt-dev's own SHA |

Steps 1-5 are useful with zero content migration and should land first, because they deliver
the token win (tier 0/1/2 discovery) before any repo has changed.

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



