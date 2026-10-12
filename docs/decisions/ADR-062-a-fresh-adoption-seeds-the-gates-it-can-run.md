# ADR-062 — A fresh adoption seeds the canonical gates it can run, and never more

Status: **accepted** · 2026-10-13 · filed as S40
**Affects:** `simt init`, `src/projection/manifest.mjs` (the `ECOSYSTEMS` table, `defaultGates`),
`src/hooks/capability.mjs` (the tool probe, the `tools` field), `src/commands/init.mjs`,
eight new files in `rules/stacks/`

## Context

S40's finding: the eight common ecosystems outside the JavaScript world — Rust, Go, .NET,
Swift, Deno, Ruby, Dart and Elixir — emit no stack tag. The fingerprint recognises them as
`has-*` facts, and the only reader of those facts was the Dependabot configuration. So a
fresh Rust repository received the core essay and a manifest that runs nothing: no profile
was selected because there was none to select, and no gate was proposed because no row keyed
on a fact. The asymmetry is the defect — the ecosystems the tool recognises were the ones it
served least, while the ecosystems that do emit stack tags got the full treatment.

Two existing mechanisms make the fix data-only, per ADR-013:

- **Profiles select on tags or facts.** `simt-applies` already accepts a fact, and the
  genericity tests already assert that a profile may select on a fact no stack tag names.
- **Gates are planned by signal.** `planGates` takes the union of stack tags and facts, so a
  row can key on either; the two never cross-match, because facts are `has-*` and tags are
  not.

What was missing is one artefact per ecosystem: the profile file — and for gates, a row that
says what a fresh adoption of one should declare. The second is the harder half, because
declaring a gate is not free:

A declared gate that cannot run is worse than an absent one. Absent, an author sees nothing
and knows nothing is being checked; declared-and-unrunnable, the dispatcher fails closed on
every commit, and the only exit an author can find is `--no-verify`, which teaches the whole
team that the gate is theatre. So the question a seeding design has to answer is not "which
ecosystem is here" — the marker file answers that — but "can this machine run what the gate
says it runs". That is ADR-017's probe-before-declare, and it shapes every ruling below.

## Rulings

1. **Every ecosystem the fingerprint names gets a profile.** Eight new stack profiles, each
   `simt-applies:` on its own fact (the files are named in the Affects line), so one marker
   file reaches both the region the repository reads and the gates its commits run. Maven's profile (`jvm`) predates
   this ruling and applies on the same fact, so the table has nine rows and eight new files.
   An ecosystem arriving later is a profile file and a row: no engine change (ADR-013).
2. **A fresh adoption seeds the canonical commands, and only where the probe found the
   tool.** On `init`, when the fingerprint emits an ecosystem fact, the row's commands land in
   `gates.commands` for each gate it proposes — but only when the probe found `tool`. The
   probe is the same discipline ADR-017 applies to node tools: a binary on PATH, or a file in
   the repository when the row says `file` (the Maven wrapper, probed the way `gradlew`
   already is). A marker says the ecosystem is here; the probe says its program can run. Both
   must be true for a seed to land. `readCapability` reports the results in a `tools` field
   next to `binaries`, so the plan can say which seeds fired and which did not.
3. **A seed is a default, and a default loses to every form of declaration.** A command the
   repository already declared in `gates.commands` is never re-seeded. An npm runner keeps its
   own scripts untouched: `package.json` is the repository's own answer to "how do I test and
   format", and a seed that outranked a script would replace a choice with a default —
   precisely in the mixed repository (a `package.json` and a `Cargo.toml`) where the script is
   the deliberate answer. The escape hatch for a repository whose runner differs from the
   canonical one (a Rails app, a Flutter module) is to declare its own command, and
   declaration beats seed everywhere.
4. **Where the probe fails, the gate is dropped with a why and a remedy, never declared.**
   This is the invariant `planGates` already holds for every proposed gate; seeding inherits
   it rather than creating an exception to it. A fresh Rust checkout on a machine without
   cargo gets `dropped gate test: …` with a remedy that names the install, not a gate that
   blocks its first commit.

## Consequences

- `simt init` on a fresh Rust, Go, .NET, Swift, Deno, Ruby, Dart or Elixir repository declares
  runnable gates when the toolchain is present — a `seeded` line in the plan output names each
  command that landed — and drops them with a remedy when it is not.
- `readCapability` gains the probe and the `tools` field: a PATH lookup, plus an executable
  check in the repository root for a `file` row.
- `defaultGates`'s expansion of an ecosystem row tolerates a missing phase key: the Maven row
  proposes only pre-push, and absence is "none", not a defect.
- The seed picks one canonical command per gate (`bundle exec rspec`, `dart test`). A
  repository whose runner differs declares its own; ruling 3 makes that declaration win.
- Acceptance: one test per ecosystem asserting marker → fact → profile selection; a seeding
  matrix (every row seeds when the tool can run, every row drops when it cannot, an npm
  repository takes no seed, a declaration beats a seed); and two end-to-end Rust inits, with
  and without `cargo` on PATH.

## Rejected

- **Seed on the marker's word alone.** The marker is a file in the repository; the tool is a
  program on the machine. A repository can have one without the other — a freshly cloned Rust
  checkout on a machine that has never installed the toolchain is the common case — and
  seeding there would declare a gate that fails closed on every commit. ADR-017 exists for
  exactly this.
- **Seed into an npm repository's scripts.** The scripts are the repository's own answer, and
  a seed that outranks them replaces a choice with a default. The mixed repository is where
  this matters most, because there the script and the marker coexist on purpose.
- **A second gate table or a new engine path for ecosystems.** The fact was already flowing
  into `planGates`, and the union of tags and facts never cross-matches. What was missing was
  a row and a file, which is data; the engine that reads it already existed.
