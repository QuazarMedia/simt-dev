# Review 0005 — simt-dev production readiness

Status: **closed** — 38 row(s): 38 Complete · 2026-11-21

Verdict: **BLOCK**

Reviewed baseline: `863888b` on `main`, package `0.10.0`. The full revision is recorded in the evidence below.

An unpacked npm artifact wrote a tracked-project skill during an `init` preview. A malformed pre-commit declaration produced a successful report with zero gates. The pre-push implementation tests the checked-out revision and can record that result against a different tree. A Python focused test cannot build its invocation, and a conventional knowledge document can pass validation while its reader rejects it. These are release blockers independent of aggregate test results.

## 1. Release scope

The production contract is a deterministic, offline-by-default tool for Git repositories on the supported host matrix. A repository with an unfamiliar language, build tool, layout, or CI provider must be able to adopt, declare its commands and policy, and get truthful results without an engine patch. Built-in extraction, report parsing, package discovery, and agent integrations have an explicit support matrix and generic fallbacks. Declare the limits of each fallback. Operating-system support remains a separate distribution decision under ADR-012.

Keep the default path small. It consists of adoption, projection and drift, configured gates and evidence, task context, and the tracked slice workflow. Keep optional capabilities where they have a named user, stable input/output contract, and verifiable behavior. Keep a supported compatibility adapter as long as it is needed to read or migrate a published format. Isolate experimental and research-only code, and retire it from the production package when the caller and migration audit supports removal. Preserve distinct semantics where similar commands answer different questions.

Each slice below owns its findings, proposed change, and acceptance checks. **Observed** means this review exercised the stated result. **Source** means the behavior follows from the cited code and needs a regression during implementation. **Qualification** means the matrix or ownership decision remains open and is a deliverable of the slice. P0 blocks adoption or trust in enforcement and recovery. P1 blocks a production release of the affected surface. P2 is cleanup, qualification, or contract work required before sign-off. Use new decision records to change standing policy, preserving the history of superseded ADRs.

## 2. Tracker

| ID | Slice | Priority | Lane | Tier | Depends on | State | SHA / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PR01 | Make init previews and refusals side-effect free | P0 | adoption | S | — | Complete | 7ecc7c9f8566b5a032ca7ca30be76e1123cadfbf |
| PR02 | Reject invalid manifest and gate configuration at the boundary | P0 | config | M | — | Complete | f0bdbffca12f861113294eff88e48eea37234f4c |
| PR03 | Run pre-push gates on the revisions being pushed | P0 | hooks | M | PR02 | Complete | da06e94d6c0b1aeabfe56d05383f81659d4dab3f |
| PR04 | Bind gate evidence to the executed inputs and outcome | P0 | hooks | M | PR03 | Complete | 35c29afd1e5b7da78ff86326c6142356f38f0427 |
| PR05 | Resolve gate cwd and runnable status through one contract | P1 | hooks | M | PR04 | Complete | 918e1795997806ab2dd70503a5038dd5cce34bb1 |
| PR06 | Restore Python focused test execution | P1 | runners | S | — | Complete | 3bd310f4d704662535e0d9066d8534f163e50215 |
| PR07 | Make multi-file writes recoverable and race-aware | P0 | adoption | L | PR01, PR02 | Complete | 0fb73c354fa83d4dba1fcf0cb084174ab2511163 |
| PR08 | Restore every journaled effect and report accurate undo outcomes | P1 | adoption | M | PR07 | Complete | d8e02dd727d542283b350f4ae25508004e5e3695 |
| PR09 | Establish canonical repository context and config precedence | P1 | config | M | PR02 | Complete | 78dff168814df62a278ff69a71285c5f8b7b3c0a |
| PR10 | Validate and apply repository-local ecosystem records | P1 | ecosystem | M | PR09 | Complete | b3aaec60c74fc6bef363199703e7b69f946f395b |
| PR11 | Make focused runners configurable across nested and mixed stacks | P1 | runners | M | PR06, PR10 | Complete | c6a28c4c3f393e60aac3b8170ca27753b257f7b2 |
| PR12 | Resolve polyglot gates without command collisions | P1 | ecosystem | M | PR10, PR05 | Complete | 7521ce3c16752517d198d573efb0ac76b371c719 |
| PR13 | Report test-selection gaps, deletions, and actual test outcomes | P1 | runners | M | PR11 | Complete | c7a6be00cc761963c427ca4b9d22533c3552be65 |
| PR14 | Share bounded gate execution and report cleanup | P1 | runners | M | PR13, PR04 | Complete | 547b7c3f86488400a18ba568760a5ec50e25c546 |
| PR15 | Make projected rules and adoption reports actionable in consumers | P1 | projection | M | PR08, PR12 | Complete | 324f5757eca06954ad63aaa7c9158cf03d043568 |
| PR16 | Make frozen projection and upgrades agree on the applied state | P1 | projection | M | PR15 | Complete | d57ee4a7769376f9f217b2536614a74fd5fdffe1 |
| PR17 | Generate reproducible CI with an explicit provider contract | P1 | ci | M | PR12, PR16 | Complete | a944acc7fc7efa06afaf50857ecdb4a36fc4cbe3 — dc2d07d |
| PR18 | Repair tracker concurrency and slice completion recovery | P1 | tracker | M | PR07, PR04 | Complete | 75237c386f1292b04885a45df601f1302b50987a |
| PR19 | Validate knowledge with the same readers used by its commands | P1 | knowledge | M | PR02 | Complete | 7ebf20fdb69948ea6f87dab15f9e8e00e7854b00 |
| PR20 | Make document-driven verification reject malformed input | P1 | work | M | PR19 | Complete | 4afc0e34a194b79e5ea6a100b808d1e4cdc86638 |
| PR21 | Separate MCP reads from cache writes and process execution | P1 | transport | M | PR09, PR02 | Complete | 20722ee329feb60bd4cd6d4ec4d6622b30727a3e |
| PR22 | Bound MCP framing and make response contracts consistent | P1 | transport | M | PR21 | Complete | d092ff35c5db4d1419b873617663a98a853acc7a |
| PR23 | Make index provenance and rebuild semantics coherent | P1 | retrieval | M | PR10, PR09 | Complete | 7869ead14b7f01af9c43b6efe33456e13f5d33ef |
| PR24 | Fix registry portability, skill identity, and workspace caching | P1 | retrieval | M | PR23 | Complete | aa3ef1840ce79325f86d6676e7fac066023c5590 |
| PR25 | Enforce local model data and transport boundaries | P1 | retrieval | M | PR24, PR21 | Complete | c87eeb1f9f81ba3aaf24f40b5192c4db5ef00ef9 |
| PR26 | Audit filesystem scope and executable configuration ownership | P1 | trust | M | PR08, PR05, PR21, PR24 | Complete | 863c42544b7227e2d7a85428c1322b437cac360b |
| PR27 | Resolve each release once and verify cross-channel promotion | P1 | release | M | PR17 | Complete | 6abb3071377c6f9a28eb63a01601441b98a06d6f |
| PR28 | Qualify installed packages and state platform prerequisites | P1 | release | M | PR27, PR11 | Complete | 9a65d8a941d0ca9313e6d98e8666ab965c3a7d23 |
| PR29 | Publish one supported surface and deprecation map | P2 | surface | M | — | Complete | cfacc16781d49c825d3ef6d0dc9d8b0b94d9bc82 |
| PR30 | Retire or explicitly retain experimental packs | P2 | surface | M | PR29, PR16 | Complete | 52c579e2025423cf7d21445c3fbb9e844fa7252c |
| PR31 | Move bench and synthetic research outside the stable core | P2 | surface | L | PR30, PR20, PR14 | Complete | 04601e72170426f675de3adedba50fb2f8fdc45c · test: node --test test/bench.test.mjs test/bench2.test.mjs test/bench3.test.mjs test/distill.test.mjs test/work-door-parity.test.mjs test/work-release.test.mjs test/work-replay.test.mjs test/work-calibration.test.mjs test/pack-imports.test.mjs test/packaging.test.mjs test/testing.test.mjs test/pilot-remote.test.mjs test/shipped-decisions.test.mjs |
| PR32 | Verify reachability, remove dead bindings, and narrow exports safely | P2 | surface | M | PR31, PR22 | Complete | a6301712c72eedc41ddfec089ab4dde4f69f54d5 |
| PR33 | Consolidate duplicate test reporting and repository adapters | P2 | runners | M | PR14, PR31 | Complete | 9938e2465abd8cb83facd2acba62dc077ff2e2e4 |
| PR34 | Migrate and retire legacy compatibility paths on evidence | P2 | adoption | M | PR08, PR32, PR16 | Complete | 33b92c765653ef4e8cc187a77749c5729bbc414c |
| PR35 | Make CLI, API, MCP, and generated references agree | P1 | surface | M | PR32, PR22, PR19 | Complete | 3957b70889c7d1158107aec5eb630d051c8a4b04 |
| PR36 | Make the isolated test and release qualification gate reproducible | P1 | ci | M | PR17, PR28, PR32, PR33 | Complete | 9397ba14a1f253279c32646f6952767f3695a7f8 |
| PR37 | Qualify production readiness from installed consumer fixtures | P1 | release | M | PR18, PR25, PR26, PR28, PR34, PR35, PR36, PR38 | Complete | 664aa34108ba209c295edfc739448549031ece39 |
| PR38 | Bind an inline agent-hook override to its invocation | P0 | agenthooks | M | — | Complete | b65d36fc54897c0b576c85dc02bf6a90f857befb |

