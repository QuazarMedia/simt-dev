---
simt-affects: ["src/index/extract.mjs", "src/index/syntax.mjs", "src/index/bindings.mjs", "src/index/store.mjs", "src/index/persist.mjs"]
---

# ADR-236 — The symbol graph records file-local evidence

Status: accepted · 2026-11-22

## Context

An import edge names a source file. It gives no evidence about which export
the caller uses or which name a barrel made visible.

## Rulings

1. **Extract local evidence before resolving cross-file references.** Keep
   import names, aliases, re-exports and reference locations with the source
   blob. An unchanged blob retains its extraction.

2. **Preserve provenance on resolved edges.** Follow explicit aliases and
   re-exports to a defining file and symbol. Ambiguous, dynamic or unsupported
   references remain unresolved and are reported to callers.

3. **Keep the file graph as the conservative basis.** Symbol precision and
   live overlays carry their own provenance. A reader that requires complete
   test evidence falls back to file-level coverage where binding is incomplete.

## Consequences

- A file import keeps its existing shape and meaning while symbol consumers
  can ask for finer evidence.
- A local edit can be analysed without rescanning unrelated source files.
