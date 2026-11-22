// The supported surface, one disposition per command, export and tool (ADR-207).
//
// Seven entry points described this tool and none of them agreed: the spec named the
// commands, `--help` divided them into tiers, `api.mjs` exported a library, the MCP tool
// table exposed a subset, `package.json` exposed a wildcard, the shims resolved a binary,
// and the generated pages restated what the spec said. A tier is a presentation fact, so
// none of those was a stability statement - which is how a prototype read door and the
// adoption path ended up looking the same to a reader.
//
// This module is that statement. Every dispatchable path resolves to exactly one
// disposition; a group this table does not name makes `dispositionOf` throw rather than
// defaulting to stable, so a new command has to be classified before it can ship a page.
// The library and package exports are listed the same way, and the page rendered from
// these tables is `docs/reference/surface.md`.
//
// The vocabulary is deliberately four words, not a licence to add a fifth per group:
//
//   stable       a compatibility promise: a removal is a deprecation first
//   optional     shipped and supported when used, but not part of the adoption path
//   prototype    reachable for a design partner, no compatibility promise, may change
//   experimental published, frozen, and gains no feature until a real consumer adopts it
//
// `stable` is a promise about the NAME and the SHAPE of the output, not a claim that every
// bug is fixed. Removing one still needs a deprecation with a window; that is what
// `DEPRECATIONS` below records for the two that exist today.

import { ALIASES, SPEC } from './commands/spec.mjs';

export const STABILITY = ['stable', 'optional', 'prototype', 'experimental'];

const ALIASES_POLICY =
  'every merged spelling resolves to its path and stays until the next major; an alias adds no capability';

/**
 * One row per surface decision. `groups` covers whole command groups; `paths` overrides a
 * row inside a group whose promise differs (workspace sharing is the adoption path, the
 * rest of `workspace` is the same promise, but the review asked for it to be named).
 */
export const DISPOSITIONS = [
  {
    id: 'adoption',
    stability: 'stable',
    owner: 'adoption',
    consumer: 'a repository adopting the tool, and the agent working in it',
    note: 'the path this review is about: init, projection, gates, hooks, evidence, index, brief',
    groups: [
      'agent-hook', 'agent-hooks', 'agents', 'brief', 'check', 'completions', 'decide', 'docs',
      'doctor', 'evidence', 'explain', 'gate', 'graph', 'harness', 'hooks', 'ignore', 'impact',
      'index', 'init', 'lease', 'lessons', 'map', 'mcp', 'plan', 'pr-body', 'review', 'rules',
      'skills', 'slice', 'status', 'sync', 'tests', 'tokens', 'undo', 'why', 'workspace',
    ],
  },
  {
    id: 'workspace-sharing',
    stability: 'stable',
    owner: 'workspace',
    consumer: 'a maintainer carrying rules once for a workspace of repositories',
    note: 'the user-level half of the workspace surface (ADR-084); an alias spelling stays supported',
    paths: ['workspace share', 'workspace install'],
  },
  {
    id: 'bench',
    stability: 'optional',
    owner: 'bench',
    consumer: 'maintainers measuring brief quality against their own corpus',
    note: 'shipped because its fixtures are the measurement; not needed to adopt or run the gates',
    groups: ['bench'],
  },
  {
    id: 'pack',
    stability: 'experimental',
    owner: 'packs',
    consumer: 'rule-pack authors, once a repository vendors one',
    note: 'frozen until a real repository adopts a pack (ADR-130); local profiles are the supported route, and `pack migrate` moves a pinned pack onto them',
    groups: ['pack'],
  },
  {
    id: 'distill',
    stability: 'optional',
    owner: 'distill',
    consumer: 'a maintainer turning a repository into a skill or rule proposal',
    note: 'one command, proposal output only; it writes no rule into a projected region',
    groups: ['distill'],
  },
  {
    id: 'plugin',
    stability: 'optional',
    owner: 'distribution',
    consumer: 'a harness vendor packaging the same tables this repository ships',
    note: 'generates a harness package; the shipped artefacts are qualified by the packaging tests',
    groups: ['plugin'],
  },
  {
    id: 'studio',
    stability: 'optional',
    owner: 'studio',
    consumer: 'a maintainer watching the doors of the tool in a browser',
    note: 'one loopback socket, opened only by explicit invocation and read-only (ADR-212); nothing leaves the machine (ADR-075)',
    groups: ['studio'],
  },
  {
    id: 'local-models',
    stability: 'optional',
    owner: 'local',
    consumer: 'an operator pointing at a loopback model endpoint',
    note: 'off unless configured; bounded by ADR-075 and ADR-204',
    groups: ['local'],
  },
  {
    id: 'work',
    stability: 'prototype',
    owner: 'work',
    consumer: 'a design partner sequencing work from documents',
    note: 'document-driven doors; `work inspect` and `work setup` are the usable half and ship in the core path',
    groups: ['work'],
  },
  {
    id: 'action',
    stability: 'prototype',
    owner: 'action',
    consumer: 'an execution runner reading a journal',
    note: 'read and review only; no command here starts an operation',
    groups: ['action', 'adapter'],
  },
  {
    id: 'verify',
    stability: 'prototype',
    owner: 'verification',
    consumer: 'a maintainer validating contracts, documents or procedures',
    note: 'the read doors (`verify plan`, `verify select`, `verify status`) are used by the core path; the validators are prototypes',
    groups: ['verify'],
  },
  {
    id: 'knowledge',
    stability: 'prototype',
    owner: 'knowledge',
    consumer: 'a repository exchanging a scoped corpus with another',
    note: 'declared-scope reads are stable in behaviour; the exchange format is a prototype',
    groups: ['knowledge'],
  },
  {
    id: 'federation',
    stability: 'optional',
    owner: 'federation',
    consumer: 'an MCP client asking a declared sibling repository',
    note: 'transport-only, user-allowlisted, and the only tool that may start a process (ADR-205)',
    groups: [],
    tools: ['federation_query'],
  },
  {
    id: 'aliases',
    stability: 'stable',
    owner: 'compatibility',
    consumer: 'a script written against an earlier name',
    note: ALIASES_POLICY,
    groups: [],
    aliases: true,
  },
];

