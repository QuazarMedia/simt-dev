# Commands

Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.
Every path this binary dispatches is listed here, and nowhere else in the docs.

| Group | Commands |
| --- | --- |
| [action](action.md) | 2 |
| [agent-hook](agent-hook.md) | 1 |
| [agent-hooks](agent-hooks.md) | 3 |
| [agents](agents.md) | 2 |
| [bench](bench.md) | 13 |
| [brief](brief.md) | 1 |
| [check](check.md) | 1 |
| [work](work.md) | 6 |
| [workspace](workspace.md) | 4 |
| [completions](completions.md) | 1 |
| [decide](decide.md) | 2 |
| [distill](distill.md) | 1 |
| [docs](docs.md) | 1 |
| [doctor](doctor.md) | 1 |
| [evidence](evidence.md) | 3 |
| [explain](explain.md) | 1 |
| [gate](gate.md) | 1 |
| [graph](graph.md) | 1 |
| [harness](harness.md) | 2 |
| [hooks](hooks.md) | 3 |
| [ignore](ignore.md) | 1 |
| [impact](impact.md) | 1 |
| [index](index.md) | 2 |
| [init](init.md) | 1 |
| [knowledge](knowledge.md) | 8 |
| [adapter](adapter.md) | 1 |
| [verify](verify.md) | 6 |
| [lessons](lessons.md) | 4 |
| [lease](lease.md) | 1 |
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
# action
simt action review --input <file>                                         # a reviewable bundle of contract, delta, target, authorization and postconditions
simt action status --journal <file>                                       # where an operation stands from its journal, and what the state permits next

# agent-hook
simt agent-hook <event> --harness                                         # the harness entry point: decide one tool call, or deliver the prompt packet

# agent-hooks
simt agent-hooks explain --harness <id> [--payload <file>] [--mediated]   # what one harness payload is in the policy table terms, and how the boundary would judge it
simt agent-hooks install --yes                                            # write this repository's policies into each harness hooks file
simt agent-hooks status                                                   # what each harness will run, and what is not trusted yet

# agents
simt agents install --yes                                                 # write the Simt-Agent into each harness agents file
simt agents status                                                        # what each harness carries, and what is not installed yet

# bench
simt bench ablate --yes                                                   # measure one arm of the brief against its ablation
simt bench calibrate --input <file>                                       # false-accept rate against expert labels, and the autonomy it does or does not justify
simt bench compat --input <file>                                          # compare two baselines, or audit the predecessor document
simt bench corpus --input <file>                                          # the stratified canary corpus, with gold, noop and wrong graded apart
simt bench critic                                                         # score the review critic against the labelled bench set
simt bench export --yes                                                   # write the sealed bench corpus as one signed document
simt bench import                                                         # verify a sealed corpus and load it into the vault
simt bench mine --yes                                                     # mine tasks out of a repository history
simt bench probes --yes                                                   # run the deterministic probes against a workspace
simt bench replay --input <file>                                          # counterfactual replay: did an irrelevant change move the outcome?
simt bench report [--compare a b]                                         # summarise the runs recorded in the vault
simt bench run --yes                                                      # run agents against the mined tasks
simt bench world --input <file>                                           # run the seeded world model and ask the oracle what the effects should be

# brief
simt brief "<task>"                                                       # the packet for a task: rules, skills and the files it names, within a budget

# check
simt check                                                                # report stale or missing generated regions and every check finding

# work
simt work graduate --input <file>                                         # whether repeated traces can be proposed as a procedure, and what still blocks it
simt work handoff --input <file>                                          # build a resume capsule from ids and provenance, never from a transcript
simt work inspect                                                         # what this repository's work consists of, and which validations are actually available
simt work packet --input <file>                                           # the proof-bearing task packet, inside its byte budget or explicitly incomplete
simt work resume --input <file>                                           # revalidate permission, target, dependencies, authorization and lease before reuse
simt work schedule --input <file>                                         # which ready tasks can run together under capacity and resource constraints

# workspace
simt workspace compare                                                    # the adoption and drift matrix across every sibling repository
simt workspace install --yes                                              # carry those rules once per reader, at user level
simt workspace share                                                      # what repeated rules in a workspace cost to carry, and where they would go
simt workspace upgrade --yes                                              # replace this installation with the pinned release

# completions
simt completions <bash|zsh|fish>                                          # print a bash, zsh or fish completion script generated from this spec

# decide
simt decide lint                                                          # check every decision record for the structure a supersession needs
simt decide new "<title>" --yes                                           # scaffold a numbered decision record with its frontmatter

# distill
simt distill <skill|doc>                                                  # turn a repository into a skill or rule proposal

# docs
simt docs commands                                                        # render the command reference in docs/commands from the spec

# doctor
simt doctor [--fix]                                                       # report what is wrong with this installation

# evidence
simt evidence                                                             # the runs recorded against the tree on disk
simt evidence check <msg-file>                                            # a commit message claiming a run this tree does not have
simt evidence validate --input <file>                                     # validate ledger evidence and the chain of custody behind it

# explain
simt explain <CODE>                                                       # what one check finding code means, and how to fix it

# gate
simt gate --changed                                                       # the tests a change reaches over the import closure, and only those

# graph
simt graph lint [--spec agentskills]                                      # check the skill registry against the skills on disk

# harness
simt harness detect [--user]                                              # which harness is installed, and what it carries
simt harness loaders [--table]                                            # the instruction files each harness loads, and what they cost

# hooks
simt hooks install --yes                                                  # install the shared dispatcher; --agent writes each harness hooks file
simt hooks run <event>                                                    # run one git event's gates now, as git would
simt hooks status                                                         # what each git event routes to; --agent reports each harness instead

