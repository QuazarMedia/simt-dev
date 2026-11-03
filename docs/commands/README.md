# Commands

Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.
Every path this binary dispatches is listed here, and nowhere else in the docs.

| Group | Commands |
| --- | --- |
| [agent-hook](agent-hook.md) | 1 |
| [agent-hooks](agent-hooks.md) | 2 |
| [agents](agents.md) | 2 |
| [bench](bench.md) | 8 |
| [brief](brief.md) | 1 |
| [check](check.md) | 1 |
| [workspace](workspace.md) | 4 |
| [completions](completions.md) | 1 |
| [decide](decide.md) | 2 |
| [distill](distill.md) | 1 |
| [docs](docs.md) | 1 |
| [doctor](doctor.md) | 1 |
| [evidence](evidence.md) | 2 |
| [explain](explain.md) | 1 |
| [gate](gate.md) | 1 |
| [graph](graph.md) | 1 |
| [harness](harness.md) | 2 |
| [hooks](hooks.md) | 3 |
| [ignore](ignore.md) | 1 |
| [impact](impact.md) | 1 |
| [index](index.md) | 1 |
| [init](init.md) | 1 |
| [lease](lease.md) | 1 |
| [lessons](lessons.md) | 3 |
| [local](local.md) | 1 |
| [map](map.md) | 1 |
| [mcp](mcp.md) | 1 |
| [pack](pack.md) | 3 |
| [plan](plan.md) | 5 |
| [plugin](plugin.md) | 1 |
| [pr-body](pr-body.md) | 1 |
| [review](review.md) | 1 |
| [rules](rules.md) | 4 |
| [skills](skills.md) | 8 |
| [slice](slice.md) | 3 |
| [status](status.md) | 1 |
| [sync](sync.md) | 1 |
| [tests](tests.md) | 1 |
| [tokens](tokens.md) | 1 |
| [undo](undo.md) | 1 |
| [why](why.md) | 1 |

## Every command

<!-- simt:commands:begin -->
<!-- Rendered from the spec by `simt docs commands --yes`; do not edit by hand. -->

