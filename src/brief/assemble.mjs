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
//
// `build` is the one behaviour that depends on the caller. A delivered packet passes
// `build: false`, so the first prompt in a fresh clone reports a cold index instead of
// waiting on a cold extraction; interactive callers can read the missing staged evidence
// for the current packet.
//
// `federate` is the second, and it exists to keep the delivery's latency promise honest: a
// packet delivered into a prompt submits within 300 ms, and starting someone else's server
// is not a wait a prompt submit may take, so that one caller turns federation off. The
// command and the tool leave it on. It is inert either way in a repository that declared no
// servers.

import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { CLI, STATE_DIR } from '../name.mjs';
import { parse as parseRegion } from '../projection/markers.mjs';
import { assembleScopedBrief } from './local-work.mjs';
import { DEFAULT_BRIEF_BYTES, PROMPT_CAP_BYTES, buildPacket, collect, keptSections } from './packet.mjs';
import { buildProofPacket } from './proof.mjs';
import { classifyTask, cardVerbs } from './kind.mjs';
import { briefAdvice } from '../advice/advice.mjs';
import { commandCard } from '../kernel/card.mjs';
import { decisionHits, scopeHits, sourceRoots } from '../index/govern.mjs';
import { rankFiles, renderMap, spelledPaths } from '../index/map.mjs';
import { embedTaskQuery } from '../index/vectors.mjs';
import { searchFtsBm25 } from '../index/store.mjs';
import { coverage } from '../index/coverage.mjs';
import { loadRegistry } from '../graph/load.mjs';
import { fingerprint } from '../resolve/fingerprint.mjs';
import { closure, rankSkills } from '../resolve/resolve.mjs';
import { tokenize } from '../text/tokens.mjs';
import { loadLiveGraph } from '../index/live.mjs';
import { dirtyPaths, parsePathList } from '../commands/skills.mjs';
import { decisionRecords, lessonScopes } from '../commands/why.mjs';
import { readFederation } from '../federation/config.mjs';
import { consult } from '../federation/query.mjs';
import { gitText } from '../sys/git.mjs';

/**
 * How many ranked files the packet may consider as candidates for other sections.
 *
 * The FILES section is bounded by the budget, but TESTS and DECISIONS are asked "what
 * covers the likely files" — a question a packet of any size can only answer about a
 * handful of files before the answer stops being about the task.
 */
const LIKELY_FILES = 3;
/** Skill names a packet carries: enough for the task's own path plus its closure. */
const SKILL_NAMES = 4;

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
 * The directory the knowledge doors read their inputs from.
 *
 * Its presence is what gates the pointer below and, in the projection, the
 * knowledge rule: a repository that authored no inputs has nothing to point at,
 * and a packet that pointed at a directory that is not there would be a caution
 * about the tool rather than a fact about the tree.
 */
const KNOWLEDGE_DIR = '.simt/knowledge';

/**
 * The six conventional inputs, each named for the door it feeds.
 *
 * `src/knowledge/inputs.mjs` validates these files against the doors' reader
 * contracts; this table only names them, so the pointer never carries a claim's
 * content and cannot disagree with a reader about what a door reads.
 */
const KNOWLEDGE_DOORS = [
  { name: 'why', file: 'claims.json', usage: `${CLI} knowledge why <claim-id> --claims ${KNOWLEDGE_DIR}/claims.json` },
  { name: 'rank', file: 'units.json', usage: `${CLI} knowledge rank --input ${KNOWLEDGE_DIR}/units.json` },
  { name: 'debt', file: 'debt.json', usage: `${CLI} knowledge debt --input ${KNOWLEDGE_DIR}/debt.json` },
  { name: 'impact', file: 'impact.json', usage: `${CLI} knowledge impact --input ${KNOWLEDGE_DIR}/impact.json` },
  { name: 'derivations', file: 'derivations.json', usage: `${CLI} knowledge derivations --input ${KNOWLEDGE_DIR}/derivations.json` },
  { name: 'import', file: 'export.json', usage: `${CLI} knowledge import --input ${KNOWLEDGE_DIR}/export.json` },
];

