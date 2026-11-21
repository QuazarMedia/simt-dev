# Plan 0006 — Make work and knowledge usable in local repositories

Status: **queued** · 2026-11-19

Implementation owner: simt-dev

Baseline: `7188aefa7ab4b1c0bd8f64a608b3bb87751e570a`

## Outcome

A maintainer can point SIMT at one existing collection of documents or procedures, use its existing files and checks, and get three useful answers in the first session.

1. **Find evidence.** Find the source section that applies to a named scope and date, distinguish contradictory evidence from a superseded version, and open the cited location.
2. **Understand a change.** See the requirements, procedures, scripts, tests, and generated outputs a changed source or template reaches, including gaps in the graph.
3. **Know what is verified.** Run or review the repository's scoped local checks and see what their results prove, what needs human review, and what remains unverified.

Adoption starts with one scope. Canonical documents, procedures, scripts, templates, and existing work items stay where their maintainers keep them. A project can grow from a document collection to a mixed repository by adding configuration. It needs neither a bespoke importer nor a new runtime to get the first answer. Existing local search, generators, conventions, task workflow and CI remain valid inputs and integration points.

This plan covers local Git repositories and offline inputs, including externally produced evidence that a maintainer imports explicitly. Live fetching, remote target dispatch, model-based decisions, and mandatory new hooks are outside this rollout. A local result cannot attest to an external outcome.

## What exists and what prevents adoption

Two local repository shapes informed the plan. The first has a large, partitioned and multilingual document corpus, effective dates and source references, downstream specifications generated from requirements, per-area checks, and ignored local maintenance items. The second has reference pages, structured Markdown procedures, executable helpers and tests, an existing lexical and dependency search, and ignored work items with their own lifecycle. The first needs scope and derivation fidelity. The second needs to reuse existing retrieval and local workflows rather than build a second catalogue or tracker. Seed synthetic fixtures with both shapes.

| Existing capability | Gap on the normal path |
| --- | --- |
| Plan 0005 projects a knowledge pointer and validates conventional inputs | There is no scoped onboarding or producer. In a scratch repo, `knowledge rank --query retention` requested `--input` even with `units.json` present. The brief printed a rank example without a query. |
| `work inspect` samples artifacts and produces capability cards | A configured validator with no executable was marked available. A bounded tree sample guesses kinds from names. It does not give maintainers a reliable map of the part of the corpus they opted in to use. |
| Knowledge readers, extraction, ranking, temporal claims, impact, derivations and debt already exist | A repository must prepare several unrelated JSON documents. Existing Markdown, source references, approved metadata and recipe links are not connected into a single local queryable view. |
| `verify select` evaluates caller-supplied paths, obligations and validators | A changed document returned `nothing-selected` through the source gate. `verify select --changed` was rejected. The repo-aware path from a diff to typed obligations, execution and evidence is missing. |
| `work schedule`, `work handoff`, `work resume`, `work graduate` and `work packet` accept JSON inputs | Tasks, current evidence and provenance must be assembled by hand. Handoff requires a target incarnation even for a local editorial task. Existing ignored work items cannot become a second authority by accident. |

**Evidence.** Inspected tracked layout and documented conventions in both reference repositories. Neither tracked a SIMT manifest or knowledge inputs at inspection time. No repository work item bodies or credential files were needed. A disposable fixture exercised `work inspect --json`, `knowledge rank` with and without a document, `brief --json`, `gate --changed`, and refusal of `verify select --changed`. Ran `node --test test/work-facets.test.mjs test/work-capabilities.test.mjs test/work-profiles.test.mjs test/work-doors.test.mjs test/check-knowledge.test.mjs test/pilot-knowledge.test.mjs test/verify-selection.test.mjs` using an isolated Git configuration. All 66 tests passed. The docs and tracker run with `node --test test/docs.test.mjs test/plan.test.mjs test/archive.test.mjs` passed 49 tests. SIMT recognized all 15 rows, found WK01, and resolved WK02’s dependency. The end-to-end workflows below are implementation acceptance.

