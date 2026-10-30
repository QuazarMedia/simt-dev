---
simt-id: node
simt-title: Node (general)
simt-applies: [node]
simt-priority: convention
simt-scope: ["package.json", "tsconfig.json", "jsconfig.json", ".nvmrc"]
simt-fallback: true
---

# Stack profile: Node (general)

Applies to: `node`, `node-web`, `typescript` when no more specific profile matches.

## Manifest

- One `packageManager` field, matching the committed lockfile. A repo with no declared
  package manager has no enforced one.
- `engines.node` states a floor. A version floor nobody enforces is a comment.
- `.nvmrc` pins the development version and must agree with `engines` and with CI.

## Scripts

- Run through `npm run <script>` (ADR-010). Never `npx` or `npm exec` for a declared
  dependency: `npx` will fetch a version the project does not pin.
- A script name is the contract. Rename a script and rename every caller, including docs,
  hooks and CI, in the same change.

## Formatting and linting

- Prettier owns formatting. ESLint disables the stylistic rules Prettier already owns —
  otherwise the two tools fight over every file.
- `format` and `format:check` are both present. `format:check` is what CI and hooks run.
- `.prettierignore` covers generated and vendored output: build directories, coverage,
  generated clients, graph output. Formatting generated output is a review finding, not a fix.

## Types

- `strict` plus the full strictness set, and `noEmit` for any project that bundles elsewhere.
  A bare `tsc` in a bundler project writes JavaScript next to the sources.
- `moduleResolution` spelled consistently across every repo in the workspace.

## Tests

- `vitest`, `jest` or `node --test` — one runner per repo, declared, not inherited.
- Focused selection is the default invocation. A full suite runs against the triggers in the
  repository's manifest (`{manifest}`) (ADR-003).
- No snapshot-only acceptance: a snapshot proves the code did not change, not that it is right.