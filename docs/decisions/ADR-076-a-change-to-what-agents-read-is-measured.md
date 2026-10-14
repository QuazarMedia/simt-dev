# ADR-076 — A change to what agents read is measured before it ships, or labelled unmeasured in its record

Status: **accepted** · 2026-10-15 · filed as D1 (R01)
**Affects:** `src/bench/mine.mjs`, `src/commands/bench.mjs`, `src/commands/index.mjs`, `src/commands/help.mjs`, `test/bench.test.mjs`

## Context

Every rule and profile projected by this package enters an agent's context window on every
turn, yet nothing in the repository could say whether a paragraph improved resolution,
increased token cost, or did neither. Controlled studies on repository context files show
that unmeasured instructions routinely raise inference cost by 20% or more without moving
task resolution when they repeat facts the repository already proves.

Without a repository-native task suite and a rule requiring evidence, changes to projected
context are judged by how plausible the prose sounds to a reviewer rather than by what an
agent does with it. And a task suite whose verification tests sit inside the agent's
worktree is trivial to game: an agent can read or weaken the test it is being graded by.

## Rulings

1. **A change to projected context is measured against the benchmark suite before it ships,
   or its decision record states `unmeasured` and why.** Context changes include core
   rules, stack profiles, process rules, kernel compilation, command cards and brief
   assembly. When a slice cannot be run through the benchmark (for example, before the
   runner is wired or when a rule governs an external release gate), the decision record
   must carry the explicit label `unmeasured` rather than implying an empirical win.

2. **Benchmark tasks are mined deterministically from non-merge git history.** `simt bench mine`
   walks non-merge commits with a parent, selects commits that modify both test paths and
   implementation paths, splits each commit into `test.patch` (test files) and `gold.patch`
   (implementation files), and assigns the deterministic identifier `t-<shortSha>-01`.

3. **Every mined task is validated twice in an isolated worktree before acceptance.** At
   the parent commit `BASE`:
   - `BASE` plus `test.patch` must fail (`RED`) on two consecutive runs with the same
     failing and passing test identifiers;
   - `BASE` plus `test.patch` plus `gold.patch` must pass (`GOLD`) on two consecutive runs
     with zero failing tests and the same passing test identifiers;
   - any commit whose test outcome differs between the two runs is discarded as flaky.

4. **Test identifiers are extracted from runner-native machine output, never from human
   console summaries.** The miner parses TAP (`node --test --test-reporter=tap`), Vitest
   JSON (`--reporter=json`), JUnit XML (Gradle, Maven and `pytest --junitxml`) and Go JSON
   event streams (`go test -json`) to record exact `f2p` (`FAIL_TO_PASS`) and `p2p`
   (`PASS_TO_PASS`) test identifiers.

5. **Hidden test patches live in a verifier vault outside every worktree.** Task metadata
   is written to the adopting repository's benchmark task directory so the suite
   membership is versioned and reviewable, while `test.patch` and `gold.patch` are written
   to the user's cache vault (`~/.cache/simt-dev/vault/<repo-id>/<id>/`, or the platform
   cache equivalent) so an agent running inside a task workspace cannot inspect the
   verifier test diff or the oracle fix.

## Consequences

`simt bench mine --yes` mines a deterministic, flake-filtered task suite from a
repository's own commits without network access or model calls. Re-running the miner over
the same commit history produces byte-identical task JSON files and vault patches.

## Rejected

- **Keeping `test.patch` inside the repository's committed task directory.** An agent
  evaluated in a checkout of the repository could read the hidden test expectations or the
  oracle patch directly from disk.
- **Accepting any commit that touches a test file without running `RED` and `GOLD` twice.**
  Refactors, formatting commits and flaky tests touch test files without failing on `BASE`,
  producing tasks where a no-op agent scores 100% or a valid fix fails at random.
- **Scraping human-formatted test summaries with regular expressions.** Console summaries
  vary by locale, terminal width and runner version, and do not name individual
  `FAIL_TO_PASS` test cases needed to grade partial regressions.
