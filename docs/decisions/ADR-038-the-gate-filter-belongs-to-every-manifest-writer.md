# ADR-038 — The gate filter belongs to every writer of a manifest, not to `init`

Status: **accepted** · 2026-10-08 · amends [ADR-017](ADR-017-a-declared-gate-must-be-runnable.md) ruling 1 · affects every code path that calls `buildManifest`

## Context

ADR-017 ruled that a gate is declared only if the repo can run it, and attributed the
mechanism to one command: *"`init` filters the stack table's proposals through what the
repo demonstrably has."* The belief is general. The attribution is what was read, and it
stayed true only as long as `init` was the sole writer of a manifest.

Review 0002's S27 is what the attribution bought. `recordLocal` in `skills install` writes a
manifest for a repo that has none, and called `buildManifest` with no capability. Measured
end to end: a bare Node repo — a `package.json` with no scripts and no `node_modules` — ran
`skills install api-contract-sync --yes`, and the manifest it was handed declared `format`
and `lint` on pre-commit and `test` and `typecheck` on pre-push. `check` then reported four
`UNRUNNABLE` findings and exited 1. After `hooks install`, a real commit ran the pre-commit
gate, which failed both staged gates with their remedies and blocked. The hook's own exit
code is not the commit's, so the reader's first evidence is a commit that silently did not
happen.

Four declared gates the repo cannot run, written by a command whose entire job is to pin
one skill. ADR-017's own wording names this as the failure: *"declaring one would block
every commit"*.

The test that should have caught it asserted the opposite of the truth. It checked that
`gates` was present and that `preCommit` and `prePush` were **non-empty**, and read
non-empty as correct — so the test about manifests being right passed on a manifest
declaring four gates nobody could run.

## Ruling

**1. `buildManifest` requires a capability from every caller.** The filtering happens in one
place, and that place is reached only with the evidence it filters on. A caller that passes
no `capability` is a caller asking for the defaults, and today it gets them — which is
correct for a pure function and wrong for a writer. Rather than make the parameter
mandatory and break the three call sites that legitimately want defaults, the ruling is on
who writes: **a command that writes a manifest for a repo that has none must probe first**,
because it is making a promise on that repo's behalf.

**2. A command that writes a manifest declares nothing it cannot prove.** This is ADR-017
ruling 1 with its attribution removed, and it covers a shape ADR-017 did not anticipate:
a writer that is not an adoption command. `skills install` is not adopting the repo. It
pins one file into `.agents/skills/`. Writing a full manifest was already the wrong shape
for it and was ruled on once already; the record for that ruling said *"a `{localSkills}`
stub would read as authoritative while omitting `gates`"*, and the fix was to write the full
canonical shape. The reasoning was right and the conclusion drawn from it was wrong, because
canonical shape and default gates are different things and only one of them is a fact about
the file's schema.

**3. A manifest that declares no gates is a valid answer.** A repo with no scripts and no
formatter gets `preCommit: []` and `prePush: []`. ADR-017's consequences section already
ruled this — `init` has been writing it — so the only new fact is that a reader of the
record can now see the invariant is not `init`'s to keep.

**4. The test asserts the manifest is true, not that the field is present.** The new test
runs `unrunnableGates(manifest, await readCapability(root))` — the function `check` runs,
with the probe `check` uses — and requires an empty result. It also runs against a fixture
that *can* run gates and requires them to be there, because a fix that hardcoded two empty
lists would pass the first half and arm the project with no gates at all.

## Consequences

`test/install.test.mjs`'s existing assertion changed from
`assert.ok(manifest.gates.preCommit.length > 0 && …)` to
`assert.deepEqual(manifest.gates, { preCommit: [], prePush: [] })`. That is a test whose
pass condition was the defect, and it is the fourth in this repository to read presence as
correctness — the shape ADR-030 exists to catch.

Three mutations were applied and reverted, each caught by its own test: the `capability`
argument removed; a hand-built empty capability substituted for the probe (caught by the
capable half, not the bare one); and the capable half's non-empty assertion deleted — which
the bare half alone did not notice, confirming both halves earn their place.

## Rejected

- **Make `capability` a required argument of `buildManifest`.** Three callers legitimately
  want the unfiltered defaults, including the tests that exercise `planGates` directly. A
  signature that cannot be called wrongly is worth having, and the wrong call here is one of
  two lines in a function whose purpose is obvious from its name; ruling on the caller keeps
  `buildManifest` a pure function that a test can call with any evidence it likes.
- **Have `skills install` write a `{localSkills}`-only manifest after all.** That was ruled
  on and the ruling holds: a partial manifest reads as authoritative while omitting `gates`,
  and `init` would then have to be run to complete it. Probing is the smaller change.
- **Let `check` repair it, since `check` already reports the finding.** `check` reports
  findings; it is not the command a reader runs before `skills install` has already blocked
  their commits. The landmine has to be defused at the moment it is laid.
- **Leave ADR-017 as written and put the generalisation only in the code.** The code is
  where the second writer is, and a record that names `init` is a record a reader trusts to
  have already covered the case. ADR-017's own context section says nothing else owns the
  manifest — that was true in 2026-10-06 and this is what made it false.
- **Amend ADR-017's ruling 1 in place.** ADR-017 is accepted and its context is the evidence
  for why the gate filter exists at all. Rewriting the sentence would leave no trace that the
  rule was ever narrower than it reads, which is the same trick the gate list itself was
  performing on its reader.