---
simt-id: rust
simt-title: Rust
simt-applies: [has-cargo-toml]
simt-scope: ["Cargo.toml", "src/**/*.rs"]
---

# Stack profile: Rust

Applies to: `has-cargo-toml` — a Cargo workspace or crate.

## Build and gates

- `cargo build`, `cargo test` are the entrypoints; a workspace builds with
  `cargo build --workspace`. Never invoke a toolchain the manifest does not pin.
- Format with `cargo fmt`; lint with `cargo clippy -- -D warnings`. A warning is a
  defect, not a note: fix it or the gate fails.
- Pin the toolchain in `rust-toolchain.toml` where one is committed; a rustup
  default on the developer's machine is not a floor anything enforces.

## Style

- No `unwrap()` or `expect()` outside tests. A panic path in library code is an
  unhandled error; return a `Result` and let the caller decide.
- `#[must_use]` on fallible constructors; a `Result` that is ignored is a bug the
  compiler should flag.
- Prefer a small `enum` of states over booleans; a pair of `bool` fields is four
  states, one of which is always wrong.

## Testing

- Unit tests live in `#[cfg(test)]` next to the code; integration tests in `tests/`
  exercise the public API only.
- Assert on values, not on panic messages. A test that asserts a panic string has
  coupled itself to an implementation detail it should not own.