## First-session contract

The following is a proposed flow. New flags and subcommands ship with their implementation slices. Consumer-facing instructions must name only commands available in the installed version.

```sh
simt work inspect
simt work setup --scope handbook --path handbook --kind document
simt work setup --scope handbook --path handbook --kind document --yes
simt knowledge build --scope handbook
simt knowledge build --scope handbook --yes
simt knowledge rank --scope handbook --query "device checkout retention"
simt knowledge why device-checkout.retention --scope handbook --as-of 2026-05-01 --known-at 2026-11-19
simt knowledge impact --changed --scope handbook
simt verify select --changed --scope handbook
simt verify run --changed --scope handbook --yes
simt verify status --changed --scope handbook
```

`work setup` and `knowledge build` preview before writing. The pilot supplies the reviewed claim in the existing document or an adjacent sidecar. A built corpus can find an ordinary section without a reviewed claim. In that case `why` offers the supported way to add a claim and search continues to show the source section with its actual authority. For an existing project today, `work inspect` and `knowledge sections <file.md>` work directly. The other knowledge readers take explicit JSON files or stdin. Existing input forms remain supported in the new flow.

### Data ownership

- **Repository configuration and authored evidence.** Use versioned `work` configuration in `simt.json`, with optional repo-relative paths to mappings or reviewed sidecars. Reuse existing document metadata and explicit ids where they exist. Scope is a configured path and typed context, such as a jurisdiction, product, version, population, or a repository's equivalent dimension. Language and valid/known dates are explicit values. One overlapping path resolves through ADR-145's specificity rule or reports ambiguity.
- **Derived data and local state.** Keep rebuildable section indexes, views, receipts and work capsules under the existing Git-ignored local area with schema and input revisions. Keep shared reviewed claims and local-only material distinct. A cache missing or built on another revision gives an actionable unavailable or stale result. Tracked, staged and working-tree inputs have explicit provenance.
- **Authority and trust.** Git tracking does not grant publication rights. Default ingestion is tracked files within declared scopes. Exclude ignored, denied, generated or sensitive paths by default as appropriate to the declared source policy. A user can opt in to private work items for local coordination with a separate path scope. Private data stays out of shared output, agent packets by default, export, and persistent raw logs. Files, import data, and retrieved content supply evidence. They cannot change policy or authorize actions.
- **Evidence status.** Structural checks, semantic review, and observed outcomes retain their own basis. A declared command, a planned check, a stale receipt, a successful invocation with zero matching items, and an unresolved source have distinct results. Treat unknown as an explicit state and name the next check.

## Tracker

