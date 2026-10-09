# ADR-043 — A keyword is a phrase, and two letters is a word

Status: **accepted** · 2026-10-08 · affects `src/resolve/resolve.mjs` and what `graph lint` rejects

## Context

Review 0001 §S03, marked P1, reproduced exactly. Two independent filters in `scoreSkill` were
between a task description and every skill it named.

`tokenize` dropped tokens of length 2 or less. In this domain those are not noise: `d1`, `r2`, `kv`,
`ci` and `ui` are the vocabulary, and the capability aliases `ui`, `r2`, `kv` and `d1` were dead for
that reason alone. `tokenize("fix d1 migration")` returned `fix, migration` — the one word that
identifies the change was removed from the sentence before anything read it.

Keywords were then compared one task token at a time. A multi-word keyword could therefore never
match, because no single token equals `"durable object"`. Thirteen of the registry's 232 unique
keywords were unreachable, nine of them multi-word, and `durable object` — declared on
`durable-objects`, `cloudflare` and `api-security-review` — was dead on all three. Review 0001 §4
records the symptom: `skills find "durable object"` returned four matches and not one `keyword:`
reason.

`graph lint` reported the registry clean. It checked that `keywords` was non-empty, which a list of
words the tokenizer discards satisfies.

## Ruling

**One.** The tokenizer keeps words of length 2. The floor was 3 and it was chosen as a noise filter
in a domain where the two-letter words are the signal. Lowering it is only half a fix; the noise it
admits is the subject of S04 and is measured below rather than absorbed here.

**Two.** A declared keyword is matched as a contiguous phrase, not token by token. Adjacency is the
whole of the rule, so there is no similarity and no model: `"durable storage object"` does not match
`"durable object"` and `"a durable object"` does.

**Three.** The `keyword:` reason quotes the declaration as written. `keyword:durable object` is a
string a reader can look up in the registry; `keyword:durable` is a keyword nobody declared.

**Four.** A keyword whose words the tokenizer all discards is a lint error. This is the same
question `checkGlobs` asks of a path (ADR-042), added for the same reason: a hand-authored field
costs nothing to declare, so only a check that speaks the resolver's language catches one nobody
executed.

## Consequences

Both acceptance cases named in review 0001 §S03 are now asserted against the shipped binary rather
than against a function's return value, because both are claims about what a reader sees:
`skills find "durable object"` prints `keyword:durable object`, and `skills brief --task "d1
migration"` prints `keyword:d1`.

Five mutations, each reverted, each caught by the test that claims it:

| Mutation | Caught by |
| --- | --- |
| the tokenizer floor put back to 3 | five tests, including both acceptance cases |
| phrase matching reverted to token equality | `a multi-word keyword matches as a phrase`, plus `skills find` |
| `hasPhrase` becomes a bag of words | `a phrase needs its words adjacent` |
| `checkKeywords` deleted | `lint: detects a keyword no task can produce` |
| the reason names a token rather than the declaration | both phrase tests, plus `skills find` |

### The noise this admits, measured

Keeping two-letter words lets six of them reach the summary signal: `an`, `in`, `on`, `of`, `so`, and
`or`, which selects eleven skills on its own. That is real and it is S04's finding, which was filed
against the old floor and is still open.

The measurement that keeps this record honest is the other side of it: `the` selected eleven skills
and `and` selected twenty-nine **before** this change. A `summary:` hit is weight 8, and any score
above 0 selects, so the threshold was already low before a single stopword was admitted. S03 adds
six offenders to a pre-existing problem rather than creating it, and the remedy is the one review
0001 named — a stopword list and a minimum score — not a longer tokenizer floor. Restoring the floor
to 3 would hide the problem by making `d1` disappear again.

## Rejected

**Restoring the length-3 floor and declaring the two-letter aliases dead instead.** It would leave the
suite quieter and `d1` unselectable, which is the defect this record exists to end. The word is in
the domain; the filter is what was wrong.

**Matching multi-word keywords as an unordered bag of words.** Cheaper, and it matches
`"durable storage object"`. It also makes `google-services.json` a keyword reachable by any task
merely mentioning Google, which is not what the declaration means.

**Tokenizing the task and then searching the joined string for the keyword.** Same adjacency, but it
loses the `start` offset a phrase needs and re-tokenizes a task the caller already tokenized. The
keyword is a phrase over the same token stream, so the check belongs on the stream.

**Widening `tokenize` to keep single letters as well.** `c`, `x` and `r` appear in skill names as
initialisms, and every one of them is a stopword or a typo in a task description. Two is the point
below which a word stops being a word.