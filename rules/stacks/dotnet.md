---
simt-id: dotnet
simt-title: .NET
simt-applies: [has-nuget]
simt-priority: convention
simt-scope: ["*.csproj", "*.sln", "*.fsproj"]
---

# Stack profile: .NET

Applies to: `has-nuget` — a `.csproj` or solution.

## Build and gates

- `dotnet build`, `dotnet test` are the entrypoints; `dotnet format
  --verify-no-changes` is the formatting gate. A solution builds with `dotnet build
  <solution>`, never a bare project path that skips the solution's configuration.
- Build with `-warnaserror` where the repo sets it; a warning that is not an error
  is a defect the gate is being asked to ignore.
- Restore is deterministic: commit `global.json` and any NuGet.config the repo has,
  so a build does not depend on a machine's cache.

## Style

- Prefer `required` members and `init` over a public setter that exists to satisfy
  the constructor. A mutable property nobody should write is a hole in the type.
- `async`/`await` all the way: no `.Result`, no `.Wait()`. A synchronous call into
  an async boundary is a deadlock waiting for the thread pool.
- Nullability is on: `#nullable enable` in new code, and a `?` that is guessed
  rather than checked is a defect.

## Testing

- `dotnet test` runs xUnit, NUnit or MSTest — whichever the project references; do
  not add a second framework to a repo that has one.
- Assert on behaviour through the public surface; a test that reaches into a private
  field is coupled to an implementation it should not own.
