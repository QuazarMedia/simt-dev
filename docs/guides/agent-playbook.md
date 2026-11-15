# Agent playbook: how and when to use each module

An agent working in an adopted repository should use `simt` as its primary orientation,
retrieval, validation and memory layer rather than scanning the tree by hand. Every
read-only command supports `--json` (and `--max-bytes <n>`) or can be called over stdio
through `simt mcp`.

## Decision tree: which command to run when

| Situation | First command | If you need more |
| --- | --- | --- |
| New task, no context yet | `simt brief "<task>"` | `simt map --task "<task>"` for broader file ranking |
| About to edit a file | `simt why <file>` | `simt impact <file>` for blast radius |
| Need to know what tests to run | `simt tests <file>` | `simt gate --changed` to run them |
| Rule violation or error | `simt lessons list` | `simt rules why <rule-id>` for the decision |
| Working from a plan | `simt plan next` | `--tier <class>` / `--wave <name>` / `--lane <name>` to stay inside one; `simt plan done <id> <sha> --yes` when finished |
| Before committing | `simt check` | `simt evidence` to verify test claims |
| Opening a pull request | `simt pr-body` | `--base <ref>` to diff against another fork point |
| Repository adoption | `simt init --yes` | `simt doctor` to verify stack detection |
| Multi-repo workspace | `simt compare` | `simt shared plan` to find deduplication opportunities |
| Local model available | `simt local doctor` | `simt index --embed` to build vector embeddings |

## 1. Start of task — orient in one call instead of broad exploration

1. **Assemble the task packet first.** Run `simt brief "<task>"` (or call MCP `brief`, or
   read the packet injected automatically when `agent-hooks install --yes` wired
   `prompt-submit`). Within `--budget 2048` bytes (pass `--budget 0` for unlimited or
   `--explain` to see why items were kept or cut), the packet gives:
   - `TASK`: the classified task kind (`bugfix`, `feature`, `refactor`, `test`, `docs`,
     `config`) and the evidence behind it.
   - `COMMANDS`: the exact `build`, `test`, `lint`, `format`, `typecheck`, and focused
     test templates for this repository.
   - `LIKELY FILES`: top files ranked by reciprocal-rank fusion (`RRF_K = 40`) across
     SQLite FTS5 `bm25()`, PageRank graph proximity, and resolver signals.
   - `TESTS`: the test files mapped to those likely files.
   - `DECISIONS`, `SKILLS`, `LESSONS`, `CAUTIONS`, and `FEDERATION`: governing ADRs,
     matched skills, promoted lessons for those paths, active worktree/hook cautions, and
     any structural answer from a declared external code-graph server.
2. **Pull the next tracker slice when working from a plan.** Instead of reading a multi-thousand-line
   plan in `docs/plans/` or `docs/reviews/`, run `simt plan next` (or MCP `plan_next`) to
   load only the next queued slice (~1 KB) whose dependencies are already `Complete` or
   `Accepted`. Add `--tier <class>`, `--wave <name>` or `--lane <name>` to keep the answer
   inside one class, one wave or one subsystem; a filter that matches nothing says so
   rather than answering from the whole tracker. `simt plan status` reports how much of
   each tracker is done and what remains.

**When to use `--json` format.** When piping output to other tools or when the agent needs
structured data, add `--json` to any read-only command. For example, `simt brief "<task>" --json`
returns a JSON object with `task`, `commands`, `files`, `tests`, `decisions`, `skills`,
`lessons`, `cautions`, and `federation` fields that can be programmatically consumed.

## 2. Before editing — query the graph, blast radius, and governance

1. **Rank files or symbols at the right granularity.** When `brief`'s file list is too
   narrow or the task evolves, run `simt map --task "<task>" --level outline` for paths,
   `--level names` for exported symbols, or `--level signatures` for declaration lines.
   Pass `--embed` when `local.embed` is configured in `simt.json` and clears the +10-point
   recall@10 bar.
2. **Check blast radius before changing a shared file or export.** Run
   `simt impact <file|symbol>` to see every direct and transitive importer, the tests
   covering them, the governing rules and ADRs, and any sibling repository in the
   workspace that imports that symbol.
3. **Read the governance on a path before changing its behaviour.** Run `simt why <path>`
   to list every ADR whose `simt-affects` matches the file, every scoped rule, skill,
   gate, and promoted lesson. Run `simt why` with no path to audit the repository for
   `UNRESOLVED-AFFECTS` tokens.
4. **Resolve deferred rules and citations on demand.** When `simt.json` sets
   `"mode": "kernel"`, only `hard` and `command` rules are loaded at session start;
   `convention` and `style` rules are listed by ID at the foot of the projection. Fetch a
   deferred rule with `simt rules show <id>`, and read any cited `ADR-NNN` with
   `simt rules why ADR-NNN` (or MCP `rules_why`) to see its rulings and whether any ruling
   was superseded or narrowed.
5. **Load skills progressively (Tier 0 → Tier 1 → Tier 2).** Never read every skill file
   upfront:
   - Tier 0: `simt skills index` (or MCP `skills_index`) lists one line per skill.
   - Tier 1: `simt skills brief --task "<task>"` (or MCP `skills_brief`) ranks compatible
     skills within budget (`--plan` emits a fetch plan without bodies).
   - Tier 2: `simt skills show <name> --max-bytes 8192` (or MCP `skills_show`) loads only
     the chosen skill's body.

