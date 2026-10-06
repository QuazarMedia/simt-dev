# ADR-010 — Invoke tools through the repo's own runner, never a package runner

Status: **accepted** · 2026-10-05 · affects all repos

## Context

Four repos independently arrived at the same rule, in two ecosystems, with the same rationale.

- `simt-social` / `simt-social-api`: "Run tests and quality checks through repository `npm run
  ...` scripts… **Do not invoke local package binaries through `npx` or `npm exec`** unless no
  repository script supports the required operation."
- A Python repo outside this estate, in the same form: "**Do not use `uv run pytest`**; the
  console entrypoint can miss the `uv` import path and fail to import dependencies." Its
  contributor guide states the same rule with a stronger failure description: it "can
  **silently** run against the wrong environment."

The failure mode is identical: a package runner resolves a binary outside the project's
configured environment, so the tool runs, the import path is wrong, and the result is either an
obvious import error or — worse — a pass against the wrong interpreter.

Note the severity disagreement on that last point: "fail to import" versus "silently run
against the wrong environment." The second is far worse and is treated as canonical below.

## Ruling

Invoke tools through the repository's own declared runner, in every ecosystem:

- Node: `npm run <script>`. Never `npx` or `npm exec` for a binary that is a declared
  dependency.
- Python: the module form, `uv run -m pytest`, or the repo's own wrapper. Never the bare
  console entrypoint.
- Gradle: `./gradlew`, never a system `gradle`.
- Any other ecosystem: the repo's declared entrypoint, never a bare global binary.

**Read the actual runner manifest before running anything.** A command that does not exist in
`package.json` is not a command. This is stated because it is the other half of the failure:
guessing a script name is how an agent concludes a check "passed" when it never ran.

Exception: a tool that is genuinely not a project dependency (a one-off inspector, a global
formatter) may be invoked directly, provided its version is pinned.

## Consequences

- The estates' two ecosystems converge on one rule, so an agent moving between a Python repo
  and a TypeScript repo does not have to learn the rule twice.
- The stronger failure description is canonical: silently running against the wrong environment
  is worse than failing, and the rule exists to prevent it.
- Repos with no declared scripts get them from the tooling baseline (plan 0001 §3.1), so this
  ruling is always actionable.

## Rejected

- **Adopt only the npm half.** Leaves the identical failure unguarded in Python, Gradle and
  every future ecosystem.
- **Permit `npx` for convenience.** `npx` will fetch a package that is not the project's
  version, which reintroduces exactly the environment drift the rule prevents.
