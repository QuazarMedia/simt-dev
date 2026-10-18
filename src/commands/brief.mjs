// `simt brief "<task>"` — one packet, under a byte ceiling (plan 0003 R27).
//
// What this is for: an agent that has to explore a repository to find out how to run its
// tests, which files the task will touch and what governs them spends turns discovering
// what the repository already knows. The packet is that answer, assembled from the index
// the repository already has, in the bytes a prompt can carry.
//
// Two properties are load-bearing, and neither is negotiable:
//
//   * Deterministic. No clock, no locale, no network, no environment beyond the paths git
//     reports. The same tree gives the same bytes, which is what makes a packet
//     reviewable: a diff in a packet is a diff in what every agent reads next.
//   * Cheap. Warm, this runs without walking history or blobs. It reads the index, the
//     command card, the decisions, the lesson scopes and the skill registry — nothing
//     else. `simt tests <path>` is the authoritative selector for the tests of a file,
//     and it reads test blobs and commit history to find multi-line and dynamic imports;
//     this command deliberately does not, because a brief is delivered on every prompt
//     submit and 300 ms is the bar R29 sets for it.
//
// Where those two meet, the packet says so rather than guessing: the TESTS section lists
// the tests the index already knows — the files that import a likely file, and their
// conventional neighbours — and it names the command that knows more.
//
// One thing is deliberately missing: `skills brief` keeps its own behaviour, and MCP's
// `skills_brief` keeps its own shape. Superseding them changes two accepted decisions
// (ADR-035, ADR-052) and the MCP contract, and this slice carries no ADR to do it.

import { CLI } from '../name.mjs';
import { EXIT, emit, emitJson, fail, isJson } from '../output/index.mjs';
import { classifyTask, cardVerbs } from '../brief/kind.mjs';
import { DEFAULT_BRIEF_BYTES, buildPacket, collect, explainPacket } from '../brief/packet.mjs';
import { commandCard } from '../kernel/card.mjs';
import { decisionHits, scopeHits, sourceRoots } from '../index/govern.mjs';
import { rankFiles, renderMap } from '../index/map.mjs';
import { SQLITE_FILE } from '../index/persist.mjs';
import { readEdges } from '../index/store.mjs';
import { testEdges, testsFor } from '../index/tests.mjs';
import { loadRegistry } from '../graph/load.mjs';
import { fingerprint } from '../resolve/fingerprint.mjs';
import { closure, rankSkills, selectWithinBudget, tokenize } from '../resolve/resolve.mjs';
import { loadGraph } from './map.mjs';
import { dirtyPaths, parsePathList } from './skills.mjs';
import { decisionRecords, lessonScopes } from './why.mjs';

/**
 * How many ranked files the packet may consider as candidates for other sections.
 *
 * The FILES section is bounded by the budget, but TESTS and DECISIONS are asked "what
 * covers the likely files" — a question a packet of any size can only answer about a
 * handful of files before the answer stops being about the task.
 */
const LIKELY_FILES = 3;

/**
 * How generously the map is allowed to render before the packet's own budget trims it.
 *
 * The packer can only drop what it is given, so the candidate list needs a bound. Eight
 * times the ceiling is that bound: large enough that the trimmed packet is a choice about
 * relevance rather than an artefact of the cut, and small enough that a brief on an
 * enormous repository never renders the whole map.
 */
const MAP_FACTOR = 8;

/**
 * The tool's own state directory, read from the path the index is written to.
 *
 * A brief asks git what a task touches, and the index it just read the answer from is a
 * write: in a repository that has not gitignored this directory, the second run of the
 * same brief would report a dirty path the first one did not, and a packet that changes
 * between two identical commands is not the packet this command promises. The tool's own
 * scratch space is never part of a task's scope.
 */
const STATE_DIR = `${SQLITE_FILE.split('/')[0]}/`;

/** Every file git tracks that carries a generated region, one `git grep` away. */
async function generatedRegions(root) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  try {
    const { stdout } = await promisify(execFile)(
      'git',
      ['grep', '-lF', '--', `${'simt'}:begin`],
      { cwd: root, maxBuffer: 8 << 20 },
    );
    return stdout.split('\n').filter((line) => line.length > 0).sort();
  } catch {
    // No match is exit 1, and a directory that is not a repository fails too. Both mean
    // the same thing to a reader: no generated region was found to warn about.
    return [];
  }
}