/** The groups the review named, each mapped to the disposition that settles it. */
export const NAMED_SURFACES = [
  ['bench', 'bench'],
  ['pack', 'pack'],
  ['distill', 'distill'],
  ['work', 'work'],
  ['action', 'action'],
  ['verify', 'verify'],
  ['federation', 'federation'],
  ['workspace sharing', 'workspace-sharing'],
  ['studio', 'studio'],
  ['compatibility aliases', 'aliases'],
];

/**
 * The disposition for one dispatchable path.
 *
 * An exact `paths` entry wins over the group; anything else must match exactly one group,
 * and a path that matches none or several throws. A default would be a stability promise
 * made by omission, which is the defect this module exists to end.
 */
export function dispositionOf(path) {
  const exact = DISPOSITIONS.filter((entry) => (entry.paths ?? []).includes(path));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`${path} is claimed by ${exact.length} dispositions`);
  const group = path.split(' ')[0];
  const matches = DISPOSITIONS.filter((entry) => (entry.groups ?? []).includes(group));
  if (matches.length === 1) return matches[0];
  throw new Error(`${path} has ${matches.length} dispositions; classify ${group} in src/surface.mjs`);
}

/** The disposition of an MCP tool: its row's, or the transport-only entry's. */
export function toolDisposition(name) {
  const row = SPEC.find((entry) => entry.mcp?.name === name);
  if (row) return dispositionOf(row.path);
  const entry = DISPOSITIONS.find((candidate) => (candidate.tools ?? []).includes(name));
  if (entry) return entry;
  throw new Error(`MCP tool ${name} has no disposition; classify it in src/surface.mjs`);
}

/**
 * The library surface, one row per named export of `src/api.mjs`.
 *
 * `test/api.test.mjs` compares this list with the module's runtime exports, so a new
 * export arrives with a decision about its promise instead of appearing in the package
 * the moment somebody adds an `export`.
 */
export const API_EXPORTS = [
  { name: 'run', module: 'run.mjs' },
  { name: 'renderText', module: 'run.mjs' },
  { name: 'renderJson', module: 'run.mjs' },
  { name: 'checkRepo', module: 'commands/sync.mjs' },
  { name: 'checkTargets', module: 'commands/sync.mjs' },
  { name: 'checkTarget', module: 'commands/sync.mjs' },
  { name: 'frozenFindings', module: 'commands/sync.mjs' },
  { name: 'diagnose', module: 'commands/doctor.mjs' },
  { name: 'serialisedFindings', module: 'commands/doctor.mjs' },
  { name: 'rulesCatalogue', module: 'commands/rules.mjs' },
  { name: 'rulesWhyFacts', module: 'commands/rules.mjs' },
  { name: 'skillsFindFacts', module: 'commands/skills.mjs' },
  { name: 'skillsShowFacts', module: 'commands/skills.mjs' },
  { name: 'skillsWhyFacts', module: 'commands/skills.mjs' },
  { name: 'assembleBrief', module: 'brief/assemble.mjs' },
  { name: 'loadRegistry', module: 'graph/load.mjs' },
  { name: 'discover', module: 'compare/discover.mjs' },
  { name: 'buildRows', module: 'compare/row.mjs' },
  { name: 'resolveConcurrency', module: 'compare/row.mjs' },
  { name: 'summarise', module: 'compare/row.mjs' },
  { name: 'planNext', module: 'plan/index.mjs' },
  { name: 'buildPrBody', module: 'prbody.mjs' },
  { name: 'federationAccess', module: 'federation/config.mjs' },
  { name: 'readFederation', module: 'federation/config.mjs' },
];

