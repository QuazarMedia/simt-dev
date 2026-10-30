// The packet, assembled — one implementation behind three doors.
//
// `simt brief` prints it, MCP's `brief` tool returns it as a payload, and a prompt-submit
// hook delivers it into a conversation. The three differ in how the bytes leave — stdout,
// a JSON result, a harness's own context key — and in nothing else, so the assembly lives
// here and each caller renders. A second copy of this logic would be a second answer to
// "what does this repository know about this task", and the two would drift the first time
// a section gained a caution.
//
// The two properties that make a packet worth reading belong to the assembly, not to any
// one renderer:
//
//   * Deterministic, until the repository names a server. No clock, no locale, no network,
//     no environment beyond the paths git reports, so the same tree gives the same items —
//     which is what makes a packet reviewable: a diff in a packet is a diff in what every
//     agent reads next. The one exception is opt-in and declared: a `federation` block in
//     the manifest lets the packet cite an external server's answer, and that answer is
//     cited precisely because it is the one item a reader cannot reproduce from the tree.
//   * Cheap. Warm, this reads the index, the command card, the decisions, the lesson
//     scopes and the skill registry, and walks nothing else. `simt tests <path>` is the
//     authoritative selector for the tests of a file — it reads test blobs and commit
//     history to find multi-line and dynamic imports — and this deliberately does not,
//     because a brief is delivered on every prompt submit and 300 ms is the bar for that
//     (plan 0003 R29).
//
// `build` is the one behaviour that depends on the caller. A delivered packet passes
// `build: false`, so the first prompt in a fresh clone reports a cold index instead of
// waiting on a repository walk; the command and the MCP tool, which a person asked for,
// build the index they need.
//
// `federate` is the second, and it exists to keep the delivery's latency promise honest: a
// packet delivered into a prompt submits within 300 ms, and starting someone else's server
// is not a wait a prompt submit may take, so that one caller turns federation off. The
// command and the tool leave it on. It is inert either way in a repository that declared no
// servers.

import { CLI, STATE_DIR } from '../name.mjs';
import { DEFAULT_BRIEF_BYTES, buildPacket, collect } from './packet.mjs';
import { classifyTask, cardVerbs } from './kind.mjs';
import { briefAdvice } from '../advice/advice.mjs';
import { commandCard } from '../kernel/card.mjs';
import { decisionHits, scopeHits, sourceRoots } from '../index/govern.mjs';
import { embedTaskQuery, rankFiles, renderMap } from '../index/map.mjs';
import { searchFtsBm25 } from '../index/store.mjs';
import { testEdges, testsFor } from '../index/tests.mjs';
import { loadRegistry } from '../graph/load.mjs';
import { fingerprint } from '../resolve/fingerprint.mjs';
import { closure, rankSkills, selectWithinBudget, tokenize } from '../resolve/resolve.mjs';
import { loadGraph } from '../commands/map.mjs';
import { dirtyPaths, parsePathList } from '../commands/skills.mjs';
import { decisionRecords, lessonScopes } from '../commands/why.mjs';
import { readFederation } from '../federation/config.mjs';
import { consult } from '../federation/query.mjs';

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
 * between two identical commands is not the packet this promises. The tool's own scratch
 * space is never part of a task's scope.
 */

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

/**
 * Assemble one packet for a task.
 *
 * @param {object} [options]
 * @param {string} [options.root] the repository
 * @param {string} [options.task] the task text; the empty string is a legitimate task
 * @param {string|null} [options.paths] a `--paths` string, or null to take the scope from
 *   the files git reports as modified
 * @param {number} [options.budget] the byte ceiling; 0 means the whole packet, which no
 *   delivered brief may ask for
 * @param {object} [options.flags] passed through to the skill registry loader
 * @param {boolean} [options.build] whether an empty index may be built here
 * @param {boolean} [options.federate] whether a declared external server may be asked one
 *   question; a delivered packet turns it off to keep its 300 ms bar
 * @returns a packet, or `{ error }` carrying the exit code a failure already reported, or
 *   `{ cold: true }` when the index is empty and this caller may not build one
 */
