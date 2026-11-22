import { parsePathList } from '../argv.mjs';
import { decisionRecords, lessonScopes } from '../commands/why.mjs';
import { loadRegistry } from '../graph/load.mjs';
import { decisionPaths, scopeHits, sourceRoots } from '../index/govern.mjs';
import { loadLiveGraph } from '../index/live.mjs';
import { prepareMapStructure, rankMapV2 } from '../index/map-v2.mjs';
import { testEdges, testsFor } from '../index/tests.mjs';
import { isTestPath } from '../testing/paths.mjs';
import { commandCard } from '../kernel/card.mjs';
import { fingerprint } from '../resolve/fingerprint.mjs';
import { rankSkills } from '../resolve/resolve.mjs';
import { INDEX_STOP, STOPWORDS, tokenize } from '../text/tokens.mjs';
import { cmp } from '../util/sort.mjs';
import { bindSubtaskAnchors } from './anchors.mjs';
import { detailCommands, drillFooter, subtaskCoverage } from './drilldown.mjs';
import { classifySubtaskIntents, subtaskCommands } from './kind.mjs';
import { keptSections } from './packet.mjs';
import { clusterSubtasks, orderSubtasks, subtaskLanes } from './plan-graph.mjs';
import { buildCompactPacket, compactFileLine, compactTestLine, symbolEntrypoints, taggedLine } from './render.mjs';

const TOP_FILES = 3;

function compact(value, limit) {
  const text = String(value).replace(/\s+/gu, ' ').trim();
  if (Buffer.byteLength(text) <= limit) return text;
  let used = 3;
  let prefix = '';
  for (const point of text) {
    used += Buffer.byteLength(point);
    if (used > limit) break;
    prefix += point;
  }
  return prefix.trimEnd() + '…';
}

function candidatePool(section, tagged) {
  const pool = new Map();
  return {
    add(facet, key, render, id, score = 1, hard = false) {
      if (section !== null && section !== facet) return;
      const identity = JSON.stringify([facet, key]);
      const row = pool.get(identity) ?? { render, facet, relevance: new Map(), hard: false };
      row.hard ||= hard;
      row.relevance.set(id, Math.max(score, row.relevance.get(id) ?? 0));
      pool.set(identity, row);
    },
    items() {
      return [...pool].map(([id, row], order) => {
        const subtaskIds = [...row.relevance.keys()].filter((value) => value !== 0).sort((a, b) => a - b);
        const ids = tagged ? subtaskIds : [];
        const text = typeof row.render === 'function' ? row.render(ids) : taggedLine(row.render, ids);
        return {
          id, order, section: row.facet, text, subtaskIds,
          priority: row.hard ? 'hard' : 'soft',
          relevance: [...row.relevance].map(([subtask, score]) => ({ subtask, score })),
          why: ['evidence for the named subtasks'],
        };
      });
    },
  };
}

function targetedPaths(query, files) {
  const suffixes = new Set([...query.matchAll(/(?:[\w@-]+\/)*[\w@-]+\.[\w.-]+/gu)]
    .map(([name]) => name.replace(/[.]+$/u, '')));
  const words = new Set(tokenize(query).filter((word) => word.length > 3 && !STOPWORDS.has(word) && !INDEX_STOP.has(word)
    && word !== 'tests' && word !== 'test'));
  const explicit = files.filter(({ path }) => [...suffixes].some((name) => path === name || path.endsWith('/' + name)));
  const topic = new Map();
  for (const { path } of files) {
    const parts = path.split('/');
    const base = parts.pop().split('.')[0].toLowerCase();
    const score = Number(words.has(base)) * 2 + Number(parts.some((part) => words.has(part.toLowerCase())));
    if (score) topic.set(path, score);
  }
  return { explicit, topic };
}

