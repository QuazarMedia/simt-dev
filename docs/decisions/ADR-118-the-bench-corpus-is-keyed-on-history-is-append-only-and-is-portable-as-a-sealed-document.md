---
simt-affects: ["src/bench/mine.mjs", "src/bench/corpus.mjs", "src/bench/grade.mjs", "src/argv.mjs", "src/commands/bench.mjs", "src/commands/index.mjs", "src/commands/help.mjs", "test/bench.test.mjs"]
simt-supersedes: []
---

# ADR-118 — the bench corpus is keyed on history, is append-only, and is portable as a sealed document

Status: **accepted** · 2026-10-31 · filed as review 0003 Q48

## Context

Review 0003 (Q48) verified four failures in the mined bench corpus:

- The vault was keyed on the absolute checkout path, so the 20 committed tasks
  failed from every clone (`ENOENT …/vault/repo-ca1b5891/…/gold.patch`): a corpus
  was unrunnable from any machine that was not the one that mined it.
- Re-mining silently replaced the corpus: `mineTasks(target 3)` deleted all 20
  committed tasks and wrote 3 others, with no signal that anything was lost.
- The Gradle grader read one report file and the Maven grader read none, while
  both runners write one JUnit XML *per test class* under a directory: both
  graders graded on an empty parse.
- Code-read: 7-character ids with a fixed `-01` suffix can collide, and the
  exclusion list and the per-test timeout were hardcoded, so a repository could
  not declare its own.

## Ruling

1. **The vault is keyed on the repository's history, not its checkout path.**
   The key is the checkout basename plus the root commit
   (`git rev-list --max-parents=0 HEAD`), read synchronously like
   `package-version.mjs`: a vault path that throws is worse than one that is
   occasionally less specific. The root commit is identical in every clone and
   survives remote renames; a root with no git history degrades to the path
   digest, because a vault path must never fail because git is absent.
2. **Re-mining is append-only, and taking over the corpus is explicit.** Tasks
   the current mine does not reproduce survive a re-mine; only `--replace`
   deletes them. An id that already holds a task from a different
   `sourceCommit` is a hard error naming `--replace`, not a silent overwrite —
   guessing which corpus the reader wants is worse than refusing.
3. **New task ids are 12 hex characters plus `-01`.** The 20 committed tasks
   keep their 7-character ids: the corpus is not regenerated to widen them, and
   the collision check — not a wider prefix — is what makes a collision an
   error.
4. **JUnit XML is read from the directory the runners write.**
   `readReports(paths)` walks report directories recursively in sort order
   (Gradle `build/test-results/test/`, Maven `target/surefire-reports/`), reads
   single files, and skips missing paths. The miner and the grader clean
   `reportPaths` before every run — a report left by a prior run would be
   graded as this run's result — and read through `readReports`.
5. **Exclusion and timeout are repository-declared.** `simt.json`
   `bench.mine.{exclude,timeoutMs}`; an explicit option wins, then the manifest,
   then the default (`['test/pack.test.mjs']`, 5000 ms).
6. **The corpus is portable as a sealed document.** `bench export <corpus.json>`
   and `bench import <corpus.json>` (in `src/bench/corpus.mjs`) carry the task
   descriptors and both hidden patches for every task in a single file: tasks
   sorted by id, canonical key-sorted JSON, base64 patches, no timestamp, and a
   sha256 seal over everything but the seal. The seal is verified before a
   single byte is trusted, and two exports of the same corpus are
   byte-identical.
7. **The mine records where the corpus came from.** `.simt/bench/corpus.json`
   carries `{minedFrom, target, simtVersion}` — no timestamp, so a re-mine at
   the same HEAD is byte-identical.

## Consequences

- A `bench export` on the machine that mined a corpus and a `bench import` on
  any other machine reproduce it exactly, hidden test patches included: the
  committed corpus is runnable from a clone.
- 7-character and 12-character ids coexist in one corpus; the schema test
  asserts the committed corpus keeps its 7-character ids and the miner asserts
  12 for every new mine.
- `bench import` and `bench export` preview like every other write: without
  `--yes` nothing is written, and a dry-run import writes nothing.
- The sealed document lives in its own module (`src/bench/corpus.mjs`);
  `mine.mjs` is trimmed to the 1000-line ceiling so the slice adds no new
  file-lines finding.

## Rejected

- **Keying the vault on the remote URL.** It breaks on a remote rename, and it
  is a second mutable identity where the root commit is immutable and
  clone-invariant.
- **Regenerating the committed corpus to 12-character ids.** It churns 20 task
  files and their vault layout for a width only new mines need; the collision
  check, not a wider prefix, is what protects the corpus.
- **A timestamp in the exported document.** It breaks byte-identity: two
  exports of the same corpus differ, and a reader cannot tell content drift
  from time drift.
- **Silent overwrite on re-mine.** The failure this ADR exists to fix: a corpus
  is data, and a routine command deleting twenty tasks is a data loss wearing a
  success exit code.