/**
 * The tool's own state directory, read from the path the index is written to.
 *
 * A brief asks git what a task touches, and the index it just read the answer from is a
 * write: in a repository that has not gitignored this directory, the second run of the
 * same brief would report a dirty path the first one did not, and a packet that changes
 * between two identical commands is not the packet this promises. The tool's own scratch
 * space is never part of a task's scope.
 */

/**
 * Every file git tracks that carries a generated region, one `git grep` away.
 *
 * A file that merely mentions the marker is not carrying a region: a rule file, a review
 * and this test all quote `simt:begin`, and warning that they are generated sends a reader
 * to edit a source file that has no generated bytes at all. The grep is
 * only the candidate list; the region parser decides.
 */
async function generatedRegions(root) {
  const { readFile } = await import('node:fs/promises');
  let candidates;
  try {
    const stdout = await gitText(root, ['grep', '-lF', '--', `${'simt'}:begin`], { maxBuffer: 8 << 20 });
    candidates = (stdout ?? '').split('\n').filter((line) => line.length > 0).sort();
  } catch {
    // No match is exit 1, and a directory that is not a repository fails too. Both mean
    // the same thing to a reader: no generated region was found to warn about.
    return [];
  }
  const carrying = [];
  for (const path of candidates) {
    const text = await readFile(join(root, path), 'utf8').catch(() => null);
    if (text === null) continue;
    if (parseRegion(text, 'html').status === 'ok') carrying.push(path);
  }
  return carrying;
}

/**
 * The knowledge pointer lines this repository's packet carries.
 *
 * Pointer only: the directory, the README when it is there, and one usage line for
 * each conventional input the repository authored. It reads no claim file, scores
 * no path and performs no matching, so the same tree yields the same lines and a
 * repository without the directory yields none at all — which is what keeps its
 * packet byte-identical to the one it had before this section existed.
 *
 * @param {string} root
 * @returns {Promise<string[]>} the section's lines, empty when there is no directory
 */
async function knowledgePointers(root) {
  const dir = join(root, KNOWLEDGE_DIR);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // No directory is the ordinary case: the repository authored no knowledge
    // inputs, so the packet has nothing to point at.
    return [];
  }
  const present = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));

  const lines = [`${KNOWLEDGE_DIR}/ — the knowledge doors read their inputs here`];
  if (present.has('README.md')) {
    lines.push(`${KNOWLEDGE_DIR}/README.md — the cheat sheet that names each input and its door`);
  }
  // A door whose input is absent is not offered: the pointer sends a reader to a
  // file that is there, never to one the repository has not authored.
  for (const door of KNOWLEDGE_DOORS) {
    if (present.has(door.file)) lines.push(`${door.name}: ${door.usage}`);
  }
  return lines;
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
 * @param {string[]} [options.commands] the dispatchable command paths (`COMMANDS`). A
 *   decision's `Affects:` token is a command only when the tool has that command, so a
 *   packet that does not know them reports every one of them as unresolved
 * @param {boolean} [options.proof] also report whether the kept packet proves every
 *   section it kept; the default packet's bytes never change
 * @param {string|null} [options.only] keep only this section, for a view such as the
 *   packet's SKILLS section
 * @returns a packet, or `{ error }` carrying the exit code a failure already reported, or
 *   `{ cold: true, broken, indexError }` when this caller may not build the index; `broken`
 *   is true when an index is present but unreadable, and `indexError` is its error
 */
