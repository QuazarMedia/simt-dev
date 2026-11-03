# MCP surface

`simt mcp` serves JSON-RPC over stdio. The surface is read-only: a tool answers from the same
functions the commands call, and a flag absent from a tool's allowlist is not reachable
through it. `simt mcp --list` prints the surface without reading stdin.

| Tool | Answers |
| --- | --- |
| `action_review` | A review bundle before execution: contract, semantic delta, target incarnation, authorization and postconditions, with the checks still missing. |
| `action_status` | Where an operation stands from its journal: the state, whether it is resumable, whether an effect may be in flight, the recovery the state permits, the recorded authorization, and the guarantee the adapter can promise. |
| `adapter_check` | Validate adapter descriptors as data: interfaces, capability and side effects, with observe-only kept apart from execute. Nothing is loaded or run. |
| `brief` | The packet for one task in prompt-sized bytes: kind, commands, files, tests, decisions, skills. With no task it describes the repository. |
| `check` | The gate for one repository: region current, unmanaged, drifted or malformed, and rule files lacking an id. Read-only - it never repairs. |
| `compare` | The workspace matrix: adoption, region, SHA, hooks and gates per repo, plus problems. Pages with limit/cursor; honors progressToken and cancellation. |
| `doctor` | Classify a repository: stack tags, the facts with the file that proved each, and manifest presence. Call this first when the repo is unknown. Read-only: `--fix` and `--diff` stay on the command. |
| `evidence_validate` | Validate a ledger evidence record against a tree, target and obligations, and report the chain of custody behind it. |
| `federation_query` | Ask a declared code-graph server one structural question; the answer names the server. Starts only servers simt.json names; none declared is an error. |
| `index_overlay` | A working-tree or staged index node labelled by the provenance its revision proves, with the artifact obligations it carries. |
| `knowledge_export` | A bounded, permission-filtered packet another repository can read offline; restricted facts are dropped before the page is cut. |
| `knowledge_import` | Validate an exported packet as data: schema, version, expiry and revision digests. It executes nothing and treats every fact as text. |
| `knowledge_why` | Why a claim is held: what it derives from, what depends on it, the conflicts that mention it, and its validity window. Reads declared claims only, so a clean scan certifies nothing. |
| `lessons_discover` | Deduplicate discovery candidates by proposition and scope, and report the authority each one has actually earned. |
| `plan_done` | Preview the one-row rewrite for a slice. The write stays on the plan done command, behind --yes. |
| `plan_next` | The next queued slice whose dependencies are complete; its design section only. Pass id for one slice whether or not it is ready. |
| `pr_body` | The pull request body: ledger evidence for this tree, the decisions the diff touches, gate state, and the ADR-008 verdict with what was not reviewed. |
| `rules_list` | The rule catalogue, and which rules a repository actually receives. Pass root for the selection, not just the catalogue. |
| `rules_why` | Why a rule exists: a rule id for the decisions that settled it, or an ADR id for the rules that repeat it. An uncited rule is a finding, reported so. |
| `skills_brief` | THE entry point. Resolve the skill set for a task: selected with why, deferred, and not selected with the reason to override. |
| `skills_find` | Raw search across capability, keyword and summary. Use when skills_brief has nothing and you suspect a skill exists. |
| `skills_index` | Full skill catalogue: every skill with summary, size, stack tags and deferred flag. The fallback when brief returns nothing useful. |
| `skills_show` | One skill body and the metadata needed to judge it: source path, the location it was read from, and its cited decisions. |
| `skills_why` | The signal chain for one skill in one repository: its score, the reasons, whether the stack gate admits it, and what would select it. |
| `verify_contracts` | Evaluate obligations against observations, keeping pass, fail, unknown, unavailable, not-run and waived apart from a review verdict. |
| `verify_documents` | Check a generated document against its pinned template, required sections, source scope and declared representation. |
| `verify_plan` | The next observation worth making: which declared capability discharges the most unmet obligation inside the stated constraints, and why it stops when nothing admissible remains. Suggests only; executes nothing. |
| `verify_procedures` | Check procedures for missing imports, calls to undeclared procedures, and flag prerequisites no environment can satisfy. |
| `verify_select` | The narrowest checks that prove a change: mandatory first, then cover by cost, with independence kept and unverified said out loud. |
| `verify_status` | Closure over recorded obligations: the verdict, what is unresolved and why. An unreachable verifier is never a pass, and a remote-scope closure needs its reviewed contract. |
| `work_inspect` | What a repository work consists of: artifact kinds, activities, execution loci, and five validation capabilities that keep declared, available and authorized apart. Derived from paths and the manifest; nothing is executed. |
| `work_packet` | The proof-bearing task packet: mandatory units kept, citations required, and an over-budget packet reported as incomplete rather than trimmed. |

Two prompts (`simt-brief`, `simt-slice`) and two resources (`rules`, `decisions`) sit beside
the tools. A prompt is a template the client renders; a resource is a document it can attach.
Neither writes.

The tool list is declared on the command spec (`mcp: { name, flags }` on a row), so a tool and
its command cannot disagree about which flags exist. `test/mcp*.test.mjs` holds the list
against the spec, and `test/docs.test.mjs` holds this page against the list.