async function retrieveSubtasks(root, graph, tasks, allowed) {
  const queries = new Map();
  let structure;
  return Promise.all(tasks.map(async (task) => {
    if (!task.query) return { ...task, files: [], feedback: null, evidence: [] };
    const excluded = new Set(task.excludedPaths);
    const key = JSON.stringify([task.query, task.excludedPaths]);
    const include = ({ path }) => !excluded.has(path) && (allowed === null || allowed.has(path));
    const explicit = task.anchors.filter(({ kind }) => kind === 'path' || kind === 'suffix');
    if (explicit.length) {
      const paths = [...new Set(explicit.map(({ path }) => path))].slice(0, TOP_FILES);
      return { ...task, files: paths.map((path) => ({ path, rank: 1, resolver: 1 })),
        feedback: { reason: 'exact-anchor', expansion: [] },
        evidence: paths.map((path) => ({ path, channels: { entity: { matches: explicit.filter((row) => row.path === path) } } })),
      };
    }
    const testIntent = /\btests?\b/iu.test(task.query);
    const files = graph.files.filter((file) => include(file) && (testIntent || !isTestPath(file.path, root) || task.anchors.some(({ path }) => path === file.path)));
    const target = targetedPaths(task.query, files);
    const codeTopics = files.filter(({ path, lang }) => target.topic.has(path) && lang);
    const family = codeTopics.length && codeTopics.length <= TOP_FILES * 6
      ? codeTopics
      : target.topic.size && target.topic.size <= TOP_FILES * 6
        ? files.filter(({ path }) => target.topic.has(path)) : files;
    const restricted = target.explicit.length ? target.explicit : family;
    const eligible = new Set(restricted.map(({ path }) => path));
    const anchored = [...new Set(task.anchors.map(({ path }) => path))];
    if (target.explicit.length && target.explicit.length <= TOP_FILES) {
      const paths = [...eligible].sort(cmp);
      return { ...task, files: paths.map((path) => ({ path, rank: 0, resolver: 0 })),
        feedback: { reason: 'ambiguous-path', expansion: [] },
        evidence: paths.map((path) => ({ path, channels: { entity: { ambiguous: true } } })),
      };
    }
    if (!queries.has(key)) {
      const local = {
        ...graph, files: restricted, symbols: graph.symbols.filter(({ path }) => eligible.has(path)),
        fieldedRows: graph.fieldedRows.filter(({ ref }) => eligible.has(ref)),
      };
      structure ??= prepareMapStructure(graph);
      queries.set(key, rankMapV2(root, local, task.query, { explain: true, coupling: false, structure, exactOnly: graph.nativeLexical }));
    }
    const rank = await queries.get(key);
    const byPath = new Map(rank.ranked.map((row) => [row.path, row]));
    const topics = rank.ranked.filter(({ path }) => target.topic.has(path)).sort((a, b) =>
      target.topic.get(b.path) - target.topic.get(a.path) || b.rank - a.rank || cmp(a.path, b.path));
    const ranked = [...new Set([...anchored, ...topics.map(({ path }) => path), ...rank.ranked.map(({ path }) => path), ...eligible])];
    const candidates = ranked.slice(0, TOP_FILES).map((path) => byPath.get(path) ?? { path, rank: 0, resolver: Number(anchored.includes(path)) });
    const selected = new Set(candidates.map(({ path }) => path));
    return { ...task, files: candidates, feedback: rank.feedback, evidence: rank.evidence.filter(({ path }) => selected.has(path)) };
  }));
}

