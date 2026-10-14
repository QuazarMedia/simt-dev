---
simt-id: elixir
simt-title: Elixir
simt-applies: [has-mix]
simt-priority: convention
simt-scope: ["mix.exs", "lib/**/*.ex"]
---

# Stack profile: Elixir

Applies to: `has-mix` — a `mix.exs`.

## Build and gates

- `mix test` is the entrypoint; `mix format --check-formatted` is the formatting
  gate. A repo that uses `mix credo` runs it with `mix credo --strict` where the
  `.credo.exs` exists; a check the repo configured is a decision, and skipping it
  is a change, not a fix.
- Dependencies are declared in `mix.exs`; `mix deps.get` resolves them into
  `mix.lock`, which is committed. A module that imports a library the manifest does
  not list compiles only by accident.
- A release is built with `mix release` where the repo defines one; do not run a
  `mix run` against a release's expectations.

## Style

- Pattern-match on the way in, not guard-and-raise on the way out. A function that
  takes a map and digs three levels deep is a boundary somebody refused to name;
  match the shape at the edge and pass values in.
- Errors are returned, not raised, for expected failures; `raise` is for bugs, not
  for a missing record. A caller that cannot handle the failure is a defect in the
  caller's contract, not a reason to crash.
- Prefer a small `struct` with named fields over a map of strings; a `%{}` that is
  passed through five functions is a type somebody refused to give a name.

## Testing

- `mix test` is the gate; ExUnit is the runner, and a change that touches a module
  must not break its neighbours.
- Assert on behaviour through the public API; a test that reaches into a private
  field is coupled to an implementation it should not own.