| ID | Slice | Phase | Lane | Tier | Depends on | State | SHA / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WK01 | Define local configuration, scopes and inspection | First use | config | M | — | Complete | e11b9b735c9772b1df050ffb12002ec5aae01a30 · test: node --test test/work-config.test.mjs test/work-artifacts.test.mjs test/work-facets.test.mjs test/work-capabilities.test.mjs |
| WK02 | Add previewable one-scope setup | First use | setup | M | WK01 | Complete | 172ec660c181300cbd98c037fefd8cb794ea89e9 · test: node --test test/work-setup.test.mjs test/work-config.test.mjs test/work-doors.test.mjs test/work-capabilities.test.mjs test/work-facets.test.mjs test/work-artifacts.test.mjs |
| WK03 | Build a scoped corpus from existing files | First use | corpus | L | WK01 | Complete | 14d6c59e733c53e11cfe0376a5d07e4d5cc2a7f2 · test: node --test test/work-corpus.test.mjs test/knowledge-sections.test.mjs test/work-index.test.mjs test/work-artifacts.test.mjs test/work-trust.test.mjs test/index.test.mjs |
| WK04 | Reuse native metadata for claims and source lineage | First use | corpus | M | WK03 | Complete | 1c43d11f4bef1d15d8ae1bdc75d00736302de413 · test: node --test test/work-lineage.test.mjs test/knowledge-claims.test.mjs test/knowledge-validity.test.mjs test/knowledge-observations.test.mjs test/knowledge-conflicts.test.mjs test/check-knowledge.test.mjs |
| WK05 | Query the repository directly with citations and dates | First use | query | M | WK04 | Complete | 8ea315a719b00ef2682aedd41c00232f36d82c1e · test: node --test test/work-query.test.mjs test/work-doors.test.mjs test/knowledge-rank.test.mjs test/knowledge-validity.test.mjs test/work-door-parity.test.mjs |
| WK06 | Prove the first-session flow in two installed fixtures | First use | qualify | M | WK02, WK05 | Complete | 9eb80419a09731550a957e314b7340b599f311e2 · test: node --test test/pack.test.mjs test/shipped.test.mjs test/pilot-knowledge.test.mjs test/work-release.test.mjs |
| WK07 | Explain the impact of a local change and stale derived outputs | Daily work | impact | M | WK04 | Complete | b53b9fea4b7d9c3ed8a70d7b33490631fcd4ac80 · test: node --test test/knowledge-impact.test.mjs test/work-impact.test.mjs test/knowledge-derivations.test.mjs test/verify-procedures.test.mjs test/impact.test.mjs test/work-corpus.test.mjs test/work-lineage.test.mjs test/work-query.test.mjs test/gate.test.mjs test/docs.test.mjs |
| WK08 | Select typed checks from the repository diff | Daily work | verify | M | WK07 | Complete | 7c33314d77dc002c16ca7f5e90ae66d578bbb321 · test: node --test test/verify-selection.test.mjs test/verify-documents.test.mjs test/verify-procedures.test.mjs test/gate.test.mjs test/work-profiles.test.mjs test/work-config.test.mjs test/docs.test.mjs |
| WK09 | Run scoped local validators and bind evidence to inputs | Daily work | verify | L | WK08 | Complete | d95ab71beac8fc279aaf97d6a107167363fba217 · test: node --test test/verify-contracts.test.mjs test/work-closure.test.mjs test/work-ledger.test.mjs test/ledger.test.mjs test/hooks-context.test.mjs test/pack.test.mjs test/plan-surfaces.test.mjs test/help.test.mjs test/docs.test.mjs test/verify-selection.test.mjs |
| WK10 | Bring scoped knowledge and verification into agent entry points | Daily work | agent | M | WK05, WK09 | Complete | b6990915ba379d0d2fcbaae9912102479d173c5c · test: node --test test/brief.test.mjs test/work-brief.test.mjs test/work-doors.test.mjs test/mcp-work.test.mjs test/shipped.test.mjs test/pack.test.mjs test/work-query.test.mjs test/docs.test.mjs |
| WK11 | Read and schedule work from existing trackers | Daily work | coordination | M | WK01, WK09 | In progress | — |
| WK12 | Resume local work from current evidence and artifact ids | Daily work | coordination | M | WK11 | Queued | — |
| WK13 | Import existing catalogues and exchange permitted offline data | Maintenance | interchange | M | WK04, WK05 | Queued | — |
| WK14 | Turn stale evidence and repeated work into reviewed maintenance | Maintenance | lifecycle | M | WK07, WK09, WK12 | Queued | — |
| WK15 | Qualify local adoption, migrate incrementally, and publish support | Release | qualify | M | WK06, WK10, WK12, WK13, WK14 | Queued | — |

WK06 is the first usable checkpoint. WK10 and WK12 make it a daily workflow. WK15 is the release exit.

## Slices

### WK01 — Define local configuration, scopes and inspection

Use [work config](../../src/work/config.mjs), [scope resolution](../../src/work/artifacts.mjs) and [capability cards](../../src/work/capabilities.mjs) as the owners. Read the manifest and effective paths once. Version any new fields for corpus policy, metadata mappings, and validator references. Keep existing scope declarations readable and clearly distinguish inferred shape, configured scope, installed runner, and recorded evidence. Replace sampling as an authority on configured scope. A read-only probe may report a missing runner, but cannot execute one to make an inspection appear green.

