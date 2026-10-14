# ADR-072 — The budget is a declaration beside the gates, not a number inside the projection

Status: **accepted** · 2026-10-14 · filed as S38
**Affects:** `src/projection/manifest.mjs`, `src/measure/context.mjs`, `simt tokens`,
`test/tokens.test.mjs`

## Context

Review 0002 row S38 asks for a per-repository always-on budget: "for these 7 roots,
generated always-on bytes are at most 30 KB". Plan 0003 spells the mechanism as R08, and
the plan was read rather than recalled, which is how the two facts below were found.

The first is that R08 as written presupposes R07. Its compiler "packs kernel lines by
priority class" and `check` reports "each cut line" — and there are no kernel lines
without R07's `projection.mode` and the per-line kernel frontmatter it introduces, whose own default stays
`full` until R02 proves a narrow mode is not worse. With no kernel there is nothing to cut,
so the packing half of R08 cannot be built honestly before the R01–R05 evaluation has been
run. Building it anyway would mean inventing a kernel nobody measured.

The second is where the number lives. R08 says `projection.budget.bytes`. In this tool
`projection` is a generated key: `GENERATED_KEYS` names it, and `withGenerated()` replaces
it with the tool's own `{ simtDevSha, version }` on every write. A budget written there
would be deleted by the next `upgrade`, and — because `manifestDrift` compares only the
generated keys — not reported as deleted. The repo would watch its budget disappear on a
green gate. That is the same defect this package treats as unrecoverable everywhere else:
content the repository chose must be preserved by the repair, not overwritten by it.

So the part of R08 that is independent of the kernel ships now, and the part that is not
does not.

## Rulings

1. **The budget is a repository declaration at the top level of the manifest, beside
   `limits` and `gates`.** It is content the repo chose, so it survives `upgrade`, and the
   plan's `projection.budget.bytes` spelling is superseded rather than edited in place. The
   default is not a field either: it is the value whoever measures applies when the key is
   absent, so `simt tokens` and the gate read one number from one place.

2. **A repository that declares nothing is not reported as having declared the default.**
   `buildManifest` omits the key entirely when the repo has none, which keeps
   `budget.declared` an honest fact. Writing the default in would make every adopted repo
   look like it had chosen the review's line — a reader told "declared: true" about a
   number nobody wrote is being lied to about the only thing the number is for.

3. **The default is 30,000 bytes and it is the review's figure, not this tool's
   measurement.** It is written as 30,000 rather than 30 × 1024 because it is a ceiling and
   the conservative reading of "at most 30 KB" is the one that trips first.

4. **Over budget is reported, never enforced.** The finding names the bytes measured, the
   bytes declared and what was not done: nothing was cut, because the projection is still
   in full mode. A reader who sees an over-budget line must not conclude the projection
   shrank, and a gate that failed here would fail on a measurement this tool has not
   validated against a study.

5. **`simt tokens` carries the finding it would raise, produced by the same function.**
   One function words the fact, so the report and the gate cannot describe the same
   overflow two ways.

6. **The rows themselves are unchanged.** Which rules move behind skills is R01–R05's
   finding, not this record's, and a budget that silently dropped rules would be enforcing
   a decision nobody has made.

## Consequences

S38's accept criterion is now checkable rather than asserted: a repository can declare the
line it intends to carry, and `simt tokens` reports it against that line and says how far
over it is. Three tests hold the two halves that were easy to get backwards — the budget
survives an upgrade, a repository that declared nothing keeps `declared: false`, and the
finding says that nothing was cut.

What has not landed: the gate reporting the budget as a finding, and R08's packing. The
first needs the number the gate is already comparing — the bytes of the region and the rule
files it checks — so that `check` and `tokens` cannot report different totals for one
repository; that is a wiring decision, not a measurement. The second needs R07.

## Rejected

- **The plan's `projection.budget.bytes`.** The generated block is replaced wholesale on
  every upgrade, and nothing in the repair would notice.
- **A default written into every manifest.** It would make every adopted repo look like it
  had chosen a number it never chose.
- **Cutting lines to fit the budget now.** There is no kernel to pack and no measurement
  saying which lines a reader can lose.
- **Failing the gate on an over-budget projection.** The number is this tool's own
  estimate, and a gate that fails on its own estimate teaches a reader to ignore it.