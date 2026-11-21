# Supported surface and deprecations

Rendered from `src/surface.mjs` by `simt docs commands --yes`; do not edit by hand.
Every dispatchable path resolves to exactly one disposition, and the test that holds this
page to the module fails when a new group, export or tool is left unclassified.

The vocabulary is exactly `stable`, `optional`, `prototype`, `experimental`: a stability
promise, a shipping decision, a prototype without one, and a frozen experimental surface.

## Dispositions

| Surface | Stability | Owner | Consumer | What the word means here |
| --- | --- | --- | --- | --- |
| `adoption` | stable | adoption | a repository adopting the tool, and the agent working in it | the path this review is about: init, projection, gates, hooks, evidence, index, brief |
| `workspace-sharing` | stable | workspace | a maintainer carrying rules once for a workspace of repositories | the user-level half of the workspace surface (ADR-084); an alias spelling stays supported |
| `bench` | optional | bench | maintainers measuring brief quality against their own corpus | shipped because its fixtures are the measurement; not needed to adopt or run the gates |
| `pack` | experimental | packs | rule-pack authors, once a repository vendors one | frozen until a real repository adopts a pack (ADR-130); local profiles are the supported route, and `pack migrate` moves a pinned pack onto them |
| `distill` | optional | distill | a maintainer turning a repository into a skill or rule proposal | one command, proposal output only; it writes no rule into a projected region |
| `plugin` | optional | distribution | a harness vendor packaging the same tables this repository ships | generates a harness package; the shipped artefacts are qualified by the packaging tests |
| `local-models` | optional | local | an operator pointing at a loopback model endpoint | off unless configured; bounded by ADR-075 and ADR-204 |
| `work` | prototype | work | a design partner sequencing work from documents | document-driven doors; `work inspect` and `work setup` are the usable half and ship in the core path |
| `action` | prototype | action | an execution runner reading a journal | read and review only; no command here starts an operation |
| `verify` | prototype | verification | a maintainer validating contracts, documents or procedures | the read doors (`verify plan`, `verify select`, `verify status`) are used by the core path; the validators are prototypes |
| `knowledge` | prototype | knowledge | a repository exchanging a scoped corpus with another | declared-scope reads are stable in behaviour; the exchange format is a prototype |
| `federation` | optional | federation | an MCP client asking a declared sibling repository | transport-only, user-allowlisted, and the only tool that may start a process (ADR-205) |
| `aliases` | stable | compatibility | a script written against an earlier name | every merged spelling resolves to its path and stays until the next major; an alias adds no capability |

## The surfaces this review named

| Surface | Settled by |
| --- | --- |
| bench | `bench` |
| pack | `pack` |
| distill | `distill` |
| work | `work` |
| action | `action` |
| verify | `verify` |
| federation | `federation` |
| workspace sharing | `workspace-sharing` |
| compatibility aliases | `aliases` |

## Command inventory

113 dispatchable paths, one row each in `src/commands/spec.mjs`. The generated
command pages carry the flags; this table carries the promise.

