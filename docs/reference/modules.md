# Module and MCP reference

| Module | CLI commands | Read-only MCP tools | When an agent should use it |
| --- | --- | --- | --- |
| **Task Brief** | `simt brief "<task>" [--budget <n>] [--explain]` | `brief` | First call on every task to get task kind, commands, ranked files, tests, ADRs, skills, and lessons in <= 2 KB |
| **Code Graph & Retrieval** | `simt index`, `simt map`, `simt impact`, `simt tests`, `simt gate` | `federation_query` | Before editing to rank files (`map`), trace blast radius (`impact`), or run only diff-affected tests (`gate --changed`) |
| **Governance & Provenance** | `simt why [path]`, `simt rules list`, `simt rules show <id>`, `simt rules why <id\|ADR-NNN>`, `simt decide` | `rules_list`, `rules_why` | Before touching governed files (`why`), when reading deferred kernel rules (`rules show`), or when checking/scaffolding ADRs (`rules why`, `decide`) |
| **Skills & Disclosure** | `simt skills index`, `brief`, `show`, `why`, `find`, `install`, `compile`, `eval`, `simt graph lint` | `skills_index`, `skills_find`, `skills_brief`, `skills_show`, `skills_why` | When a task requires domain workflows or reference docs without blowing the session token budget |
| **Memory & Lessons** | `simt lessons list`, `simt lessons review <id> --yes` | — | After fixing a failing test/gate or hitting a hook denial, to inspect or promote reusable failure-to-fix lessons |
| **Plans & Trackers** | `simt plan status`, `simt plan next [<id>]`, `simt plan done <id> [<sha>] --yes`, `simt slice start`, `finish <id>`, `simt lease`, `simt pr-body`, `simt status --line`, `simt undo` | `plan_next`, `plan_done`, `pr_body` | When executing a phased implementation or review plan row by row |
| **Adoption & Projection** | `simt init`, `simt doctor`, `simt check`, `simt sync`, `simt upgrade` | `doctor`, `check` | When adopting a repo, diagnosing stack/config health, or verifying zero drift before commit |
| **Dual Gates & Evidence** | `simt hooks install`, `status`, `run`, `simt agent-hooks install`, `status`, `simt agent-hook`, `simt evidence [check]` | — | When installing git/agent hooks, running gates manually, or verifying test claims before committing |
| **Context & Harnesses** | `simt tokens`, `simt harness detect`, `loaders`, `simt shared plan`, `install` | — | When auditing startup token cost across harnesses (`claude`, `codex`, `cursor`, `opencode`, `antigravity`, `copilot`, `deepseek`) or deduplicating workspace rules |
| **Workspace & Benchmarks** | `simt compare`, `simt bench mine`, `run`, `report`, `ablate`, `probes`, `simt local doctor`, `simt review [--local]`, `simt distill` | `compare` | When auditing an entire multi-repo estate, measuring rule uplift/cost, or probing local model endpoints |

The command names and their flags are generated in [../commands/index.md](../commands/index.md);
this table is the shape of the surface, not its contract.