**Acceptance.** An unconfigured doc repo reports a small actionable next step. A declared and installed local validator, a declared but missing validator, and a configured scope with no validator produce different results. Bad/impossible config names a field and remedy. Dot paths, spaces, nested roots, ignore patterns and overlapping scope fixtures resolve as documented. Run `node --test test/work-config.test.mjs test/work-facets.test.mjs test/work-capabilities.test.mjs test/work-artifacts.test.mjs`.

### WK02 — Add previewable one-scope setup

Add a narrow setup path fed by the effective configuration. Propose one explicit scope, minimal documentation, and an optional metadata or validator example. Support adopted and unadopted repositories. Reuse the projection and journal only for files the operator chooses, and preserve user-owned manifest keys, instructions, Git config, CI and hooks by default. Explain current-state prerequisites before changing files and make the second apply a no-op. The receiver's generated README must point at its own files and installed commands.

**Acceptance.** Run preview, apply, repeated apply, failure recovery and undo in both fixture shapes, with and without an existing manifest and with pre-existing handwriting. Preview leaves all bytes and Git settings unchanged. The applied diff matches it. No synthetic claims, invented runner or global dependency appears. Run `node --test test/init.test.mjs test/work-profiles.test.mjs test/write-plan.test.mjs test/undo.test.mjs test/shipped.test.mjs`. Exercise the new setup entry point against both installed fixtures.

### WK03 — Build a scoped corpus from existing files

Reuse [section extraction](../../src/knowledge/sections.mjs), [work artifact identity](../../src/work/artifacts.mjs) and the existing local index where practical. Ingest bounded, permitted Markdown sources and structured Markdown procedures first. Label unsupported file types by path and reason, and use a validated import for sites, binary formats, or proprietary generators when needed. Keep citation anchors, byte ranges, a content digest and basis. Index unchanged blobs incrementally and handle add, delete and rename. Use a source inventory and policy digest so an unchanged file never survives a scope exclusion by accident.

**Acceptance.** Build a tracked multilingual corpus and doc/recipe/source corpus with an ignored work context, denied path, generated output, long file, and missing source. Cold and incremental rebuild produce equivalent results. A staged file, unstaged change and committed revision are distinguishable. Denied/private content is filtered before reading or persisting to shared views, including symlink and stale-cache cases. Run `node --test test/knowledge-sections.test.mjs test/work-index.test.mjs test/work-artifacts.test.mjs test/work-trust.test.mjs test/index.test.mjs`.

### WK04 — Reuse native metadata for claims and source lineage

Use [claim](../../src/knowledge/claims.mjs), [applicability](../../src/knowledge/validity.mjs) and [observation](../../src/knowledge/observations.mjs) readers. Map declared frontmatter/sidecar fields for artifact id, type, scope, language, authority, applicable dates, observation dates and source links. Preserve available typed references to requirements, procedures, code or templates. Treat plain document sections as evidence candidates. Only reviewed facts declared by maintainers become claims with reviewed authority. Keep derivation and applicability judgments explicit. A missing source or uncertain relationship is visible.

**Acceptance.** A shared id survives move through explicit identity/rename mapping. Two versions with different dates and a revised later observation yield the correct temporal result. Preserve references to multiple source sections. Report unsupported schema, duplicate ids, invalid dates, ambiguous scope and proposed links separately. Validate authored inputs with the same reader as the CLI. Run `node --test test/knowledge-claims.test.mjs test/knowledge-validity.test.mjs test/knowledge-observations.test.mjs test/knowledge-conflicts.test.mjs test/check-knowledge.test.mjs`.

### WK05 — Query the repository directly with citations and dates

Add an explicit `--scope` repository mode to `knowledge rank` and `knowledge why`. Keep explicit file/stdin mode and legacy conventional files. Use the same [ranking](../../src/knowledge/rank.mjs) and lineage functions with data supplied by the local corpus. Support stable output with scope, authority, confidence basis, source location, date basis and the reason for a missing answer. Apply permission and scope before scoring. Do not invent a date, translation, or jurisdiction from the query's spelling. Provide exact matches and plain citation lookup where lexical language support is limited. A bounded local query needs no global registry.

