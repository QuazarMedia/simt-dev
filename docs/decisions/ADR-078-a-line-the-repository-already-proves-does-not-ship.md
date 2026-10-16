# ADR-078 — A line the repository already proves does not ship, and the author says so

Status: **accepted** · 2026-10-16 · filed as R09 (plan 0003)
**Affects:** `src/kernel/inferability.mjs`, `src/projection/rules.mjs`, `src/kernel/card.mjs`
(the verb vocabulary), `src/argv.mjs`, `src/commands/help.mjs`, `test/inferability.test.mjs`,
`test/shipped.test.mjs` (the estate-name guard's allowlist of the tool's own words)

## Context

Plan 0003 R09 asks for an inferability filter: a rule line may declare
`simt-inferable-when: <fact expression>`, and when the repository already proves the
expression the line is dropped — "use `./gradlew`" when the wrapper is the only runner and
the card names it, "use pnpm" when only `pnpm-lock.yaml` exists. The basis is that content
the repository already states does not help its reader.

ADR-077 built the card that names this repository's commands and left R09 open as the filter
"that would drop a card line the repository already states". What the plan leaves open is
the part that decides whether the mechanism is usable or a trap:

1. **Who may drop a line.** An inferability filter that guesses is a filter that deletes
   rules a reader needed. "The repository has a `.editorconfig`, so the indentation rule is
   inferable" is exactly the reasoning that is right most of the time and silent when it is
   wrong.

2. **What evidence may be read.** The same choice ADR-077 ruling 2 had to make, and the same
   answer applies: the projected region is required to be byte-identical on two machines
   (plan 0003 P4, R13), so evidence read off the machine cannot decide what leaves.

3. **What a removal costs the author.** A line that leaves a projection with no trace is the
   mistake ADR-073 rejected for deferred rules. But a `## Dropped` section would spend region
   bytes on lines the reader is being told not to read, which is the opposite of the slice's
   purpose.

## Rulings

1. **A line leaves only when its author says it may.** The mechanism is opt-in per block, by
   a marker the rule author writes — `<!-- simt-inferable-when: <expression> -->`. Nothing is
   dropped by inference alone. The tool checks a claim; it does not make one.

2. **The unit is the blank-line-delimited block, and the marker never reaches the region.**
   A wrapped bullet is marked once and leaves whole, rather than leaving half a sentence
   behind. The comment is stripped from the region whether or not the line is dropped:
   `simt-` vocabulary is for the rule's author, not for its reader.

3. **The expression is a conjunction of positive terms over a closed vocabulary.** A term is
   a fact or stack tag in `KNOWN_TAGS`, a `card:<verb>` for one of the card's five verbs, or
   a `gate:<name>` the repository declares. There is no negation: every reason a line is
   redundant is a positive proof the repository offers, and a grammar for a case nobody has
   is a grammar nobody can be taught. A term outside the vocabulary is a defect, reported
   through the same field as a broken frontmatter key, so `check` and `rules list` need no
   second path to a broken rule.

4. **The proofs are committed bytes only.** The repository's own facts and stack, the gates
   its manifest declares, and the verbs its card names. Never PATH and never `node_modules`,
   for the reason ADR-077 ruling 2 already settled: a proof read off the machine would make
   the region differ between a laptop and CI for no reason a diff could explain.

5. **The filter is about the repository's evidence, not about the mode.** It runs in both
   `full` and `kernel`, for the same reason the card does (ADR-077 ruling 1): inferability is
   a property of what the repository commits, and inferability of the mode would withhold the
   saving from every reader who kept the larger projection.

6. **Never silent, and never a heading.** By default a removal is reported as one count in
   the projection notes, with the command that names each one: `--explain` prints every
   removal and the evidence behind it. A count is enough to act on; the per-line detail is
   what an author needs, and a reader is not an author.

7. **The vocabulary has one definition.** `card.mjs` exports the five verbs the card can
   name, and the filter validates `card:<verb>` against that same list. A copy of the list in
   the filter would let the card name a verb the filter called unknown.

## Consequences

The region of a repository whose rules carry no marker does not move a byte: the filter
returns the body by identity when there is nothing marked, so this ruling cannot drift a
repository that did not ask for it. Where a marker is written — in a repository's own
`.simt-dev/profiles`, or in a pack — the marked line leaves the region on the next `sync`,
and `sync --explain` names it and the evidence.

**What has not landed: no shipped rule carries a marker.** `rules/stacks/go.md` states
"`go build ./...`, `go test ./...` are the entrypoints; `go vet ./...` runs with them" and
`rules/stacks/uv.md` states "`uv run -m pytest`; **never** `uv run pytest`" — both duplicate a
card line, and neither is *wholly* inferable, because each also carries a reason the card does
not state. Dropping them would lose the reason. Marking shipped rule text is therefore a
content pass with its own blast radius (a change to shipped rule text changes every repository
at once), not a step of this slice; the mechanism ships first so that pass can be measured.

A marker stays visible in `simt rules show <id>`, which prints the rule's own text. That is
deliberate: it is the author's annotation, and it is the reason a line they can see in the
file is absent from the region. It is not region text, and it never reaches one.

`--explain` is a `sync` flag and not a `check` flag, because `sync` is the command that prints
projection notes and the preview a reader reads before writing. The JSON payload of `sync`
does not carry notes, so this adds no contract.

One visible oddity, stated because the reader will meet it: `simt rules why ADR-078` prints
`simt-inferable-when` as a repository this record surveyed, because the decisions reader
treats every `simt-` word outside its allowlist as one. That is a defect in the reader rather
than in this ruling — ADR-073 carries the identical one for `simt-priority` — and it is not
fixed here.

## Rejected

- **Dropping a line the tool judges inferable without a marker.** It is the failure the slice
  exists to avoid: a rule deleted by a heuristic with no way for the author to see the
  heuristic was wrong.
- **A marker on every physical line.** A wrapped bullet is one sentence across two lines;
  marking lines would let a removal leave half of one behind.
- **Negation, parentheses or disjunction in the expression.** No shipped reason for a removal
  is negative, and a grammar with a case nobody uses is a grammar nobody can be taught.
- **Letting the filter run in `kernel` mode only.** It would withhold a saving from the
  readers who kept the larger projection, which is all of them until R02 has run.
- **A `## Dropped` section in the region.** It spends bytes on lines the reader is told not
  to read, and it moves the rule set for a reason that is not about the reader.
- **Marking shipped rules now.** No shipped line is wholly inferable, so it would delete
  rationales to save bytes that the card already saves, and it would change every
  repository's region in a slice about a mechanism.
