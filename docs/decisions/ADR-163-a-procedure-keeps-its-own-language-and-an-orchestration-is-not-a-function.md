---
simt-affects: ["src/verify/procedures.mjs", "test/verify-procedures.test.mjs"]
simt-supersedes: []
---
# ADR-163 — a procedure keeps its own language, and an orchestration is not a function

Status: accepted · 2026-11-03

## Context

Repositories describe procedures in the language they already use: a decorated Python function,
a runbook with numbered steps, a page of prose with a table. A tool that reads them is useful
only if it reads what is written. Three translations have gone wrong before:

- `@not_idempotent` was summarised as "may be retried", which is the opposite instruction;
- a runbook with a `def` in it was recorded as one callable procedure, hiding the steps and the
  waits that are the reason it exists;
- a prose section the parser did not understand disappeared from the report, so a page with
  unread paragraphs looked fully understood.

A fourth is about capability rather than text: a fallback was accepted because it returned the
same object type, when it could not honour the privacy the procedure requires.

## Rulings

1. **The local annotations are the authority and are preserved verbatim.** `@not_idempotent`
   becomes `idempotent: false`, `@mutates` becomes `mutates: true`, `@graduated helper:create`
   keeps the helper's name. The adapter records; it does not summarise.

2. **Three kinds, and only one is callable.** A `@recipe` with a definition is callable; an
   orchestration is `kind: 'orchestration'` with `callable: false` and its steps listed, even
   when the file contains a function; a reference page is `kind: 'reference'` and callable by
   nothing.

3. **Unparsed text is reported with a reason and a fraction.** Prose the adapter does not
   understand is listed by line, coverage is `parsed / total`, and no annotation is invented
   from it. A body indented under a definition counts as parsed because the adapter does not
   interpret it — not because it was checked.

4. **The checks reuse what the repository declares.** An import the repository does not have is
   `missing-import`; a call to a procedure nobody declares is `missing-procedure`; a call cycle
   is reported with its path; a flag required both present and absent is
   `impossible-prerequisites`; a mutating effect on a procedure that does not declare `@mutates`
   is `undocumented-mutation`. Each carries a remedy.

5. **A capability is not a type.** `selectFallback` requires the return type and every declared
   privacy semantic. A candidate that returns the right object without the required privacy is
   rejected with `privacy-unsatisfied` and the missing semantics named.

## Consequences

- The module reads text, never a file or a process: a procedure can be replayed from a fixture,
  and the checks are the same ones a repository's own linter would run, without requiring the
  linter to be installed.
- `checkProcedures` is where cross-procedure facts live (imports, calls, cycles), because a
  single record cannot know whether a call resolves.
- Orchestration coverage is deliberately shallow: the adapter lists steps and calls, and does
  not claim to understand ordering, waits or human gates that the text does not annotate.
