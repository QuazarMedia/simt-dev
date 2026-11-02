# MCP surface

`simt mcp` serves JSON-RPC over stdio. The surface is read-only: a tool answers from the same
functions the commands call, and a flag absent from a tool's allowlist is not reachable
through it. `simt mcp --list` prints the surface without reading stdin.

| Tool | Answers |
| --- | --- |
| `brief` | the task packet: rules, skills and the files a task names, within a budget |
| `check` | stale or missing regions, and every check finding |
| `compare` | the adoption and drift matrix across a workspace |
| `doctor` | what is wrong with this installation |
| `federation_query` | one bounded structural question to a declared external code-graph server |
| `plan_next` | one ready tracker slice, or the one named |
| `plan_done` | a tracker row marked complete with its SHA and evidence |
| `pr_body` | the pull request body: evidence, decisions, gate state, residual risk |
| `rules_list` | the rule catalogue, marked with what applies here |
| `rules_why` | the decision that settled a rule, and whether it is still in force |
| `skills_brief` | the packet for a task, read from the skill registry |
| `skills_find` | skills that match a query |
| `skills_index` | the skill index |
| `skills_show` | one skill packet |
| `skills_why` | which skill covers a task |

Two prompts (`simt-brief`, `simt-slice`) and two resources (`rules`, `decisions`) sit beside
the tools. A prompt is a template the client renders; a resource is a document it can attach.
Neither writes.

The tool list is declared on the command spec (`mcp: { name, flags }` on a row), so a tool and
its command cannot disagree about which flags exist. `test/mcp*.test.mjs` holds the list
against the spec.
