# ADR-096 — impact names who a change reaches

Status: **accepted** · 2026-10-18 · filed as R23 (plan 0003)

**Affects:** `src/index/impact.mjs`, `src/commands/impact.mjs`, `test/impact.test.mjs`

## Context

A change has a neighbourhood: the files that import it, the tests of that
neighbourhood, the decisions and rules that govern the file, and the owner a
CODEOWNERS line names. In a workspace the neighbourhood crosses a repository
when another one references a contract this change touches. That is the check
behind "the producer ships before the consumer".

## Rulings

1. **The argument is a tracked path, or the name of one export.** A private
   symbol is not an export. Several files exporting the same name is a usage
   error that names those files. A name that is neither a path nor an export
   is a usage error. A tree that is not git is unsupported.
2. **Importers are the non-test files that import the target, at any depth.**
   The tests are the test files that import that closure. Both lists stop at
   64. Past that, the report says it was truncated.
3. **Governance is what `why` would name for the file, limited to decisions
   and rules.** Owners are the last matching pattern in the first CODEOWNERS
   file that exists. A pattern with no slash matches the file name in any
   directory.
4. **A cross-repo consumer is another repository whose text contains a
   contract path this change touches.** A contract is an OpenAPI document or
   a JSON Schema file. The path has to include a directory. No workspace
   means no consumers, and that is not a failure. The scan stops at 64
   references and 2000 files in a repository.

## Consequences

`simt impact` answers who is reached. `simt gate` still runs the tests.
`simt why` still answers governance on its own, including skills, gates and
lessons, which this report does not repeat.