/**
 * The exact deep modules the optional bench package still imports.
 *
 * This is a migration list, not a new wildcard: the bench build rewrites its relative
 * core imports to these specifiers, and the package exports map names each one. The
 * list is checked against the bench's actual imports and against package.json, so a new
 * deep import cannot be published accidentally by adding it in one place only.
 */
export const LEGACY_DEEP_IMPORTS = [
  'brief/assemble.mjs',
  'brief/packet.mjs',
  'commands/doc-input.mjs',
  'commands/skills.mjs',
  'graph/compile.mjs',
  'graph/load.mjs',
  'hooks/dispatcher.mjs',
  'index/map.mjs',
  'knowledge/observations.mjs',
  'measure/ablation.mjs',
  'measure/corpus.mjs',
  'measure/metrics.mjs',
  'measure/records.mjs',
  'measure/stats.mjs',
  'measure/task-schema.mjs',
  'measure/tasks.mjs',
  'name.mjs',
  'output/index.mjs',
  'package-version.mjs',
  'plan/index.mjs',
  'projection/manifest.mjs',
  'projection/markers.mjs',
  'projection/mdc.mjs',
  'projection/project.mjs',
  'projection/rules.mjs',
  'projection/surfaces.mjs',
  'repo-root.mjs',
  'resolve/fingerprint.mjs',
  'review/critic.mjs',
  'run.mjs',
  'state.mjs',
  'sys/proc.mjs',
  'testing/parsers.mjs',
  'testing/patches.mjs',
  'testing/paths.mjs',
  'testing/runners.mjs',
  'testing/vault.mjs',
  'util/canonical.mjs',
  'work/assurance.mjs',
];

/**
 * The package export map, with what each entry promises.
 *
 * The wildcard is gone. Each `./src/<module>` entry below exists only because the
 * optional bench imports it today; a new deep import needs a deliberate addition here,
 * not a path that happens to resolve.
 */
export const PACKAGE_EXPORTS = [
  { key: '.', stability: 'stable', note: 'the library surface above' },
  { key: './package.json', stability: 'stable', note: 'so a consumer can read the version and engines floor' },
  ...LEGACY_DEEP_IMPORTS.map((module) => ({
    key: `./src/${module}`,
    stability: 'deprecate',
    note: 'the optional bench still imports this exact module; import from the package root instead',
  })),
];

/** What already works but is on its way out, and what a reader does instead. */
export const DEPRECATIONS = [
  {
    what: 'simt sync --check',
    // The replacement is the bare command BECAUSE it previews: the flag asked what the
    // default now answers. Spelled with the dropped flag in the same sentence so a
    // reader who greps a writer for its consent sees the pair, not a bare writer.
    replacedBy: 'simt sync (drop --check: it reports before it writes)',
    window: 'accepted and announced; sync reports before it writes, so the flag asks nothing new',
  },
  {
    what: 'deep imports through simt-dev/src/<module>',
    replacedBy: 'the package root exports; the optional bench uses the exact ./src/<module> entries above',
    window: 'the wildcard is gone; only the bench migration list remains and it gains no new paths',
  },
];

/** One row per command, derived from the spec - never a second list of paths. */
export function commandInventory() {
  return SPEC.map((row) => {
    const disposition = dispositionOf(row.path);
    return {
      path: row.path,
      group: row.path.split(' ')[0],
      stability: disposition.stability,
      owner: disposition.owner,
      writes: row.writes ?? 'none',
      mcp: row.mcp?.name ?? null,
      aliases: [...ALIASES].filter(([, target]) => target === row.path).map(([alias]) => alias),
    };
  });
}

/** The alias table, as the page prints it. */
export function aliasInventory() {
  return [...ALIASES].map(([alias, target]) => ({ alias, target }));
}