export async function assembleCompositeBrief({ root, task, parts, paths, budget, flags, build, commands, section, subtask = null }) {
  const need = (facets) => section === null || facets.includes(section);
  const [graph, repo, registry, records, lessons] = await Promise.all([
    loadLiveGraph(root, { build, fielded: true, nativeLexical: true, binding: true }),
    fingerprint(root),
    need(['SKILLS', 'CAUTIONS']) ? loadRegistry(null, { ...flags, root }) : null,
    need(['DECISIONS']) ? decisionRecords(root) : [],
    need(['LESSONS']) ? lessonScopes(root) : [],
  ]);
  if (graph.cold) return graph;
  const named = paths === null ? null : parsePathList(paths);
  const allowed = named === null ? null : new Set(named);
  const bound = bindSubtaskAnchors(parts, graph, { paths: named, scopes: repo.manifest?.work?.scopes });
  const ranked = await retrieveSubtasks(root, graph, bound, allowed);
  const { kind, tasks, obligations } = classifySubtaskIntents(clusterSubtasks(ranked));
  const basis = tasks.length > 1 ? 'the widest kind across ' + tasks.length + ' subtasks' : tasks[0]?.intent?.basis ?? 'no positive action';
  const plan = orderSubtasks(tasks, graph);
  const { lanes, overlaps, lines } = subtaskLanes(tasks);
  const filePaths = new Set(graph.files.map(({ path }) => path));
  const card = need(['COMMANDS', 'DECISIONS']) ? await commandCard({ root, manifest: repo.manifest, stack: repo.stack, facts: repo.facts }) : { lines: [] };
  const scope = named ?? [...new Set(tasks.flatMap(({ anchors }) => anchors.map(({ path }) => path)))].sort(cmp);
  const candidates = candidatePool(section, tasks.length > 1);
  const add = candidates.add;
  add('TASK', 'kind', 'kind ' + kind + ' — ' + basis, 0, 1, true);
  if (tasks.length <= 1) add('TASK', 'task', compact(subtask === null ? task : tasks[0].text, 180), 0, 1, true);
  for (const row of subtaskCommands(tasks, card).commands) {
    for (const id of row.subtasks) add('COMMANDS', row.command, row.label + '  ' + row.command, id, 1, ['test', 'focused'].includes(row.verb));
  }
  if (tasks.length > 1) {
    for (const line of lines) add('SUBTASKS', line, compact(line, 170), 0, 0.3);
    for (const subject of tasks) {
      add('SUBTASKS', String(subject.id), (ids) => taggedLine(compact(subject.text, 78), ids), subject.id, 1, true);
    }
  }

  const symbols = new Map();
  for (const symbol of graph.symbols) {
    const bucket = symbols.get(symbol.path) ?? [];
    bucket.push(symbol);
    symbols.set(symbol.path, bucket);
  }
  const entrypoints = symbolEntrypoints(graph.symbolGraph?.edges ?? []);
  const tests = need(['TESTS', 'CAUTIONS']) ? testEdges({ files: graph.files, imports: graph.edges }, { root }) : [];
  const likelyPaths = new Set(tasks.flatMap(({ files }) => files.map(({ path }) => path)));
  const decisionContext = { files: likelyPaths, commands: new Set(commands), roots: sourceRoots(filePaths) };
  const recordById = new Map(records.map((record) => [record.id, record]));
  const governed = decisionPaths(records, decisionContext);
  const byId = new Map(tasks.map((row) => [row.id, row]));

  for (const subject of tasks) {
    const id = subject.id;
    const likely = subject.files.map(({ path }) => path);
    for (const [index, path] of likely.entries()) {
      const weight = 1 / (1 + index * 0.7);
      add('FILES', path, (ids) => {
        const query = ids.length ? ids.map((value) => byId.get(value).query).join(' ') : subject.query;
        return compactFileLine(path, symbols.get(path) ?? [], query, { entrypoints, subtasks: ids });
      }, id, weight);
      const reachable = isTestPath(path, root) ? [path] : testsFor(path, tests);
      if (reachable.length) add('TESTS', path, (ids) => compactTestLine(path, reachable, { subtasks: ids }), id, weight);
      else if (index === 0) add('CAUTIONS', 'test:' + path, 'No direct test recorded for ' + path, id, 0.5);

      if (records.length) {
        for (const decision of governed.get(path) ?? []) {
          add('DECISIONS', decision.id, decision.id + ' — ' + compact(decision.detail, 60), id, weight);
        }
      }
    }
    for (const key of subject.decisions) {
      const record = recordById.get(key);
      if (record) add('DECISIONS', key, key + ' — ' + compact(record.title, 60), id, 1);
    }
    for (const caution of subject.cautions) add('CAUTIONS', caution, caution, id, 1, true);
    if (!likely.length && subject.query) add('CAUTIONS', 'no-match:' + id, 'No eligible files resolved for this subtask.', id, 1);
    if (registry?.ok) {
      const evidence = rankSkills(registry.registry.skills, {
        repoStack: repo.signals, taskTokens: tokenize(subject.query), paths: likely, tree: [...filePaths],
      });
      for (const row of evidence.selected.filter(({ skill }) => !skill.deferred).slice(0, 2)) {
        add('SKILLS', row.skill.name, row.skill.name + ' — ' + row.skill.bytes + ' B', id, 1);
      }
    }
    for (const lesson of lessons) {
      if (likely.some((path) => scopeHits(path, { lessons: [lesson] }).length)) {
        add('LESSONS', lesson.id, lesson.id + ' — ' + compact(lesson.detail, 74), id, 1);
      }
    }
  }
  if (graph.stale) add('CAUTIONS', 'stale', 'The live index has incomplete source evidence. Run simt index --retrieval v2.', 0, 1, true);

  const items = candidates.items();
  const drillDown = detailCommands(task, tasks, { paths: named, selected: subtask });
  const footerBytes = Math.min(350, Math.floor(budget / 4));
  const packed = buildCompactPacket(items, { budget, footer: drillFooter(tasks, drillDown, footerBytes), footerBytes });
  const constraints = tasks.flatMap(({ id, constraints: rows }) => rows.map((row) => ({ subtaskId: id, ...row })));
  return {
    root, kind, basis, task, scope, budget, items, packed,
    sections: keptSections(items, packed.cut),
    composite: {
      retrieval: 'v2', subtasks: tasks, lanes, overlaps, taskOrder: { ...plan, obligations },
      constraints, subtaskCoverage: subtaskCoverage(tasks, items, packed.cut), drillDown,
      ...(subtask === null ? {} : { selectedSubtask: subtask }),
    },
  };
}
