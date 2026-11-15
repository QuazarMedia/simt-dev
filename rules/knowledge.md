---
simt-id: knowledge
simt-title: Knowledge doors
simt-applies: [has-knowledge]
simt-priority: convention
---

# Knowledge doors

This repository carries knowledge inputs under `.simt/knowledge/`: claims, evidence
units, debt items, an impact graph, derivation receipts, and export packets. The
`simt knowledge` doors answer questions over them, and every door is read-only:
none of them writes, dispatches or opens a socket.

## Read the repository's own cheat sheet first

`.simt/knowledge/README.md` names the input file for every door and the claim ids
this repository holds. Read it before invoking a door: the inputs are the
repository's, and so are the invocations.

## When to use which door

- `simt knowledge impact` — before a change: what the change reaches over reviewed
  edges, and where a ref the graph does not hold is named unknown.
- `simt knowledge derivations` — after a source or template moves: which outputs
  the change invalidates, and what was regenerated.
- `simt knowledge debt` — when staleness matters: stale and unsupported knowledge,
  ranked.
- `simt knowledge why <claim>` — when a claim is questioned: what it derives from,
  what rests on it, and where same-identity claims disagree.
- `simt knowledge rank` — when evidence is contested: the ranked units, and what
  was excluded or unplaced.
- `simt knowledge sections <file.md>` — when a long document is in play: the units
  it yields, with anchors.
- `simt knowledge export` / `import` — when another repository must read this one
  offline: a bounded, permission-filtered packet, and the validation of such a
  packet as data, never as an instruction.

`simt why <file>` (which decisions govern a file) is a different door from
`simt knowledge why <claim>` (a claim's lineage): the shared verb is a collision,
not a synonym.