**Acceptance.** Search and open a cited file from a clean installed checkout. Exclude an otherwise high-ranking wrong scope and preserve explicit unknown scope. Return both sides of a contradiction and the correct historical version when both time axes are supplied. Verify warm/cold behavior and explicit-file compatibility. Run `node --test test/work-doors.test.mjs test/knowledge-rank.test.mjs test/knowledge-validity.test.mjs test/work-door-parity.test.mjs`.

### WK06 — Prove the first-session flow in two installed fixtures

Ship a short operator guide and self-contained fixture examples for the two repository shapes. A maintainer starts with a named directory, enables one scope, builds an index and asks a question over existing content. The guide explains how to attach one reviewed claim to an existing source and how to handle absent answers. Expand scope only when prompted by the operator.

**Acceptance.** Use a packed npm install or other qualified artifact in clean standalone clones. For each shape, go from no SIMT configuration to four useful cited answers, including a scoped and a historical answer, in one session. No new dependency, migration of canonical content or hand-authored query JSON is required. Validate refusal without configuration or source, and prove the installed docs are strictly executable. Run `node --test test/pack.test.mjs test/shipped.test.mjs test/pilot-knowledge.test.mjs test/work-release.test.mjs` and record both end-to-end transcripts as sanitized fixtures.

### WK07 — Explain the impact of a local change and stale derived outputs

Feed a normalized Git change set and the scoped graph into [knowledge impact](../../src/knowledge/impact.mjs) and [derivation checks](../../src/knowledge/derivations.mjs). Build on reviewed metadata, procedure dependencies, generator inputs and source revision receipts. Keep document citations, procedure calls, typed derivations and code imports distinct. Add a Git change mode to the existing impact command, including old and new paths on renames. Show proposed and unknown edges separately and distinguish stale output from regeneration the tool observed. The first cut reports which existing generator or source a maintainer should read.

**Acceptance.** A changed authoritative source reaches all reviewed downstream artifacts across both fixtures, a renamed template reaches its generated output, and a changed procedure reaches its caller and referenced local helper. A missing receipt or edge limits coverage visibly. No reader invokes a generator. Run `node --test test/knowledge-impact.test.mjs test/work-impact.test.mjs test/knowledge-derivations.test.mjs test/verify-procedures.test.mjs test/impact.test.mjs`.

### WK08 — Select typed checks from the repository diff

Give `verify select` a repo-aware scope and diff mode. Intentionally keep the source import-closure selection while adding typed document structure, link, source-support, generator, and procedure obligations. Translate configured gate/validator ids into descriptors with argv, cwd, coverage, authority, execution class, and optional provider. Reuse the existing [selector](../../src/verify/select.mjs). Surface every unmapped changed path even when another path has a successful selection. A selection is a plan. Human semantic review and unavailable checks remain visible.

**Acceptance.** A staged or working-tree doc-only diff selects the configured area check. A mixed doc/source diff retains source tests, and a missing or independent validator yields the appropriate unresolved obligation. Report rename/delete/ambiguous scope, empty diff, partial mapping, and inadmissible remote requirements. Test unknown prefixes against siblings with similar names. Run `node --test test/verify-selection.test.mjs test/verify-documents.test.mjs test/verify-procedures.test.mjs test/gate.test.mjs test/work-profiles.test.mjs`.

### WK09 — Run scoped local validators and bind evidence to inputs

Add an explicit local execution path for a reviewed selection. Execute only repository-configured, runnable local validators through their existing runner, with canonical cwd, argv, timeout, and reported scope. Reuse the gate runner and [ledger evidence](../../src/ledger/evidence.mjs) instead of introducing a second executor or ledger. Record revision, input digests, validator/rubric id, check class, observed count, sanitized output and outcome. Feed these receipts to `verify status` and preserve manual attestations as a distinct evidence type. Detect stale and raced input. Existing safe Git gates remain under their own contract.

