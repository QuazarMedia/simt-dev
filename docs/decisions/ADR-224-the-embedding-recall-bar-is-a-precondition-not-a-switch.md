---
simt-affects: ["src/commands/help.mjs", "src/index/map.mjs", "test/map.test.mjs"]
simt-supersedes: []
---
# ADR-224 — The embedding recall bar is a precondition, not a switch

Status: accepted · 2026-11-21

## Context

R28 accepted embeddings on a condition: they stay off by default unless they raise
gold-file recall@10 by at least 10 points. `measureRecall` computed that verdict and
returned `embedAccepted` beside `embeddingsDefault: 'off'`, and the default stayed `'off'`
in both branches. The tool therefore reported a gate it never applied, and the help text
promised the opposite — `--embed ... (off by default unless recall@10 gains at least 10
points)` — so a reader had no way to tell a deliberate floor from an unwired switch.

The verdict cannot be the switch. The measurement reads mined task descriptors and gold
patches, and the patches live in a vault outside the worktree; ADR-031 draws the same
boundary from the test side. A verdict kept as repository state would rank the same tree
differently on the machine that measured it and in CI. ADR-131 ruling 2 also rules that
no `map`, `brief` or `slice` run reads stored vectors unless it named them, and a default
that flipped on an accepted arm would have to read those vectors and send a query
embedding on every prompt submit — a socket R37's accept and ADR-075 do not open.

## Rulings

1. **The bar is a precondition for using `--embed`, not a switch.** `measureRecall`
   reports `embedAccepted`, `embedDelta` and `embeddingsDefault`, and `embeddingsDefault`
   is `off` in both branches. Acceptance says the arm earned a place; the reader still
   passes the flag. Nothing in the tool turns vectors on by itself.

2. **The report carries the reason.** Every measured result names the switch and the bar
   in `embeddingsDefaultReason`, and `formatRecall` prints the verdict with the same
   sentence. An accepted arm therefore reads as "cleared the bar and stays off: `--embed`
   is the only switch", not as an unexplained contradiction beside an untested default.

3. **An unmeasured arm says nothing about the switch.** `formatRecall` adds the embedding
   line only when it was given a delta; a repository that never ran the embedding arm gets
   the recall line and no opinion about a default it did not test.

## Consequences

`simt map --recall` and its JSON payload report both the verdict and the switch, and the
`--embed` help line states that the bar is a precondition rather than a trigger. The
default remains what ADR-131 ruling 2 says it is: a run that did not name embeddings reads
no vectors and opens no socket. If a later slice makes an accepted verdict the default, it
supersedes ruling 1 and must first answer where the verdict lives, so that two machines
with the same tree agree.

## Rejected

- **Making an accepted verdict the default.** Rejected: the measurement reads an
  out-of-tree vault, so the same tree would rank differently on the machine that measured
  it and in CI, and a default run would read stored vectors and send a query embedding —
  the socket ADR-075 keeps closed until a repository opts in.
- **Recording the verdict in the index and letting default runs read it.** Rejected: the
  index is gitignored and machine-local, so it turns a committed tree into two behaviours;
  ADR-131 ruling 2 puts the vector path outside every run that did not name it.
- **Leaving `off` hard-coded with no stated reason.** Rejected: the help line already
  claimed the opposite. A default that is deliberately not applied has to say so where the
  verdict is read, which is the report and the flag's own help.
