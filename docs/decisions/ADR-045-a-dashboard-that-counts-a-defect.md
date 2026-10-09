# ADR-045 — A dashboard that counts a defect and will not name it is worse than one that does not count it

Status: **accepted** · 2026-10-08 · amends ADR-016 · affects what `compare` reports and exits on

## Context

Review 0002 §S25, marked P1, reported two defects in one row. Both measured against the estate
before anything was changed, and both confirmed exactly as written.

**One.** `src/compare/row.mjs` gated the stale-rule-file problem on `row.adoption === 'adopted'`.
`adoption` was initialised at line 78 and only assigned at lines 127–131, so the gate ran before
anything settled it and compared against the initialiser's `'unmanaged'`. It could never fire.

Measured over the 16 repositories at `~/code/simt`:

```
staleRuleFiles: 17
repos naming stale rule files in problems: 0
simt-app problems:
  "the generated region was hand-edited; restore it with: simt-dev sync --yes"
  "core.hooksPath is \"hooks\", not the shared dispatcher; run: simt-dev hooks install --yes"
```

Five adopted repositories have stale rule files — `simt-app`, `simt-blog` and `simt-social` at 0
of 3 current, `simt-social-api` and `simt-social-media` at 0 of 4 — and not one of them said so in
its problems list. The summary already said `staleRuleFiles: 17`, because `summarise` has always
counted them. So the dashboard was reporting a count of a defect it refused to call a defect.

**Two.** `profiles` was documented at `row.mjs:33` as "profile ids that would be selected",
initialised to `[]` at line 83, and never assigned anywhere in the file's life. Every row of every
run reported no profiles. `plan()` — the thing `sync` renders — returns them.

## Ruling

**One.** A row's problems list names every stale rule file, and the exit code follows. The gate
reads `adoption` after it is settled, which means the ordering is part of the contract: **a gate
that reads a field the line above has not set yet is not a gate.** That sentence is the whole fix.

**Two.** The gate stays. A repo that has never been adopted has its own files, and reporting them
as "not current" turns the normal mid-migration state into a red estate — ADR-018's reasoning for
hooks, applied here to rule files. There is a test for the negative half specifically, because
fixing the gate is exactly the kind of change that turns this on.

**Three.** `profiles` is filled from the same `select()` call, on the same inputs, that
`desiredRegion` makes. Not from a copy of the rule table and not from the manifest's declared
stack: a dashboard that disagrees with the tool about what it would write is worse than one that
says nothing, because it is believed.

**Four.** A field documented as an answer must be either answered or absent. `profiles` was neither:
it was present, empty, and described as populated in the type it was documented with.

## Consequences

The estate now names all 17: five repositories carry the problem line, and `compare` exits non-zero
on them. Nothing else about the detection changed — the count was 17 before the fix and is 17 after
it. This slice changed reporting, not measurement, and the test asserts that by requiring the
fixture to start current before the edit.

### The ruling this amends

ADR-016 ruled that "`compare` continues to report one row per repo using `AGENTS.md` only, because a
dashboard row cannot represent four files. The gate uses the full finding list, so the dashboard's
coarser view is not inherited by the thing that must not be wrong."

That ruling is about the row's **shape** — which files it displays — and it still holds. The row
already carried `ruleFiles.total`, `ruleFiles.current` and `ruleFiles.stale` before this change, so
ADR-016's coarser display was never the problem.

What was missing is that ADR-016 reasoned about the *display* and the *problems list* together, and
they came apart. The dashboard was allowed to be coarse about which files it shows, and it was also
allowed to be silent about whether an agent reading them would get correct rules. Those are
different permissions, and only the first was granted on purpose. The problems list is not a
display; it is the exit code.

So: ADR-016 is amended, not overruled. The row stays coarse; the problems list does not.

### Three mutations, each caught by exactly its own test

| Mutation | Caught by |
| --- | --- |
| the stale-rule-file gate cannot fire | `a stale rule file on an adopted repo is a problem` |
| `profiles` back to its initialiser | `compare reports the profiles sync would project` |
| `profiles` computed from the declared stack instead of the detected one | `compare reports the profiles sync would project` |

The third is the one that matters. It is the shape this defect actually takes when it recurs: not an
empty array but a plausible array computed from the wrong input. A test asserting a hardcoded
expected list would have caught the second mutation and passed the third; asserting
`row.profiles` equals `plan(root).profiles` catches both, because it is the relationship rather
than the value that is the contract.

### A fixture that asserted nothing

The first version of the stale-file test appended a line after the `END` marker. That is hand-owned
content by design — the containment guarantee another test in the same file already asserts — so the
file was correctly not stale and the test failed. The fixture was making an edit the test claimed
wasn't being made. It now edits inside the region and asserts that the edit landed by checking the
recorded SHA marker is present first.

A first attempt at the mutation was also too coarse: re-deriving `adoption` in the wrong place broke
ten tests at once, which told me the ordering is load-bearing but not which gate depended on it. The
isolated mutation is `if (false && …)` on the one gate.

## Rejected

**Reporting per-file drift in the row's display, so the dashboard shows all four files.** ADR-016
already rejected this and its reason has not changed. A row is read across sixteen repositories at
once; four filenames per row is noise at that scale.

**Making `compare` defer entirely to `check` and drop the problems list.** The dashboard is the thing
a reader runs when they want to know where the estate stands; a command that says "run the other one"
has moved the problem rather than answered it.

**Exiting non-zero on an unmanaged repo's stray rule files.** The gate exists for the reason in
ruling two, and there is a test that asserts the negative so the fix cannot quietly widen it.

**Filling `profiles` from the manifest's declared stack.** It is cheaper and it is wrong: the
manifest is a declaration, `fingerprint` is a measurement, and `sync` selects on the measurement.
A dashboard reporting the declaration would be consistent with itself and inconsistent with the
tool. Mutation three is what that looks like when it happens.