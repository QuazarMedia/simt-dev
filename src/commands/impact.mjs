// `simt impact` reports who a file or an export reaches (ADR-096).
//
// Importers, the tests that cover them, the decisions and rules that govern
// the file, the CODEOWNERS line, and — when a workspace is configured —
// another repository that references a contract this change touches.

import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { EXIT, fail, isJson, present } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { discover } from '../compare/discover.mjs';
import { loadLiveGraph } from '../index/live.mjs';
import {
  CODEOWNERS_PATHS,
  contractReferences,
  dependents,
  filesExporting,
  impactTopology,
  isContractPath,
  ownersOf,
  relatedContracts,
  traceImpact,
} from '../index/impact.mjs';
import { targetsForHunks, targetsForTask } from '../index/impact-targets.mjs';
import { conceptualPartners } from '../index/lexical.mjs';
import { isModernRetrieval, retrievalMode } from '../index/retrieval-mode.mjs';
import { governs, sourceRoots } from '../index/govern.mjs';
import { decisionRecords, ruleScopes } from './why.mjs';
import { resolveWorkspace } from '../workspace.mjs';
import { commandRoot } from '../repo-root.mjs';
import { gitPaths } from '../sys/git.mjs';
import { readChangeHunks } from '../sys/changes.mjs';
import { cmp } from '../util/sort.mjs';

const TEXT_EXT = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'yaml', 'yml', 'md', 'toml', 'xml', 'py', 'go', 'kt', 'java', 'rs']);
const READ_CAP = 256 * 1024;
const FILE_CAP = 2000;
const USAGE = `run: ${CLI} impact <file|symbol>...  |  --changed  |  --task "<prompt>"`;

// The report is sections; `--only` answers with exactly one of them. brief's `--only
// <section>` is the precedent, and the set is exported so the MCP schema names the same
// choices instead of a copy that can drift.
export const IMPACT_SECTIONS = ['importers', 'tests', 'cochange', 'conceptual', 'governs', 'owners', 'consumers'];

// The keys each section answers with, including the annotations that section needs to
// read: tiers annotate both importer and test lines, and the v2 channel breakdowns are
// the detail view of those same two.
const SECTION_KEYS = {
  importers: ['importers', 'tiers', 'structural', 'testTiers', 'conservativeFallback', 'suppressedHubMediated'],
  tests: ['tests', 'tiers', 'structural', 'testTiers'],
  cochange: ['cochange', 'cochangeTruncated'],
  conceptual: ['conceptual'],
  governs: ['governs'],
  owners: ['owners'],
  consumers: ['consumers'],
};

function issue(message, exitCode = EXIT.USAGE, remedy = USAGE) {
  return Object.assign(new Error(message), { exitCode, remedy });
}

function sectionFromFlags(flags) {
  const value = flags.only;
  if (value === undefined || value === null) return null;
  const section = String(value).toLowerCase();
  if (!IMPACT_SECTIONS.includes(section)) {
    throw issue(`unknown impact section ${value}`, EXIT.USAGE,
      `run: ${CLI} impact --only <section> — one of ${IMPACT_SECTIONS.join(', ')}`);
  }
  return section;
}

export async function impactCommand(args, flags, commands = []) {
  try {
    const payload = await impactFacts(commandRoot(flags), args, flags, commands);
    const knowledge = payload.knowledge && !isJson(flags)
      ? (await import('../index/unified-impact.mjs')).renderKnowledgeBridge(payload.knowledge) : [];
    present(payload, () => render(payload, knowledge), flags);
    return EXIT.OK;
  } catch (error) {
    if (error.exitCode === undefined) throw error;
    return fail(error.message, error.exitCode, error.remedy);
  }
}

