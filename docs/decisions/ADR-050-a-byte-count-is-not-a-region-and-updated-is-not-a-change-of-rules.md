# ADR-050 — a byte count is not a region, and `updated` is not a change of rules

Status: accepted · 2026-10-09
**Affects:** `src/upgrade/plan.mjs`, `src/projection/markers.mjs`,
`src/projection/project.mjs`, `src/projection/targets.mjs`, `src/projection/baselines.mjs`,
`test/upgrade.test.mjs`, `test/markers.test.mjs`. Closes S26 of
`docs/reviews/0002-full-review-adoption-and-public-release.md`.

## Context

S26's finding was one line of code: the no-region guard in `upgrade` was
`list.every((t) => t.action === 'added' && !t.previousBytes)`, and a repository whose
`AGENTS.md` is hand-written prose has `previousBytes > 0`. Reproduced on a repository built
the way the estate builds one — `init`, then `AGENTS.md` replaced by hand — and `upgrade`
wrote a 9 KB region into a repository that had never had one, reporting
*"pin moved and region restamped (the rules changed)"*. No rule had changed; no region had
existed.

Two further defects were in the same command, and neither was in the finding.

**The guard as written was not the fix it looked like.** Replacing `previousBytes` with
"is every region absent" reproduces the same defect, because the estate's version of this
state leaves the **baselines'** regions in place: `.editorconfig` and `.gitattributes` were
written by the same `init` and are untouched by the hand-written `AGENTS.md`. A guard
asking about every target sees two regions, concludes the repository is adopted, and writes
one. The guard has to ask about the **primary** target, which is the rule `compare` already
applies — its `region` field is the primary document's, and its problem line for this state
is *"adopted but AGENTS.md has no generated region"*. Two commands answering "is this
repository adopted?" differently is the defect S26 and the reason it was easy to write.

**`updated` means two things, and this command reads it to explain itself.** ADR-037 made a
correct region body behind a wrong seam report as `updated`, so `sync` would repair it. That
was right, and it gave `action` a second meaning: the body moved, *or* the bytes around it
did. `upgrade`'s whole purpose is to say why a repository is behind, so with
`action !== 'unchanged'` as the evidence it reports a formatting repair as a change of
policy — and sends the reader to diff rules that did not move. Measured, with the pin
already current in all three:

| State | Reported |
| --- | --- |
| body edited by hand | `the rules changed` — correct |
| seam wrong, body correct | `the rules changed` — **false** |
| stamp moved, body identical | `the rules were already correct` — right, but only by accident of ordering |

The third row is the second half of the trap. Comparing a whole target — bytes, header and
all — makes **every** pin bump claim the rules changed, because the region header carries
the stamp by design.

## Rulings

1. **A region is present or absent; a file is not "small".** `inject` and `diff` return
   `region` (`absent` | `ok` | `malformed`) and `previousBody` alongside `action`, and every
   target carries both. `parse` has always known this; `action` cannot express it and
   `previousBytes` cannot answer it.

2. **Adoption is a question about the primary document.** `upgrade` skips when
   `AGENTS.md` has no region, whatever the baselines hold. This is `compare`'s rule and
   `ADR-016`'s rule about display versus gate, applied to a command that was about to write.

3. **The remedy is `simt-dev sync --yes`,** because `sync` does the thing the skip refused
   to do and nothing else. S26 proposed `simt-dev init`; rejected — `init` re-runs
   adoption, tags and branches, and the remedy would be doing more than the command it is
   the remedy for. `compare` already names `sync --yes` here, and two commands must not
   answer the same question with different instructions.

4. **"The rules changed" is answered by comparing region bodies,** not by reading `action`
   and not by comparing targets. A target is a change to the rules when its previous body
   and the body this simt-dev would write differ, ignoring the leading and trailing
   newlines the region may pick up from the document — the same normalisation `inject`
   uses to decide `unchanged`.

5. **A repair is named as a repair.** `region repaired; the pin and the rules were already
   current` distinguishes a seam fix from a change of policy, because the reader's next
   action differs: one is a formatting commit, the other is a review of what the rules now
   say.

## Consequences

- `upgrade` exits non-zero on a region-less repository, and `check` already did. They now
  agree, and the test asserts the exit code rather than tolerating it: a command that names
  the problem and exits 0 is the ADR-023 failure, and this command was about to start doing
  it in a new place.
- Six mutations were applied and reverted, each caught by its own test. Two of them are
  the finding and its tempting half-measure: falling back to `previousBytes`, and guarding
  on every target instead of the primary one. Both pass the whole suite if the fixture is a
  repository whose `AGENTS.md` is *absent* rather than hand-written — which is why the
  fixture builds the estate's shape instead.
- `inject`'s and `diff`'s return shape grows two fields. Both are derived from a `parse`
  that already ran, and no caller reconstructs them.

## Rejected

- **Repairing the region in `upgrade` rather than skipping.** Rejected: `upgrade` moves a
  pin. Adoption, and the repair of a repository that lost its region, are `init` and `sync`.
  A command that silently performs them during a version bump is a command nobody can
  predict — this module's own header says so.
- **Comparing `previousBody` to `body` including the header,** which would make the stamp a
  rule change on every pin bump. Rejected: ruling 4's normalisation, and the reason the
  comparison is body-to-body rather than target-to-target.
- **Making `region` a field on the plan rather than the target.** Rejected under ADR-002:
  the target is what every caller already receives, and a second place computing the same
  fact is how `compare`'s `profiles` ended up declared and never assigned (ADR-045).