| Command | Stability | Owner | Writes | MCP tool | Aliases |
| --- | --- | --- | --- | --- | --- |
| `simt action status` | prototype | action | none | `action_status` | — |
| `simt agent-hook` | stable | adoption | none | — | `harness hook` |
| `simt agent-hooks explain` | stable | adoption | none | — | — |
| `simt agent-hooks install` | stable | adoption | repo | — | `harness install` |
| `simt agent-hooks status` | stable | adoption | none | — | — |
| `simt agents install` | stable | adoption | repo | — | — |
| `simt agents status` | stable | adoption | none | — | — |
| `simt bench ablate` | optional | bench | none | — | — |
| `simt bench critic` | optional | bench | none | — | — |
| `simt bench export` | optional | bench | repo | — | — |
| `simt bench import` | optional | bench | none | — | — |
| `simt bench mine` | optional | bench | repo | — | — |
| `simt bench probes` | optional | bench | repo | — | — |
| `simt bench report` | optional | bench | none | — | — |
| `simt bench run` | optional | bench | repo | — | — |
| `simt brief` | stable | adoption | none | `brief` | — |
| `simt check` | stable | adoption | none | `check` | — |
| `simt work inspect` | prototype | work | none | `work_inspect` | — |
| `simt work setup` | prototype | work | repo | — | — |
| `simt workspace compare` | stable | adoption | none | `compare` | `compare` |
| `simt completions` | stable | adoption | none | — | — |
| `simt decide lint` | stable | adoption | none | — | — |
| `simt decide new` | stable | adoption | repo | — | — |
| `simt distill` | optional | distill | none | — | — |
| `simt docs commands` | stable | adoption | repo | — | — |
| `simt doctor` | stable | adoption | repo | `doctor` | — |
| `simt evidence` | stable | adoption | none | — | `evidence show` |
| `simt evidence check` | stable | adoption | none | — | — |
| `simt explain` | stable | adoption | none | — | — |
| `simt gate` | stable | adoption | none | — | — |
| `simt graph lint` | stable | adoption | none | — | `skills lint` |
| `simt harness detect` | stable | adoption | none | — | — |
| `simt harness loaders` | stable | adoption | none | — | — |
| `simt hooks install` | stable | adoption | repo | — | — |
| `simt hooks run` | stable | adoption | repo | — | — |
| `simt hooks status` | stable | adoption | none | — | — |
| `simt ignore` | stable | adoption | repo | — | — |
| `simt impact` | stable | adoption | none | — | — |
| `simt index` | stable | adoption | none | — | — |
| `simt init` | stable | adoption | repo | — | — |
| `simt knowledge why` | prototype | knowledge | none | `knowledge_why` | — |
| `simt knowledge export` | prototype | knowledge | none | `knowledge_export` | — |
| `simt knowledge import` | prototype | knowledge | none | `knowledge_import` | — |
| `simt knowledge rank` | prototype | knowledge | none | — | — |
| `simt knowledge derivations` | prototype | knowledge | none | — | — |
| `simt knowledge debt` | prototype | knowledge | none | — | — |
| `simt knowledge impact` | prototype | knowledge | none | — | — |
| `simt knowledge sections` | prototype | knowledge | none | — | — |
| `simt knowledge build` | prototype | knowledge | repo | — | — |
| `simt work schedule` | prototype | work | none | — | — |
| `simt work handoff` | prototype | work | none | — | — |
| `simt work resume` | prototype | work | none | — | — |
| `simt work graduate` | prototype | work | none | — | — |
| `simt bench replay` | optional | bench | none | — | — |
| `simt bench calibrate` | optional | bench | none | — | — |
| `simt action review` | prototype | action | none | `action_review` | — |
| `simt adapter check` | prototype | action | none | `adapter_check` | — |
| `simt verify contracts` | prototype | verification | none | `verify_contracts` | — |
| `simt verify documents` | prototype | verification | none | `verify_documents` | — |
| `simt verify procedures` | prototype | verification | none | `verify_procedures` | — |
| `simt lessons discover` | stable | adoption | none | `lessons_discover` | — |
| `simt work packet` | prototype | work | none | `work_packet` | — |
| `simt index overlay` | stable | adoption | none | `index_overlay` | — |
| `simt evidence validate` | stable | adoption | none | `evidence_validate` | — |
| `simt bench compat` | optional | bench | none | — | — |
| `simt bench corpus` | optional | bench | none | — | — |
| `simt bench world` | optional | bench | none | — | — |
| `simt lease` | stable | adoption | repo | — | — |
| `simt lessons capture` | stable | adoption | none | — | — |
| `simt lessons list` | stable | adoption | none | — | — |
| `simt lessons review` | stable | adoption | repo | — | — |
| `simt local doctor` | optional | local | none | — | — |
| `simt map` | stable | adoption | none | — | — |
| `simt mcp` | stable | adoption | none | — | — |
| `simt pack lint` | experimental | packs | none | — | — |
| `simt pack new` | experimental | packs | repo | — | — |
| `simt pack migrate` | experimental | packs | repo | — | — |
| `simt pack publish` | experimental | packs | registry | — | — |
| `simt plan done` | stable | adoption | repo | `plan_done` | — |
| `simt plan labels` | stable | adoption | none | — | — |
| `simt plan next` | stable | adoption | none | `plan_next` | — |
| `simt plan status` | stable | adoption | none | — | — |
| `simt plan archive` | stable | adoption | repo | — | — |
| `simt plugin` | optional | distribution | repo | — | `harness plugin` |
| `simt pr-body` | stable | adoption | none | `pr_body` | — |
| `simt review` | stable | adoption | none | — | — |
| `simt rules decisions` | stable | adoption | repo | — | — |
| `simt rules list` | stable | adoption | none | `rules_list` | — |
| `simt rules show` | stable | adoption | none | — | — |
| `simt rules why` | stable | adoption | none | `rules_why` | — |
| `simt workspace share` | stable | workspace | repo | — | `shared plan` |
| `simt workspace install` | stable | workspace | repo | — | `shared install` |
| `simt skills brief` | stable | adoption | none | `skills_brief` | `skills select` |
| `simt skills compile` | stable | adoption | repo | — | — |
| `simt skills eval` | stable | adoption | none | — | — |
| `simt skills find` | stable | adoption | none | `skills_find` | — |
| `simt skills index` | stable | adoption | none | `skills_index` | `skills list` |
| `simt skills install` | stable | adoption | repo | — | — |
| `simt skills show` | stable | adoption | none | `skills_show` | — |
| `simt skills why` | stable | adoption | none | `skills_why` | — |
| `simt slice abandon` | stable | adoption | repo | — | `plan abandon` |
| `simt slice finish` | stable | adoption | repo | — | `plan finish` |
| `simt slice start` | stable | adoption | repo | — | `plan start` |
| `simt status` | stable | adoption | none | — | — |
| `simt sync` | stable | adoption | repo | — | — |
| `simt tests` | stable | adoption | none | — | — |
| `simt tokens` | stable | adoption | none | — | `harness cost` |
| `simt verify plan` | prototype | verification | none | `verify_plan` | — |
| `simt verify select` | prototype | verification | none | `verify_select` | — |
| `simt verify status` | prototype | verification | none | `verify_status` | — |
| `simt undo` | stable | adoption | repo | — | — |
| `simt workspace upgrade` | stable | adoption | repo | — | `upgrade` |
| `simt why` | stable | adoption | none | — | — |

