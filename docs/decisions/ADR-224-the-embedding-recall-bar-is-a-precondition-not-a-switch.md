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
in both branches. The report also substituted the accepted arm's recall into `recall`, so a
reader saw a figure the default ranking does not achieve. The help text promised the
opposite of the code — `--embed ... (off by default unless recall@10 gains at least 10
points)` — and no surface said why `off` sat beside `accepted: true`.

The verdict cannot set a runtime default. The measurement reads mined task descriptors and
gold patches, and the patches live in a vault outside every checkout by design, so a verdict
kept as repository state would rank the same tree differently on the machine that measured it
and in CI. ADR-131 ruling 2 also keeps the vector path out of every run that did not name it,
and a default that flipped on an accepted arm would send a query embedding on every prompt
submit — a model call no run asked for. The bar is a release gate, and the release decision
has already been taken: embeddings ship off because no measurement has cleared it.

## Rulings

1. **The bar is a release gate on the default, not a runtime switch and not a gate on
   `--embed`.** `measureRecall` reports `embedAccepted`, `embedDelta` and
   `embeddingsDefault`, and `embeddingsDefault` is `off` in both branches. `--embed` never
   consults the verdict, so the arm the gate is about stays measurable. Moving the shipped
   default is a release decision with a record, not something a run does to itself.

2. **The headline recall is the default ranking's.** `measureRecall().recall` is
   `baseRecall` in both branches. An accepted arm is reported in `embedRecall` and
   `embedDelta`, never substituted into the figure a default run achieves: report-only must
   not look like on-by-default in the number a reader quotes.

3. **One explanation, two surfaces.** `EMBEDDINGS_DEFAULT_REASON` is the only statement of
   why `off` survives an accepted verdict; `formatRecall` appends it to the verdict, so the
   CLI and the JSON cannot drift into two phrasings.

4. **An unmeasured arm says nothing about the switch.** `formatRecall` adds the embedding
   line only when it was given a delta; a repository that never ran the embedding arm gets
   the recall line and no opinion about a default it did not test.

## Consequences

`simt map --recall` and its JSON payload report the default ranking's recall, the arm's
delta, the verdict and the shared reason. The `--embed` help line says the bar is the
precondition for shipping embeddings on, not a trigger. The default remains what ADR-131
ruling 2 says it is: a run that did not name embeddings reads no vectors and opens no
socket. A later slice that wants a measured arm to become the default supersedes ruling 1
and must first answer where the verdict lives, so that two machines with the same tree
agree.

## Rejected

- **Making an accepted verdict the default.** Rejected: the measurement reads an
  out-of-tree vault, so the same tree would rank differently on the machine that measured
  it and in CI, and a default run would send a query embedding on every prompt submit.
- **Substituting the arm's recall into `recall`.** Rejected: it reports a figure the default
  ranking does not achieve, and it makes a report-only gate indistinguishable from a default
  that was turned on.
- **Recording the verdict in the index and letting default runs read it.** Rejected: the
  index is gitignored and machine-local, so it turns a committed tree into two behaviours;
  ADR-131 ruling 2 puts the vector path outside every run that did not name it.
- **Leaving `off` hard-coded with no stated reason.** Rejected: the help line already
  claimed the opposite. A default that is deliberately not applied has to say so where the
  verdict is read, which is the report and the flag's own help.
