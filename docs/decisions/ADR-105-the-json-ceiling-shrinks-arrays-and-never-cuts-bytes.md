---
simt-affects: ["src/output/index.mjs"]
simt-supersedes: []
---

# ADR-105 — the JSON ceiling shrinks arrays and never cuts bytes

Status: **accepted** · 2026-10-29 · filed as review 0003 Q10

## Context

ADR-070 ruling 5 gave `emitJson` the byte ceiling: a document over `--max-bytes`
was cut at the byte count with a `TRUNCATED` line after it, the same announcement
the text renderer prints. Compact JSON has no newlines, so the cut landed
mid-token and the command exited 0: `why --json --max-bytes 120` answered with a
document no parser accepts and a status that called it a success.

## Ruling

1. **JSON is never byte-truncated.** `emitJson` shrinks the payload to fit: the
   longest arrays empty first, and the document carries
   `truncated: { field, omitted, limit }` (or `fields: [{ field, omitted }]`
   when several lists shrank) naming exactly which list lost how many items.
2. **A ceiling no trimming can fit is a `MAX_BYTES` error envelope, not a cut.**
   `{ ok: false, error: { code: 'MAX_BYTES', message, remedy } }` with
   `truncated: { omitted, limit }`, still one parseable document. The remedy
   reads `rerun with --max-bytes 0 for the whole document` — the same ceiling
   the text renderer names, in the same words.
3. **The text ceiling is unchanged.** `emit` still cuts lines and announces the
   omitted bytes; prose has line boundaries worth cutting at, JSON does not.

## Consequences

- Every `--json --max-bytes` answer parses, trimmed or enveloped. A reader can
  trust that a document on stdout is the whole answer when no `truncated` key
  rides with it.
- `truncated` is additive: readers that ignore unknown fields see today's shape
  with shorter lists, so no schema bump.

## Rejected

- **Cutting at a newline for JSON too.** Compact output has none and pretty
  output's newlines are indentation, not item boundaries; either cut still
  breaks the parse the caller was promised.
