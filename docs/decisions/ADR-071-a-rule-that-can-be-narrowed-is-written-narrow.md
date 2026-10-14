# ADR-071 — A rule that can be narrowed is written narrow

Status: **accepted** · 2026-10-14 · filed as S50
**Affects:** `src/projection/rules.mjs`, `src/projection/targets.mjs`,
`src/projection/surfaces.mjs`, `src/projection/project.mjs`, `rules/stacks/*.md`,
`test/scoped.test.mjs`, `test/project.test.mjs`, `test/surfaces.test.mjs`

## Context

Every per-rule file this tool ships was always-on, and so was every stack profile, because
profiles had nowhere else to live: they reached a reader through the generated region in
AGENTS.md and through nothing else. A repository on Cursor got the profile in both places,
and a repository on opencode got it in one place, always, whether or not a Python file was
ever open.

Two vendors document how to make that conditional, and both were read rather than recalled.
Cursor attaches a rule with `alwaysApply: false` and `globs` "when a matching file is in
context", and separates patterns with commas. Antigravity takes `trigger: glob` with a
comma-separated `globs`, requires patterns that start with `*` to be **quoted** so YAML does
not read them as alias anchors, and **discards a rule with invalid frontmatter without a
message**. It also documents a 24 KB per-file limit and a 20,000-token budget for always_on
rules, past which rules are demoted to pointers — so an eager profile is not merely
wasteful, it is a budget the reader spends on rules that did not apply.

One row of the surface table is the reason this needed a ruling rather than a patch.
Decision 3 — an always-on rule emits no scoping frontmatter — was settled on Claude Code's
`paths:` key silently failing to lazy-load for quoted values and YAML sequences
(anthropics/claude-code#13905, #17204, #19377), with the documented examples not valid YAML.
That decision stands. This record says what happens on either side of it, and does not
rewrite it.

## Rulings

1. **A profile leaves the region only when every selected surface can narrow it.**
   `desiredRegion` asks whether all of them can; when one cannot, the profile stays in the
   region and a note says which surface stopped it. The alternative — writing the profile
   only as a scoped file for the three surfaces that can scope it — leaves a Claude Code
   reader with no rule at all, and a rule nobody loads is worse than a rule that loads
   eagerly.

2. **Three surfaces can narrow, and the answer is per surface rather than per key.**
   Cursor (`globs`), Antigravity (`trigger: glob` plus `globs`) and Copilot (`applyTo`)
   can; Claude Code cannot, for the reason in decision 3; opencode cannot, because it has
   no per-rule channel at all (`rule: null`). `canScope` names the answer, and the shipped
   gate now probes the scoped frontmatter shape as well as the eager one, so a row that
   emitted `globs` without documenting it would fail the gate rather than ship an inert
   key.

3. **Antigravity's patterns are quoted, and a scoped rule always carries a description.**
   Unquoted `**/*.py` is an alias anchor and the whole rule is discarded silently. Cursor
   documents no description plus no globs as manual `@`-mention only, so a scoped rule with
   neither would never attach to anything — a rule that looks installed and is not.

4. **A scope that matches everything is a defect, not a narrowing.** `**`, `**/*` and `*`
   are what a surface applies when it is given no pattern, so a profile carrying one is
   the eager profile wearing a costume. An empty list is the same thing spelled plainly.
   Both are refused by `describeDefect`, where a profile's other frontmatter is checked.

5. **A quoted pattern is read as the pattern.** `parseFrontmatter` did not strip quotes, so
   a profile author quoting `"src/**/*.ts"` would have projected a glob matching nothing.
   The reader now strips them, because the alternative is that the obvious spelling of a
   glob silently does not work.

6. **One construction, and the gate uses it.** `scopedTargets` delegates to `ruleTargets`
   with the profile marked `alwaysApply: false`, and `checkTargets` calls the same function
   `plan` does. A scoped file that was planned and written but never gated would show a
   clean `check` over a stale reader — the asymmetry this module exists to prevent.

7. **The region keeps a pointer section.** A profile that moved is named in AGENTS.md with
   its patterns and the files it moved to. A reader who knows the profile was there and
   cannot find it will otherwise conclude it was deleted, and the region's source list is
   the provenance a review reads.

8. **The shipped profiles carry the scope that selected them.** Eighteen of nineteen: node,
   typescript, react-web, react-native, python, uv, rust, go, ruby, jvm, swift, dotnet,
   dart, deno, elixir, android, cloudflare-workers, container. Each is anchored on the file
   whose presence selected it, so a reader loads the profile exactly when the thing that
   made it apply is in play. `connectiq` has no scope: it is selected by a tag no file
   announces, and inventing an anchor for it would be a claim about a file this tool has
   never seen.

## Consequences

A repository on Cursor, Copilot or Antigravity now receives its stack profiles as
`.cursor/rules/python.mdc`, `.agents/rules/python.md` and
`.github/instructions/python.instructions.md`, each carrying the patterns and no
`alwaysApply: true`, with a pointer in the region replacing the profile text. A repository
whose surfaces include opencode or Claude Code sees no change at all, and says why in a
note when it asked for narrowing it could not have.

A monorepo gets the same treatment per package, because package regions call the same
`desiredRegion` (ADR-066).

## Rejected

- **Emitting `paths:` for Claude Code anyway.** Its parser defect is documented with issue
  numbers and the failure is silent: the reader loads nothing and believes the rule is
  installed.
- **Narrowing on whichever surfaces can, and leaving the rest to find the profile
  elsewhere.** It trades an eagerly loaded rule for a rule that is never loaded, which is
  the same defect with a worse diagnosis.
- **A catch-all default scope for a profile with none.** It would look like narrowing in a
  diff and behave exactly like not narrowing.
- **Reusing the mdc rule-file path for a profile file.** The name comes from `ruleName`,
  which reads `.mdc` targets; a profile has none, and the first version of this wrote
  `null.mdc` and then `python.md.mdc` before either was noticed.