export async function impactFacts(root, args, flags = {}, commands = []) {
  const section = sectionFromFlags(flags);
  const changed = flags.changed === true;
  const task = typeof flags.task === 'string' ? flags.task.trim() : '';
  if (Number(args.length > 0) + Number(changed) + Number(Boolean(task)) !== 1) {
    throw issue('choose paths or symbols, --changed, or --task');
  }
  const advanced = changed || task || args.length > 1 || flags.all === true || args.some((target) => target.includes('#'));
  const retrieval = retrievalMode(flags.retrieval);
  if (retrieval === null) throw issue('unknown retrieval mode', EXIT.USAGE, 'pass --retrieval v1, v2 or v3');
  if (retrieval === 'v1' && advanced) throw issue('this query requires retrieval v2', EXIT.USAGE, 'pass --retrieval v2');
  // The parser already checks CLI callers; this is the library and MCP door, which
  // receive flags without that check. A cap is a positive integer, not a string:
  // `Number` of anything else would walk a depth the reader did not ask for.
  const maxHop = flags.maxHops === undefined || flags.maxHops === null ? null : flags.maxHops;
  if (maxHop !== null && (!Number.isInteger(maxHop) || maxHop < 1)) {
    throw issue(`--max-hops must be a positive integer`, EXIT.USAGE, 'pass --max-hops 1, --max-hops 2, …');
  }
  const precise = isModernRetrieval(retrieval);
  let changes = [];
  try {
    if (changed) changes = await readChangeHunks(root);
  } catch (error) {
    throw issue(`could not read the diff (${error.message})`, EXIT.UNSUPPORTED, 'run this inside a git repository that has a commit');
  }
  const gone = changes.filter(({ status }) => status === 'D').map(({ path }) => path);
  const rangePaths = changes.filter(({ hunks }) => hunks.length > 0).map(({ path }) => path);
  let graph;
  try {
    graph = await loadLiveGraph(root, { binding: precise, cochange: precise, retainTargets: gone, rangePaths });
    if (graph.broken) throw new Error(graph.indexError?.message ?? 'the index cannot be read');
  } catch (error) {
    throw issue(`could not read the tree (${error.message})`, EXIT.UNSUPPORTED, 'run this inside a git repository');
  }
  const files = new Set(graph.files.map(({ path }) => path));
  const targets = changed ? targetsForHunks(changes, graph) : task ? targetsForTask(task, graph)
    : unique(args.map((target) => resolveTarget(target, files, graph.symbols, precise)), ({ file, symbol }) => JSON.stringify([file, symbol]));
  if (task && !targets.length) throw issue('the task names no unambiguous file or symbol', EXIT.USAGE, `run: ${CLI} map --task "<prompt>"`);
  const focus = targets[0];
  const sources = new Set(targets.map(({ file }) => file));
  const reach = precise ? traceImpact(impactTopology(graph, gone), targets, { root, maxHop }) : dependents(focus.file, graph.edges, undefined, maxHop);
  const [governanceItems, owners, consumers, extra] = targets.length ? await Promise.all([
    governance(root, sources, files, commands),
    readOwners(root, sources),
    consumersFor(root, flags, files, targets, reach.importers),
    precise ? impactChannels(root, graph, reach, sources, flags.all === true) : {},
  ]) : [[], [], { references: [], truncated: false }, impactChannelsEmpty()];
  const knowledge = flags.withKnowledge === true
    ? await (await import('../index/unified-impact.mjs')).knowledgeForImpact(root, { files: [...sources], graph, gone, changed })
    : null;
  const payload = {
    ok: true,
    command: 'impact',
    root,
    file: focus?.file ?? '',
    symbol: focus?.symbol ?? '',
    ...reach,
    governs: governanceItems,
    owners,
    consumers: consumers.references,
    truncated: reach.truncated || consumers.truncated || (extra.cochangeTruncated ?? false),
    ...(precise ? { ...extra, targets, symbols: targets.filter(({ symbol }) => symbol) } : {}),
    ...(knowledge ? { knowledge } : {}),
    ...(graph.basis.overlay.applied ? { provenance: graph.basis } : {}),
  };
  if (section === null) return payload;
  const out = { ok: payload.ok, command: 'impact', root, file: payload.file, symbol: payload.symbol };
  for (const key of SECTION_KEYS[section]) if (payload[key] !== undefined) out[key] = payload[key];
  // The MCP output schema requires the five sections on every answer; an unselected one
  // is present and empty, so a filtered document still validates against it.
  for (const key of ['importers', 'tests', 'governs', 'owners', 'consumers']) if (!(key in out)) out[key] = [];
  // `truncated` answers for the section asked for, not for the report that was cut:
  // a filtered view must not claim truncation a section it does not print caused.
  out.truncated = section === 'cochange' ? (extra.cochangeTruncated ?? false)
    : section === 'consumers' ? consumers.truncated
      : section === 'importers' || section === 'tests' ? reach.truncated
        : false;
  // Identity, not content: the reader must still see which file or symbol was asked
  // about, and `render` prints one header line per target.
  for (const key of ['targets', 'symbols', 'provenance']) if (payload[key] !== undefined) out[key] = payload[key];
  return out;
}