export async function assembleBrief({
  root = process.cwd(),
  task = '',
  paths = null,
  budget = DEFAULT_BRIEF_BYTES,
  flags = {},
  build = true,
  federate = true,
} = {}) {
  const named = paths !== null;
  const dirty = (await dirtyPaths(root)).filter((path) => !path.startsWith(`${STATE_DIR}/`));
  const scope = named ? parsePathList(paths) : dirty;

  const graph = await loadGraph(root, { build });
  if (graph.error) return { error: graph.error };
  if (graph.cold) return { cold: true };
  const graphStale = graph.stale === true;
  const { files, symbols, edges, fts = [], embeddings = [] } = graph;
  const filePaths = new Set(files.map((file) => file.path));

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
  if (graphStale) {
    packet.add('CAUTIONS', 'the index predates the current tree, so files added or removed since the last build are missing or ghosted', {
      why: ['this caller may not rebuild the index; run a command that can before quoting the file list'],
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

  const bm25 = task.trim().length > 0 ? await searchFtsBm25(root, task, { fts }) : [];
  const queryVector =
    flags?.embed === true && embeddings.length > 0
      ? await embedTaskQuery(root, task, {
          embed: true,
          allowRemote: flags?.allowRemote === true,
        })
      : null;
  const ranked = rankFiles({ files, symbols, edges, fts, bm25, embeddings, queryVector, task });
  const rendered = renderMap(ranked, symbols, { level: 'names', budget: budget > 0 ? budget * MAP_FACTOR : 0 });
  for (const line of rendered.text.split('\n')) {
    packet.add('FILES', line, { why: ['ranked by the task words against the import graph'] });
  }
  if (rendered.truncated) {
    packet.add('CAUTIONS', `the map held back ${rendered.total - rendered.shown} of ${rendered.total} files`, {
      why: [`\`${CLI} map --budget 0\` lists them all`],
    });
  }

  // Model and effort advice comes from the repository's bench history, not from anything a
  // model produced, so it stays deterministic. The tier exists only if the history resolved
  // a similar task, and the claim travels with its own numbers and its unmeasured accept
  // bar; simt-dev never selects the model an agent runs (plan 0003 R40).
  const advice = await briefAdvice(root, { task, scope, kind });
  if (advice?.picked) {
    packet.add('ADVICE', advice.picked.line, {
      why: ['the tier is the estate’s own bench ladder, and a human still names the model'],
    });
    packet.add('ADVICE', advice.picked.basis, {
      why: ['an advice claim names the neighborhood that backs it, so the reader can re-derive it'],
    });
    packet.add('ADVICE', advice.picked.metric, {
      why: ['the row has an accept bar, and nothing in a packet may claim the bar was met'],
    });
  } else if (advice?.caution) {
    packet.add('CAUTIONS', advice.caution, {
      why: ['advice without a neighborhood is a guess dressed as history'],
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
    files: filePaths,
    commands: new Set(card.lines.map((line) => line.command)),
    roots: sourceRoots([...filePaths]),
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

  if (federate) {
    const { servers, findings } = await readFederation(root);
    for (const finding of findings) {
      packet.add('CAUTIONS', `federation: ${finding}`, {
        why: ['a server the manifest names is skipped rather than guessed at'],
      });
    }
    if (servers.length > 0) {
      for (const server of servers) {
        if (server.languages.length > 0) {
          packet.add('FEDERATION', `${server.name} covers ${[...server.languages].sort().join(', ')}`, {
            why: ['the answer for a covered language can come from this server'],
          });
        }
      }
      // One question, and the task is the question. With no task text there is still a
      // question worth asking — the file the index ranks highest — and with neither there
      // is nothing to ask, which is a caution rather than a fabricated query.
      const question = task.trim().length > 0 ? task.trim() : (likely[0] ?? '');
      if (question.length === 0) {
        packet.add('CAUTIONS', 'federation is declared but this packet has no task to ask about', {
          why: ['a structural question needs something to be about'],
        });
      } else {
        const asked = await consult({ root, query: question, servers });
        for (const answer of asked.answers) {
          packet.add('FEDERATION', `${answer.server} — ${answer.text}`, {
            why: [`\`${answer.server}\`, declared under \`federation.servers\`, answered \`${answer.tool}\``],
          });
        }
        for (const finding of asked.findings) {
          packet.add('CAUTIONS', `federation: ${finding}`, {
            why: ['the brief carries on; a server that is down is not a task that cannot start'],
          });
        }
      }
    }
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

  const lessonTargets = [...new Set([...scope, ...likely])];
  const taskTokenSet = new Set(tokenize(task));
  for (const lesson of await lessonScopes(root)) {
    const pathHits = lessonTargets.flatMap((path) => scopeHits(path, { lessons: [lesson] }));
    const keywordMatch =
      pathHits.length === 0 &&
      Array.isArray(lesson.keywords) &&
      lesson.keywords.some((kw) => taskTokenSet.has(String(kw).toLowerCase())) &&
      [...filePaths].some((path) => scopeHits(path, { lessons: [lesson] }).length > 0);
    if (pathHits.length > 0 || keywordMatch) {
      const body =
        lesson.paragraph && lesson.paragraph !== lesson.detail
          ? `${lesson.detail}: ${lesson.paragraph.replace(/\s+/g, ' ').trim()}`
          : lesson.detail;
      packet.add('LESSONS', `${lesson.id} — ${body}`, {
        why: [pathHits.length > 0 ? 'a lesson names a path this task will touch' : 'a lesson trigger matches this task'],
      });
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

  return { root, kind, basis, task, scope, budget, items: packet.items, packed, sections };
}
