// The library surface: the read commands as data (review 0003 Q63).
//
// Every function here is the one the CLI and the MCP tools already call. Nothing in
// this file renders: a caller that wants text, JSON or an MCP result renders these
// results itself, which is the whole point - a UI, a harness and a terminal asking the
// same question must not get three answers, and they cannot disagree if they are
// reading one function's return value.
//
// This is the read half only. The commands that write (`init`, `sync`, `hooks
// install`, `skills install`, `upgrade`) still print their plans from the command
// module, because their output is a diff a person reviews before it is applied
// (ADR-001). They migrate in the next slice, when `run(ctx, input)` exists to carry
// a plan back to a caller that can show it.
//
// The exports map in package.json points `import 'simt-dev'` here, and keeps
// `./src/*` because the plugin runtime and the harness shims import deep paths.
// Removing that subpath would break them to make the surface look tidier.

export { checkRepo, checkTargets, checkTarget, frozenFindings } from './commands/sync.mjs';
export { diagnose, serialisedFindings } from './commands/doctor.mjs';
export { rulesCatalogue, rulesWhyFacts } from './commands/rules.mjs';
export { skillsBriefFacts, skillsFindFacts, skillsShowFacts, skillsWhyFacts } from './commands/skills.mjs';
export { assembleBrief } from './brief/assemble.mjs';
export { loadRegistry } from './graph/load.mjs';
export { discover } from './compare/discover.mjs';
export { buildRows, resolveConcurrency, summarise } from './compare/row.mjs';
export { planNext } from './plan/index.mjs';
export { buildPrBody } from './prbody.mjs';
export { federationAccess, readFederation } from './federation/config.mjs';
