# ADR-013 — Genericity comes from emitted facts and repo-local profiles, not from a bigger hardcoded tag table

Status: **accepted** · 2026-10-05
Affects: the `simt-dev` CLI (fingerprint, profile selection, registry validation)

## Context

The engine is already only loosely coupled to SIMT. Measured, not asserted: `src/argv.mjs`,
`src/resolve/resolve.mjs` and `src/graph/load.mjs` contain **zero** non-comment,
non-string references to SIMT. Everywhere else, "SIMT" appears as ADR citations in comments
documenting *why*, plus one hardcoded npm scope in the hook shim. The project is named SIMT;
the mechanisms are not.

The coupling that does exist is in the **vocabulary**, not the code. `fingerprint()` emits 17
tags from three hardcoded tables (`MARKERS`, `EXTENSION_TAGS`, `DEP_TAGS`) plus a literal
`'wear-os'`, and those tables are keyed by *curated product* names: `connectiq`,
`maplibre`, `hono`, `react-router`. That has three consequences, and only the first is
obvious:

1. **A new ecosystem needs a code change.** Detecting Django is one line in `MARKERS`; the
   engine then hands a Django repo the generic `node` fallback profile, which is wrong advice,
   and there is nowhere to put the correct profile because `rules/stacks/` is central-only.
2. **The tag names encode opinions that age badly.** `hono` and `maplibre` are libraries, not
   stacks. A profile that selects on a library breaks the day the library is swapped.
3. **Detection is untestable in the abstract.** There is no way to ask "what did the tool
   actually observe?" other than reading three tables.

There is also an unresolved question from the design review: a **hosted MCP service** would
make the tool more capable, but it was not clear whether it would make it more *generic*, more
*accurate*, or merely more available.

## Ruling

### 1. Detection emits facts; profiles select on facts

`fingerprint()` gains a second, orthogonal output: **`facts`** — observable, ecosystem-neutral
properties of the working tree, named `has-*` (`has-pyproject`, `has-go-mod`,
`has-cargo-toml`, `has-migrations-dir`, `has-dockerfile`, …). Facts are derived from evidence,
never from a product taxonomy, so there is no table to grow when a new ecosystem arrives: the
fact was already being observed.

The existing product tags remain, because a profile that genuinely wants "this is a Cloudflare
Worker" should say so in words that mean something to a reader. But a profile may now select
on **either**, and new profiles are expected to prefer facts where a fact will do:

- `applies: [has-cargo-toml]` — honest, survives the framework being replaced
- `applies: [cloudflare-workers]` — precise, dies with the platform

Selection is the union of both sets. A profile therefore needs **no engine change** to be
usable by an ecosystem nobody has heard of.

### 2. Profiles are content, and content may live in the repo

`simt init` prints where local profiles live and the manifest gains a `profiles` array
naming profile ids. The directory needs no creation — the first file in it creates it, and
an empty directory would not survive git anyway. Central profiles ship in `rules/stacks/`; **repo-local profiles are read from
`.simt-dev/profiles/*.md`**, use the same frontmatter contract (ADR-009), and are selected
with the same matcher. A local profile may declare `fallback: true`.

A repo that ships its own profile has made a decision about its own conventions. It does not
need a central contribution, a release, or a maintainer's permission — and when it is wrong,
the fix is a one-file PR in the repo that is wrong, which is the correct blast radius
(ADR-002).

Local profiles are **additive and shadowing**: a local `id` replaces a central one with the
same id, and otherwise both are considered. Central content is never silently overridden in
place — it is superseded by an explicit, reviewable file.

### 3. A hosted service may serve authoring; it may never serve resolution

These are different products and must not be conflated.

| | Authoring | Resolution |
|---|---|---|
| Hosted MCP is useful | yes — discovering profiles, learning an ecosystem, publishing findings | **no** |
| Non-determinism | tolerable: a human reviews the output | fatal: "did the agent follow the rules?" becomes unanswerable |
| Offline | irrelevant | required: a hook and a gate must not depend on a network call |
| Diffable in a PR | partially | required: `simt check` output is the gate's whole product |
| Fails | loudly, at authoring time | must fail **closed** with a remedy |

A hosted resolver would make every gate in the estate depend on a network round trip and a
model's ranking, and would make CI results unreproducible. That is a worse tool, not a more
capable one.

**Community extensibility therefore ships as a registry of portable profile files** in a git
repository, fetched and pinned by the same single-SHA mechanism (ruling 4) that already pins
rules. Same trust model, no hosted runtime, and the diff a reviewer sees is the diff of a
profile file.

## Consequences

- `fingerprint()` returns `{stack, facts, evidence, manifest, error}`. `evidence` gains the
  file that proved each fact, so `simt doctor` can answer "why did you think that?" without a
  human re-deriving it.
- Every tag a profile may name is still emitted by the engine. The existing test — *tags used
  by content but not emitted by the engine is the empty set* — now covers facts too, and the
  registry validator and the profile loader share one derived vocabulary so they cannot
  desynchronise.
- `graph lint` validates against the same derived vocabulary, so a profile naming a fact the
  engine cannot emit fails at lint time rather than selecting nothing at runtime.
- Step 11 of the implementation sequence is genericity; it lands **before** `compare`, because
  it changes the tag vocabulary and every later step is cheaper once it is settled.

## Rejected

- **A larger hardcoded tag table.** Moves the wall, does not remove it. Every new ecosystem
  would still need a maintainer, a code change and a release, and the names would still encode
  today's libraries rather than the repo's actual properties.
- **Community profiles in a hosted registry served at runtime.** See the table above.
- **Semantic or embedding search as the mechanism for choosing rules.** Already rejected in
  plan 0002 §3, and this ruling reinforces it: it is a resolution mechanism, so it inherits
  every constraint in row two of the table above.
- **Fingerprinting on library names alone.** Precise today, and silently wrong the day a
  dependency is replaced.