# ignore
simt ignore [--yes] [--diff]                                              # render the one ignore list into every harness ignore file

# impact
simt impact <file|symbol>                                                 # who a change reaches over the import closure: importers, their tests and the contract

# index
simt index [--open] [--search <task>] [--embed]                           # rebuild the index, or ask the open cache for rows and ranks
simt index overlay --input <file>                                         # a working-tree or staged node labelled by its provenance, never both

# init
simt init [path]                                                          # adopt this repository: manifest, region, hooks, agents and agent-hooks

# knowledge
simt knowledge debt --input <file>                                        # rank stale and unsupported knowledge by consequence per effort
simt knowledge derivations --input <file>                                 # which outputs a source, template or skill change puts in question
simt knowledge export --input <file>                                      # a bounded, permission-filtered packet another repository can read offline
simt knowledge impact --input <file> --refs <ids>                         # what a change reaches over typed edges, and where the graph is unknown
simt knowledge import --input <file>                                      # validate an exported packet as data, and never execute it
simt knowledge rank --input <file> --query "<question>"                   # rank evidence units by authority and quality, and report what was excluded
simt knowledge sections <file.md>                                         # the retrieval units a long document yields, with anchors and byte ranges
simt knowledge why <claim-id> --claims <file> [--limit <n>] [--page <n>]  # what a claim derives from, what depends on it, what applied at a date, and where it conflicts

# adapter
simt adapter check --input <file>                                         # validate adapter descriptors as data, and separate observe-only from execute

# verify
simt verify contracts --input <file>                                      # evaluate obligations against observations, with the result states kept apart
simt verify documents --input <file>                                      # check a generated document against its template, sections and source scope
simt verify plan --input <file>                                           # the next observation worth making, and the point at which there is not one
simt verify procedures --input <file>                                     # check procedures for missing imports, calls and impossible prerequisites
simt verify select --input <file>                                         # the narrowest checks that prove a change, and whether a Git hook may run them
simt verify status --input <file>                                         # closure over recorded obligations, and what is unresolved

# lessons
simt lessons capture                                                      # scan the ledger and history for new lesson candidates
simt lessons discover --input <file>                                      # deduplicate discovery candidates and report their authority
simt lessons list                                                         # deterministic lesson candidates and the promoted lessons
simt lessons review <id> --yes                                            # promote one lesson candidate into docs/lessons

# lease
simt lease [<paths>] --session                                            # claim files for one session, or list the claims

# local
simt local doctor [--allow-remote]                                        # the local model endpoints, and whether they answer

# map
simt map --task "<task>"                                                  # the files a task is most likely to touch, within a byte budget

# mcp
simt mcp [--list]                                                         # serve the read-only MCP surface over stdio

# pack
simt pack lint [dir] [--require-measured]                                 # lint a rule pack in the working directory
simt pack new <name> --source <spec>                                      # scaffold a rule pack
simt pack publish [dir] --yes                                             # publish a rule pack

# plan
simt plan archive <id>                                                    # close a finished plan or review and move it to its archive/ directory
simt plan done <id> [<sha>] --yes                                         # mark one tracker row complete, with its SHA and its evidence
simt plan labels                                                          # the header each tracker column matched, and the labels this repository configured
simt plan next [<id>] [--tier <name>] [--wave <name>] [--lane <name>]     # one ready slice's section, or the one named, inside a tier, a wave or a lane
simt plan status                                                          # count the tracker rows, the share of the plan done, and its tiers, waves and lanes

# plugin
simt plugin <claude|gemini|cursor|opencode>                               # generate a harness package from the same tables the hooks use

# pr-body
simt pr-body [--base <ref>]                                               # the pull request body: evidence, decisions, gate state and residual risk

# review
simt review [--local]                                                     # review the staged diff against the estate rules

# rules
simt rules decisions                                                      # every known decision, and which layer each came from
simt rules list [--root <path>]                                           # the rule catalogue, marked with what applies to this repository
simt rules show <id>                                                      # one rule body
simt rules why <id|ADR-NNN> [--all]                                       # the decision that settled a rule, and whether it is still in force

# skills
simt skills brief --task "<task>"                                         # the packet for a task, read from the skill registry
simt skills compile [<name>]                                              # compile a skill to the Agent Skills standard
simt skills eval [corpus]                                                 # score the skill registry against transcripts
simt skills find <query>                                                  # skills that match a query
simt skills index                                                         # rebuild the skill index
simt skills install <name> --yes                                          # install skills into the workspace
simt skills show <name>                                                   # one skill packet
simt skills why <name>                                                    # which skill covers a task

# slice
simt slice abandon <id> --yes                                             # remove a slice worktree, delete its branch, and return the row
simt slice finish <id> --yes                                              # run the gates, commit the slice and record its evidence
simt slice start <id> --yes  |  -- "<text>"                               # give a slice its worktree, branch and brief; -- starts one from a prompt, no row

# status
simt status [--line]                                                      # the repository snapshot, or one line of the last check

# sync
simt sync --yes                                                           # re-render the generated regions from the rule content

# tests
simt tests <path> [--cochange]  |  --run [--changed]                      # the stored test edges that exercise a file; --run asks the gate instead

# tokens
simt tokens [--repos] [--session]                                         # count tokens per instruction file and per skill

# undo
simt undo --yes                                                           # restore the last journaled set of writes, if untouched

# why
simt why [<subject>]                                                      # what governs a path, rule, decision, skill or finding code
```
<!-- simt:commands:end -->
