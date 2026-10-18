# ADR-095 — gate output keeps the failures

Status: **accepted** · 2026-10-18 · filed as R18 (plan 0003)

**Affects:** `src/index/compact.mjs`, `src/commands/gate.mjs`, `test/compact.test.mjs`

## Context

A gate that prints every passing test spends the reader's attention on the
lines that did not fail. A summary that drops a failure is worse: the run
looks cleaner than it was. The formats this tool's own runners emit are
known. An arbitrary shell log is not one of them, and guessing at it is how
a line gets lost.

## Rulings

1. **Compaction applies to a report this tool produced, and only to a format
   it can read.** Those formats are TAP, JUnit XML, vitest or jest JSON, and
   `go test -json`. Pytest's junit file is JUnit XML. A stream that is none
   of these is printed unchanged.
2. **Failures come first, and each one is kept.** The name, the assertion
   and the location stay in the printed block. Passing tests become a count.
   A skip becomes a count when there is one.
3. **The raw log path is printed.** The log is gitignored. The command does
   not wrap an arbitrary shell command. The gate is the caller.

## Consequences

`simt gate` is the command that compacts. Another command that wants the same
treatment calls the same function. A format that is not in the list stays
raw until it is added with a golden fixture.