**Acceptance.** Fixtures exercise a passing and failing local wrapper, zero checked items, missing executable, timeout, and changed inputs during/after a pass. Verify structural green while semantic review is pending. A selected remote check remains unrun. No validator runs during setup, selection, preview, sync, or a read-only MCP query. Run `node --test test/verify-contracts.test.mjs test/work-closure.test.mjs test/work-ledger.test.mjs test/ledger.test.mjs test/hooks-context.test.mjs` and a new installed CLI lifecycle scenario.

### WK10 — Bring scoped knowledge and verification into agent entry points

Maintain Plan 0005's pointer-only default. Extend [the brief](../../src/brief/assemble.mjs) with an explicit scoped option for a small cited packet, reusing the work packet builder. Add relevant verified/pending summaries to the agreed CLI entry points without changing their meaning for existing repositories. Show the command that opens a referenced source, planned check or receipt. Preserve the current MCP surface until a consumer needs more and keep all read-only transport behavior aligned.

**Acceptance.** From an installed harness launch a brief for each fixture. It points to committed documentation, citations and exact follow-up commands, with source/verification gaps explicit. The proof packet respects byte budget and permissions, and omits local private task contents by default. No configured work means the prior output and projection remain stable. Run `node --test test/brief.test.mjs test/work-brief.test.mjs test/work-doors.test.mjs test/mcp-work.test.mjs test/shipped.test.mjs`.

### WK11 — Read and schedule work from existing trackers

Reuse SIMT's plan tracker and [work scheduler](../../src/coordination/workgraph.mjs). Add a read-only data adapter for configured local Markdown items or validated JSON exports. Map ids, source of truth, state, dependency, priority, artifact scope and resource constraint. Keep original ticket ids and ownership local. Do not copy body text into a global index, synthesize a parallel tracker, or rewrite lifecycle files. Connect readiness to receipt state and show unmet dependencies and cycles.

**Acceptance.** Read a shared tracker and two layouts of a private local work board. Select ready work with priority and dependencies intact. Report missing/duplicate ids, stale predecessor evidence and scoped resource conflicts. Snapshots for public sharing contain neither private filenames nor references. Run `node --test test/plan.test.mjs test/workgraph.test.mjs test/work-doors.test.mjs test/work-trust.test.mjs`.

### WK12 — Resume local work from current evidence and artifact ids

Use [handoff and resume](../../src/coordination/handoff.mjs) with an explicit local basis for stable project/worktree and artifact revisions. Resolve a capsule from a selected task, current permission/scope, dependencies, receipts, and applicable lease. Bind a capsule to the source of its observations and reopen only affected obligations after a change. Local editorial work needs no remote target incarnation. Handoff is a bounded local reference document, and resume revalidates against the repository before recommending work. Preserve the explicit document and remote-target forms.

**Acceptance.** Suspend one task, change one source, and resume in the same and a second worktree. Unaffected obligations retain evidence, stale ones reopen, and unavailable scope or expired lease reports a clear blocker. Capsules contain ids and digests with no transcripts or private source excerpts. Run `node --test test/work-handoff.test.mjs test/work-leases.test.mjs test/work-doors.test.mjs test/work-ledger.test.mjs`.

### WK13 — Import existing catalogues and exchange permitted offline data

Define a narrow versioned input for an existing search index or dependency export to contribute candidate ids, locations, links and revisions. Convert only supported data; compare its revision and permission to local declarations before reusing it. Keep built-in extraction available for repos without an exporter. Reuse [the bundle contract](../../src/knowledge/bundle.mjs) for explicit exchange and canonical import validation. Scope export to an operator-selected shareable set. Keep externally produced observations typed and linked to their basis.

