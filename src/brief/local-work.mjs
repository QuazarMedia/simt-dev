import { collectCorpus } from '../knowledge/collect.mjs';
import { rankCorpus } from '../knowledge/query.mjs';
import { CLI } from '../name.mjs';
import { EXIT, fail } from '../output/index.mjs';
import { selectLocalVerification } from '../verify/local-selection.mjs';
import { localVerificationStatus } from '../verify/local-run.mjs';
import { readWork } from '../work/effective.mjs';
import { buildPacket, collect, DEFAULT_BRIEF_BYTES, PROMPT_CAP_BYTES } from './packet.mjs';
import { buildProofPacket } from './proof.mjs';

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export async function assembleScopedBrief({ root, task, budget, workScope }) {
  const work = await readWork(root);
  if (!work.ok) return { error: fail(work.problems[0].message, EXIT.CONFIG, work.problems[0].remedy) };
  const scope = work.scopes.find(({ id }) => id === workScope);
  if (!scope) return { error: fail(`no declared work scope ${workScope}`, EXIT.USAGE, `run: ${CLI} work inspect`) };
  const collected = await collectCorpus({ root, work, scope });
  if (collected.error) return { error: fail(collected.error, EXIT.CONFIG, collected.remedy) };
  const ceiling = Math.min(budget > 0 ? budget : DEFAULT_BRIEF_BYTES, PROMPT_CAP_BYTES);
  const committed = collected.corpus.units.filter(({ provenance }) => provenance === 'committed');
  const ranked = rankCorpus({ ...collected.corpus, units: committed }, { query: task, limit: 4 });
  const matches = new Map();
  for (const { citation } of [...ranked.exact, ...ranked.ranked]) {
    if (!citation || matches.has(citation.path) || !/\.(?:md|markdown)$/i.test(citation.path)) continue;
    const command = `${CLI} knowledge sections ${quote(citation.path)}`;
    matches.set(citation.path, {
      id: citation.path,
      text: `${citation.path}${citation.anchor ? `#${citation.anchor}` : ''} (${citation.authorityBasis}) · ${command}`,
      authority: citation.authorityBasis === 'reviewed' ? 2 : 1,
      obligations: [citation.path],
      revision: { ref: citation.path, digest: citation.revision },
      anchor: { path: citation.path, startLine: citation.lineStart + 1, endLine: citation.lineEnd },
    });
  }
  const proof = buildProofPacket([...matches.values()], { budget: ceiling, required: [...matches.keys()] });
  const selection = await selectLocalVerification(root, { scopeId: workScope });
  const status = selection.error ? null : await localVerificationStatus(selection);
  const packet = collect();
  packet.add('TASK', `local scope ${workScope}`);
  const flag = `--scope ${quote(workScope)}`;
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
  const sections = {};
  for (const item of kept) {
    sections[item.section] ??= [];
    sections[item.section].push(item.text);
  }
  const shown = new Set(kept.filter(({ section }) => section === 'KNOWLEDGE').map(({ text }) => text));
  const citations = proof.citations.filter(({ id }) => shown.has(matches.get(id).text));
  return {
    root, kind: 'work', basis: 'declared local scope', task, scope: scope.paths, workScope, budget: ceiling,
    items: packet.items, packed, sections,
    proof: { complete: matches.size > 0 && citations.length === matches.size,
      citations, omittedObligations: [...matches.keys()].filter((path) => !citations.some(({ id }) => id === path)) },
  };
}