Worktree boundaries follow the files, including shared tests and generated outputs. Use the tracker dependencies for sequencing and check planned paths before parallel work. Serialize overlapping edits to the command spec, projection, dispatcher, or shared fixtures. Keep a focused regression and rendered consumer acceptance with the slice that changes behavior. Use the full document name `0005-production-readiness.md` when archiving because the separate knowledge plan also uses 0005.

## 3. Implementation slices

### PR01 — Make init previews and refusals side-effect free

**Observed.** The unpacked npm CLI returned 0 for `init --json` in a clean docs-only Git repo and created `.agents/skills/simt-commands/SKILL.md`. [Init planning](../../src/commands/init.mjs#L119) calls the writer before validation and write mode, and [the helper](../../src/agents/render.mjs#L265) writes to disk so disclosure can see it.

**Change.** Represent the skill as a planned target and let projection and disclosure consume a projected view. Include changes in preview, apply them behind write mode, and make agent opt-out semantics explicit.

**Acceptance.** Compare files, modes, links, Git config and refs before and after text/JSON preview, `--dry-run`, conflicts, malformed regions, and a refused harness config. The applied skill and disclosure must match preview and round-trip through undo. Run `node --test test/init.test.mjs test/init2.test.mjs test/init-harness.test.mjs test/disclosure.test.mjs test/undo.test.mjs`.

### PR02 — Reject invalid manifest and gate configuration at the boundary

**Observed.** A string `gates.preCommit` returned `ok:true` with zero hooks. A numeric value made `check` return an “is not iterable” error. **Source.** [The manifest reader](../../src/manifest/schema.mjs#L155) validates the outer gates object and treats all file-read errors as absence. The [dispatcher](../../src/hooks/dispatcher.mjs#L401) treats an invalid event list like an empty one. [The manifest reference](../reference/manifest.md) promises unknown keys are named, while the schema deliberately accepts them.

**Change.** Parse and validate consumed keys once, including nested gate options, work, local and federation config, ownership, and version. Distinguish absent, unreadable, malformed and unsupported. Reserve a clear extension namespace and document what happens to unknown keys. Preserve valid older documents and keep an explicit empty array legal.

**Acceptance.** Table-driven fixtures for missing, unreadable, malformed, unsupported-version, legacy, and empty values across `check`, `doctor`, `hooks run`, `status`, and MCP. Every invalid enabled gate produces a named config finding and nonzero exit. Run `node --test test/manifest-schema.test.mjs test/checks.test.mjs test/doctor.test.mjs test/hooks.test.mjs test/work-config.test.mjs`.

### PR03 — Run pre-push gates on the revisions being pushed

**Source.** [Push classification](../../src/hooks/dispatcher.mjs#L329) can see multiple local refs, but [worktree materialization](../../src/hooks/head-worktree.mjs#L31) always checks out HEAD and [dispatch](../../src/hooks/dispatcher.mjs#L442) passes in the caller checkout's manifest. A push including a different tip receives a report about HEAD and possibly different configuration.

**Change.** Resolve the push ref list and run once per distinct relevant local tree. Read declared gates and toolchain from the same approved basis as execution. Fail closed with targeted remediation when the revision cannot be prepared. Make a manual run's default basis explicit, and define how deletion-only and unsupported object formats are reported.

**Acceptance.** Use a local bare fixture and two branches with different files and gate config, including a non-HEAD ref, multiple refs, repeats, and dirty caller state. Report ref, revision and result per target and prove scratch worktrees are cleaned after failure. Run `node --test test/hooks-push.test.mjs test/hooks2.test.mjs test/hooks-context.test.mjs`.

### PR04 — Bind gate evidence to the executed inputs and outcome

**Observed.** `hasTestEvidence` returned true for a staged tree that differed from the recorded executed working tree. **Source.** [Execution records](../../src/hooks/dispatcher.mjs#L658) compute the tree from the ledger destination, even when the gate ran in a detached worktree. [The ledger](../../src/ledger/index.mjs#L127) records the worktree and index together, and [the skip query](../../src/ledger/index.mjs#L307) accepts either. A timed-out child that exits 0 also reaches the pass path.

**Change.** Record subject revision/tree, command identity and arguments, meaningful environment/toolchain identities, report coverage, and timeout/cancellation outcome separately from storage location. Qualify skips only on the exact executed basis and the matching gate. Continue to read old records for history and migrate optimization eligibility through a new ruling superseding the relevant ADR-120 behavior.

**Acceptance.** Cover split staged/worktree bytes, isolated push trees, command changes on identical source, later failure, legacy evidence, and timeouts with a clean process exit. No skip is earned without a qualifying run. Run `node --test test/ledger.test.mjs test/ledger-v2.test.mjs test/hooks-push.test.mjs test/hooks2.test.mjs test/slice.test.mjs`.

### PR05 — Resolve gate cwd and runnable status through one contract

**Source.** [Gate checking](../../src/commands/sync.mjs#L527) and [dispatch](../../src/hooks/dispatcher.mjs#L637) duplicate lexical containment and directory checks. They can disagree on malformed values, symlinks, and relative roots. Dispatch resolves runners and tools at the repo root before applying the configured package cwd.

**Change.** Reuse one validated gate resolver for cwd, capabilities, argv and findings. Check actual path ownership, resolve package-local runners and binaries in the intended scope, and derive hints from the normalized invocation. Keep the intentional staged-files rules for built-ins and document explicit exceptions.

**Acceptance.** Check/install/doctor/execute agree on valid and invalid cwd, canonical equivalents, linked worktrees, nested package scripts and binary paths. Validate path containment defensively with inert fixtures. Run `node --test test/hooks-context.test.mjs test/checks.test.mjs test/hooks-install.test.mjs test/node-runner.test.mjs test/monorepo.test.mjs`.

### PR06 — Restore Python focused test execution

**Observed.** Calling the Python runner's `buildExec` with a valid test path throws `CLI is not defined` in [the report-path helper](../../src/testing/runners.mjs#L29). Detection and parser checks alone do not exercise this handoff.

**Change.** Repair the missing binding, validate report-path ownership, and exercise the invocation through the public focused gate. Leave broader runner selection to PR11.

**Acceptance.** A Python fixture reaches its declared runner, propagates failures, produces a readable per-run result, and removes scratch reports. Include a no-tool diagnostic. Run `node --test test/testing.test.mjs test/gate.test.mjs`.

### PR07 — Make multi-file writes recoverable and race-aware

**Source.** [The shared writer](../../src/write/plan.mjs) uses before/after to select work but does not verify the planned before-image before applying. [The journal](../../src/journal.mjs#L128) records in memory after a write and persists at the end. `init`, `sync`, and `upgrade` can leave applied effects behind without a durable undo set if a later write fails.

**Change.** Apply a validated plan under a repo-scoped write coordinator. Persist enough intent before the first effect to resume or restore, check before-images and path/type changes, and record completed effects. Keep user edits intact on races. Bring the common writers onto that contract in dependency order.

**Acceptance.** Inject failures before and after each effect and interrupt after the first effect. Verify retry or recovery, no silent overwrite of a concurrent edit, deterministic reports, and independently recoverable workspaces. Run `node --test test/write-plan.test.mjs test/init2.test.mjs test/project.test.mjs test/upgrade.test.mjs test/undo.test.mjs`.

### PR08 — Restore every journaled effect and report accurate undo outcomes

**Source.** [Init](../../src/commands/init.mjs#L647) and [sync](../../src/commands/sync.mjs#L331) exclude pointer symlinks from undo. [Journal undo](../../src/journal.mjs#L627) writes a `write.undone` event even when restore refused. Recovery copy in [init](../../src/commands/init.mjs#L515) suggests broad Git commands that can discard unrelated edits and cannot recover all adoption effects.

**Change.** Model links and effective mode as reversible effects without dereferencing targets. Emit accurate refused/resumed/completed states. Make backup refs and other intentional effects explicit in the apply result, together with scoped, safe recovery commands.

**Acceptance.** Apply and undo across existing file mode, new and repaired links, existing user edits and refusal. Confirm event history reflects the state and generated recovery instructions operate on the intended adoption. Run `node --test test/undo.test.mjs test/init2.test.mjs test/events.test.mjs test/markers.test.mjs`.

### PR09 — Establish canonical repository context and config precedence

**Observed.** `status --json` from a nested directory used that directory as its root, while explicit `--root` reached the repo. **Source.** [Command roots](../../src/repo-root.mjs) and Git hook roots follow different paths. [Work facet detection](../../src/work/facets.mjs#L115) bypasses the common manifest loader, losing legacy and invalid-manifest semantics.

**Change.** Resolve an implicit Git root once per invocation, including from nested directories, and preserve explicit single-repo/workspace scope and non-Git inspection where supported. Use one canonical repository context to carry manifest, config provenance, worktree and workspace roots. Expose explicit precedence and handle paths containing whitespace.

**Acceptance.** Compare CLI, library, and MCP from root, child, linked worktree, symlink-equivalent path, and workspace. Cover explicit roots, legacy and invalid work declarations, and no-Git reads. Run `node --test test/root.test.mjs test/context.test.mjs test/commands-context.test.mjs test/workspace.test.mjs test/work-facets.test.mjs`.

### PR10 — Validate and apply repository-local ecosystem records

**Observed.** A valid JSON ecosystem with `manifestOrder` but no facts crashed `init`. A local `.acme` language resolved through the record loader, while the index returned no language. **Source.** [Record loading](../../src/ecosystem/records.mjs#L34) skips malformed JSON and merges unvalidated records, [fingerprinting](../../src/resolve/fingerprint.mjs#L132) uses an in-code set, and [index extraction](../../src/index/extract.mjs#L14) and [test conventions](../../src/testing/paths.mjs#L19) read shipped data only.

**Change.** Define a versioned, bounded schema for repo-local facts, marker predicates, languages, conventions, and overrides. Validate collisions and precedence and load once per repo. Thread the effective records into detection, profile selection, capabilities, package discovery, index and test mapping. Expose invalid input as an actionable finding and reuse generic text/path behavior when no language extractor exists.

**Acceptance.** Add a fixture ecosystem absent from shipped tables with a custom marker, files, test naming, profile and gate. Adopt it using only configuration. Confirm deterministic results and quarantine invalid, ambiguous or unsupported records without losing validated built-ins. Run `node --test test/ecosystem-records.test.mjs test/genericity.test.mjs test/monorepo.test.mjs test/extract.test.mjs test/rules.test.mjs`.

### PR11 — Make focused runners configurable across nested and mixed stacks

**Source.** [Focused-runner dispatch](../../src/testing/runners.mjs#L47) is a fixed detection chain. Any `package.json` reaches the Node branch first; its default uses `process.execPath`, which names the packaged simt executable under SEA. The [gate](../../src/commands/gate.mjs#L116) has no configured override when a runner is unsupported.

**Change.** Add a validated argv-based focused test runner contract with package and path selectors, report type, and explicit runtime requirements. Apply built-in defaults only when the package can actually run them. Keep the SEA and Python launchers using the declared consumer runtime for tests. Share the resolver with bench callers that remain.

**Acceptance.** Prove a nested mixed-language repo, custom wrapper, Node project using SEA, and a missing runner. Assert selected files reach the right runner and valid no-tool configurations show a useful unsupported result. Run `node --test test/testing.test.mjs test/gate.test.mjs test/monorepo.test.mjs test/node-runner.test.mjs test/binary.test.mjs`.

### PR12 — Resolve polyglot gates without command collisions

**Source.** [Default gates](../../src/gates/index.mjs#L236) merge by gate name and [seeded commands](../../src/gates/index.mjs#L282) suppress non-Node seeds when a Node runner is present. For two non-Node records with the same gate key, the later matching record replaces the earlier seed. The resulting gate list can look complete while running one part of a mixed repository.

**Change.** Resolve gates by scope and stable id, with visible precedence and explicit defaults versus repo declarations. Reuse the resolver for init, card, doctor, check, hooks, and CI. Keep legacy single-name entries runnable and preserve user overrides.

**Acceptance.** Run adopted fixtures for Node plus a foreign stack, two foreign stacks, and two packages using the same gate id. Each gate must name its command and scope and execute against the intended files. Run `node --test test/init.test.mjs test/ecosystem-records.test.mjs test/checks.test.mjs test/card.test.mjs test/hooks.test.mjs`.

### PR13 — Report test-selection gaps, deletions, and actual test outcomes

**Source.** [The gate](../../src/commands/gate.mjs#L56) rejects a path that is no longer tracked or on disk, has only one graph-quality flag, and uses child exit code without verifying requested tests ran. An empty selection is explicit in current JSON, but exits 0 for compatibility. A renamed/deleted file and a runner that silently ignores a selector need separate treatment.

**Change.** Carry old and new paths and their versioned graph evidence across changes. Include unresolved inputs per package and retain the distinction between import closure, test mapping and whole-project runs. Add a versioned strict verification mode for unproven selection and selected-but-unexecuted tests. Decide and document the compatibility behavior under ADR-164.

**Acceptance.** Test pure deletion, rename, partial and unknown dependency graphs, a successful runner with zero collected tests, docs-only no-op, and real passing/failing results. Confirm the report distinguishes all outcomes. Run `node --test test/gate.test.mjs test/impact.test.mjs test/mapping.test.mjs test/coverage.test.mjs test/verify-selection.test.mjs`.

### PR14 — Share bounded gate execution and report cleanup

**Source.** [Focused gate execution](../../src/commands/gate.mjs#L140) uses its own `execFile` buffer with no timeout and ignores built `reportPaths`. [Hook dispatch](../../src/hooks/dispatcher.mjs#L109) and [shared process utilities](../../src/sys/proc.mjs) implement bounds elsewhere. Focused gate logs retain complete captured output in local state and in JSON before the final envelope cap.

**Change.** Reuse a single bounded executor and report lifecycle across the focused gate, hook runner and retained bench caller. Preserve streaming/tail, limits, cleanup and failure semantics. Serialize or give unique ownership to log writes. Apply documented output redaction before durable storage or machine output.

**Acceptance.** Exercise long-running, noisy, cancelled, and multi-process runs, successful zero-exit timeouts, missing reports, and concurrent runs. Check bounded logs and cleanup after every outcome. Run `node --test test/gate.test.mjs test/sys-utils.test.mjs test/hooks2.test.mjs test/testing.test.mjs`.

### PR15 — Make projected rules and adoption reports actionable in consumers

**Observed.** Plain Git adopted and passed `check --frozen`. Its rendered core rules assume the reader can act on hooks and pre-push evidence, while that adoption had no runnable gates or generated CI, and the CLI told the reader to run its check in CI. **Source.** [The spec](../../src/commands/spec.mjs#L76) describes `init` as adopting hooks, while [the completion path](../../src/commands/init.mjs#L711) reports that Git hooks are a separate installation.

**Change.** Render repository commands, hook state, and CI availability as capability-dependent facts. Keep policy rules distinct from installation state. Make first-use and recovery instructions executable in a fresh consumer and expose explicit opt-ins for agent, baseline, and CI changes. Reconcile help with the actual effects of `init`.

**Acceptance.** Render and read installed outputs for docs-only, one-language, polyglot, and no-agent fixtures. Run the commands prescribed by each first-use report. Check refusal and opt-out, stable rerendering, and retention of user-authored bytes. Run `node --test test/surfaces.test.mjs test/shipped.test.mjs test/init.test.mjs test/init-harness.test.mjs test/help.test.mjs`.

### PR16 — Make frozen projection and upgrades agree on the applied state

**Observed.** In an installed npm fixture with current rendered rules and an older version pin, `upgrade --yes` returned 0 and left the pin unchanged. A subsequent `check` still reported `version-mismatch`. **Source.** [Lock computation](../../src/projection/lock.mjs#L25) hashes a fixed manifest subset and one desired region. [Projection planning](../../src/projection/project.mjs#L163) computes its lock before the writer applies planned manifest repairs. [Upgrade](../../src/commands/upgrade.mjs#L183) writes targets and the generated digest but preserves the old `projection.version` that [the pin check](../../src/package-version.mjs#L118) compares. Its apply loop also recomputes targets after preview.

**Change.** Derive a canonical snapshot of effective configuration and all managed targets from the one apply plan. Recompute affected lock/output records transactionally and keep artifact pin, release actually installed, rendered output and migration result coherent. Decide how custom surfaces and unchanged legacy variants participate. Give the operator a remedy that can complete the transition.

**Acceptance.** Install an older fixture, upgrade to a different tagged fixture version with changed rule bytes and surfaces, and run `check --frozen` plus a real declared hook with the newly pinned executable. Test lock changes for substitutions, ecosystem overrides, managed target changes, and scope-preserving replays. Run `node --test test/lock.test.mjs test/project.test.mjs test/surfaces.test.mjs test/upgrade.test.mjs test/version-pin.test.mjs`.

### PR17 — Generate reproducible CI with an explicit provider contract

**Source.** [The consumer workflow](../../src/ci/workflow.mjs#L334) falls back to an unlocked install on any failed frozen install. The [runner table](../../src/ecosystem/node-runner.mjs#L22) names pnpm, Yarn and Bun while the template only conditionally sets up Node. The shipped workflow runs projection checks, and its presence alone gives no evidence a consumer's actual test gates ran.

**Change.** Resolve installation strategy from the lockfile, pinned toolchain and distribution channel. Bootstrap the declared package manager or fail with a remedy. Treat a failed frozen install as a failure. Expose explicit external-CI and no-CI modes, with a consumable contract for any provider. Let GitHub workflow generation remain opt-in and preserve ownership of existing workflows.

**Acceptance.** In clean jobs exercise npm, pnpm, Yarn, Bun and standalone binary paths with missing tools, lockfile absent, lockfile stale and offline errors. Prove the approved gate scope and no overwrite of customer CI. Run `node --test test/ci.test.mjs test/ci-dependabot.test.mjs test/node-runner.test.mjs test/binary.test.mjs`.

### PR18 — Repair tracker concurrency and slice completion recovery

**Source.** [Plan done](../../src/plan/index.mjs#L851) rebuilds and writes a whole file from a prior snapshot. Concurrent updates to separate rows can overwrite one another. [Slice finish](../../src/commands/slice.mjs#L702) commits before it updates the tracker, and its recovery hint omits the write flag. Successful retry and cleanup require a clear persisted state. Completion SHA and test fields currently accept free-form evidence from `plan done`.

**Change.** Lock or compare-and-rebase tracker row writes and model post-commit recovery explicitly. Reconcile the committed SHA rather than creating another commit. Define which completion modes require validated evidence and keep compatibility for historical tracker rows. Ensure cleanup cannot remove unrelated work.

**Acceptance.** Update concurrent rows, detect ambiguous ids and cycles, survive stale before-images, signing/commit failure and tracker-write failure, and recover once with correct evidence and lease state. Run `node --test test/plan.test.mjs test/plan-surfaces.test.mjs test/slice.test.mjs test/archive.test.mjs test/lease.test.mjs`.

### PR19 — Validate knowledge with the same readers used by its commands

**Observed.** `claims.json` containing `{"claims":[{"id":"a"}]}` produced zero knowledge findings, and `knowledge why a` refused the claim. **Source.** [Shape validation](../../src/knowledge/inputs.mjs#L53) checks mostly outer arrays. The same module [labels export.json as import input](../../src/knowledge/inputs.mjs#L31), while [Plan 0005](../plans/0005-knowledge-doors-in-default-flows.md) describes export requests there. Directory errors are treated as absence and the gate reads documents without the CLI's size bound.

**Change.** Reuse the canonical input readers for semantic/shape findings in CLI, MCP and check. Give authoring and imported bundles distinct, documented conventions. Validate at rest without requiring query-time inputs or time-sensitive export/import state.

**Acceptance.** Check malformed nested records and edges, valid input for every advertised command, absent directories, path-type and permission errors, and oversized files. Compare findings with each invoked reader and test byte-identical projection when knowledge is absent. Run `node --test test/check-knowledge.test.mjs test/doc-input.test.mjs test/work-doors.test.mjs test/mcp-work.test.mjs test/knowledge-claims.test.mjs`.

### PR20 — Make document-driven verification reject malformed input

**Observed.** [Verify select](../../src/commands/verify.mjs#L35) treated a string `changed` as an empty list and returned an OK no-op. **Source.** The shared JSON input helper accepts arrays and applies the byte check after reading files. Several work and verify adapters default invalid present fields to empty inputs.

**Change.** Define per-command schema and required/optional semantics at the boundary. Return stable typed errors for malformed input, and keep empty legitimate requests distinct from invalid or incomplete evidence. Share bounded file/stdin reads and preserve existing accepted input shapes.

**Acceptance.** Direct CLI/API/MCP tests with absent, empty, invalid-type, oversized, and legitimate input documents. Verify unread or unresolved observations never satisfy an obligation. Run `node --test test/doc-input.test.mjs test/verify-selection.test.mjs test/verify-contracts.test.mjs test/work-closure.test.mjs test/work-query-contract.test.mjs test/mcp-work.test.mjs`.

### PR21 — Separate MCP reads from cache writes and process execution

**Observed.** Calling `checkRepo(root,{})` on a new fixture created a check cache. **Source.** The [MCP check tool](../../src/mcp/tools-facts.mjs#L33) calls that function, which [writes unconditionally](../../src/commands/sync.mjs#L656). Federation is advertised alongside reads but may start a separately authorized configured process.

**Change.** Make repository checking pure with respect to filesystem writes, then refresh the prompt cache explicitly from the CLI path that owns it. Audit every MCP tool/resource for use of read, data-disclosure, local write, or subprocess capabilities. Keep federation separately opt-in and enforce scope at invocation.

**Acceptance.** Compare files, modes, Git state, spawned processes, and socket attempts before and after listed MCP tools/resources on empty and warm fixtures. Exercise configured and unconfigured federation without a live target. Run `node --test test/mcp.test.mjs test/mcp-work.test.mjs test/mcp-spec.test.mjs test/federation.test.mjs test/status.test.mjs`.

### PR22 — Bound MCP framing and make response contracts consistent

**Source.** [The stdio server](../../src/mcp/server.mjs#L489) limits a line only after `readline` buffers it. Its line listener can parse cancellation messages outside the size check. Response writes also lack an explicit backpressure contract. Root and argument handling occur across tool code, schemas, and resources.

**Change.** Enforce a byte cap before buffering or parsing, respect stdout backpressure, and make framing, lifecycle and cancellation behavior explicit for each supported protocol version. Preserve request identity and structured schema/error outcomes. Keep expensive reads cancellable and bounded.

**Acceptance.** Test split UTF-8 and line endings, oversized frames, queue and output backpressure, cancellation, invalid request shapes, slow clients, reconnect, and output-schema validity. Test an installed stdio process in addition to handler functions. Run `node --test test/mcp.test.mjs test/mcp-session.test.mjs test/mcp-cancel.test.mjs test/mcp-schema.test.mjs test/mcp-paginate.test.mjs`.

### PR23 — Make index provenance and rebuild semantics coherent

**Source.** [Reindex](../../src/index/store.mjs#L229) uses schema version and blob oid to decide when to re-extract. Changing the parser, ecosystem configuration, or package boundaries leaves unchanged file rows and neighboring import edges eligible for reuse. [Freshness](../../src/index/store.mjs#L317) treats inability to read Git as not stale. The existing cold-build concurrency regression passed in isolation. Equivalence under concurrent mutation remains to be established.

**Change.** Version the index's effective inputs, including parser and extraction config, scope, package layout and index revision. Refresh dependent edges when resolution changes, keep reads bound to a consistent build, and surface busy or unknown freshness as such. Document index, working-tree overlay, and committed basis on every retrieval result.

**Acceptance.** Test add/delete/rename of an imported destination, unchanged source under a new parser or package root, failed Git read, simultaneous builders and staged/worktree overlay separation. Compare incremental output with a clean rebuild. Run `node --test test/index.test.mjs test/index-open-error.test.mjs test/index-fts-quote.test.mjs test/work-index.test.mjs test/overlay-corrupt.test.mjs test/map.test.mjs`.

### PR24 — Fix registry portability, skill identity, and workspace caching

**Source.** [Registry discovery](../../src/graph/load.mjs#L56) prefers the source checkout's catalogue and later assumes a workspace member. [Its process-wide memo](../../src/graph/load.mjs#L130) can retain stale config and is keyed partly by cwd. [Source identity](../../src/resolve/source.mjs#L51) is a byte count, so different same-size bodies can satisfy the same declaration.

**Change.** Keep estate data out of published artifacts as ADR-061 requires. Define an explicit repo-local registry/config path and useful single-repo setup, reconcile root/flag/env/user/workspace precedence, and move config caching to the normalized invocation or a bounded revision-based cache. Introduce digest-based verification with a migration path for byte-only registries.

**Acceptance.** Run source and packed CLI against isolated repo-local, workspace, and explicit registries. Change config between requests in the same process and demonstrate same-length substitutions are detected. Preserve missing/ambiguous registry and legitimate vendored skill behavior. Run `node --test test/graph.test.mjs test/graph-vendored.test.mjs test/workspace.test.mjs test/skills-context.test.mjs test/install.test.mjs test/pack.test.mjs`.

### PR25 — Enforce local model data and transport boundaries

**Source.** [Model requests](../../src/local/client.mjs) validate the initial endpoint but leave redirect handling to fetch and read full response bodies. [Index embedding](../../src/index/store.mjs#L330) and [distillation](../../src/distill/distill.mjs) have different data and caching paths.

**Change.** Resolve one explicit endpoint policy and enforce it for redirects, payload input, output bounds, credentials and error redaction. Record the selected model and data basis without storing credentials or raw sensitive context. Keep optional network features isolated from core reads.

**Acceptance.** With controlled HTTP fixtures, assert exact allowed request destinations, selected/redacted content, refusal on a disallowed redirect or oversized response, timeouts, and zero socket opens with optional features off. Run `node --test test/local.test.mjs test/distill.test.mjs test/review.test.mjs test/work-trust.test.mjs test/index.test.mjs`.

### PR26 — Audit filesystem scope and executable configuration ownership

**Source and qualification.** Repository paths enter [journal writers](../../src/journal.mjs#L128), [skill lookup](../../src/resolve/source.mjs#L39), [parser loading](../../src/index/store.mjs#L634), and [federation](../../src/federation/config.mjs#L130) through different trust boundaries. One reviewed lexical path check cannot prove filesystem ownership. Agent hooks are advisory enforcement for supported payloads and need a published assurance boundary.

**Change.** Inventory effect-bearing paths and trust principals. Use canonical containment, explicit exceptions for intended workspace/user locations, and opt-in for executable extensions. Keep data parsing separate from execution. Fail closed on invalid policy configuration while preserving documented behavior for advisory hooks and unsupported harnesses.

**Acceptance.** Add inert filesystem and config trust fixtures for local links, worktrees, dependencies, retries, missing policy, and cross-repo allowlists. Validate real agent-hook dialogs/exit semantics for supported harness versions and publish precisely what is covered. Run `node --test test/undo.test.mjs test/install.test.mjs test/agenthooks-audit.test.mjs test/agenthooks.test.mjs test/work-adapters.test.mjs test/federation.test.mjs test/secrets.test.mjs`.

### PR27 — Resolve each release once and verify cross-channel promotion

**Source.** [Publish channels](../../.github/workflows/publish-channels.yml#L85) groups runs by the raw input, while PyPI, Homebrew and brew verification each resolve the version separately. A moving default can split the run across releases. A version alias and explicit value can target the same artifact through different concurrency keys. The PyPI gate checks registry version presence, then verifies wheel parity against locally built bytes. Dispatch values are also interpolated into generated shell before the workflow establishes a single validated release input.

**Change.** Resolve and validate one immutable release descriptor, with concrete version, source commit, and artifact hashes. Feed it to all jobs. Serialize promotion by destination and verify registry, wheels and binary bytes against their intended source. Make retries and partial promotion explicit and idempotent.

**Acceptance.** Dry-run staged/latest/explicit versions against simulated registries and tap, including a moving version, concurrent releases, mismatched checksum and partial publication. Produce the exact release evidence a maintainer reviews. Run `node --test test/packaging.test.mjs test/shipped.test.mjs test/binary.test.mjs` and the release rehearsal across all enabled channels.

### PR28 — Qualify installed packages and state platform prerequisites

**Observed.** Local npm packing produced 546 archive entries and an unpacked CLI that ran in a clean consumer. The SEA smoke could prepare its payload but failed on a build-only dependency fetch in this environment. **Source.** [The binary target list](../../src/distribute/release.mjs#L29) contains macOS arm64/x64 and Linux x64. [The wheel launcher](../../python/simt_dev/cli.py) delegates to an external Node runtime.

**Change.** Publish support by channel, OS, architecture, Node/Git floor and optional runner prerequisites. Derive release and install metadata from one target inventory and state the fallback for unsupported combinations. Qualify package contents, CLI/library, MCP and shims as delivered. Decide Linux arm64 or other platform additions with explicit release policy and CI capacity.

**Acceptance.** Run `npm run verify:shipped`, `npm run verify:wheel` and `npm run build:sea` in release-capable jobs. Install actual artifacts in isolated repos and cover no global simt, no Node for SEA, wheel with/without Node, supported and unsupported platforms, package managers and Git object formats. Compare checksums and exercise rollbacks and upgrade. Run `node --test test/pack.test.mjs test/packaging.test.mjs test/binary.test.mjs test/node-version.test.mjs`.

### PR29 — Publish one supported surface and deprecation map

**Source.** [The spec](../../src/commands/spec.mjs), [dispatch table](../../src/commands/index.mjs), [API exports](../../src/api.mjs), [MCP tools](../../src/mcp/tools.mjs), [package exports](../../package.json), shims, and generated docs each expose a different view. Advanced presentation and stability are separate concepts, but only packs explicitly carry an experimental classification in the spec.

**Change.** Inventory every CLI route and alias, public export/deep import, schema, write effect, file path, MCP tool/resource, shipped plugin and artifact. Give each a consumer and owner. Record keep, merge, optional, deprecate or remove decisions, compatibility window and migration. Preserve distinct commands where their provenance, effects or evidence differ.

**Acceptance.** Generate and diff the inventory from the product entry points. Require explicit treatment of bench, pack, distill, work/action/verification prototypes, federation, workspace sharing, and compatibility aliases. Run `node --test test/spec.test.mjs test/spec-taxonomy.test.mjs test/spec-writes.test.mjs test/mcp-spec.test.mjs test/api.test.mjs test/docs.test.mjs`.

### PR30 — Retire or explicitly retain experimental packs

**Source and qualification.** [ADR-130](../decisions/ADR-130-packs-are-experimental-and-frozen-until-a-repository-adopts-one.md) freezes packs pending a consumer. The `pack` group includes registry publishing, and [projection](../../src/projection/rules.mjs#L44) plus [check](../../src/commands/sync.mjs#L609) depend on the consumer format. This review found no adoption evidence in the tool checkout. Outside usage is open.

**Change.** Retire the experimental publishing/scaffolding surface if the caller audit finds no production user. Retain local profiles as the first-choice configuration path, and provide a read/migrate path for pinned packs before removing support. If adoption justifies retention, isolate management, keep deterministic local resolution, and specify the responsible maintainer and support tier.

**Acceptance.** Migrate an adopted pinned-pack fixture without changing effective rules or losing provenance. Cover invalid pins, preview/apply and script-facing deprecation behavior. Verify the legacy data path and any removed CLI/API/shipped files from the installed package. Run `node --test test/packs.test.mjs test/packcli.test.mjs test/project.test.mjs test/spec.test.mjs`.

### PR31 — Move bench and synthetic research outside the stable core

**Source.** [The npm allowlist](../../package.json) imports bench source into the production payload. [Dispatch](../../src/commands/index.mjs#L336) exposes runner, grader, probes, corpus, critic and experimental paths. Some action, trust and coordination helpers have internal callers or synthetic tests without a demonstrated production entry point. ADR-191 requires accuracy about reachability.

**Change.** Give existing consumers a supported optional route for bench, distill and measured adapters. Move research harnesses, worlds, probe catalogs and experiment-only action helpers behind that boundary or back into fixtures. Keep shared test selection, proof primitives and read-only validation in core where real consumers use them. Require distinct owned contracts for any work/action features promoted to stable.

**Acceptance.** Compare installed core payload and startup dependency graph before and after. Verify normal CLI/API/MCP can run with optional pieces absent, and a separately installed optional package reproduces retained experiments from the existing corpus. Run `node --test test/bench.test.mjs test/bench2.test.mjs test/bench3.test.mjs test/distill.test.mjs test/work-door-parity.test.mjs test/work-release.test.mjs`.

### PR32 — Verify reachability, remove dead bindings, and narrow exports safely

**Observed.** A literal relative-import scan reached all 294 tracked modules in `src`, `packages`, `bin`, and `scripts` from the API, binary and build scripts. That does not establish usage of every binding. [The current dead-code test](../../test/deadcode.test.mjs) counts word occurrences, including comments and tests, and the wildcard export exposes internal paths to external users.

**Change.** Audit reachability at the binding and shipped entry-point level. Count actual module edges, lazy routes, generated imports and documented public consumers. Examples requiring disposition include `writeLockVariants` after the variant runner retirement and test-exercised action schedulers/observations. Remove unreachable private functions and redundant re-exports after accounting for real users. Replace the wildcard only with a migration for plugins, shims and known legacy callers.

**Acceptance.** Verify removed code and unused package files disappear from npm/wheel/SEA. Exercise every supported entry point, including dynamic and generated imports, from outside the checkout. Regression-check a test-only or comment-only occurrence so it cannot certify production reachability. Run `node --test test/deadcode.test.mjs test/api.test.mjs test/spec.test.mjs test/pack-imports.test.mjs test/plugins.test.mjs test/shipped.test.mjs`.

### PR33 — Consolidate duplicate test reporting and repository adapters

**Source.** [Focused output compaction](../../src/index/compact.mjs) and [test result parsers](../../src/testing/parsers.mjs) separately parse TAP, Vitest/Jest, Go and JUnit. [Package discovery](../../src/monorepo.mjs#L276) and [index package assignment](../../src/index/store.mjs#L586) also infer project ownership separately.

**Change.** Reuse structured report readers and render compact output from their result. Keep a raw fallback with an explicit unavailable status. Consume one effective package/scope descriptor from PR09–PR12 for ranking, running and attribution. Consolidate only overlapping detection and parsing, retaining separate consumers and presentation contracts.

**Acceptance.** Differential fixtures for real pass/fail/skip/empty/malformed reports and nested package ownership. Assert equivalent outputs where contracts agree and deliberately different outcomes for focused tests versus a full gate. Run `node --test test/testing.test.mjs test/compact.test.mjs test/gate.test.mjs test/index.test.mjs test/monorepo.test.mjs test/bench.test.mjs`.

### PR34 — Migrate and retire legacy compatibility paths on evidence

**Source.** [Name and state constants](../../src/name.mjs) preserve old manifests, locks, markers and state. [The state reader](../../src/state.mjs#L33) and migration routines carry fallbacks of different ages and retention promises. Some are needed to recover user data and still-installed shims.

**Change.** Inventory format age, presence in released payloads, existing users and recovery value. Use one migration owner per format. Collapse duplicate readers after migrating all supported versions and remove only expired paths with evidence. Preserve human-authored regions, old variant winners, active leases and recoverable journal history.

**Acceptance.** Exercise each supported legacy version alone, mixed old/new data, crash/retry, and idempotent migration without touching unrelated files. Verify current fixtures use only supported paths and any retired path has a documented remedy. Run `node --test test/naming.test.mjs test/markers.test.mjs test/lock.test.mjs test/lease-v2.test.mjs test/ledger-v2.test.mjs test/undo.test.mjs test/deprecation.test.mjs`.

### PR35 — Make CLI, API, MCP, and generated references agree

**Source.** [Programmatic run](../../src/run.mjs#L48) reimplements flag checks and lets a thrown handler reject the promise, whereas [the CLI](../../src/cli.mjs#L35) converts exceptions to a failure and force-exits on the exception path. [The own CI template](../../src/ci/workflow.mjs#L94) still explains that the repo has never self-adopted. Its generated AGENTS region and manifest contradict the explanation. Generated command pages and the handwritten simt-commands guide need separate drift checks.

**Change.** Normalize invocation, validate accepted flag names/types/arity, and structure domain errors before transport rendering. Preserve transport-specific status codes where defined. Drive help, completions, command pages and reference manifests from the supported inventory. Review generated bytes as the recipient, update the self-gate rationale, and use the same acceptance for a consumer checkout.

**Acceptance.** Test alias, invalid arguments, typed refusal, thrown handler, large output, contradictory write flags and cancellation across CLI/API/MCP where supported. Check generated docs and projected commands against the installed binary. Run `node --test test/run.test.mjs test/api.test.mjs test/spec.test.mjs test/completions.test.mjs test/envelope.test.mjs test/docs.test.mjs test/ci.test.mjs`.

### PR36 — Make the isolated test and release qualification gate reproducible

**Observed.** The first isolated checkout suite failed in signing-sensitive fixtures, npm packing, SEA dependency retrieval, and the incremental-index wall-clock test, among other tests. See the evidence below. [The suite script](../../package.json) uses host CPU count for concurrency and [the index test](../../test/index.test.mjs#L67) puts a 300 ms performance threshold in the correctness suite. CI also assumes fixed history in its full checkout.

**Change.** Make Git fixture identity and signing independent of local user configuration. Give npm and SEA builds explicit writable caches and pinned inputs. Keep fast deterministic correctness tests offline and move real artifact/remote checks into named qualification jobs with prerequisite failures visible. Separate index work-set correctness from a predeclared, repeatable benchmark under controlled load. Build fixture history where it is test data.

**Acceptance.** Run `npm test`, `npm run lint`, `node scripts/ci.mjs --check` and package qualification from a relocated full checkout without siblings, host user config, or prior build data. Run an offline test pass and explicit release-capable jobs across the supported matrix. Confirm skips are declared and reported. Run `node --test test/tiers.test.mjs test/identity.test.mjs test/index.test.mjs test/pack.test.mjs test/review.test.mjs test/binary.test.mjs` during implementation.

### PR37 — Qualify production readiness from installed consumer fixtures

**Qualification.** A green source suite cannot establish installation, upgrade, configuration or enforcement in a receiving repository. Require evidence by capability and channel before making a general-purpose support claim.

**Change.** Adopt a release acceptance matrix using only installed artifacts and independently staged fixtures. Publish reproducible commands, actual targets, bounds and failure behavior. Establish measurable startup, index and hook limits before collecting performance data. Record unsupported combinations by reason and supported exit or remedy.

**Acceptance.** Exercise docs-only, custom ecosystem, at least one non-Node codebase, Node with each supported installer, mixed and nested projects, worktree/submodule, mono- and multi-repo, shallow clone, dirty checkout, and prior published formats. For each applicable channel prove preview, adoption, projection, frozen check, actual gates and evidence, undo, upgrade, and clean packaging. Exercise plain CLI/library and supported MCP/harness clients, interruption and retry, optional tools absent, and explicit CI opt-in. Rerun the full isolated test suite, document regressions and all skipped boundaries, and sign off each row against reviewed evidence.

### PR38 — Bind an inline agent-hook override to its invocation

**Source.** Main advanced during this review. Commit `c7f1f2c` adds command-local overrides, but [command fact extraction](../../src/agenthooks/shell.mjs#L502) flattens assignments across the command list. [The policy decision](../../src/agenthooks/decide.mjs#L101) consumes the final assignment once for every matched fact. That loses the shell's per-invocation environment boundary and cannot establish that the same override applies to each invocation.

**Change.** Attach an effective, scoped override to the fact it governs. Keep inherited and inline authority distinct and leave an unproven scope indeterminate under the existing enforcement policy. Preserve the approval rule and ensure explanations expose the scope without exposing unrelated environment values.

**Acceptance.** Test normalized facts with multiple invocations, independent policy decisions, nested wrappers and ambiguous scope in inert fixtures. An override on one invocation leaves independent decisions intact, and valid single-invocation behavior still works. Run `node --test test/agenthooks.test.mjs test/agenthooks-audit.test.mjs test/work-agenthooks.test.mjs test/command-agenthooks-explain.test.mjs`.

## 4. Review evidence and verification limits

Baseline `863888bdd2bc7728e3571b46b99bb0359980d836`. Reviewed CLI, library and MCP entry points, along with manifest configuration, adoption, projection, migrations, Git and agent hooks, gate evidence, indexing, skills, workspace resolution, trackers, knowledge and work commands, and release workflows. Used the prior archived reviews to distinguish existing rulings and completed fixes from current findings. The audit combined source tracing, import inventory, fixture probes, rendered-output inspection, and tests. Verification was targeted within each subsystem.

- **Relocated checkout.** Ran `npm test` from a full local clone under a fresh parent directory with no sibling repos, on macOS arm64, Node `26.13.0` and Git `2.54.0`. The first run exited 1 with 29 failures out of 2,459 tests. It inherited host signing and npm settings. A second run with isolated Git and npm settings exited 1 with 12 failures out of 2,459. The second run's three identity failures came from its fixture author environment overriding the identity under test. Seven package tests shared one setup failure because their install discarded the supplied npm cache settings. The SEA build's dependency fetch returned HTTP 403, and the incremental-index test took 309 ms against a 300 ms threshold.
- **Focused reruns.** `node --test test/docs.test.mjs test/plan.test.mjs test/archive.test.mjs test/identity.test.mjs` passed 67 tests using an isolated Git config file with no fixture author override. `node --test test/index.test.mjs` passed 18 tests in the isolated clone, including the incremental-index threshold case. Both full-suite runs remain red.
- **Distribution smoke.** Ran `npm pack --ignore-scripts` with an isolated cache, unpacked the artifact, and inspected a generated AGENTS region from a docs-only repo. The unpacked CLI's `init --yes` and `check --frozen` succeeded. Installed the same archive offline with an explicit cache in a separate Git fixture. The installed CLI passed `init --yes`, `check --frozen`, `hooks install --yes`, and `hooks run pre-commit` with one passing lint gate. Its pin-only upgrade failure is recorded in PR16.
- **Repository checks.** `npm run lint` exited 0 with structural checks only because the isolated checkout had no skill-source workspace. `node scripts/ci.mjs --check` reported both generated artifacts current. `node bin/simt.mjs check --frozen --json` exited 0 in the adopted tool checkout with file-size warnings. `node bin/simt.mjs docs commands --json` reported the command pages unchanged. Reviewed the tracker with `node bin/simt.mjs plan status --json` and `node bin/simt.mjs plan next PR01 --json`, verified unique ids and an acyclic dependency graph, and confirmed the archive preview refuses unfinished rows.
- **Main advanced during review.** Reviewed both incoming changes through `09ccb2e2943d8b310a8a82539ec950720a439a54`. Inline override scope is captured in PR38. The binary shim test now sanitizes PATH and its executable override. `node --test --test-name-pattern="the hook shim hands over" test/binary.test.mjs` passed at the newer revision. All 29 tests in `test/agenthooks.test.mjs` also passed at the newer revision. Both full-suite totals above belong to the original baseline.
- **Remaining qualification.** Linux and Node floor runs, a successful standalone SEA build, wheel build/install parity, Homebrew installation, live CI and promotion workflows, external registry adoption, and live harness/MCP clients remain open. PR26–PR28 and PR36–PR37 own that evidence. The review used no live publication or operational target.