**Acceptance.** Import a generic JSON catalogue from an independently generated index, compare results against local extraction, and preserve unsupported edges as unknown. Reject stale or wrong-project imports, and check that no denied/private item crosses an export boundary. Validate offline receipt expiry and duplicate imports. Run `node --test test/work-doors.test.mjs test/work-door-parity.test.mjs test/mcp-work.test.mjs test/work-trust.test.mjs`.

### WK14 — Turn stale evidence and repeated work into reviewed maintenance

Derive debt items from the same dated evidence, broken citations, missing derivations and pending review states. Reuse [debt ranking](../../src/knowledge/debt.mjs), [lessons](../../src/memory/lessons.mjs) and the [graduation policy](../../src/memory/graduation.mjs). Keep ranked backlog suggestions separate from the existing ticket authority. Offer a bounded proposal when verified local traces establish a reusable procedure or validator. Use the existing promotion rules and human review before changing canonical knowledge or repo policy.

**Acceptance.** A new source observation or broken citation gives a bounded actionable debt entry. A one-off or stale trace remains a candidate, and the validated independent traces create a reviewable proposal without writing canonical docs. Run `node --test test/knowledge-debt.test.mjs test/knowledge-derivations.test.mjs test/lessons.test.mjs test/work-graduation.test.mjs`.

### WK15 — Qualify local adoption, migrate incrementally, and publish support

Run the lifecycle below from an installed artifact and test incremental adoption beside an existing search/validation workflow. Cover an unconfigured repository, prior manually authored inputs and a partially configured project. Document the supported formats, precision limits, exact commands and safe rollback. Make it possible to remove the new configuration and local cache while retaining authored files. Confirm the release claim with recorded outcomes on the two fixture shapes and one maintainer-led local trial per shape. Report synthetic and real trial evidence separately.

**Acceptance.** Both fixtures and the opted-in trials get from a source question to a verified local change using the shipped guide. The guide describes remaining unknowns and rollback. Compare against the baseline using the release criteria below. Run `npm test` in an isolated checkout, `npm run lint`, `npm run verify:shipped`, and the doc/test checks for each included slice. If a distribution channel cannot be qualified, state the channel limit explicitly.

## Release acceptance and sequencing with existing work

- **First use.** Install in standalone clones without an estate, global agent config or live service. Enable one scope, open a primary citation, inspect a historical claim, run the applicable local validator and see a receipt tied to the change. Measure setup steps and time before raising the bar.
- **Evidence quality.** Freeze a labelled corpus before measuring. Include exact lookup, multilingual terms, same subject with a different scope, effective-date and knowledge-date differences, conflicts, missing sources, and a source edit that changes multiple outputs. Require correct disposition in every mandatory scope, privacy, temporal and negative-control fixture. Require top-five retrieval of the labelled source in at least 90% of lookup cases in **each** repository shape, with denominators reported. Compare with the fixture's existing lexical/search baseline and record regressions.
- **Change and continuity.** In each shape, change a source or procedure, surface affected outputs, select and run existing checks, record current evidence, resume an interrupted local task and reopen only invalidated obligations. Include error, incomplete/partial selection, and stale-evidence runs. An intentionally unsupported case must produce an actionable response.
- **Boundaries.** Assert zero network attempts with the local profile, no access to excluded paths, no remote dispatch, no operator scratch in exported/shared data, and no writes in preview. Prove deterministic output and an incremental rebuild equivalent to a clean rebuild. Record the host and data sizes used to measure cold and warm build and query latency.
- **Dependencies on existing plans.** [Plan 0005](0005-knowledge-doors-in-default-flows.md) is the starting integration. Reuse the fixes in [Review 0005](../reviews/0005-production-readiness.md) PR01/PR07/PR08 for setup writes, PR02/PR09 for manifest and root, PR04/PR05/PR14 for runner and evidence, PR19/PR20 for shared readers, PR21/PR22/PR26 for read/trust boundaries, and PR23 for index provenance. Coordinate shared files and write one fix per invariant. Prototype and validate the read-only corpus and query path in parallel. A shipping slice that uses one of these shared invariants requires its applicable fix or test evidence at integration.
