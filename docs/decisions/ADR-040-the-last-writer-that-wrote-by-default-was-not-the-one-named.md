# ADR-040 — The last writer that wrote by default was not the one named

Status: **accepted** · 2026-10-08 · affects `simt-dev hooks install`, every remedy naming it, and the shim it installs

## Context

ADR-035 ruled that `writeMode(flags)` decides whether a run may write, "and every mutating
command reads it. A command that consults `flags.yes` directly is a defect whether or not its
arithmetic happens to agree today". ADR-036 then took `sync` out of the set of writers that write
by default. Review 0002's S24 opened by calling `sync` "the only writer that writes by default"
and named its five siblings as the ones that "all preview first": `init`, `upgrade`, `ci`,
`hooks install` and `skills install`.

Four of those five were true. One was not.

Measured against the shipped binary, in a fresh repository that declares `lint` and `test`:

```
$ simt-dev hooks install --root .
repo     .
core.hooksPath  created  (unset) -> .simt-hooks
CREATED   .simt-hooks/pre-commit
CREATED   .simt-hooks/pre-push
WROTE    shims and set core.hooksPath
$ echo $?
0
```

`hooks.mjs` read `flags.yes` at line 146 and `flags.dryRun` at line 169 and imported neither
`writeMode` nor any other write decision. In the ordinary case — no `core.hooksPath`, no foreign
hook — neither flag was consulted at all and the shims were written.

Six independent sources agree this is a defect rather than an exemption:

1. ADR-035's ruling names the exact pattern as a defect.
2. The code is the pattern.
3. S24's premise, which is the finding the rest of Wave 0 was ordered against, was wrong on one
   of six.
4. Review 0002's own migration script instructs: "**Route hooks.** `simt-dev hooks install`
   (plan), then `--yes`." An operator following it would read a plan and get a write, and the
   `--yes` on the next line would be spent on nothing.
5. Three **shipped** strings assumed the preview: `init`'s remedy, two `compare` remedies, and
   the `Reinstall with:` comment inside the shim itself, which is written into every adopting
   repository.
6. `contract.test.mjs`'s `WRITERS` table covered `upgrade`, `sync` and `skills install`. It never
   covered `hooks install`, which is why 586 tests did not notice.

Six is not an accident and it is not a subtle shape. It is what happens when a rule about a set of
commands is checked by reading the commands one at a time.

The comment `sync.mjs` gained in ADR-036 is part of the evidence. It reads "the odd one out among
six: `init`, `upgrade`, `ci`, `hooks install` and `skills install` all preview unless told
otherwise" — a claim about code a different file owns, one commit out of date, which this record
corrects.

## Ruling

**1. `hooks install` reads `writeMode(flags)`, like every other writer.** `apply` gates the write
and the `core.hooksPath` assignment together, so there is no half-installed state reachable by a
flag combination.

**2. The preview exits `EXIT.OK` and names the command that applies it.** A rehearsal is not a
failure: `upgrade`, `ci` and `skills install` previews all exit 0, and a preview that exits
non-zero would make `--dry-run` unusable in a script for no gain. This is deliberately **not**
`sync`'s rule, where a preview that found work exits 1 because plain `sync` is also a check
(ADR-036). `hooks install` is not a check; `hooks status` is, and it says so through its own exit
code.

**3. `--yes` is one flag doing two jobs here, and that is not a reason to keep two.** It
authorises the write *and* it is the consent ADR-018 requires to take over routing git is already
using. A bare command is refused in the takeover case and merely previews in the ordinary one, so
the consent is required exactly where it was before and the write is now gated by the same word.
The BLOCKED text needed no change: it already ended "then re-run with `--yes` to accept".

**4. Every string that names the command moves with it.** `init`'s remedy, both `compare`
remedies, the shim's own `Reinstall with:` comment, the help synopsis, and the ADR-036 comment
that misdescribed it. This is ADR-036's own rule — "a writer that writes says so, and the
instructions naming it move with it" — applied to the second writer rather than the first.

**5. A remedy is a guard, and the guard covers both writers.** `shipped.test.mjs`'s "every remedy
names a command that does what the remedy claims" now scans `simt-dev hooks install` as well as
`simt-dev sync`. The assertion had to be rewritten to be worth having: the original required the
authorising flag immediately after the command, which would have reported `simt-dev hooks install
--root <path> --yes` — the shape `init` prints — as an offender. It searches the rest of the line
instead, stopping at the next `simt-dev` so a correct remedy cannot vouch for a bare one later on
the same line, and it skips comment lines because prose about the tool is not an instruction to
run it.

