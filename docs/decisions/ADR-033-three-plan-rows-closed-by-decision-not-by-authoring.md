# ADR-033 — three plan rows closed by decision, not by authoring

Status: accepted · 2026-10-08
**Affects:** `docs/plans/0001-centralise-agent-rules.md` §3.1 row 3, §6 phase 6, §6 phase 7.
Ships no rule text. **Refuses:** the seven agent policies row 3 asks for, the twin collapse
phase 6 asks for, and untracking the two committed `local.properties` files phase 7 does not
mention but whose existence made the sweep look unfinished.

## Context

Closing plan 0001 meant auditing each row against the tree rather than against the plan's own
prose, because the plan was written on 2026-10-05 and three things changed underneath it. This
record is the audit's residue: three items that read as unfinished work and are not.

Row 3 asked for eight agent policies as separate files. Seven were never authored. A search for
their source material across every tracked `*.md` and `*.mdc` in the estate returns two files,
neither of which is a policy: they are a progress ledger and a completed UX plan that happen to
contain the phrases. The three most specific of the eight — the 70/30 quality-versus-performance
split, the 12-state coverage list, the matrix-trigger heuristic — have no source anywhere. Writing
them would mean inventing doctrine this estate never agreed to, into `rules/core.md`, from where
every adopted repo would inherit it.

Phase 6 asked to "collapse the 7 drifted Social skill twins to canonical + stub". The registry's
`sources.role` mechanism landed the same evening, two hours after the plan was authored, and
answers the row directly. All three resolvers select `role === 'canonical'` and nothing else —
`src/commands/skills.mjs` twice, `src/commands/skillsinstall.mjs:291`, `src/mcp/tools.mjs:192` — so
a copy declared `duplicate` or `variant` is never installed. The one pair that genuinely had to be
collapsed, `add-country-galaxy`, is already a stub in `simt-social` pointing at the API repo.

Phase 7 asked for a sweep of hardcoded absolute paths. The sweep found 17 tracked files. Six were
fixed. The two Android `local.properties` files were not, and were nearly fixed by reflex.

## Rulings

1. **A row is closed by ruling on it when the thing it asks for was never a decision anyone made.**
   Row 3's eight policies are closed: the four claims `rules/core.md` already carries — the
   minimum viable team, never weakening a security control, anti-overclaim, and a stated agent
   budget that never converts a failure into an approval — are the doctrine, and they ship. The
   other four, including the 70/30 split, the 12-state list and the matrix-trigger heuristic, are
   recorded here as unmade. If one is wanted it needs someone who held the original
   conversation, not someone reconstructing it from a table cell.

2. **A mechanism that supersedes a row retires the row, and the deletion is the wrong move.** The
   `sources.role` vocabulary already distinguishes `canonical`, `duplicate`, `variant`, `stub` and
   `deprecated`, and `graph lint` passes with all of them in use. Deleting a `duplicate` copy would
   remove a version-pinned tool from a repo that can still run it, and nothing would detect the loss
   because resolution never read those bytes. Phase 6's twin collapse is therefore closed as
   already answered, at `a9983c8`.

3. **`local.properties` stays tracked.** Both `simt-app` and `wakt-app` commit it, and both
   `.gitignore` files have the conventional `# local.properties` line commented out at lines 22 and
   24 — a deliberate override of Android's own convention, not an oversight. Untracking them would
   be a house-style change made while closing a plan, and a build machine that checks out without
   an SDK would stop building. It stays, and plan 0001 says so, so the next sweep does not
   rediscover it as a defect.

## Consequences

Row 3 reads "done, four of eight" rather than "partial". Phase 6's twin item reads "superseded"
rather than "outstanding". The estate keeps two `local.properties` files whose `sdk.dir` names a
developer's home directory, by decision.

The registry's byte counts moved with the two skill bodies corrected in the same pass, because a
declared source's identity is its size (ADR-015): `cloudflare` 384277 → 384869 and
`production-quality-review` 5869 → 5904. That changed the provenance digest (ADR-032), so all
fourteen adopted repos were re-stamped afterwards rather than left pinning a value this tool can no
longer produce.

## Rejected

**Authoring the seven agent policies.** The plan's one-line summaries are not enough to write seven
files of rule text, and these rules reach every adopted repo. This is ADR-030's exact shape: an
unmade decision is not a gap to fill by invention.

**Collapsing `graphify` and `parallel-feature-team`.** Both are declared `duplicate` with matching
byte counts, so they look like the obvious candidates. `graphify` is `vendored: true` — an
84 534-byte, ten-file, version-pinned tool present in both Social repos on purpose. Deleting
simt-social's copy would leave nothing to detect the loss, because resolution only ever read the
canonical copy.

**Untracking `local.properties`.** An Android SDK path is machine state, and two repos chose to
share it. That is the repo's call to reverse, not a plan's defect sweep.