**Optimal retrieval strategy.** For best performance, use this sequence:
1. `simt brief "<task>"` — gets the most relevant files and tests in one call
2. If more files are needed, `simt map --task "<task>" --level outline` — broader ranking
3. If you need to understand a specific file's impact, `simt impact <file>` — blast radius
4. If you need to understand governance, `simt why <file>` — ADRs and rules

6. **Review an operation before it runs.** Ask for the bundle instead of the transcript:
   `simt action review --input <bundle.json>` (MCP `action_review`) names the contract, the
   semantic delta, the target incarnation, the authorization and the postconditions, and says
   which check is still missing. An adapter descriptor is validated as data with
   `simt adapter check --input <descriptor.json>` (MCP `adapter_check`), which keeps
   observe-only apart from execute. Neither runs the operation, and an untrusted descriptor is
   refused before anything could.
## 3. During implementation — validate incrementally under dual gates

1. **Keep the local index current.** After adding, renaming, or changing exports/imports,
   run `simt index`. It hashes tracked blobs via `git ls-files --stage` and re-extracts
   only changed files in under 300 ms.
2. **Run only the tests your change reaches.** Use `simt tests <path>` to inspect which
   tests cover a file (via import edges, naming conventions, or coverage records; add
   `--cochange` to include historical co-change pairs). Run `simt gate --changed` (or
   `simt gate <path...>`) to execute only the tests reachable from the diff, with gate
   output compacted so every failure line survives while passing noise is trimmed.
3. **Respect agent-time hooks and learn from failures.** With `simt agent-hooks install --yes`,
   `pre-tool-use` blocks unapproved `git push`, history rewrites (`--no-verify`,
   `--amend`, `reset --hard`, `rebase`), and direct edits to generated regions before the
   tool executes. When a test or gate fails, `post-tool-use` hashes the normalised first
   error line against `docs/lessons/*.md` and injects the matching lesson into context.

**Incremental validation workflow.** After each meaningful code change:
1. Run `simt tests <changed-file>` to see which tests cover your changes
2. Run `simt gate --changed` to execute only the affected tests
3. If a test fails, check `simt lessons list` for known issues and their remedies
4. If the failure is new, fix it and consider promoting the lesson with `simt lessons review <id> --yes`

## 4. Before committing and closing a slice — verify drift, evidence, and memory

1. **Run the repository gate.** Run `simt check` (or MCP `check`). Fix any reported
   `DRIFT` with `simt sync --yes`, and resolve any rule checker or manifest findings.
2. **Verify execution evidence matches the current tree.** Run `simt evidence` to confirm
   that the tests and gates you plan to cite were recorded against the current
   `git write-tree` digest in `.simt/ledger.jsonl`. Any file edit invalidates earlier
   evidence.    `simt evidence validate --input <evidence.json>` (MCP `evidence_validate`) checks a claim's
   state and its chain of custody, and `simt verify status --input <closure.json>` (MCP
   `verify_status`) closes recorded obligations without turning an unreachable verifier into a
   pass.
3. **Record decisions, lessons, and tracker state:**
   - If the change alters what the repository or tool believes, scaffold an ADR with
     `simt decide "<title>" [--supersedes ADR-NNN[:<ruling>]] --yes`.
   - If a failing gate or test was fixed during the session, inspect captured candidates
     with `simt lessons list` and promote reusable ones with
     `simt lessons review <id> --yes`.
   - After committing locally (never push without explicit approval per `ADR-001`), close
     the tracker slice with `simt plan done <id> <sha> --test "<cmd>" --yes`.

**Pre-commit checklist.** Before committing, run this sequence:
1. `simt check` — verify no drift and all rules pass
2. `simt evidence` — confirm test runs are recorded against current tree
3. `simt lessons list` — check for any unreviewed lesson candidates
4. `git commit` — commit locally (never push without explicit approval)
5. `simt plan done <id> <sha> --yes` — close the tracker slice if working from a plan

## 5. When the task is about knowledge, work or proof itself

These doors answer from a JSON document passed with `--input`, and the matching MCP tool takes
the same document as an object. They report; they do not mutate.

- **Knowledge.** `simt knowledge rank`, `impact`, `derivations`, `debt` and `sections` rank
  evidence units, trace typed edges, name what a source change puts in question, order stale
  knowledge by consequence per effort, and split a long document into retrievable units.
- **Work.** `simt work inspect` describes what the repository's work consists of;
  `simt work schedule`, `handoff`, `resume` and `graduate` sequence ready tasks, build a resume
  capsule, revalidate it, and decide whether repeated traces can become a procedure.
- **Proof.** `simt work packet --input <packet.json>` (MCP `work_packet`) returns the packet
  with uncited units rejected rather than trimmed. `simt verify contracts`, `documents` and
  `procedures` check obligation results, a generated document, and a procedure's imports and
  prerequisites.
- **Discovery.** `simt lessons discover --input <candidates.json>` deduplicates candidates and
  reports the authority each has earned.
- **Retrieval.** `simt index --search "<task>"` and `--rank "<task>"` answer from the open
  cache; `simt index --open` reports its counts and staleness without rebuilding it.
