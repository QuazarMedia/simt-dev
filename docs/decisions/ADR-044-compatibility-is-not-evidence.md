# ADR-044 — Compatibility is not evidence, and a resolver nobody measured is merely felt

Status: **accepted** · 2026-10-08 · affects what `skills brief` and `skills find` return

## Context

Review 0001 §S04, marked P1, reproduced exactly through the shipped binary. Two facts, both
measured in a Workers fixture before anything was changed:

- `skills brief --task "fix d1 migration"` resolved 29 914 bytes against a 20 480-byte budget and
  reported `(budget capped)`. The tail was `complete-testing` and `slice-commit`, selected on
  `stack:node+cloudflare-workers` alone.
- `skills brief --task "fix a typo in the README"` resolved four skills, every one of them on
  `summary:the` or `summary:in`, and filled the budget with bodies about launch galaxies.

The mechanism is one line. Stack overlap is 15 a tag, any score above zero selects, and the stack
gate already ran. Compatibility is a **precondition**, so a score made of nothing but compatibility is
not a weak match — it is no match, reported as one. Meanwhile `summary` is weight 8 and clears a
threshold of zero, so a word of shared English was enough to select anything.

The review asked for three things: make stack a tiebreaker, add a stopword list with a minimum score
of 25, and add a gold corpus. It also noted that plan 0002 §11 step 5 claims an `eval` corpus
"passes" and is marked **done**. There is no `skills eval` command and there was no corpus. Every
ranking change in this repository had been argued from examples.

## Ruling

**One.** A score may select only with evidence. `scoreSkill` returns `evidence` — the score without
its stack contribution — and the threshold is applied to that, never to the total. Both halves matter:
stack is 15 a tag, so a repo matching three of a skill's tags is 45 on its own, and a threshold that
counted stack would wave it through.

**Two.** `MIN_SCORE` is `W.capability`, 25. Below it the only available signals are `summary` at 8 and
`stack` at 15, and neither is a statement about the task. "Only a capability-strength signal or better
selects" is the rule the review states and the number it gives.

**Three.** Stopwords are suppressed in the summary signal only. A keyword is an explicit declaration
and a name is an identity, so hiding those would suppress something a person wrote on purpose; a
summary is prose, and prose carries words that are there for grammar. `do not push` is a declared
keyword and stays reachable.

**Four.** The rejection says why. `NOT SELECTED` is the block an agent uses to override, so a
rejection that cannot be acted on is the same defect as a bad selection.

**Five.** One place decides, and three commands call it: `rankSkills`, `skills find`, and the MCP
`skills_find` tool. They each ranked on `score > 0` independently, and an assertion that one of them
kept that rule would have passed the entire suite — see the fourth mutation below.

## Consequences

The two acceptance cases in review 0001 §S04 now hold, and both are asserted against the shipped
binary: `fix d1 migration` selects `d1-safe-change` and not `api-contract-sync`, and a task of
stopwords resolves nothing and says why. The budget no longer caps on either.

The gold corpus is `test/fixtures/eval-corpus.json`, ten cases across four ecosystems, run by
`test/eval.test.mjs`. It states `select` (must return) and `reject` (must not), and asserts that
every skill it names still exists in the registry — a corpus citing a renamed skill otherwise passes
by comparing two lists that no longer overlap.

Five mutations, each reverted, each caught by the test that claims it:

| Mutation | Caught by |
| --- | --- |
| the minimum score dropped | two corpus cases, the weak-signal test, and the shipped-binary test |
| stack counted toward the threshold again | two corpus cases and the weak-signal test |
| stopwords not applied to the summary signal | both stopword tests |
| `skills find` reverted to `score > 0` | **nothing** — see below |
| the stopword list emptied | both stopword tests |

The fourth is the one worth keeping. Reverting `skills find` to its own weaker rule passed all 621
tests at the time, because it was the third command to be moved and no test covered the third. It is
ADR-035's lesson exactly: a promise about a set of commands is only true while something checks the
set. The test that now catches it queries `secrets`, chosen because that word lands strictly between
0 and `MIN_SCORE` for exactly one skill (`wrangler`, at 8 via its summary), so the two rules give
visibly different answers — 3 matches against 4.

The first version of the precision metric was also wrong and was caught by the corpus itself. It
scored precision against `select + reject`, so a case where the resolver selected a skill neither
list named scored a perfect 1.0. That is not precision, it is agreement with whatever was written
down. Precision is now measured two ways and both must hold: every named negative stays unselected,
and every case whose answer is "nothing" returns nothing at all.

### What the corpus found that the review did not predict

The `regenerate the openapi contract` case failed on the first run, against my own expectation: I had
written that `web-feature-slice` and `api-feature-slice` should not be selected. The resolver was
right and the corpus was wrong. `web-feature-slice` and `add-country-galaxy` both declare capability
`contract`, and `api-feature-slice` declares keyword `openapi` — so each carries a capability-strength
signal, which is exactly what ruling two admits. A hand-authored gold set is an opinion written down,
and this one had been written without checking the registry.

That leaves a real question this record does not answer: whether `contract` is the right capability
for a skill that registers a country. Changing `graph/skills.graph.json` changes
`provenanceDigest()`, which stamps every consumer repository, so the answer is not a question this
slice may decide by editing one line of data.

## Rejected

**Making the minimum score a `--min-score` flag.** It would let a user recover the old behaviour and
it would put the default in a place nobody reads. The old behaviour is not a preference some
repositories want; it is the reason `NOT SELECTED` was empty and the budget was full of bodies.

**Thresholding on the total score instead of on evidence.** Simpler, and wrong: it fails for exactly
the repos this tool serves. A repo matching three tags is the common case, not the edge.

**Removing the stack signal from the score entirely.** It orders candidates, which is a tiebreaker's
job, and removing it would make two equally-evidenced skills order by name alone.

**Putting the corpus under `graph/`, beside the registry.** `provenanceDigest()` walks `rules/` and
`graph/`, so a corpus file there changes the content digest and forces every consumer repository to
be restamped. A test corpus is not worth a migration, and the digest would move invisibly.

**Building the `skills eval` command this record could have built.** Plan 0002 §9 lists it. It is a
new product surface with its own flags, JSON contract and help text, and its absence is a defect in
the plan rather than in the tool. The corpus and the runner are what S04 asked for; the command is
recorded below as still owed.