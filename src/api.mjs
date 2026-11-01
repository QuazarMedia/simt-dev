// The library surface: the read commands as data.
//
// Every function here is the one the CLI and the MCP tools already call. Nothing in
// this file renders: a caller that wants text, JSON or an MCP result renders these
// results itself, which is the whole point - a UI, a harness and a terminal asking the
// same question must not get three answers, and they cannot disagree if they are
// reading one function's return value.
//
// The write half arrives through `run(command, input)`: a writer still renders its plan
// from the command module, because a person reviews that diff before it is applied
// (ADR-001), but a library caller now gets that plan back as text and documents instead
// of having it printed at a terminal it does not own. `run` resolves the same registry
// and calls the same handler `dispatch` does, so the two surfaces cannot answer
// differently.
//
// The exports map in package.json points `import 'simt-dev'` here, and keeps
// `./src/*` because the plugin runtime and the harness shims import deep paths.
// Removing that subpath would break them to make the surface look tidier.

export { run, renderText, renderJson } from './run.mjs';
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