export async function assembleBrief({
  root = process.cwd(),
  task = '',
  paths = null,
  budget = DEFAULT_BRIEF_BYTES,
  flags = {},
  build = true,
  federate = true,
  commands = [],
  proof = false,
  workScope = null,
  retrieval = 'v1',
  only = null,
} = {}) {
  if (workScope !== null) return assembleScopedBrief({ root, task, budget, workScope, retrieval });
  // A view is the same packet with the other sections never collected, so it shares the
  // packer, the budget and the cut line rather than a second arithmetic (ADR-226).
  const section = only === null ? null : String(only).toUpperCase();
  if (retrieval === 'v2' && !proof) {
    const { decomposePrompt } = await import('./decompose.mjs');
    const parts = decomposePrompt(task);
    if (parts.length > 1 || /\b(?:without|except|never|unless|only when|do not|leave|keep|if)\b/iu.test(task)) {
      const { assembleCompositeBrief } = await import('./multi.mjs');
      return assembleCompositeBrief({ root, task, parts, paths, budget, flags, build, commands, section });
    }
  }
  // A view collects one section, so a block of work runs only when the collected section
  // consumes its result: collect() would drop the rest, and paying for it changes nothing
  // a reader sees. `section` null is the whole packet, where every block runs. Each call
  // names the sections its block contributes to — directly, or through `focused`/`likely`
  // — so a view for any future section keeps exactly the work it needs and skips the rest.
  const need = (sections) => section === null || sections.includes(section);
  const named = paths !== null;
  const dirty = (await dirtyPaths(root)).filter((path) => !path.startsWith(`${STATE_DIR}/`));
  // A dirty file is where the reader is standing, not what the task asked about. When a
  // task is given, its scope is the paths it names; the working tree is a fact reported
  // beside it, because otherwise a modified plan file made a code task "docs", and the
  // packet offered format commands for a change to the pack migration.
  const asked = task.trim().length > 0;
  const pending = named ? parsePathList(paths) : null;

  const graph = await loadLiveGraph(root, { build, text: task.trim().length > 0, embed: flags?.embed === true });
  if (graph.cold) {
    return { cold: true, broken: graph.broken === true, indexError: graph.indexError ?? null };
  }
  const graphStale = graph.stale === true;
  const { files, symbols, edges, fts = [], embeddings = [] } = graph;
  const filePaths = new Set(files.map((file) => file.path));
  // A path the task spells is its scope, and the strongest evidence any section has: it
  // is what the reader already decided to touch. Emptying the scope for every task left
  // SKILLS and LESSONS with no path to match, so a skill declaring this file's path could
  // not surface; the dirty tree is still only scope when nothing was asked.
  const spelled = asked && pending === null ? spelledPaths(task, filePaths) : [];
  const scope = pending ?? (asked ? spelled : dirty);

  const { kind, basis } = classifyTask(task, { paths: pending ?? spelled });
  const packet = collect({ sections: section === null ? null : [section] });
  packet.add('TASK', `kind ${kind} — ${basis}`, {
    hard: true,
    why: ['the kind chooses the commands, and the commands are the part a reader cannot recover from a wrong guess'],
  });
  packet.add('TASK', `task ${task.length > 0 ? task : '(none given)'}`, { hard: true, why: ['the packet is an answer to this'] });
  const scopeWhy = named
    ? 'named with --paths'
    : asked
      ? spelled.length > 0 ? 'the paths the task spells' : 'the task names no path, so the whole repository'
      : 'taken from the files git reports as modified';
  packet.add('TASK', `scope ${scope.length > 0 ? scope.join(', ') : 'the whole repository'}`, { why: [scopeWhy] });
  if (!asked && !named) {
    packet.add('CAUTIONS', 'no task was given, so the packet describes the working tree rather than a task', {
      why: ['an unasked question has no answer to be short of'],
    });
  }
  if (asked && !named && dirty.length > 0) {
    const shown = dirty.slice(0, 3).join(', ');
    packet.add('CAUTIONS', `the working tree has ${dirty.length} modified file(s) (${shown}${dirty.length > 3 ? ', …' : ''}); they are not this task's scope`, {
      why: ['a dirty checkout is where the reader stands, not what the task asked about'],
    });
  }
  if (graphStale) {
    packet.add('CAUTIONS', 'the index predates the current tree or some edits could not be read; file evidence may be incomplete', {
      hard: true,
      why: ['run simt index to refresh staged evidence before quoting the file list'],
    });
  }

  // The fingerprint feeds the skill ranking (`repo.signals`) and the card feeds COMMANDS
  // and the decisions context's command list; CAUTIONS is a consumer through both, because
  // the registry's cautions name the skills the ranking selected. A view collecting none
  // of them pays nothing for the read. The fallbacks keep every reference below defined
  // when the read is skipped.
  let repo = null;
  let card = { lines: [], dropped: [] };
  if (need(['COMMANDS', 'SKILLS', 'DECISIONS', 'CAUTIONS'])) {
    repo = await fingerprint(root);
    card = await commandCard({ root, manifest: repo.manifest ?? null, stack: repo.stack, facts: repo.facts });
  }
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

  // The knowledge pointer. Soft, because it names a directory the
  // reader can list in one command; a packet under pressure loses the pointer
  // before it loses a command or a path.
  if (need(['KNOWLEDGE'])) {
    for (const line of await knowledgePointers(root)) {
      packet.add('KNOWLEDGE', line, {
        why: ['the repository authored knowledge inputs, and a door is how they are read'],
      });
    }
  }

  // `focused` feeds FILES directly and TESTS, DECISIONS and LESSONS through `likely`, and
  // the FEDERATION fallback question when no task was given; its cautions (matched 0, map
  // held back) make CAUTIONS a consumer too. A view collecting none of them pays nothing
  // for the ranking that produces it.
  let focused = [];
  if (need(['FILES', 'TESTS', 'DECISIONS', 'LESSONS', 'FEDERATION', 'CAUTIONS'])) {
    const bm25 = task.trim().length > 0 ? await searchFtsBm25(root, task, { fts }) : [];
    const queryVector =
      flags?.embed === true && embeddings.length > 0
        ? await embedTaskQuery(root, task, {
            embed: true,
            allowRemote: flags?.allowRemote === true,
          })
        : null;
    const ranked = rankFiles({ files, symbols, edges, fts, bm25, embeddings, queryVector, task });
    // A resolver hit is the task's own words against a path or symbol; a fused score is
    // positive for graph neighbours and BM25 body hits too. When nothing resolves, those
    // rows stay as context and the caution below says so. When something does resolve, keep
    // only the resolver rows: the rest made a two-file task look like it touched src/name.mjs.
    const matched = ranked.filter((row) => row.resolver > 0).length;
    focused = matched > 0 ? ranked.filter((row) => row.resolver > 0) : ranked;
    if (task.trim().length > 0 && matched === 0) {
      packet.add('CAUTIONS', 'matched 0: no path or symbol matches this task’s words, so FILES is context rather than a match', {
        hard: true,
        why: ['a body hit or a graph neighbour is not path or symbol evidence about this task'],
      });
    }
    const rendered = renderMap(focused, symbols, { level: 'names', budget: budget > 0 ? budget * MAP_FACTOR : 0 });
    for (const line of rendered.text.split('\n')) {
      packet.add('FILES', line, { why: ['ranked by the task words against the import graph'] });
    }
    if (rendered.truncated) {
      packet.add('CAUTIONS', `the map held back ${rendered.total - rendered.shown} of ${rendered.total} files`, {
        hard: true,
        why: [`\`${CLI} map --budget 0\` lists them all`],
      });
    }
  }

  // Model and effort advice comes from the repository's bench history, not from anything a
  // model produced, so it stays deterministic. The tier exists only if the history resolved
  // a similar task, and the claim travels with its own numbers and its unmeasured accept
  // bar; simt-dev never selects the model an agent runs.
  let advice = null;
  if (need(['ADVICE', 'CAUTIONS'])) {
    advice = await briefAdvice(root, { task, scope, kind });
  }
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

  const likely = focused.slice(0, LIKELY_FILES).map((row) => row.path);
  const untested = [];
  if (need(['TESTS', 'CAUTIONS'])) {
    packet.add('TESTS', `the index knows direct importers; \`${CLI} tests <path>\` is the authority for multi-line and dynamic imports`, {
      why: ['a cheap packet and an exact answer are different questions'],
    });
    for (const path of likely) {
      // The packet's own edges, walked by the same function `tests` uses .
      const found = coverage({ files, imports: edges.filter((edge) => edge.kind === 'import') }, [path], {
        transitive: false,
      });
      if (found.length === 0) untested.push(path);
      else packet.add('TESTS', `${path} -> ${found.join(' ')}`, { why: ['the test imports it, or sits beside it'] });
    }
  }

  if (need(['DECISIONS', 'CAUTIONS'])) {
    const records = await decisionRecords(root);
    const ctx = {
      files: filePaths,
      // The card's lines are shell commands (`npm run test`); a decision's Affects token is
      // a command of this tool. Passing only the card's list made every `simt …` token
      // unresolved — 47 false cautions on this repository.
      commands: new Set([...card.lines.map((line) => line.command), ...commands]),
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
  }

  if (federate && (section === null || section === 'FEDERATION')) {
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

  if (need(['SKILLS', 'CAUTIONS'])) {
    const loaded = await loadRegistry(null, flags);
    if (!loaded.ok) {
      packet.add('CAUTIONS', `the skill registry did not load (${loaded.errors[0]}), so no skill was offered`, {
        why: ['every other section is independent of the registry, which is why this is a caution and not a failure'],
      });
    } else {
      const rankedSkills = rankSkills(
        loaded.registry.skills,
        { repoStack: repo.signals, taskTokens: tokenize(task), paths: scope, tree: [...filePaths] },
        { forced: [] },
      );
      const expanded = closure(rankedSkills.selected, loaded.registry.skills);
      // The packet prints a skill's NAME and size; the body never enters its bytes. Budgeting
      // the name by the body (`budget / 4`, inherited from `skills brief`) held back every
      // real body against a 512-byte allowance, so the section could never show the skill
      // whose declared path the task named. A registry-deferred skill is a body to fetch,
      // not one this packet stands in for, so it is the only thing filtered out.
      const offered = expanded.filter((entry) => !entry.skill.deferred);
      for (const entry of offered.slice(0, SKILL_NAMES)) {
        const reasons = [...entry.reasons];
        packet.add('SKILLS', `${entry.skill.name} — ${entry.skill.bytes} B, ${reasons.join(' ')}`, {
          why: [`\`${CLI} skills show ${entry.skill.name}\` reads the body`],
        });
      }
      if (offered.length > SKILL_NAMES) {
        packet.add('CAUTIONS', `skills matched but not named: ${offered.slice(SKILL_NAMES).map((entry) => entry.skill.name).sort().join(', ')}`, {
          why: [`\`${CLI} skills find <query>\` lists the rest`],
        });
      }
      const deferred = expanded.filter((entry) => entry.skill.deferred);
      if (deferred.length > 0) {
        packet.add('CAUTIONS', `skills deferred by the registry: ${deferred.map((entry) => entry.skill.name).sort().join(', ')}`, {
          why: ['a skill the registry marks deferred is not one this packet can stand in for'],
        });
      }
    }
  }

  if (need(['LESSONS'])) {
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
  }

  if (need(['CAUTIONS'])) {
    const generated = await generatedRegions(root);
    if (generated.length > 0) {
      packet.add('CAUTIONS', `generated — edit the source, not these: ${generated.join(', ')}`, {
        why: ['a hand edit inside a generated region is overwritten by the next projection'],
      });
    }
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

  const items = packet.items;
  const packed = buildPacket(items, { budget });
  const cut = new Set(packed.cut);

  // A proof summary answers only what the kept packet itself proves: each kept section is
  // an obligation, and each kept line cites the tree it was read from (A39).
  let proofSummary;
  if (proof) {
    const head = (await gitText(root, ['rev-parse', 'HEAD']))?.trim() ?? '';
    const kept = items.filter((item) => !cut.has(item.id));
    const units = kept.map((item) => ({
      id: item.id,
      text: item.text,
      obligations: [item.section],
      mandatory: item.priority === 'hard',
      revision: {
        ref: head.length > 0 ? head : 'worktree',
        digest: `sha256-${createHash('sha256').update(item.text).digest('hex')}`,
      },
      anchor: null,
    }));
    const report = buildProofPacket(units, {
      budget: Math.min(budget > 0 ? budget : DEFAULT_BRIEF_BYTES, PROMPT_CAP_BYTES),
      required: [...new Set(kept.map((item) => item.section))],
    });
    const mandatory = new Set(units.filter((unit) => unit.mandatory).map((unit) => unit.id));
    proofSummary = {
      complete: report.complete,
      omittedObligations: report.omittedObligations,
      selectedMandatory: report.selected.filter((id) => mandatory.has(id)),
    };
  }

  const sections = keptSections(items, cut);

  return { root, kind, basis, task, scope, budget, items, packed, sections, proof: proofSummary };
}
