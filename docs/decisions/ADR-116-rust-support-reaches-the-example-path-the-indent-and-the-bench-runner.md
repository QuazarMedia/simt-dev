---
simt-affects: ["rules/mdc/test-gate.mdc", "src/projection/baselines.mjs", "src/bench/mine.mjs", "src/compare/learn.mjs", "test/bench.test.mjs", "test/mdc.test.mjs", "test/baselines.test.mjs", "test/compare.test.mjs"]
simt-supersedes: []
---

# ADR-116 — Rust support reaches the example path, the indent and the bench runner

Status: **accepted** · 2026-10-31

## Context

ADR-062 made Rust a first-class adoption: `has-cargo-toml` selects the `rust` profile,
`simt init` seeds `cargo fmt --check`, `cargo clippy -- -D warnings` and `cargo test`
when `cargo` is on PATH, and dependabot watches `Cargo.toml`. Much of the rest of the
tool already knew the ecosystem — the index extracts Rust `use` edges and records `.rs`
files, `simt secrets` reads `Cargo.lock`, the monorepo reader reads `[workspace] members`
from `Cargo.toml`, and the card resolves `cargo build` and a focused `cargo test {name}`.

Three places a Rust repository reads or runs did not know it:

- `rules/mdc/test-gate.mdc` substitutes one example test path, and only Go had a
  per-signal default. A Rust repository was handed `path/to/the.changed.test.ts` — an
  instruction that names a file its test gate can never run.
- The shared `.editorconfig` assigns four spaces to Python, Java and Kotlin, and left
  `.rs` at the default two. Rust's own formatter writes four, so the shared baseline
  contradicted `cargo fmt` in every Rust repository that adopted it.
- `detectTestRunner` knew package.json, vitest, Go, Python, Gradle and Maven. A Cargo
  repository fell through to no runner, so `simt bench mine` could not grade a Rust
  patch and `simt gate` could not select its tests.

The gate classifier had the same blind spot in its heuristic fallback: a declared
`cargo test` was classified through the declared command, but a command read from a
repository that had not declared it was not recognised as a test gate.

## Ruling

1. **A Rust repository is shown a Rust test path.** `exampleTestPath` gains
   `default-has-cargo-toml: tests/the_changed.rs`. Rust's test paths are Cargo
   integration tests in `tests/`; inline `#[cfg(test)]` modules live in the source file
   and have no separate path to name. The signal is the detection fact, not a new stack
   tag, so ADR-013 and ADR-062 still hold.
2. **`.rs` is four spaces in the shared editorconfig.** It joins the
   `[*.{py,pyi,java,kt,kts,rs}]` section with `indent_size = 4`, matching rustfmt.
3. **The bench runs Cargo the way Cargo can be run.** A `tests/<stem>.rs` file is a
   test target, so a patch touching only integration tests selects one `--test <stem>`
   per file (`cargo test --test api`). A patch touching a source file means inline unit
   tests, which have no file argument, so the crate's whole test binary runs
   (`cargo test`). No changed files also runs the crate. The prompt command, the
   executed command and the parser come from the same branch, so a preview cannot name
   a narrower command than the one that ran.
4. **Cargo's text output is parsed by its result lines.** `parseCargoTestOutput` accepts
   only lines of the form `test <name> ... ok|FAILED|ignored`. `ignored` is neither a
   pass nor a failure. `test result:` summaries and compile output are not tests. The
   parser is shared by `simt bench mine`, `simt bench grade` and `simt gate`, which all
   go through `detectTestRunner`.
5. **`cargo test` is classified as a test gate.** The fallback in
   `classifyGateCommand` recognises it alongside `npm test`, `node --test`, `pytest` and
   `go test`, with ADR-003's focused-default ruling.

This record does not supersede ADR-062 (what a fresh Rust adoption seeds) or ADR-092
(which test edges count). It closes the three reader-facing gaps those records left
open.

## Consequences

- A Rust repository's projected `test-gate` names `tests/the_changed.rs`; no TypeScript
  or Go example path leaks into it. The signal is `has-cargo-toml`, so a mixed
  repository with both `package.json` and `Cargo.toml` is shown the Rust example.
- Every repository that adopts `.editorconfig` now writes `.rs` at four spaces. A
  repository that deliberately wants another indent still overrides it below the
  region, which is what last-match-wins is for.
- `simt gate <path>` on a Rust repository selects `cargo test --test <target>` for an
  integration test and `cargo test` for a source file. The bench can mine and grade
  Rust tasks with the same evidence discipline as the other ecosystems.
- The parser has no JSON dependency: `cargo test --format json` is nightly-only, and
  this package has zero runtime dependencies and must not require a nightly toolchain
  to read a test result.
- Acceptance: the Rust render of `test-gate` names only `tests/the_changed.rs`; the
  editorconfig section for `.rs` states four spaces; a Cargo runner is detected for
  both `tests/*.rs` and `src/*.rs`; libtest output yields passed and failed names and
  drops ignored tests.

## Rejected

- **A `rust` stack tag.** Rust is detected by `has-cargo-toml`; adding a tag would give
  one ecosystem two identities and break the fact/tag separation ADR-013 relies on.
- **Seeding `typecheck: cargo check`.** ADR-062 rules the seeded Rust gates to format,
  lint and test. Adding a gate changes what a fresh adoption declares, and that is a
  separate decision with its own acceptance tests, not a silent part of this one.
- **A conventional `tests/foo.rs` → `src/foo.rs` edge.** A Cargo integration test is a
  separate crate and need not mirror a source file. ADR-092 permits a conventional edge
  only when the convention is real; guessing one would manufacture test coverage that
  does not exist.
- **A Rust toolchain pin check.** The Rust profile requires a pin only where the
  repository commits one. `src/toolchain.mjs` is deliberately Node-specific; extending
  it to read `rust-toolchain.toml` or `rust-version` is a new belief and needs its own
  record.
- **Adding `.rs` to `FORMATTABLE`.** That set is the staged-file list for Prettier.
  Rust formatting is a declared command gate (`cargo fmt --check`), and handing `.rs`
  to Prettier would format it with the wrong tool.
