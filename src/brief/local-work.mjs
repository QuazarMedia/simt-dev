import { collectCorpus } from '../knowledge/collect.mjs';
import { rankCorpus } from '../knowledge/query.mjs';
import { CLI } from '../name.mjs';
import { EXIT, fail } from '../output/index.mjs';
import { shellWord } from '../sys/proc.mjs';
import { selectLocalVerification } from '../verify/local-selection.mjs';
import { localVerificationStatus } from '../verify/local-run.mjs';
import { readWork } from '../work/effective.mjs';
import { buildPacket, collect, keptSections, DEFAULT_BRIEF_BYTES, PROMPT_CAP_BYTES } from './packet.mjs';
import { buildProofPacket } from './proof.mjs';
import { decomposePrompt, maskPrompt, MAX_SUBTASKS } from './decompose.mjs';

function questionList(task, retrieval) {
  if (retrieval !== 'v2') return [task];
  const clauses = decomposePrompt(task);
  if (clauses.length > 1) return clauses.map(({ text }) => text);
  const { masked } = maskPrompt(task);
  const questions = [];
  let begin = 0;
  for (const separator of masked.matchAll(/\?\s+(?=\p{L})/gu)) {
    if (questions.length === MAX_SUBTASKS - 1) break;
    questions.push(task.slice(begin, separator.index + 1).trim());
    begin = separator.index + separator[0].length;
  }
  questions.push(task.slice(begin).trim());
  return questions;
}

function proofSources(corpus, questions, retrieval) {
  const multi = questions.length > 1;
  const matches = new Map();
  for (const [index, question] of questions.entries()) {
    const ranked = rankCorpus(corpus, { query: question, limit: 4, retrieval });
    const seen = new Set();
    for (const { citation } of [...ranked.exact, ...ranked.ranked]) {
      if (!citation || seen.has(citation.path) || !/\.(?:md|markdown)$/iu.test(citation.path)) continue;
      seen.add(citation.path);
      const id = multi ? citation.path + '#' + (citation.anchor ?? citation.lineStart) : citation.path;
      const obligation = multi ? 'question ' + (index + 1) : id;
      const command = CLI + ' knowledge sections ' + shellWord(citation.path);
      const row = matches.get(id) ?? {
        id, text: citation.path + (citation.anchor ? '#' + citation.anchor : '') + ' (' + citation.authorityBasis + ') · ' + command,
        authority: citation.authorityBasis === 'reviewed' ? 2 : 1,
        obligations: [], lineage: citation.path,
        revision: { ref: citation.path, digest: citation.revision },
        anchor: { path: citation.path, startLine: citation.lineStart + 1, endLine: citation.lineEnd },
      };
      row.obligations.push(obligation);
      matches.set(id, row);
    }
  }
  return { matches, multi, required: multi ? questions.map((_, index) => 'question ' + (index + 1)) : [...matches.keys()] };
}

export async function assembleScopedBrief({ root, task, budget, workScope, retrieval = 'v1' }) {
  const work = await readWork(root);
  if (!work.ok) return { error: fail(work.problems[0].message, EXIT.CONFIG, work.problems[0].remedy) };
  const scope = work.scopes.find(({ id }) => id === workScope);
  if (!scope) return { error: fail(`no declared work scope ${workScope}`, EXIT.USAGE, `run: ${CLI} work inspect`) };
  const collected = await collectCorpus({ root, work, scope });
  if (collected.error) return { error: fail(collected.error, EXIT.CONFIG, collected.remedy) };
  const ceiling = Math.min(budget > 0 ? budget : DEFAULT_BRIEF_BYTES, PROMPT_CAP_BYTES);
  const committed = collected.corpus.units.filter(({ provenance }) => provenance === 'committed');
  const questions = questionList(task, retrieval);
  const { matches, multi, required } = proofSources({ ...collected.corpus, units: committed }, questions, retrieval);
  const proof = buildProofPacket([...matches.values()], { budget: ceiling, required, diverse: multi });
  const selection = await selectLocalVerification(root, { scopeId: workScope });
  const status = selection.error ? null : await localVerificationStatus(selection);
  const packet = collect();
  packet.add('TASK', `local scope ${workScope}`);
  const flag = `--scope ${shellWord(workScope)}`;
  packet.add('COMMANDS', `${CLI} verify status --changed ${flag}`);
  if (status !== null && selection.obligations.length > 0) {
    const passed = status.results.filter(({ state }) => state === 'pass').length;
    packet.add('TESTS', `${passed}/${status.results.length} obligations verified, ${status.results.length - passed} pending; ${status.pending.length} changed path(s) unresolved`);
    packet.add('COMMANDS', `${CLI} verify select --changed ${flag}`);
  } else {
    packet.add('TESTS', 'no in-scope change has verification evidence');
  }
  for (const path of proof.selected) packet.add('KNOWLEDGE', matches.get(path).text);
  if (matches.size === 0) {
    packet.add('CAUTIONS', 'no committed source section matched');
    packet.add('COMMANDS', `${CLI} knowledge build ${flag} --yes`);
  }
  if (collected.truncated) packet.add('CAUTIONS', 'source inventory reached its limit');
  if (proof.omittedObligations.length > 0) packet.add('CAUTIONS', `${proof.omittedObligations.length} source citation(s) exceed the packet budget`);

  const built = buildPacket(packet.items, { budget: ceiling });
  // Even the ordinary packet's omission footer can exceed a very small ceiling.
  const packed = built.after <= ceiling ? built : {
    ...built, text: '', after: 0, floorHeld: false, cut: packet.items.map(({ id }) => id),
  };
  const cut = new Set(packed.cut);
  const kept = packet.items.filter(({ id }) => !cut.has(id));
  const sections = keptSections(packet.items, cut);
  const shown = new Set(kept.filter(({ section }) => section === 'KNOWLEDGE').map(({ text }) => text));
  const citations = proof.citations.filter(({ id }) => shown.has(matches.get(id).text));
  const covered = new Set(citations.flatMap(({ id }) => matches.get(id).obligations));
  const omittedObligations = required.filter((obligation) => !covered.has(obligation));
  return {
    root, kind: 'work', basis: 'declared local scope', task, scope: scope.paths, workScope, budget: ceiling,
    items: packet.items, packed, sections,
    ...(retrieval === 'v2' ? { retrieval } : {}),
    proof: { complete: matches.size > 0 && omittedObligations.length === 0 && !proof.overBudget,
      citations, omittedObligations,
      ...(multi ? { questions: questions.map((text, index) => ({ id: index + 1, text,
        citations: citations.filter(({ id }) => matches.get(id).obligations.includes('question ' + (index + 1))).map(({ id }) => id),
      })) } : {}),
    },
  };
}
