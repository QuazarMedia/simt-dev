---
simt-id: deno
simt-title: Deno
simt-applies: [has-deno-config]
simt-priority: convention
simt-scope: ["deno.json", "deno.jsonc", "**/*.ts"]
---

# Stack profile: Deno

Applies to: a committed `deno.json` or `deno.jsonc`.

## Build and gates

- `deno test`, `deno check .` are the entrypoints; `deno fmt --check` and
  `deno lint` are the formatting and lint gates. A repo that vendors dependencies
  runs them with `--vendor`; one that does not must not add the flag.
- The lockfile (`deno.lock`) is committed where it exists; a build that ignores it
  is not reproducible. A lockfile the repo chose to delete is a decision, and
  re-adding it is a change, not a fix.
- Import from `npm:` specifiers where the repo does; do not introduce a second
  registry convention into a repo that has one.

## Style

- Types are checked with `deno check .`; a file that compiles under `deno run` but
  not under `deno check` is a defect the gate exists to catch.
- No `any`. An `unknown` that is narrowed at the boundary is a type; an `any` is a
  hole the checker was told to stop looking through.
- Prefer a small `enum`-shaped union over booleans; a pair of `boolean` fields is
  four states, one of which is always wrong.

## Testing

- `Deno.test` is the runner; a test that needs a fixture reads it from a path
  relative to the test file, never from a machine-specific location.
- Assert on values through the public API; a test that reaches into module-private
  state is coupled to an implementation it should not own.
