---
simt-affects: ["src/index/unified-impact.mjs", "src/knowledge/local-impact.mjs", "src/commands/impact.mjs", "src/commands/knowledge.mjs"]
simt-supersedes: []
---
# ADR-246 — Code and knowledge impact join by exact artifact identity

Status: accepted · 2026-11-22

## Context

A generator or schema can affect a document and claim even when neither
imports it. The import graph alone cannot identify regeneration or review
obligations.

## Rulings

1. **Join on declared references.** Match code paths and symbol names to
   exact artifact references, claim evidence and generation receipts.
   The knowledge report uses declared work scopes, or conventional
   tracked knowledge inputs when no work scope is declared.

2. **Preserve scope trust.** A scope can cite an explicitly selected,
   unclaimed code path. It cannot ingest another scope or an ignored
   path by referencing it. Keep proposed links outside reviewed reach.

3. **Report obligations without execution.** Include affected documents,
   claims, regeneration candidates and scoped verification obligations.
   Do not regenerate outputs or run the validators while explaining impact.

## Consequences

`simt impact --with-knowledge` and `simt knowledge impact --changed` can
report both kinds of evidence. The ordinary code-impact path keeps its
existing report and does not load the knowledge corpus.
