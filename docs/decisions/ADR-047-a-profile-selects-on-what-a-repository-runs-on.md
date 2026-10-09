# ADR-047 — A profile selects on what a repository runs on, not on what it is written in

Status: **accepted** · 2026-10-09 · refines ADR-013 ruling 1

## Context

Review 0002 §S28, P1, marked "decision" (proposal P3). Four profiles selected on a language or a
build tool while their bodies advised on a platform. Measured across the estate before anything
changed — the review's four rows, plus two smaller defects in the same table:

| Repo shape | Profile it received | Why that is wrong |
| --- | --- | --- |
| any TypeScript library | `cloudflare-workers` (D1, Durable Objects, wrangler) | applied on `typescript` |
| Spring or Ktor backend on Gradle | `jvm-android` (Compose, Wear OS, overlay policy) | applied on `gradle`, `kotlin` |
| React Native / Expo app | `react-web` (CSS logical properties, WCAG reflow, a browser matrix) | applied on `react`, and `DEP_TAGS` mapped `react` and `react-dom` to the same tag |
| Poetry project | a `python` body that says `uv run -m`, `uv.lock` | the body was uv-specific, the selection was any Python marker |

Two smaller ones in the same table: `hono` also keyed `cloudflare-workers`, and Hono runs on
Node, Bun and Deno as happily as on Workers — a library tag read as platform evidence. And
`wrangler.json` was missing from `MARKERS`, so a Worker configured with the plain JSON file and
no `wrangler` dependency had no evidence of being a Worker at all.

ADR-013 ruling 1 made platform tags and facts interchangeable in `applies`, and its consequences
promised that "every tag a profile may name is one the engine emits" would hold for facts too,
with "the registry validator and the profile loader share one derived vocabulary so they cannot
desynchronise." Half of that was implemented: `graph lint` checked a skill's `stack` array
against the vocabulary, and nothing checked a profile's `applies`. The four rows above are what
that half produced — not a typo, but selections the vocabulary permitted and no check objected to.

## Ruling

**One.** A profile's `applies` names the evidence of what its body advises on. Where platform
evidence exists, a bare language or build-tool tag is not that evidence:

| Profile | Before | After | What selects it |
| --- | --- | --- | --- |
| `cloudflare-workers` | `cloudflare-workers, hono, typescript` | `cloudflare-workers` | a wrangler config or the `wrangler` dependency |
| `jvm-android`, split into `jvm` | `gradle, kotlin, wear-os` | `jvm`: `gradle, has-maven-pom, kotlin, java` | a JVM build |
| `jvm-android`, split into `android` | (the same file) | `android`: `has-android-manifest` | a module with an `AndroidManifest.xml` |
| `react-web` | `react, react-router, maplibre, firebase` | `react-dom, react-router, maplibre, firebase` | the browser renderer |
| `react-native`, new | — | `react-native` | a `react-native` or `expo` dependency |
| `python`, split into `python` and `uv` | `python` (with a uv-specific body) | `python`: `python`; `uv`: `has-uv-lock` | the language / the lockfile |

The exception is where a language *is* the finest fact available: `python`'s body advises
invocation hygiene that holds in every Python repository, so the `python` marker is the right
key there. The test that separates those two cases is the pair of rows whose shared stack is
exactly `node, react` and which differ only by the renderer tag: one receives `react-web`, the
other `react-native`, and neither receives both.

**Two.** The Android and uv facts name a path at an unknown depth, which the two existing kinds
(`file`, `dir`) cannot express. A third kind, `glob`, walks at most `GLOB_DEPTH` directory levels
below the root. The bound is a convention, not a preference: the Android Gradle Plugin puts a
module's manifest at `<module>/src/main/AndroidManifest.xml`, and simt-app's sits at
`app/src/main/AndroidManifest.xml`. A shallower bound makes `has-android-manifest` the shape S07
found — a fact no repository could have. A deeper one is a scan rather than a probe, and
ADR-013's promise is that adding an ecosystem is data, so a fact must not cost a search.

The walk skips dot-directories and `node_modules` for the reason the extension sample skips them;
the matcher is the registry's `matchesGlob` (ADR-042), so a fact's shape and a skill's `path:`
are one language rather than two; and the evidence for a `glob` fact is the matched path, never
the pattern — `doctor` answers "why did you think that?", and a shape is not an answer.

**Three.** `wrangler.json` and `wrangler.jsonc` join the Workers markers beside `wrangler.toml`.

