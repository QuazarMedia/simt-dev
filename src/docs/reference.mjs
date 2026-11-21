// The reference pages about the surface: every read-only tool, and the module map.
//
// Both were hand-written, and both had drifted: the MCP table listed 15 of 32 tools before it was
// regenerated. They are now rendered from `src/commands/spec.mjs`, so a new command or tool cannot
// leave a page describing the surface as it was. The grouping and the "when" sentence are the only
// editorial parts, and they live here rather than in the page, so changing them is a code change a
// test covers.

import { SPEC } from '../commands/spec.mjs';
import { TOOLS } from '../mcp/tools.mjs';
import {
  API_EXPORTS,
  DEPRECATIONS,
  DISPOSITIONS,
  NAMED_SURFACES,
  PACKAGE_EXPORTS,
  STABILITY,
  aliasInventory,
  commandInventory,
} from '../surface.mjs';

const MODULES = [
  {
    name: 'Task Brief',
    paths: ['brief', 'work packet'],
    when: 'First call on every task to get task kind, commands, ranked files, tests, ADRs, skills, and lessons in <= 2 KB; `work packet` when the packet must prove its units are cited',
  },
  {
    name: 'Code Graph & Retrieval',
    paths: ['index', 'index overlay', 'map', 'impact', 'tests', 'gate'],
    when: 'Before editing to rank files (`map`), trace blast radius (`impact`), run only diff-affected tests (`gate --changed`), or ask the open cache (`index --search`)',
  },
  {
    name: 'Knowledge & Governance',
    paths: [
      'why',
      'rules list',
      'rules show',
      'rules why',
      'decide lint',
      'decide new',
      'knowledge why',
      'knowledge rank',
      'knowledge impact',
      'knowledge derivations',
      'knowledge debt',
      'knowledge sections',
      'knowledge build',
      'knowledge export',
      'knowledge import',
    ],
    when: 'Before touching governed files (`why`), when ranking evidence or asking what a change puts in question, or when moving claims between repositories as data',
  },
  {
    name: 'Verification',
    paths: ['verify plan', 'verify select', 'verify status', 'verify contracts', 'verify documents', 'verify procedures'],
    when: 'Before choosing checks, when closing recorded obligations, or when checking a generated document, a procedure or a set of obligation results',
  },
  {
    name: 'Actions & Adapters',
    paths: ['action status', 'action review', 'adapter check'],
    when: 'Before executing an operation: read the journal state, review the bundle, and validate an adapter descriptor as data',
  },
  {
    name: 'Skills & Disclosure',
    paths: ['skills index', 'skills brief', 'skills show', 'skills why', 'skills find', 'skills install', 'skills compile', 'skills eval', 'graph lint'],
    when: 'When a task requires domain workflows or reference docs without blowing the session token budget',
  },
  {
    name: 'Memory & Lessons',
    paths: ['lessons list', 'lessons review', 'lessons discover'],
    when: 'After fixing a failing test/gate or hitting a hook denial, to inspect or promote reusable failure-to-fix lessons, or to deduplicate discovery candidates',
  },
  {
    name: 'Work & Plans',
    paths: [
      'work inspect',
      'work setup',
      'work schedule',
      'work handoff',
      'work resume',
      'work graduate',
      'plan status',
      'plan next',
      'plan done',
      'slice start',
      'slice finish',
      'lease',
      'pr-body',
      'status',
      'undo',
    ],
    when: "When describing a repository's work, sequencing ready tasks, resuming a handoff, or executing a phased plan row by row",
  },
  {
    name: 'Adoption & Projection',
    paths: ['init', 'doctor', 'check', 'sync', 'workspace upgrade'],
    when: 'When adopting a repo, diagnosing stack/config health, or verifying zero drift before commit',
  },
  {
    name: 'Dual Gates & Evidence',
    paths: ['hooks install', 'hooks status', 'hooks run', 'agent-hooks install', 'agent-hooks status', 'agent-hook', 'evidence', 'evidence check', 'evidence validate'],
    when: 'When installing git/agent hooks, running gates manually, or validating a test claim and its chain of custody before committing',
  },
  {
    name: 'Context & Harnesses',
    paths: ['tokens', 'harness detect', 'harness loaders', 'workspace install', 'workspace share'],
    when: 'When auditing startup token cost across harnesses (`claude`, `codex`, `cursor`, `opencode`, `antigravity`, `copilot`, `deepseek`) or deduplicating workspace rules',
  },
  {
    name: 'Workspace & Benchmarks',
    paths: [
      'workspace compare',
      'bench mine',
      'bench run',
      'bench report',
      'bench ablate',
      'bench probes',
      'bench replay',
      'bench calibrate',
      'bench compat',
      'bench corpus',
      'bench world',
      'local doctor',
      'review',
      'distill',
    ],
    when: 'When auditing an entire multi-repo estate, measuring rule uplift/cost, replaying an outcome, calibrating autonomy, or probing local model endpoints',
  },
];

const cell = (text) => String(text).replace(/\|/g, '\\|');

function entryFor(path) {
  const found = SPEC.find((row) => row.path === path);
  if (found === undefined) throw new Error(`docs: no spec row for ${path}`);
  return found;
}

const commandText = (row) => '`simt ' + row.path + (row.usage === undefined ? '' : ' ' + row.usage) + '`';
const toolText = (row) => (row.mcp === undefined ? null : '`' + row.mcp.name + '`');

