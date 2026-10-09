# ADR-046 — One rule, one copy: a reader that reads AGENTS.md must not also get the file

Status: **accepted** · 2026-10-08 · supersedes ADR-021 ruling 3 · settles P7's context-budget question

## Context

Only ADR-021 **ruling 3** is superseded. Its other rulings — one surface per repo, a pointer is not
a copy, a written file is not removed, skills follow the same rule — stand, and ruling 6 is load
bearing *here*. So the status line deliberately does not name it in the form the index parses
(`supersedes [ADR-NNN]`): marking the whole record superseded would be false, exactly as it would
be for a narrowing.

Review 0001 §S12, marked P1 and "decision". Measured across the estate before anything changed —
the five repositories selecting `opencode,cursor`:

```
simt-app           folded=3  .mdc=3  0/3 current
simt-blog          folded=3  .mdc=3  0/3 current
simt-social        folded=3  .mdc=3  0/3 current
simt-social-api    folded=4  .mdc=4  0/4 current
simt-social-media  folded=4  .mdc=4  0/4 current
```

Seventeen generated rule files. Every one of them byte-identical to the section already folded into
the same repository's `AGENTS.md`, verified by extracting both bodies and diffing: the only
difference was a trailing marker line in my first extraction, and the second extraction made 14 of
the 17 identical and the remaining three identical apart from that marker. **28,101 bytes of context
loaded twice per session**, in five repositories, forever.

ADR-021 ruling 3 decided this deliberately: "Folding is `some`, not `all`: a repo that also opts into
Cursor still folds, because an opencode reader's only channel is `AGENTS.md` **and a Cursor reader
getting `.mdc` files does not serve them**."

The bolded clause is the whole dispute, and it is a factual claim about a vendor. It is false.
Cursor's own documentation says `AGENTS.md` is "a simple markdown file for defining agent
instructions... an alternative to `.cursor/rules`", and that "Cursor supports AGENTS.md in the
project root and subdirectories." Cursor reads `AGENTS.md`.

Note where the original claim came from: the `readers` string on **simt-dev's own opencode row**
already said "AGENTS.md is also read natively by Codex, Cursor, Windsurf, Zed, Amp, Jules, Copilot
CLI and the DeepSeek harness". The table knew. The decision that depended on the fact was written
without checking the table, which is the shape of error this repository keeps having.

## Ruling

**One.** A surface declares `readsPrimary: true` when its own vendor documents that its reader loads
`AGENTS.md`. When any selected surface folds, `ruleTargets` skips per-rule files for those surfaces
and says so in the plan: the note names the file and the reason.

**Two.** It is per-surface, not global, because Copilot is the counter-example and the row says so
already: its CLI reads `AGENTS.md`; its editor and code review do not. A per-rule file there is the
only channel two of its three readers have, and dropping it would remove the process rules from a
chat that had nowhere else to get them.

**Three.** The skip depends on folding. With no folding surface selected there is no region to
duplicate, so a repo on `cursor` alone still gets its files — asserted, because a flag that reads
as "cursor never gets files" would be a different and much larger change.

**Four.** `sync` never deletes a file it wrote (ADR-021 ruling 6), so a file that becomes orphaned
cannot be repaired by any command. It is therefore a **note with a remedy, never a problem**, and it
never fails the gate. A gate nothing can satisfy is worse than a gate that is merely noisy.

**Five.** The tool must not stop looking at it. `orphanedRuleFiles` scans the rule directories of
every `readsPrimary` surface — **whether or not the repo still selects it** — for files carrying a
simt-dev region, and reports them. A file without the marker is hand-owned and is never mentioned.

## Consequences

`sync --surfaces opencode,cursor` now writes `AGENTS.md` and no `.cursor/rules/*.mdc`. The three
always-on rules still arrive, folded, and the plan says why each file was not written.

The estate reports all 17 as notes with a delete command. Nothing was deleted: removal is a human
decision with a visible diff, and this record does not authorise a tool to make it.

### The invisibility that ruling five exists to prevent

The skip landed first and the estate run showed `staleRuleFiles` go from **17 to 0**. Every one of
those files was still on disk. A tool that stops looking at a file it generated has not cleaned up —
it has lost track of it — and the symptom is a dashboard reporting a clean estate while seventeen
files are being read twice.

The first version of the scan then made the same mistake in a subtler form: it iterated the
*selected* surfaces. A file becomes orphaned precisely when a repo **drops** the surface that wrote
it, so scanning the selected set finds nothing at all — the one repo that needs the note is the one
that dropped the surface. Both defects were found by running the command against the estate, not by
reading the code. The estate run is worth more than either unit test.

### Six mutations, three of which caught nothing at first

| Mutation | Caught by |
| --- | --- |
| the skip never fires | `opting into a rule surface ... writes one file, not two` |
| `readsPrimary` applied without the folding condition | three tests, including `cursor alone still gets its own files` |
| the orphan scan deleted | **nothing** — found, then fixed |
| `orphaned` made blocking | **nothing** — found, then fixed |
| `orphaned` counted as a stale problem | **nothing** — found, then fixed |
| orphan scan restricted to selected surfaces | `compare reports an orphaned rule file as a note` |

The middle three passed all 627 tests, which is worth recording plainly: the half of this slice with
the most dangerous failure mode — a gate nothing can satisfy — shipped with no test at all, and only
a deliberate mutation found it. Four tests were written afterwards, including a negative control
("a repo's own rule files are never reported as orphaned"), because a scan that always returned an
empty array satisfies every positive test in the file.

### Two tests that encoded the old ruling

`test/surfaces.test.mjs` asserted the three `.mdc` files beside the folded region, with the comment
"One canonical source, two destinations" — a fair description of the behaviour, and the behaviour
was wrong. `test/upgrade.test.mjs` used `--surfaces opencode,cursor` to produce the generated file
whose wholesale repair it tests. Both now use **copilot**, whose reader does not read the primary, so
the properties under test are unchanged while their fixtures remain honest. A test fixture built on
a behaviour a new ADR reverses has to be moved deliberately, and the reason recorded, or the next
reader moves it back.

`test/compare.test.mjs`'s S25 fixture also moved to copilot for the same reason — and its helper
selected rule files by the `.mdc` suffix, which silently matched nothing and reported "the fixture
must project at least one rule file" rather than "the fixture is broken".

## Rejected

**Deleting the orphaned files automatically.** ADR-021 ruling 6, and the reason is sound: `sync` is a
projection, and a projection that deletes is a second, silent writer. The file is reported with the
command that removes it.

**Making `readsPrimary` global.** It would drop Copilot's only channel for its editor and code
review. The flag is per-surface for that reason and the Copilot row carries the note that says why.

**Keeping the `.mdc` files and not folding into the region when both surfaces are selected** — the
alternative review 0001 named. It gives opencode users nothing in mixed repos, which is ADR-021's
original objection to one surface per repo and still true.

**Removing Cursor support entirely, on the grounds that it reads `AGENTS.md`.** That would be true
and would lose the `.mdc` channel for anyone whose Cursor does not surface `AGENTS.md`, and it would
make a narrowing into a removal — which is not this tool's habit. The rules still reach a Cursor
reader; they just reach them once.

**The worktree-agent caveat becoming a gate.** A Cursor bug report records `AGENTS.md` not being read
in worktree agents by default, fixed in 3.9. That is a fact about a product and it is recorded on
the row, but gating on a version number would make a rule's presence depend on a vendor's release
cadence — and the alternative for those readers is a duplicated 5 KB, which is the cheaper error.