**Four.** The vocabulary check now covers profiles as well as skills. `describeDefect` rejects a
`simt-applies` entry that `fingerprint()` cannot emit — `simt-applies names "pyton", which
fingerprint() never emits, so this profile could never be selected` — for central and local
profiles alike. A tag the engine cannot emit is a profile that can never be selected, and the
defect lives in the file that names it, not in whatever repository happens to load it. This is
the half of ADR-013's shared-vocabulary consequence that was unimplemented, and it is what makes
ruling one enforceable rather than aspirational: a future profile that re-keys on a language tag
spelling no detector emits fails at load time, in the file's own defect list.

## Consequences

`compare` over the estate before and after — 16 repositories, **4 move, 12 unchanged**, and no
repository loses coverage:

| Repo | Before | After |
| --- | --- | --- |
| `app-ui`, `simt-app`, `wakt-app` | `core, jvm-android` | `core, android, jvm` |
| `bunnyland-server` | `container, core, python` | `container, core, python, uv` |

The three Android repositories gain the profile whose body they actually needed and keep the JVM
build rules; `simt-app` gaining `android` was the row's acceptance criterion. `bunnyland-server`
carries a committed `uv.lock`, so its gain is the defect repaired, not a new selection.

The rename is breaking in one narrow way: the id `jvm-android` no longer exists. A consumer that
pinned it — a manifest's `profiles` array, a local profile shadowing by id, a document that names
it — must rename to `jvm` and `android`. Nothing in the estate pinned it, which is why the table
above is complete; a consumer outside it learns from this record.

The provenance digest moves `47160e9e…` to `0cfea39f…` because files under `rules/stacks/` were
added and removed. Every adopted repository re-stamps on its next `sync` or `upgrade`.

The fixture table in `test/genericity.test.mjs` asserts each row's `stack` **and** its exact
profile set, in order — `core` first because it applies always, the rest in profile-file read
order. Asserting the set alone would still pass if a fixture stopped being the thing its row
claims (a "TypeScript library" that is no longer TypeScript), which is the weaker claim a
mutation produces. The hand-maintained `PROFILES` list in `test/shipped.test.mjs` is deleted:
S28's rename broke it, and it guarded nothing — the leak check already iterates `loadRules()`.

Seven mutations, all caught:

| Mutation | Caught by |
| --- | --- |
| `react-web` re-keyed on `react-dom, react` | the exact-set row test |
| the `glob` probe reduced to a root-presence check | four tests: row, evidence, bound, root shape |
| `GLOB_DEPTH` 3 → 2 | three tests: row, evidence, bound |
| `wrangler.json` dropped from the markers | the row test |
| `hono` restored to the Workers applies | the row test |
| the vocabulary check removed from `describeDefect` | the local-profile probe: an error where the message belongs |
| the android fact made a shallow `dir` probe (S07's shape) | three exact-set rows |

## Rejected

**Selecting on the language and excluding with an extra condition** — `cloudflare-workers`
applies on `typescript`, but not when …. Selection by subtraction needs its own detector for
every new shape of repository, and each exclusion is a hole until it is written. The positive
form asks one question — *is this a Worker?* — and the answer is a file or a dependency, which is
what a fact is for.

**The build-plugin half of `has-android-manifest`.** The review proposed the manifest *or* the
`com.android.application` / `com.android.library` plugin in a build file. The plugin has two
spellings (Groovy `apply plugin:` and the Kotlin DSL `id(...)`), moves with the plugin's
versioning, and a repository can carry the plugin without the manifest while it is mid-migration.
The manifest is the one path shape that makes a module buildable as Android, and it is what
`doctor` can point at. The plugin half is recorded here rather than implemented, so the next
reader does not discover it as a gap.

**An unbounded glob walk.** It would find the manifest, and it would also make detection a scan
of every file below the root, which is what ADR-013's promise rules out: adding an ecosystem is a
profile file, not a search. The bound is the convention the fact exists to see.

**Keeping `jvm-android` and documenting the mis-selection.** That ships a profile whose body the
review measured as wrong for a whole class of repositories, with a comment where a fix belongs.

**A per-renderer tag for every framework.** `react-dom` is the renderer, and it is what
distinguishes a browser from every other surface. The other keys on `react-web` — `react-router`,
`maplibre`, `firebase` — were already there as discriminators, and they stay: each names a
library whose presence implies a browser deployment the same way `wrangler` implies Workers.