function unique(rows, key = (value) => value) {
  return [...new Map(rows.map((row) => [key(row), row])).values()];
}

function impactChannelsEmpty() {
  return { structural: { direct: [], transitive: [], hubMediated: [] },
    testTiers: { direct: [], transitive: [], hubMediated: [] }, cochange: [], conceptual: [] };
}

async function impactChannels(root, graph, reach, sources, all) {
  const { structural, testTiers } = impactChannelsEmpty();
  const tests = new Set(reach.tests);
  const exclude = new Set([...reach.importers, ...reach.tests]);
  for (const [tier, rows] of Object.entries(reach.tiers)) {
    for (const row of rows) (tests.has(row.path) ? testTiers : structural)[tier].push(row);
  }
  const cochange = (graph.cochange ?? []).filter(({ src, dst }) => sources.has(src) && !sources.has(dst) && !exclude.has(dst))
    .sort((a, b) => b.confidence - a.confidence || b.lift - a.lift || b.support - a.support || cmp(a.dst, b.dst) || cmp(a.src, b.src));
  for (const { dst } of cochange) exclude.add(dst);
  const conceptual = [];
  if (all || (!reach.importers.length && !reach.tests.length)) {
    const lexical = await loadLiveGraph(root, { fielded: true });
    const best = new Map();
    for (const row of conceptualPartners(lexical.fieldedRows, sources, { exclude })) {
      if (row.score > (best.get(row.path)?.score ?? 0)) best.set(row.path, row);
    }
    conceptual.push(...[...best.values()].sort((a, b) => b.score - a.score || cmp(a.path, b.path)).slice(0, 3));
  }
  return { structural, testTiers, cochange: cochange.slice(0, 64), cochangeTruncated: cochange.length > 64, conceptual };
}

function resolveTarget(target, files, symbols, precise) {
  if (files.has(target)) return { file: target, symbol: '' };
  const split = target.lastIndexOf('#');
  const qualified = precise && split > 0 && files.has(target.slice(0, split));
  const name = qualified ? target.slice(split + 1) : target;
  const candidates = qualified ? symbols.filter(({ path }) => path === target.slice(0, split)) : symbols;
  const exported = filesExporting(name, candidates);
  if (exported.length === 1) {
    const file = exported[0];
    const lines = candidates.filter((row) => row.path === file && row.name === name && row.exported).map(({ line }) => line);
    return { file, symbol: name, lines };
  }
  if (exported.length === 0) {
    throw issue(`not a file or an export: ${target}`, EXIT.USAGE, 'pass a path git tracks, or the name of one export');
  }
  throw issue(`${target} is exported by ${exported.join(', ')}`, EXIT.USAGE,
    precise ? `pass <file>#${name} to select one export` : 'pass the path of the export you mean');
}

async function governance(root, paths, files, commands) {
  const [records, rules] = await Promise.all([decisionRecords(root), ruleScopes(root)]);
  const ctx = { files, commands: new Set(commands), roots: sourceRoots(files) };
  return unique([...paths].flatMap((file) => governs(file, { records, rules, ctx })),
    ({ kind, id, detail }) => JSON.stringify([kind, id, detail]));
}

async function readOwners(root, paths) {
  for (const path of CODEOWNERS_PATHS) {
    try {
      const text = await readFile(join(root, path), 'utf8');
      return unique([...paths].flatMap((file) => ownersOf(text, file)));
    } catch {
      // The next location may hold the file. GitHub reads the first that exists.
    }
  }
  return [];
}

async function contractsFor(root, files, targets, importers) {
  const contracts = [];
  for (const path of files) {
    if (!isContractPath(path) && !mightSniff(path)) continue;
    let text = '';
    try {
      text = await readFile(join(root, path), 'utf8');
    } catch {
      continue;
    }
    if (!isContractPath(path) && !sniffs(text)) continue;
    contracts.push({ path, text });
  }
  return unique(targets.flatMap(({ file, symbol }) => relatedContracts(contracts, { file, symbol, importers })));
}