export async function briefCommand(args, flags) {
  if (args.length > 1) {
    return fail(`brief takes one task, not ${args.length}`, EXIT.USAGE, `run: ${CLI} brief "<task>"`);
  }
  if (args.length === 1 && flags.task !== undefined) {
    return fail('the task was passed twice, as an argument and as --task', EXIT.USAGE, `run: ${CLI} brief "<task>"`);
  }
  const budget = flags.budget === undefined ? DEFAULT_BRIEF_BYTES : Number(flags.budget);
  if (!Number.isInteger(budget) || budget < 0) {
    return fail(`--budget must be a byte count, not ${flags.budget}`, EXIT.USAGE, `run: ${CLI} brief --budget ${DEFAULT_BRIEF_BYTES}`);
  }

  const root = flags.root ?? process.cwd();
  const task = String(args[0] ?? flags.task ?? '');
  const named = flags.paths !== undefined;
  const dirty = (await dirtyPaths(root)).filter((path) => !path.startsWith(STATE_DIR));
  const scope = named ? parsePathList(flags.paths) : dirty;

  const graph = await loadGraph(root);
  if (graph.error) return graph.error;
  const { files, symbols, edges } = graph;
  const paths = new Set(files.map((file) => file.path));

  const { kind, basis } = classifyTask(task, { paths: scope });
  const packet = collect();
  packet.add('TASK', `kind ${kind} — ${basis}`, {
    hard: true,
    why: ['the kind chooses the commands, and the commands are the part a reader cannot recover from a wrong guess'],
  });
  packet.add('TASK', `task ${task.length > 0 ? task : '(none given)'}`, { hard: true, why: ['the packet is an answer to this'] });
  packet.add('TASK', `scope ${scope.length > 0 ? scope.join(', ') : 'the whole repository'}`, {
    why: [named ? 'named with --paths' : 'taken from the files git reports as modified'],
  });
  if (task.length === 0 && !named) {
    packet.add('CAUTIONS', 'no task was given, so the packet describes the working tree rather than a task', {
      why: ['an unasked question has no answer to be short of'],
    });
  }

  const repo = await fingerprint(root);
  const card = await commandCard({ root, manifest: repo.manifest ?? null, stack: repo.stack, facts: repo.facts });
  const wanted = cardVerbs(kind);
  const chosen = card.lines.filter((line) => wanted.includes(line.verb));
  for (const line of chosen.length > 0 ? chosen : card.lines) {
    packet.add('COMMANDS', `${line.label}  ${line.command}`, {
      hard: line.verb === 'test' || line.verb === 'focused',
      why: [`the ${kind} kind needs ${line.verb}`],
    });
  }
  if (card.lines.length === 0) {
    packet.add('CAUTIONS', 'the repository declares no evidence of how it is built, so no command was offered', {
      why: ['a card is read from committed evidence, never invented from a guess'],
    });
  }
  for (const verb of card.dropped) {
    packet.add('COMMANDS', `dropped by the card's own 600-byte ceiling: ${verb}`, {
      why: ['the card keeps its own budget before this packet spends any of it'],
    });
  }

  const ranked = rankFiles({ files, symbols, edges, task });
  const rendered = renderMap(ranked, symbols, { level: 'names', budget: budget > 0 ? budget * MAP_FACTOR : 0 });
  for (const line of rendered.text.split('\n')) {
    packet.add('FILES', line, { why: ['ranked by the task words against the import graph'] });
  }
  if (rendered.truncated) {
    packet.add('CAUTIONS', `the map held back ${rendered.total - rendered.shown} of ${rendered.total} files`, {
      why: [`\`${CLI} map --budget 0\` lists them all`],
    });
  }

  const likely = ranked.slice(0, LIKELY_FILES).map((row) => row.path);
  const known = testEdges({ files, imports: edges.filter((edge) => edge.kind === 'import') });
  const untested = [];
  packet.add('TESTS', `the index knows direct importers; \`${CLI} tests <path>\` is the authority for multi-line and dynamic imports`, {
    why: ['a cheap packet and an exact answer are different questions'],
  });
  for (const path of likely) {
    const found = testsFor(path, known);
    if (found.length === 0) untested.push(path);
    else packet.add('TESTS', `${path} -> ${found.join(' ')}`, { why: ['the test imports it, or sits beside it'] });
  }

  const records = await decisionRecords(root);
  const ctx = {
    files: paths,
    commands: new Set(card.lines.map((line) => line.command)),
    roots: sourceRoots([...paths]),
  };
  const decisions = new Map();
  const unresolved = new Set();
  for (const path of likely) {
    const hit = decisionHits(records, path, ctx);
    for (const entry of hit.hits) if (!decisions.has(entry.id)) decisions.set(entry.id, { ...entry, path });
    for (const entry of hit.unresolved) unresolved.add(entry.token);
  }
  for (const id of [...decisions.keys()].sort()) {
    const entry = decisions.get(id);
    packet.add('DECISIONS', `${entry.id} — ${entry.detail}`, { why: [`names ${entry.path}`] });
  }
  if (unresolved.size > 0) {
    packet.add('CAUTIONS', `decisions name tokens nothing resolves: ${[...unresolved].sort().join(', ')}`, {
      why: [`\`${CLI} why\` reports them`],
    });
  }

  const loaded = await loadRegistry(null, flags);
  if (!loaded.ok) {
    packet.add('CAUTIONS', `the skill registry did not load (${loaded.errors[0]}), so no skill was offered`, {
      why: ['every other section is independent of the registry, which is why this is a caution and not a failure'],
    });
  } else {
    const rankedSkills = rankSkills(
      loaded.registry.skills,
      { repoStack: repo.signals, taskTokens: tokenize(task), paths: scope },
      { forced: [] },
    );
    const expanded = closure(rankedSkills.selected, loaded.registry.skills);
    const allowance = budget > 0 ? Math.floor(budget / 4) : 0;
    const selection = selectWithinBudget(expanded, { budget: allowance, all: false });
    for (const entry of selection.picked) {
      const reasons = [...entry.reasons];
      packet.add('SKILLS', `${entry.skill.name} — ${entry.skill.bytes} B, ${reasons.join(' ')}`, {
        why: [`\`${CLI} skills show ${entry.skill.name}\` reads the body`],
      });
    }
    if (selection.deferred.length > 0) {
      packet.add('CAUTIONS', `skills held back for the budget: ${selection.deferred.map((entry) => entry.skill.name).sort().join(', ')}`, {
        why: ['a body is not worth a command that cannot be run'],
      });
    }
  }

  for (const lesson of await lessonScopes(root)) {
    const hits = likely.flatMap((path) => scopeHits(path, { lessons: [lesson] }));
    if (hits.length > 0) {
      packet.add('LESSONS', `${lesson.id} — ${lesson.detail}`, { why: ['a lesson names a path this task will touch'] });
    }
  }

  const generated = await generatedRegions(root);
  if (generated.length > 0) {
    packet.add('CAUTIONS', `generated — edit the source, not these: ${generated.join(', ')}`, {
      why: ['a hand edit inside a generated region is overwritten by the next projection'],
    });
  }
  if (untested.length > 0) {
    packet.add('CAUTIONS', `the index knows no test for ${untested.join(', ')}`, {
      why: [`\`${CLI} tests <path>\` reads the blobs and may know one`],
    });
  }
  if (named && dirty.length > 0) {
    const outside = dirty.filter((path) => !scope.includes(path));
    if (outside.length > 0) {
      packet.add('CAUTIONS', `dirty and outside the scope, leave alone: ${outside.join(', ')}`, {
        why: ['a change nobody asked for is a change nobody reviews'],
      });
    }
  }

  const packed = buildPacket(packet.items, { budget });
  const cut = new Set(packed.cut);
  const sections = {};
  for (const item of packet.items) {
    if (cut.has(item.id)) continue;
    sections[item.section] ??= [];
    sections[item.section].push(item.text);
  }

  if (isJson(flags)) {
    emitJson(
      {
        ok: true,
        command: 'brief',
        root,
        kind,
        basis,
        task,
        scope,
        budget,
        bytes: packed.after,
        before: packed.before,
        floorHeld: packed.floorHeld,
        cut: packed.cut,
        sections,
        explain: flags.explain === true ? explainPacket(packet.items, { cut }) : undefined,
        text: packed.text,
      },
      { pretty: flags.pretty === true, maxBytes: Number(flags.maxBytes ?? 0) || 0 },
    );
    return EXIT.OK;
  }

  const body = flags.explain === true ? [packed.text, '', 'EXPLAIN', ...explainPacket(packet.items, { cut })] : [packed.text];
  emit(body.join('\n'), { maxBytes: Number(flags.maxBytes ?? 0) || 0 });
  return EXIT.OK;
}