**6. An unauthorised run that finds work is either a rehearsal or a refusal, and the exit code is
the only thing that says which.** This is a change to the `WRITERS` table, not to `hooks install`.
Asserting only the bytes passes on a command that **refuses** rather than previews, because a
refusal changes nothing. `hooks install` on a repo with no runnable gate is refused exactly that
way, and the refusal is correct: a shim with an empty gate list enforces nothing yet merely
existing replaces whatever git was running. The row therefore carries `stack: 'node'` and the
table asserts the exit code of every unauthorised run — 0 for a rehearsal, non-zero only for the
row (`sync`) that is also a check. The old `if (writer.name === 'sync')` special case became a
`previewFindsWork` column, because a table that encodes one row's name in the loop is a table that
cannot get a new row right.

The assertion is scoped to the unauthorised form. A rehearsal is a different question:
`sync --yes --dry-run` reports the work it found exactly as the unauthorised form does (ADR-036),
and requiring 0 there would fail on behaviour that record deliberately settled. **That was caught
by a mutation, not by reading it** — the first version asserted the exit code in both modes and
failed the whole table.

## Consequences

`hooks install` becomes the fourth row in `contract.test.mjs`'s `WRITERS` table, and its
`verify` fingerprints **both** things it writes: the shim under `.simt-hooks/` and
`core.hooksPath` inside `.git/config`. The second is not decoration. A preview that set the config
without writing the shims would leave a repository whose commits are gated by a hook git does not
run, which is the same silent downgrade ADR-018 exists to prevent — and a shim-only fingerprint
does not notice it. Removing the config probe makes that mutation pass; that was measured rather
than assumed.

Six mutations were applied and reverted, each caught by its own test:

| Mutation | Caught by |
| --- | --- |
| the `!mode.apply` gate removed — always write | the `WRITERS` row |
| the preview drops the "apply with:" clause | `hooks install: without --yes it prints the plan and the command that applies it` |
| `init`'s remedy loses `--yes` | `every remedy names a command that does what the remedy claims` |
| the shim's `Reinstall with:` loses `--yes` | the same guard, and `the installed shim tells the reader how to reinstall it` |
| the `WRITERS` row pointed at the python fixture | the new exit assertion — *"hooks install exited 1 instead of previewing"* |
| the preview half-writes `core.hooksPath` | the `WRITERS` row, and **not** without the config probe |

A seventh mutation is worth recording because it was **not** caught by the new row: `hooks
install --yes` that never sets `core.hooksPath` passes `contract.test.mjs` entirely, because the
row only exercises unauthorised and rehearsed runs. Six tests in `hooks.test.mjs` catch it. The
row does not carry that claim and this record does not claim it does.

Two of the new assertions were wrong before they were right. The exit-code assertion was, as
above. The `sync` row's own preview also exits 1 in `--dry-run`, which is the same finding seen
from the other row. Two of two wrong first is not a coincidence worth explaining: a table that
grows a new column needs each cell written down, and neither cell was.

## Rejected

- **Treat `hooks install` as exempt because ADR-018 already asks for consent.** ADR-018's consent
  is about *taking over* routing git already uses. In the ordinary case there is nothing to take
  over, so the consent requirement never fired — and the write happened anyway. An exemption
  invented to fit a defect is indistinguishable from a decision, which is why this one would have
  needed a reason and there is not one.
- **Leave `--yes` as takeover-only and add a second flag for the write.** Two flags for one
  decision is ADR-035's defect restated: a command reading `flags.a` for one thing and
  `flags.b` for another is how `upgrade` read `yes` and ignored `dryRun`. The word "yes" is also
  what the reader expects, and every remedy already says `--yes`.
- **Make the preview exit 1 when it finds work, matching `sync`.** Defensible, and it would break
  `hooks install` in the one script shape that uses it: read the plan, then decide. `hooks status`
  is the command for "is this repo wired up", and it already reports drift through its exit code.
- **Only add the `WRITERS` row and leave the shipped strings.** The strings are the defect's
  widest blast radius. A remedy that prints a command which no longer reinstalls is ADR-036's
  exact failure, one writer later, and `Reinstall with:` lives inside the file that gets installed
  into every adopting repository.
- **Rewrite `sync.mjs`'s ADR-036 comment by deleting the sentence.** The sentence is the record of
  why that change was made. It is amended instead, with the correction stated, because a comment
  that enumerates which commands follow a rule is a claim about code this file does not own and
  the next reader has no way to check it cheaply.