async function consumersFor(root, flags, paths, targets, importers) {
  const workspace = await resolveWorkspace({ ...flags, repoRoot: root });
  if (!workspace.root) return { references: [], truncated: false };
  const found = await discover(workspace.root);
  if (found.shape !== 'workspace') return { references: [], truncated: false };
  const here = resolve(root);
  const siblings = found.repos.filter((repo) => resolve(repo) !== here);
  if (!siblings.length) return { references: [], truncated: false };
  const contracts = await contractsFor(root, paths, targets, importers);
  if (!contracts.length) return { references: [], truncated: false };
  const files = [];
  let truncated = false;
  for (const repo of siblings) {
    const listed = await tracked(repo);
    if (listed.error) continue;
    const name = basename(repo);
    let read = 0;
    for (const path of listed.files) {
      if (!textExt(path)) continue;
      if (read >= FILE_CAP) {
        truncated = true;
        break;
      }
      read += 1;
      try {
        const text = await readFile(join(repo, path), 'utf8');
        if (text.length > READ_CAP) continue;
        files.push({ repo: name, path, text });
      } catch {
        // A file git lists and the worktree no longer has is not a consumer.
      }
    }
  }
  const refs = contractReferences(contracts, basename(root), files);
  return { references: refs.references, truncated: truncated || refs.truncated };
}

function render(payload, knowledge) {
  const targets = payload.targets ?? [payload];
  if (!targets.length) return 'no changed files';
  const lines = targets.flatMap(({ file, symbol }) => [`file      ${file}`, ...(symbol ? [`symbol    ${symbol}`] : [])]);
  const tiers = new Map(Object.entries(payload.tiers ?? {}).flatMap(([tier, rows]) =>
    rows.map(({ path, hop }) => [path, `  (${tier}, hop ${hop})`])));
  for (const path of payload.importers) lines.push(`importer  ${path}${tiers.get(path) ?? ''}`);
  for (const path of payload.tests) lines.push(`test      ${path}${tiers.get(path) ?? ''}`);
  for (const { src, dst, confidence } of payload.cochange ?? []) lines.push(`cochange  ${dst}  (${src}, ${confidence.toFixed(3)})`);
  for (const { path, score } of payload.conceptual ?? []) lines.push(`concept   ${path}  (${score.toFixed(3)})`);
  if (payload.conservativeFallback) lines.push('fallback  unresolved bindings; file-level edges used where available');
  if (payload.suppressedHubMediated) lines.push(`hub paths omitted  ${payload.suppressedHubMediated}`);
  for (const hit of payload.governs) lines.push(`${hit.kind.padEnd(10)}${hit.id}  ${hit.detail}`);
  for (const owner of payload.owners) lines.push(`owner     ${owner}`);
  for (const consumer of payload.consumers) lines.push(`consumer  ${consumer.repo}/${consumer.path}  ${consumer.contract}`);
  lines.push(...knowledge);
  if (payload.truncated) lines.push('truncated  1');
  return lines.join('\n');
}

function mightSniff(file) {
  const base = file.slice(file.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  const ext = base.slice(dot + 1).toLowerCase();
  return ext === 'json' || ext === 'yaml' || ext === 'yml';
}

function sniffs(text) {
  const head = text.slice(0, 500);
  return head.includes('"openapi"') || head.includes('"$schema"');
}

function textExt(file) {
  const base = file.slice(file.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return TEXT_EXT.has(base.slice(dot + 1).toLowerCase());
}

async function tracked(root) {
  try {
    // `-z`: without it git C-quotes a non-ASCII path and the reader's real
    // filename never matches it.
    return { files: await gitPaths(root, ['ls-files']) };
  } catch (error) {
    // `issue`, not `fail`: this is a library path whose result the caller reads
    // in-process, and `fail` emits one `{ok:false}` document to stdout per call -
    // one per non-repo sibling in the workspace, wedged into the command's single
    // result document under `--json`.
    return {
      error: issue(
        `could not read the tree (${error.message})`,
        EXIT.UNSUPPORTED,
        'run this inside a git repository',
      ),
    };
  }
}