```sh
# agent-hook
simt agent-hook <event> --harness                                      # the harness entry point: decide one tool call, or deliver the prompt packet

# agent-hooks
simt agent-hooks install --yes                                         # write this repository's policies into each harness hooks file
simt agent-hooks status                                                # what each harness will run, and what is not trusted yet

# agents
simt agents install --yes                                              # write the Simt-Agent into each harness agents file
simt agents status                                                     # what each harness carries, and what is not installed yet

# bench
simt bench ablate --yes                                                # measure one arm of the brief against its ablation
simt bench critic                                                      # score the review critic against the labelled bench set
simt bench export --yes                                                # write the sealed bench corpus as one signed document
simt bench import                                                      # verify a sealed corpus and load it into the vault
simt bench mine --yes                                                  # mine tasks out of a repository history
simt bench probes --yes                                                # run the deterministic probes against a workspace
simt bench report [--compare a b]                                      # summarise the runs recorded in the vault
simt bench run --yes                                                   # run agents against the mined tasks

# brief
simt brief "<task>"                                                    # the packet for a task: rules, skills and the files it names, within a budget

# check
simt check                                                             # report stale or missing generated regions and every check finding

# workspace
simt workspace compare                                                 # the adoption and drift matrix across every sibling repository
simt workspace install --yes                                           # carry those rules once per reader, at user level
simt workspace share                                                   # what repeated rules in a workspace cost to carry, and where they would go
simt workspace upgrade --yes                                           # replace this installation with the pinned release

# completions
simt completions <bash|zsh|fish>                                       # print a bash, zsh or fish completion script generated from this spec

# decide
simt decide lint                                                       # check every decision record for the structure a supersession needs
simt decide new "<title>" --yes                                        # scaffold a numbered decision record with its frontmatter

# distill
simt distill <skill|doc>                                               # turn a repository into a skill or rule proposal

# docs
simt docs commands                                                     # render the command reference in docs/commands from the spec

# doctor
simt doctor [--fix]                                                    # report what is wrong with this installation

# evidence
simt evidence                                                          # the runs recorded against the tree on disk
simt evidence check <msg-file>                                         # a commit message claiming a run this tree does not have

# explain
simt explain <CODE>                                                    # what one check finding code means, and how to fix it

# gate
simt gate --changed                                                    # the tests a change reaches, and only those

# graph
simt graph lint [--spec agentskills]                                   # check the skill registry against the skills on disk

# harness
simt harness detect [--user]                                           # which harness is installed, and what it carries
simt harness loaders [--table]                                         # the instruction files each harness loads, and what they cost

# hooks
simt hooks install --yes                                               # install the shared dispatcher; --agent writes each harness hooks file
simt hooks run <event>                                                 # run one git event's gates now, as git would
simt hooks status                                                      # what each git event routes to; --agent reports each harness instead

# ignore
simt ignore [--yes] [--diff]                                           # render the one ignore list into every harness ignore file

# impact
simt impact <file|symbol>                                              # who a change reaches: importers, their tests and the contract

# index
simt index [--embed]                                                   # rebuild the local file index from git blob hashes

# init
simt init [path]                                                       # adopt this repository: manifest, region, hooks, agents and agent-hooks

# lease
simt lease [<paths>] --session                                         # claim files for one session, or list the claims

# lessons
simt lessons capture                                                   # scan the ledger and history for new lesson candidates
simt lessons list                                                      # deterministic lesson candidates and the promoted lessons
simt lessons review <id> --yes                                         # promote one lesson candidate into docs/lessons

# local
simt local doctor [--allow-remote]                                     # the local model endpoints, and whether they answer

# map
simt map --task "<task>"                                               # the files a task is most likely to touch, within a byte budget

# mcp
simt mcp [--list]                                                      # serve the read-only MCP surface over stdio

# pack
simt pack lint [dir] [--require-measured]                              # lint a rule pack in the working directory
simt pack new <name> --source <spec>                                   # scaffold a rule pack
simt pack publish [dir] --yes                                          # publish a rule pack

# plan
simt plan archive <id>                                                 # close a finished plan or review and move it to its archive/ directory
simt plan done <id> [<sha>] --yes                                      # mark one tracker row complete, with its SHA and its evidence
simt plan labels                                                       # the header each tracker column matched, and the labels this repository configured
simt plan next [<id>] [--tier <name>] [--wave <name>] [--lane <name>]  # one ready slice's section, or the one named, inside a tier, a wave or a lane
simt plan status                                                       # count the tracker rows, the share of the plan done, and its tiers, waves and lanes

# plugin
simt plugin <claude|gemini|cursor|opencode>                            # generate a harness package from the same tables the hooks use

# pr-body
simt pr-body [--base <ref>]                                            # the pull request body: evidence, decisions, gate state and residual risk

# review
simt review [--local]                                                  # review the staged diff against the estate rules

# rules
simt rules decisions                                                   # every known decision, and which layer each came from
simt rules list [--root <path>]                                        # the rule catalogue, marked with what applies to this repository
simt rules show <id>                                                   # one rule body
simt rules why <id|ADR-NNN> [--all]                                    # the decision that settled a rule, and whether it is still in force

# skills
simt skills brief --task "<task>"                                      # the packet for a task, read from the skill registry
simt skills compile [<name>]                                           # compile a skill to the Agent Skills standard
simt skills eval [corpus]                                              # score the skill registry against transcripts
simt skills find <query>                                               # skills that match a query
simt skills index                                                      # rebuild the skill index
simt skills install <name> --yes                                       # install skills into the workspace
simt skills show <name>                                                # one skill packet
simt skills why <name>                                                 # which skill covers a task

# slice
simt slice abandon <id> --yes                                          # remove a slice worktree, delete its branch, and return the row
simt slice finish <id> --yes                                           # run the gates, commit the slice and record its evidence
simt slice start <id> --yes  |  -- "<text>"                            # give a slice its worktree, branch and brief; -- starts one from a prompt, no row

# status
simt status [--line]                                                   # the repository snapshot, or one line of the last check

# sync
simt sync --yes                                                        # re-render the generated regions from the rule content

# tests
simt tests <path> [--cochange]  |  --run [--changed]                   # the tests that exercise a file, or - with --run - the ones a change reaches

# tokens
simt tokens [--repos] [--session]                                      # count tokens per instruction file and per skill

# undo
simt undo --yes                                                        # restore the last journaled set of writes, if untouched

# why
simt why [<subject>]                                                   # what governs a path, rule, decision, skill or finding code
```
<!-- simt:commands:end -->