## Compatibility aliases

An alias is a second spelling of a dispatch key: it resolves before the registry is
consulted, it never appears in help, and it adds no capability. One is kept until the
next major, and removing one is a deprecation with a window like any other name.

| Alias | Path |
| --- | --- |
| `compare` | `workspace compare` |
| `evidence show` | `evidence` |
| `harness cost` | `tokens` |
| `harness hook` | `agent-hook` |
| `harness install` | `agent-hooks install` |
| `harness plugin` | `plugin` |
| `plan abandon` | `slice abandon` |
| `plan finish` | `slice finish` |
| `plan start` | `slice start` |
| `shared install` | `workspace install` |
| `shared plan` | `workspace share` |
| `skills lint` | `graph lint` |
| `skills list` | `skills index` |
| `skills select` | `skills brief` |
| `upgrade` | `workspace upgrade` |

## Library exports

| Export | Module | Stability |
| --- | --- | --- |
| `run` | `src/run.mjs` | stable |
| `renderText` | `src/run.mjs` | stable |
| `renderJson` | `src/run.mjs` | stable |
| `checkRepo` | `src/commands/sync.mjs` | stable |
| `checkTargets` | `src/commands/sync.mjs` | stable |
| `checkTarget` | `src/commands/sync.mjs` | stable |
| `frozenFindings` | `src/commands/sync.mjs` | stable |
| `diagnose` | `src/commands/doctor.mjs` | stable |
| `serialisedFindings` | `src/commands/doctor.mjs` | stable |
| `rulesCatalogue` | `src/commands/rules.mjs` | stable |
| `rulesWhyFacts` | `src/commands/rules.mjs` | stable |
| `skillsBriefFacts` | `src/commands/skills.mjs` | stable |
| `skillsFindFacts` | `src/commands/skills.mjs` | stable |
| `skillsShowFacts` | `src/commands/skills.mjs` | stable |
| `skillsWhyFacts` | `src/commands/skills.mjs` | stable |
| `assembleBrief` | `src/brief/assemble.mjs` | stable |
| `loadRegistry` | `src/graph/load.mjs` | stable |
| `discover` | `src/compare/discover.mjs` | stable |
| `buildRows` | `src/compare/row.mjs` | stable |
| `resolveConcurrency` | `src/compare/row.mjs` | stable |
| `summarise` | `src/compare/row.mjs` | stable |
| `planNext` | `src/plan/index.mjs` | stable |
| `buildPrBody` | `src/prbody.mjs` | stable |
| `federationAccess` | `src/federation/config.mjs` | stable |
| `readFederation` | `src/federation/config.mjs` | stable |

## Package exports

| Entry | Stability | What it is for |
| --- | --- | --- |
| `.` | stable | the library surface above |
| `./package.json` | stable | so a consumer can read the version and engines floor |
| `./src/*` | deprecate | deep imports kept for the generated plugin runtime; import from the package root instead |

## Deprecations

| Working today | Use instead | Window |
| --- | --- | --- |
| simt sync --check | simt sync (drop --check: it reports before it writes) | accepted and announced; sync reports before it writes, so the flag asks nothing new |
| deep imports through simt-dev/src/* | the package root exports | until the plugin runtime imports the root; not removed in a patch release |

A removal is a separate, later decision: it needs the replacement to be the documented
route for a release, and the deprecation to have been printed by the surface it names.