export function renderMcpPage() {
  // From the registry rather than the spec rows: `federation_query` is a stated transport-only
  // exemption with no command, and a page built from rows alone would silently omit it.
  const tools = [...TOOLS]
    .map((tool) => ({ name: tool.name, summary: tool.description }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return [
    '# MCP surface',
    '',
    'Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.',
    '',
    '`simt mcp` serves JSON-RPC over stdio. The surface is read-only: a tool answers from the same',
    "functions the commands call, and a flag absent from a tool's allowlist is not reachable",
    'through it. `simt mcp --list` prints the surface without reading stdin.',
    '',
    '| Tool | Answers |',
    '| --- | --- |',
    ...tools.map((tool) => `| \`${tool.name}\` | ${cell(tool.summary)} |`),
    '',
    'Two prompts (`simt-brief`, `simt-slice`) and two resources (`rules`, `decisions`) sit beside',
    'the tools. A prompt is a template the client renders; a resource is a document it can attach.',
    'Neither writes.',
    '',
    'The tool list is declared on the command spec (`mcp: { name, flags }` on a row), so a tool and',
    'its command cannot disagree about which flags exist. `test/mcp*.test.mjs` holds the list',
    'against the spec, and the docs test holds this page against both.',
    '',
  ].join('\n');
}

/** `docs/reference/surface.md`: what is promised, per command, export and tool. */
export function renderSurfacePage() {
  const commands = commandInventory();
  const rows = DISPOSITIONS.map(
    (entry) =>
      `| \`${entry.id}\` | ${entry.stability} | ${entry.owner} | ${cell(entry.consumer)} | ${cell(entry.note)} |`,
  );
  const aliases = aliasInventory()
    .sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0))
    .map((entry) => `| \`${entry.alias}\` | \`${entry.target}\` |`);
  return [
    '# Supported surface and deprecations',
    '',
    'Rendered from `src/surface.mjs` by `simt docs commands --yes`; do not edit by hand.',
    'Every dispatchable path resolves to exactly one disposition, and the test that holds this',
    'page to the module fails when a new group, export or tool is left unclassified.',
    '',
    `The vocabulary is exactly ${STABILITY.map((word) => `\`${word}\``).join(', ')}: a stability`, 'promise, a shipping decision, a prototype without one, and a frozen experimental surface.',
    '',
    '## Dispositions',
    '',
    '| Surface | Stability | Owner | Consumer | What the word means here |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '## The surfaces this review named',
    '',
    '| Surface | Settled by |',
    '| --- | --- |',
    ...NAMED_SURFACES.map(([name, id]) => `| ${name} | \`${id}\` |`),
    '',
    '## Command inventory',
    '',
    `${commands.length} dispatchable paths, one row each in \`src/commands/spec.mjs\`. The generated`,
    'command pages carry the flags; this table carries the promise.',
    '',
    '| Command | Stability | Owner | Writes | MCP tool | Aliases |',
    '| --- | --- | --- | --- | --- | --- |',
    ...commands.map(
      (row) =>
        `| \`simt ${row.path}\` | ${row.stability} | ${row.owner} | ${row.writes} | ${row.mcp === null ? '—' : `\`${row.mcp}\``} | ${row.aliases.length === 0 ? '—' : row.aliases.map((alias) => `\`${alias}\``).join(', ')} |`,
    ),
    '',
    '## Compatibility aliases',
    '',
    'An alias is a second spelling of a dispatch key: it resolves before the registry is',
    'consulted, it never appears in help, and it adds no capability. One is kept until the',
    'next major, and removing one is a deprecation with a window like any other name.',
    '',
    '| Alias | Path |',
    '| --- | --- |',
    ...aliases,
    '',
    '## Library exports',
    '',
    '| Export | Module | Stability |',
    '| --- | --- | --- |',
    ...API_EXPORTS.map((entry) => `| \`${entry.name}\` | \`src/${entry.module}\` | stable |`),
    '',
    '## Package exports',
    '',
    '| Entry | Stability | What it is for |',
    '| --- | --- | --- |',
    ...PACKAGE_EXPORTS.map((entry) => `| \`${entry.key}\` | ${entry.stability} | ${cell(entry.note)} |`),
    '',
    '## Deprecations',
    '',
    '| Working today | Use instead | Window |',
    '| --- | --- | --- |',
    ...DEPRECATIONS.map((entry) => `| ${cell(entry.what)} | ${cell(entry.replacedBy)} | ${cell(entry.window)} |`),
    '',
    'A removal is a separate, later decision: it needs the replacement to be the documented',
    'route for a release, and the deprecation to have been printed by the surface it names.',
    '',
  ].join('\n');
}

export function renderModulesPage() {
  const rows = MODULES.map((module) => {
    const entries = module.paths.map(entryFor);
    const commands = entries.map(commandText).join(', ');
    const tools = entries.map(toolText).filter((text) => text !== null).join(', ');
    return `| **${module.name}** | ${commands} | ${tools === '' ? '—' : tools} | ${cell(module.when)} |`;
  });

  return [
    '# Module and MCP reference',
    '',
    'Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.',
    '',
    '| Module | CLI commands | Read-only MCP tools | When an agent should use it |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    'The command names and their flags are generated in [../commands/index.md](../commands/index.md);',
    'this table is the shape of the surface, not its contract.',
    '',
  ].join('\n');
}
