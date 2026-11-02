# Add a finding code

Every finding the gate can emit is explained by `simt explain <CODE>`, and the explanation
lives in one table: `EXPLAIN_CODES` in `src/explain.mjs`. A code that exists in a checker but
not in that table is a message the reader cannot act on.

1. **Pick the code.** Upper-case, hyphenated, and named for the defect rather than the
   checker: `PACK-DIGEST-MISMATCH`, not `CHECK7`. One code, one cause.
2. **Write all four fields.** `what` (the defect in one sentence), `why` (the ruling that
   settles it, by ADR id), `fix` (a command, not a location), `example` (what a reader sees).
   A `fix` that names a path is a second problem stacked on the first.
3. **Emit it from one place.** A finding is produced by a checker or a gate; two producers
   for one code means the explanation describes one of them.
4. **Test it.** `test/explain.test.mjs` holds the table's shape, and the checker's own test
   asserts the code it emits. A code with no emitting test is a message nothing produces.

The codes are listed by name in `docs/reference/findings.md`; the table in `src/explain.mjs`
is the authority, and the page is a map of it.
