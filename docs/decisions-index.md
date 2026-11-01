# Decisions

Architecture decision records for the SIMT development ecosystem. One canonical home per
decision; nothing here is duplicated into a repo's `AGENTS.md`.

A decision is superseded by writing a new ADR with a higher number and editing the old
record's status line — never by editing the ruling in place.

This table is generated from the records: `simt rules decisions --yes` writes it, and
`test/decisions-index.test.mjs` fails when it drifts. The history behind the numbers is
in [architecture/history.md](architecture/history.md).

| ADR | Decision | Status |
|---|---|---|
| [001](decisions/ADR-001-push-requires-approval.md) | Push requires explicit approval | accepted · 2026-10-05 · affects all repos |
| [002](decisions/ADR-002-refactor-blast-radius.md) | Blast radius bounds refactoring; a third copy is a defect | accepted · 2026-10-05 · affects all repos |
| [003](decisions/ADR-003-test-breadth.md) | Focused tests are the default; a full suite needs a named trigger | accepted · 2026-10-05 · affects all repos |
| [004](decisions/ADR-004-hook-owns-format.md) | The hook owns format and lint for staged files | accepted · 2026-10-05 · affects all repos |
| [005](decisions/ADR-005-file-length.md) | File length is two tiers: 400 review trigger, 1000 hard ceiling | accepted · 2026-10-05 · affects all repos |
| [006](decisions/ADR-006-coverage-bar.md) | Evidence discipline is central; the numeric bar is per-repo | accepted · 2026-10-05 · affects all repos |
| [007](decisions/ADR-007-section-skeleton.md) | One canonical section skeleton | accepted · 2026-10-05 · affects all repos |
| [008](decisions/ADR-008-verdict-vocabulary.md) | One review verdict vocabulary: three values | accepted · 2026-10-05 · affects all repos |
| [009](decisions/ADR-009-skill-layout.md) | Skills are `<name>/SKILL.md` with mandatory frontmatter | accepted · 2026-10-05 · affects all repos · ruling 4 superseded by ADR-112 |
| [010](decisions/ADR-010-runner-invocation.md) | Invoke tools through the repo's own runner, never a package runner | accepted · 2026-10-05 · affects all repos |
| [011](decisions/ADR-011-windows-support.md) | Windows is supported from v1 | superseded by ADR-012 · 2026-10-05 |
| [012](decisions/ADR-012-drop-windows-support.md) | Windows support is dropped; POSIX only | accepted · 2026-10-05 · supersedes ADR-011 |
| [013](decisions/ADR-013-genericity-by-facts-and-local-profiles.md) | Genericity comes from emitted facts and repo-local profiles, not from a bigger hardcoded tag table | accepted · 2026-10-05 |
| [014](decisions/ADR-014-workspace-is-configuration.md) | The workspace is configuration, and a single repo is a first-class case | accepted · 2026-10-05 · ruling 1 superseded by ADR-119 |
| [015](decisions/ADR-015-a-source-is-content-not-a-location.md) | A source is identified by its content; the repository is a location, not a precondition | accepted · 2026-10-05 |
| [016](decisions/ADR-016-a-divergent-rule-is-retired-not-merged.md) | A divergent rule is retired, not merged | accepted · 2026-10-06 · one ruling narrowed by ADR-045 |
| [017](decisions/ADR-017-a-declared-gate-must-be-runnable.md) | A declared gate must be one the repo can actually run | accepted · 2026-10-06 |
| [018](decisions/ADR-018-an-unset-hooks-path-is-not-an-absent-hook.md) | An unset hooks path is not an absent hook | accepted · 2026-10-06 |
| [019](decisions/ADR-019-a-declared-command-is-the-runner.md) | A declared command is the runner; the remedy must be one the reader can take | accepted · 2026-10-07 |
| [020](decisions/ADR-020-a-rule-is-written-per-surface-and-pointed-not-copied.md) | A rule is written per surface, and pointed at — never copied | accepted · 2026-10-07 |
| [021](decisions/ADR-021-one-surface-per-repo.md) | One surface per repo, chosen or defaulted | accepted · 2026-10-07 · ruling 3 superseded by ADR-046 |
| [022](decisions/ADR-022-a-key-simt-dev-reads-is-prefixed.md) | A key simt-dev reads is prefixed `simt-` | accepted · 2026-10-08 |
| [023](decisions/ADR-023-the-gate-ships-as-a-file-the-repo-owns.md) | The gate ships as a file the repo owns | accepted · 2026-10-06 · ruling 2 superseded by ADR-024, which carves out this repository's own copy; rulings 3 and 4 narrowed by the same record to every repository except this one. The text below is left as it was accepted. |
| [024](decisions/ADR-024-simt-dev-overwrites-its-own-gate-file.md) | simt-dev overwrites its own gate file, and no repository else's | accepted · 2026-10-06 |
| [025](decisions/ADR-025-a-baseline-is-a-region-in-a-file-the-repo-owns.md) | a baseline is a region in a file the repo owns, and only a file that can hold one | accepted · 2026-10-06 · rulings 1 and 2 narrowed by ADR-026 · ruling 8 withdrawn by ADR-048 |
| [026](decisions/ADR-026-a-config-without-a-region-is-a-file-the-repo-owns.md) | a config whose grammar cannot hold a region is a file the repo owns | accepted · 2026-10-06 |
| [027](decisions/ADR-027-the-one-gitattributes-line-that-is-neither-dangerous-nor-empty.md) | the one gitattributes line that is neither dangerous nor empty | accepted · 2026-10-06 |
| [028](decisions/ADR-028-a-base-file-is-a-floor-so-the-disagreement-it-cannot-repair-becomes-a-check.md) | a base file is a floor, so the disagreement it cannot repair becomes a check | accepted · 2026-10-07 |
| [029](decisions/ADR-029-the-pins-a-repository-declares-are-its-own.md) | the pins a repository declares are its own, so a check reports them and never writes them | accepted · 2026-10-07 |
| [030](decisions/ADR-030-what-a-plan-does-not-ship-is-a-decision-with-a-record.md) | what a plan does not ship is a decision with a record, not a silence | accepted · 2026-10-07 |
| [031](decisions/ADR-031-the-suite-stages-the-environment-it-needs.md) | the suite stages the environment it needs, because a test that inherits the author's directory is not evidence | accepted · 2026-10-08 |
| [032](decisions/ADR-032-provenance-is-a-content-digest-not-a-commit.md) | provenance is a digest of the content that leaves this package, not a commit id | accepted · 2026-10-08 · ruling 1 narrowed by ADR-054 |
| [034](decisions/ADR-034-a-staged-tool-refuses-a-partially-staged-file.md) | A staged tool refuses a partially staged file rather than staging around it | accepted · 2026-10-08 · affects every repo with a pre-commit hook |
| [035](decisions/ADR-035-one-write-decision-and-one-json-document.md) | One place decides whether a run may write, and one document says whether it did | accepted · 2026-10-08 · affects every command that writes or reports |
| [036](decisions/ADR-036-a-writer-that-writes-says-so-and-the-instructions-naming-it-move-with-it.md) | A command that writes says so, and every instruction that names it moves with it | accepted · 2026-10-08 · affects sync, every remedy naming it, and the generated-region note shipped into every consumer repository |
| [037](decisions/ADR-037-unchanged-means-writing-would-not-change-a-byte.md) | `unchanged` means writing would not change a byte, not that the body matches | accepted · 2026-10-08 · affects every generated region, in every file style |
| [038](decisions/ADR-038-the-gate-filter-belongs-to-every-manifest-writer.md) | The gate filter belongs to every writer of a manifest, not to `init` | accepted · 2026-10-08 · amends ADR-017 ruling 1 · affects every code path that calls buildManifest |
| [039](decisions/ADR-039-a-ci-step-runs-a-form-that-can-fail.md) | A gate a CI step runs must have a form that can fail, and a refusal is a failure | accepted · 2026-10-08 · affects ci, its own workflow copy, and any command a workflow runs |
| [040](decisions/ADR-040-the-last-writer-that-wrote-by-default-was-not-the-one-named.md) | The last writer that wrote by default was not the one named | accepted · 2026-10-08 · affects simt hooks install, every remedy naming it, and the shim it installs |
| [041](decisions/ADR-041-the-suite-installs-the-package-in-order-to-test-it.md) | The suite installs the package in order to test it | accepted · 2026-10-08 |
| [042](decisions/ADR-042-a-declared-glob-must-match-a-path-built-from-it.md) | A declared glob must match a path built from it | accepted · 2026-10-08 · ruling 1 superseded by ADR-053 |
| [043](decisions/ADR-043-a-keyword-is-a-phrase-and-two-letters-is-a-word.md) | A keyword is a phrase, and two letters is a word | accepted · 2026-10-08 |
| [044](decisions/ADR-044-compatibility-is-not-evidence.md) | Compatibility is not evidence, and a resolver nobody measured is merely felt | accepted · 2026-10-08 · affects what skills brief and skills find return |
| [045](decisions/ADR-045-a-dashboard-that-counts-a-defect.md) | A dashboard that counts a defect and will not name it is worse than one that does not count it | accepted · 2026-10-08 · amends ADR-016 · affects what compare reports and exits on |
| [046](decisions/ADR-046-one-rule-one-copy.md) | One rule, one copy: a reader that reads AGENTS.md must not also get the file | accepted · 2026-10-08 · supersedes ADR-021 ruling 3 · settles P7's context-budget question |
| [047](decisions/ADR-047-a-profile-selects-on-what-a-repository-runs-on.md) | A profile selects on what a repository runs on, not on what it is written in | accepted · 2026-10-09 · refines ADR-013 ruling 1 |
| [048](decisions/ADR-048-a-baseline-carries-only-keys-a-reader-honours.md) | a baseline carries only keys a reader honours | accepted · 2026-10-09 · amends ADR-025 (withdraws ruling 8, corrects its context) |
| [049](decisions/ADR-049-a-ruling-that-a-later-record-moved-says-so-where-it-is-printed.md) | a ruling that a later record moved says so where it is printed | accepted · 2026-10-09 |
| [050](decisions/ADR-050-a-byte-count-is-not-a-region-and-updated-is-not-a-change-of-rules.md) | a byte count is not a region, and `updated` is not a change of rules | accepted · 2026-10-09 |
| [051](decisions/ADR-051-a-pointer-is-the-readers-only-route-so-it-is-not-a-convenience.md) | a pointer is the reader's only route, so it is not a convenience | accepted · 2026-10-09 |
| [052](decisions/ADR-052-a-dependency-is-counted-against-the-budget-and-there-is-one-budget.md) | a dependency is counted against the budget, and there is one budget | accepted · 2026-10-09 |
| [053](decisions/ADR-053-the-node-floor-is-22-20-0.md) | The Node floor is 22.20.0 | accepted · 2026-10-10 |
| [054](decisions/ADR-054-the-digest-covers-every-byte-that-leaves-the-package.md) | The digest covers every byte that leaves the package, and a cause is read off the body | accepted · 2026-10-10 · amends ADR-032 |
| [055](decisions/ADR-055-a-status-line-travels-so-it-may-not-name-a-location.md) | A status line travels, so it may not name a location; prose is the record's own argument | accepted · 2026-10-10 · filed as S54 · affects a file in this tool |
| [056](decisions/ADR-056-three-names-one-of-which-is-cheap-to-move.md) | The command, the package and the project are three names, and only one of them is cheap to move | accepted · 2026-10-10 · filed as S18 · amends ADR-023 · affects a file in this tool, package.json, a file in this tool, a file in this tool |
| [057](decisions/ADR-057-an-identity-is-per-developer-and-a-repository-does-not-own-it.md) | An identity is per-developer, and a repository does not own it | accepted · 2026-10-11 |
| [058](decisions/ADR-058-one-tool-three-channels-and-the-order-is-forced.md) | One tool, three channels, and the order is forced | accepted · 2026-10-11 |
| [059](decisions/ADR-059-the-version-a-repository-runs-is-the-one-it-pinned.md) | The version a repository runs is the one it pinned, and the gate refuses otherwise | accepted · 2026-10-12 · affects all repos · ruling 3's no-npm install and remedy superseded by ADR-098 |
| [060](decisions/ADR-060-a-repository-with-nothing-to-run-is-adopted-and-says-so.md) | A repository with nothing to run is adopted and says so, and a gate is verified where it runs | accepted · 2026-10-12 · filed as S36 |
| [061](decisions/ADR-061-the-skill-registry-is-workspace-data.md) | The skill registry is workspace data, and the package ships none of it | accepted · 2026-10-12 · filed as S61 |
| [062](decisions/ADR-062-a-fresh-adoption-seeds-the-gates-it-can-run.md) | A fresh adoption seeds the canonical gates it can run, and never more | accepted · 2026-10-13 · filed as S40 |
| [063](decisions/ADR-063-the-adoption-escape-hatch-is-opt-in.md) | The adoption escape hatch is opt-in, and the default writes in place | accepted · 2026-10-13 · filed after a consumer asked why every adoption branched |
| [064](decisions/ADR-064-the-context-meter-counts-what-the-tool-wrote.md) | The context meter counts what the tool wrote, and says what it did not | accepted · 2026-10-13 · filed after review 0002 S38 |
| [065](decisions/ADR-065-a-pack-is-one-shared-rule-set-pinned-by-digest.md) | A pack is one shared rule set, vendored into the repository and pinned by digest | accepted · 2026-10-13 · filed as S39 |
| [066](decisions/ADR-066-a-monorepo-projects-once-per-package.md) | A monorepo projects once per package | accepted · 2026-10-13 · filed as S41 |
| [067](decisions/ADR-067-which-harnesses-read-agents-md-is-a-column.md) | Which harnesses read AGENTS.md is a column, and a row without a document gets none | accepted · 2026-10-13 · filed as S42 |
| [068](decisions/ADR-068-the-mcp-revision-list-cites-what-was-read.md) | The revision list is a claim about revisions that were read | accepted · 2026-10-13 · filed as S43 |
| [069](decisions/ADR-069-the-conformance-lint-checks-the-published-specification.md) | The conformance lint checks the published specification | accepted · 2026-10-13 · filed as S44 |
| [070](decisions/ADR-070-the-json-payload-carries-its-own-version.md) | The JSON payload carries its own version | accepted · 2026-10-13 · filed as S51 |
| [071](decisions/ADR-071-a-rule-that-can-be-narrowed-is-written-narrow.md) | A rule that can be narrowed is written narrow | accepted · 2026-10-14 · filed as S50 |
| [072](decisions/ADR-072-the-budget-is-a-declaration-beside-the-gates.md) | The budget is a declaration beside the gates, not a number inside the projection | accepted · 2026-10-14 · filed as S38 |
| [073](decisions/ADR-073-a-kernel-is-a-smaller-projection-the-repository-asks-for.md) | A kernel is a smaller projection the repository asks for, not one it is given | accepted · 2026-10-14 · filed as S38 (R07) · ruling 6 narrowed by ADR-084 |
| [074](decisions/ADR-074-a-rule-and-a-decision-are-readable-by-uri.md) | A rule and a decision are addressable, so they are readable by URI | accepted · 2026-10-14 · filed as S43 |
| [075](decisions/ADR-075-nothing-leaves-the-machine.md) | Nothing leaves the machine: no telemetry, local transcripts, loopback models by default | accepted · 2026-10-14 · filed as D7 (R06) |
| [076](decisions/ADR-076-a-change-to-what-agents-read-is-measured.md) | A change to what agents read is measured before it ships, or labelled unmeasured in its record | accepted · 2026-10-15 · filed as D1 (R01) |
| [077](decisions/ADR-077-the-command-card-leads-the-region-and-reads-committed-evidence.md) | The command card leads the region, and is derived from committed evidence only | accepted · 2026-10-16 · filed as R10 (plan 0003) · ruling 1 narrowed by ADR-086 |
| [078](decisions/ADR-078-a-line-the-repository-already-proves-does-not-ship.md) | A line the repository already proves does not ship, and the author says so | accepted · 2026-10-16 · filed as R09 (plan 0003) |
| [079](decisions/ADR-079-the-rules-are-enforced-at-the-tool-call-from-one-policy-table.md) | The rules are enforced at the tool call, from one policy table every harness renders | accepted · 2026-10-16 · filed as R15 (plan 0003) |
| [080](decisions/ADR-080-the-tools-own-names-are-not-repositories-and-neither-reader-decides-by-shape.md) | The tool's own names are not repositories, and neither reader decides by shape | accepted · 2026-10-16 · settles what rules why calls a repository |
| [081](decisions/ADR-081-a-tracker-is-read-through-the-repositorys-template.md) | A tracker is read through the repository's template | accepted · 2026-10-16 · rulings 1 and 2 superseded by ADR-082 |
| [082](decisions/ADR-082-the-tracker-override-is-a-manifest-key.md) | The tracker override is a manifest key, and init keeps what it did not write | accepted · 2026-10-16 · supersedes ADR-081 rulings 1 and 2 · ruling 1 superseded by ADR-128 |
| [083](decisions/ADR-083-a-budget-is-met-by-cutting-the-kernel-and-hard-is-the-floor.md) | A budget is met by cutting the kernel, and the hard constraints are the floor | accepted · 2026-10-17 · filed as R08 (plan 0003) · ruling 7 narrowed by ADR-084 |
| [084](decisions/ADR-084-a-workspace-carries-its-repeated-rules-once.md) | A workspace carries its repeated rules once, and the region does not read the reader's home | accepted · 2026-10-17 · filed as R11 (plan 0003) |
| [085](decisions/ADR-085-the-region-ends-with-the-names-it-kept-out.md) | The region ends with the names of what it kept out | accepted · 2026-10-18 · filed as R12 (plan 0003) |
| [086](decisions/ADR-086-the-stable-prefix-comes-first-and-the-lock-records-both-digests.md) | The stable prefix comes first, and the lock records both digests | accepted · 2026-10-18 · filed as R13 (plan 0003) · ruling 3's file name is superseded by ADR-110 |
| [087](decisions/ADR-087-a-run-is-evidence-for-one-tree.md) | A run is evidence for one tree | accepted · 2026-10-18 · filed as R17 (plan 0003) |
| [088](decisions/ADR-088-a-marked-line-is-enforced-by-a-checker.md) | A marked line is enforced by a checker | accepted · 2026-10-18 · filed as R19 (plan 0003) · ruling 3 narrowed by ADR-090 |
| [089](decisions/ADR-089-the-local-index-is-a-cache-of-git-blobs.md) | The local index is a cache of git blobs | accepted · 2026-10-18 · filed as R20 (plan 0003) |
| [090](decisions/ADR-090-an-optional-adapter-is-off-until-named.md) | An optional adapter is off until a repository names it | accepted · 2026-10-18 · filed as R21 (plan 0003) |
| [091](decisions/ADR-091-the-map-ranks-files-a-task-mentions.md) | The map ranks the files a task mentions, and the files next to them | accepted · 2026-10-18 · filed as R22 (plan 0003) |
| [092](decisions/ADR-092-tests-are-imports-conventions-and-coverage.md) | A test is an import, a conventional neighbour, or a coverage record | accepted · 2026-10-18 · filed as R24 (plan 0003) |
| [093](decisions/ADR-093-why-names-what-governs-a-file.md) | why names what governs a file | accepted · 2026-10-18 · filed as R25 (plan 0003) |
| [094](decisions/ADR-094-a-change-runs-the-tests-that-import-it.md) | a change runs the tests that import it | accepted · 2026-10-18 · filed as R16 (plan 0003) |
| [095](decisions/ADR-095-gate-output-keeps-the-failures.md) | gate output keeps the failures | accepted · 2026-10-18 · filed as R18 (plan 0003) |
| [096](decisions/ADR-096-impact-names-who-a-change-reaches.md) | impact names who a change reaches | accepted · 2026-10-18 · filed as R23 (plan 0003) |
| [097](decisions/ADR-097-the-channels-publish-by-hand-and-the-version-rides-in-as-an-input.md) | the channels publish by hand, and the version rides in as an input | accepted · 2026-10-25 · ruling 3's Homebrew precondition is superseded by ADR-098, which also restates what each channel now waits on |
| [098](decisions/ADR-098-the-fourth-channel-is-one-file-and-it-needs-no-toolchain.md) | The fourth channel is one file, and it needs no toolchain | accepted · 2026-10-26 · supersedes ADR-058 ruling 5 · narrows ADR-058 ruling 7 and ADR-097 ruling 3 · supersedes ADR-059 ruling 3 · ruling 3's cross-host byte-identicality narrowed by ADR-099 |
| [099](decisions/ADR-099-the-release-verifies-served-bytes-and-the-formula-mirrors-them.md) | the release verifies served bytes, and the formula mirrors them | accepted · 2026-10-27 · narrows ADR-098 ruling 3 · ruling 1 superseded by ADR-117 |
| [100](decisions/ADR-100-a-staged-diff-is-the-last-gate-before-history-and-it-runs-inside-the-tool.md) | a staged diff is the last gate before history, and it runs inside the tool | accepted · 2026-10-27 |
| [101](decisions/ADR-101-a-file-lease-belongs-to-one-session-and-the-pre-edit-hook-refuses-another.md) | a file lease belongs to one session, and the pre-edit hook refuses another's edit | accepted · 2026-10-28 |
| [103](decisions/ADR-103-co-projected-duplicates-merge-down.md) | duplicates stand alone, fingerprints generalize, references spell out | accepted · 2026-10-28 |
| [104](decisions/ADR-104-the-pre-tool-use-policy-reads-the-command-the-way-a-shell-reads-it.md) | the pre-tool-use policy reads the command the way a shell reads it | accepted · 2026-10-28 |
| [105](decisions/ADR-105-the-json-ceiling-shrinks-arrays-and-never-cuts-bytes.md) | the JSON ceiling shrinks arrays and never cuts bytes | accepted · 2026-10-29 · filed as review 0003 Q10 |
| [106](decisions/ADR-106-the-harness-hook-runs-through-a-repo-shim.md) | the harness hook runs through a repo shim, and `failClosed` only with it | accepted · 2026-10-29 |
| [107](decisions/ADR-107-an-install-can-name-one-harness-and-the-skipped-ones-are-named.md) | an install can be narrowed to one harness, and the skipped ones are named | accepted · 2026-10-30 |
| [108](decisions/ADR-108-an-adoption-builds-the-index-and-a-command-refreshes-it-on-read.md) | an adoption builds the index, and a command that reads it refreshes it on read | accepted · 2026-10-30 |
| [109](decisions/ADR-109-simt-dev-is-its-own-consumer-and-the-guards-that-kept-it-from-being-one-are-retired.md) | simt-dev is its own consumer, and the guards that kept it from being one are retired | accepted · 2026-10-30 |
| [110](decisions/ADR-110-the-lock-file-follows-the-manifest-name-and-the-old-name-is-read-until-the-next-write.md) | the lock is `simt.lock.json`, and the old name is read until the next write | accepted · 2026-10-30 · supersedes ADR-086 ruling 3's file name |
| [111](decisions/ADR-111-the-tool-ships-one-agent-rendered-per-harness-and-installs-it-with-init-and-a-command.md) | the tool ships one agent, rendered per harness, and installs it with init and a command | accepted · 2026-10-30 |
| [112](decisions/ADR-112-the-registry-is-what-simt-dev-ships-and-a-repo-owns-its-own-skills.md) | the registry is what simt-dev ships, and a repo owns its own skills | accepted · 2026-10-31 · filed as S4 (plan 0005) · supersedes ADR-009 ruling 4 |
| [113](decisions/ADR-113-a-pre-push-that-carries-only-documentation-skips-the-test-gate-and-says-so.md) | a pre-push that carries only documentation skips the test gate, and says so | accepted · 2026-10-31 |
| [114](decisions/ADR-114-the-bench-pairs-at-the-task-level-a-missing-cost-is-not-zero-and-an-unasked-cross-group-compare-is-refused.md) | the bench pairs at the task level, a missing cost is not zero, and an unasked cross-group compare is refused | accepted · 2026-10-31 |
| [115](decisions/ADR-115-the-index-stamps-its-schema-version-migrates-older-databases-in-place-and-serves-newer-ones-from-a-sidecar.md) | the index stamps its schema version, migrates older databases in place, serves newer ones from a sidecar, and names a corrupt index | accepted · 2026-10-31 · filed as review 0003 Q44 |
| [116](decisions/ADR-116-rust-support-reaches-the-example-path-the-indent-and-the-bench-runner.md) | Rust support reaches the example path, the indent and the bench runner | accepted · 2026-10-31 |
| [117](decisions/ADR-117-the-darwin-release-builds-on-supported-macos-15-runners-and-a-re-run-is-idempotent.md) | the darwin release builds on supported macOS 15 runners, and a re-run is idempotent | accepted · 2026-10-31 · supersedes ADR-099 ruling 1 |
| [118](decisions/ADR-118-the-bench-corpus-is-keyed-on-history-is-append-only-and-is-portable-as-a-sealed-document.md) | the bench corpus is keyed on history, is append-only, and is portable as a sealed document | accepted · 2026-10-31 · filed as review 0003 Q48 |
| [119](decisions/ADR-119-the-environment-variable-points-into-a-workspace-the-repo-declared.md) | the environment variable points into a workspace the repo declared | accepted · 2026-10-31 · supersedes ADR-014 ruling 1 |
| [120](decisions/ADR-120-a-pre-push-whose-tree-is-already-proven-green-skips-the-test-gate-on-that-evidence.md) | a pre-push whose tree is already proven green skips the test gate on that evidence | accepted · 2026-10-31 |
| [122](decisions/ADR-122-the-shims-move-into-the-state-directory-and-the-legacy-directory-removes-itself.md) | the shims move into the state directory, and the legacy directory removes itself | accepted · 2026-10-31 |
| [123](decisions/ADR-123-a-surplus-positional-is-not-refused-because-arity-is-not-in-the-source.md) | a surplus positional is not refused, because a command's arity is not in its source | accepted · 2026-10-31 |
| [124](decisions/ADR-124-the-manifest-has-a-schema-in-the-tool-and-its-unknown-keys-stay-the-repositorys.md) | the manifest has a schema in the tool, and its unknown keys stay the repository's | accepted · 2026-10-31 |
| [125](decisions/ADR-125-a-shared-context-belongs-to-a-read-and-a-writer-reads-directly.md) | a shared context belongs to a read, and a writer reads directly | accepted · 2026-10-31 |
| [126](decisions/ADR-126-the-mcp-surface-stays-a-reader-so-there-is-no-write-path-to-build.md) | the MCP surface stays a reader, so there is no write path to build | accepted · 2026-11-01 |
| [127](decisions/ADR-127-the-mcp-tool-list-is-written-by-hand-and-roots-is-not-asked-for.md) | the MCP tool list is written by hand and held to the spec, and roots is not asked for | accepted · 2026-11-01 |
| [128](decisions/ADR-128-a-research-plan-is-a-plan-and-the-tracker-reads-it.md) | A research plan is a plan, and the tracker reads it | accepted · 2026-11-01 · supersedes ADR-082 ruling 1 |
