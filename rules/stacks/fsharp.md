---
simt-id: fsharp
simt-title: F#
simt-applies: [has-fsharp]
simt-priority: convention
simt-scope: ["**/*.fsproj", "**/*.fs", "**/*.fsx", "**/*.fsi"]
---

# Stack profile: F#

Applies to: a committed F# project (`.fsproj`), including projects nested in a solution.

## Build and gates

- Reuse the repository's .NET gates. Build and test the `.fsproj` or its containing
  solution with `dotnet build <project-or-solution>` and `dotnet test
  <project-or-solution>`; a solution invocation keeps its project graph and
  configuration intact.
- Keep NuGet dependencies in the project or the repository's central package
  configuration. Commit lock files where the repository uses them; a machine's
  package cache is not dependency declaration.
- Run an F# script with `dotnet fsi <script.fsx>` when the repository declares that
  runner, not through an unrelated C# entrypoint.

## Language design

- Prefer immutable records and discriminated unions for domain state, then
  pattern-match those shapes at the boundary. Boolean flags and nested tuples hide
  states the type system could make impossible.
- Make illegal states unrepresentable. A wildcard pattern is a decision that a new
  case needs no handling; use it only when that is true, not to silence a warning.
- Keep data immutable by default. Return updated values instead of mutating shared
  objects, and do not keep mutable module-level state.
- Use `task { ... }` or `async { ... }` according to the API being called, and carry
  cancellation through the call chain. No `.Result` or `.Wait()` across an async
  boundary.
- Represent absence with F# options where the API permits it. Validate data crossing
  an external boundary rather than guessing nullability, and do not add null to a
  domain type merely to satisfy an unchecked caller.

## Testing

- Keep the repository's existing xUnit or Expecto setup; do not add a second test
  framework. The command card's .NET filter template narrows an existing test run.
- Assert behaviour through the public API. A test that reaches into private state is
  coupled to an implementation it should not own.
- Keep tests deterministic: control time, randomness and I/O at the boundary instead
  of sleeping or depending on execution order.
