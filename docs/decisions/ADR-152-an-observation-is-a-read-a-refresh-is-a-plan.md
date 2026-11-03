---
simt-affects: ["src/knowledge/observations.mjs", "test/knowledge-observations.test.mjs"]
simt-supersedes: []
---
# ADR-152 — an observation is a record of a read, a refresh is a plan, and only a reviewed canonicalizer may ignore bytes

Status: accepted · 2026-11-03

## Context

Noticing that a source changed is the difference between a document that is current and one
that looks current. The naive implementation blurs three different events into "fetched":
a fetch of new content, a fetch that found the same content, and a fetch that failed. When
they share one word, a timeout refreshes a record's timestamp and the document is reported
fresh although nothing was read.

The second blur is cosmetic change. A source that re-wraps a paragraph or switches to CRLF
has not changed what it asserts, and re-verifying every dependent claim costs a reviewer
their day. But line-level normalization is where a well-meaning fix deletes a space between
`19` and `%`, and the digest then says "unchanged" for a document whose value moved.

The third is a refresh that has become a crawler: it follows a redirect to `127.0.0.1`,
reads a metadata address, or reaches a host nobody put on the allowlist, all because the
first URL was fine.

## Rulings

1. **An observation is a record of a read**: source, fetched instant, representation digest,
   the source's own revision, content scope and parse status. It is produced by an adapter
   and validated where it is written.

2. **A 304 is a new observation of the same content revision.** The digest and revision are
   retained, `fetchedAt` moves, and the result is `not-modified`. A 304 with nothing observed
   before is `unknown`, not an empty document.

3. **A transport failure produces no observation and the answer `unknown`.** The previous
   record never stands in for a read that did not happen, and the claims that depend on the
   source are reported as `undetermined`, not as valid.

4. **Cosmetic normalization requires a reviewed, versioned canonicalizer.** Ignoring bytes
   happens only under a named id and version (`line-endings-v1` today), the record keeps the
   raw digest beside the canonical one, and without a canonicalizer CRLF is a content change.
   A canonicalizer may not alter anything inside a line, because that is where an amount, a
   date or a unit lives.

5. **A refresh is a plan, not a request.** `planRefresh` returns a method, a URL, conditional
   headers and a budget; it opens nothing. No offline path (`brief`, `check`, a hook) may
   reach it.

6. **Destinations are checked before a request exists.** Scheme, port, credentials, a
   private or link-local host, and a host outside the declared allowlist are refused, and a
   redirect target is checked as strictly as the first hop with a separate hop budget.

7. **Freshness takes its clock as an argument.** `freshness` requires an explicit `now` and
   a declared maximum age, so its answer is a pure function and never a clock reading.

## Consequences

- `invalidate` reads the claim's `evidence` references (plan 0004 W13) and returns the
  dependent ids; a change with no conclusion returns them as `undetermined`.
- The allowlist is policy, not a default: an empty allowlist refuses every destination, so a
  repository that has not declared one cannot refresh by accident.
- Conditional requests are expressed as `if-none-match` from a retained revision. A
  `Last-Modified` date is not sent, because rendering an instant as an HTTP date is a
  formatting decision nobody has made yet.
