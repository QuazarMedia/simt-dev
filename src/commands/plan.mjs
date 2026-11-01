import { relative } from 'node:path';
import { EXIT, emit, emitJson, fail, isJson, writeMode } from '../output/index.mjs';
import { formatCounts, planDone, planLabels, planNext, planStatus } from '../plan/index.mjs';
import { diffField, emitDiffs } from '../diff.mjs';
import { CLI } from '../name.mjs';
import { commandRoot } from '../repo-root.mjs';
import { MANIFEST_FILE } from '../name.mjs';

// Preview unless --yes, and --dry-run wins even then. A tracker row marked done
// for a commit that was never written is a claim the next reader will believe.

export async function planCommand(sub, args, flags) {
  const root = commandRoot(flags);
  if (sub === 'status') return runStatus(root, flags);
  if (sub === 'labels') return runLabels(root, flags);
  if (sub === 'next') return runNext(root, args[0] ?? null, flags);
  if (sub === 'done') {
    if (!args[0]) return fail('plan done needs a slice id', EXIT.USAGE, `run: ${CLI} plan next`);
    return runDone(root, args[0], args[1] ?? null, flags);
  }
  if (!sub) {
    return fail('plan needs a subcommand', EXIT.USAGE, `run: ${CLI} plan status  |  ${CLI} plan next  |  ${CLI} plan labels  |  ${CLI} plan done <id>`);
  }
  return fail(`unknown plan subcommand ${sub}`, EXIT.USAGE, `run: ${CLI} plan status`);
}

async function runStatus(root, flags) {
  const result = await planStatus(root);
  if (result.error) return fail(result.error, EXIT.USAGE, result.remedy);
  if (isJson(flags)) {
    emitJson({ ok: true, command: 'plan status', ...result });
    return EXIT.OK;
  }
  const lines = [`repo     ${root}`, `template ${result.template}`, `dirs     ${result.directories.join(', ')}`];
  if (result.documents.length === 0) lines.push(`(no tracker in ${result.directories.join(' or ')})`);
  for (const doc of result.documents) {
    const share = doc.progress.percent === null ? '' : `  progress=${doc.progress.percent}%`;
    lines.push(`${doc.name}  slices=${doc.slices}  ${formatCounts(doc.counts, result.stateOrder)}${share}`);
    // Only when the tracker carries a tier column at all: an untagged count on a table
    // with no tier column is every slice, and says nothing about the plan.
    const tiers = formatCounts(doc.tiers);
    if (tiers !== '') lines.push(`  tiers  ${tiers}${doc.untagged > 0 ? `  untagged=${doc.untagged}` : ''}`);
    const waves = formatCounts(doc.waves);
    if (waves !== '') lines.push(`  waves  ${waves}`);
    const lanes = formatCounts(doc.lanes);
    if (lanes !== '') lines.push(`  lanes  ${lanes}${doc.unlaned > 0 ? `  unlaned=${doc.unlaned}` : ''}`);
  }
  lines.push('', `total    ${formatCounts(result.totals, result.stateOrder) || '-'}`);
  // The percent is rounded, so done and remaining travel with it: 99% of 150 rows and 99%
  // of 1500 are different amounts of work, and the counts are what say which one it is.
  const { percent, done, remaining } = result.progress;
  if (percent !== null) lines.push(`progress ${percent}%  done=${done}  remaining=${remaining}`);
  // A tracker with neither a tier column nor a wave table gets neither line: an empty
  // heading reads as "the tool looked and found something worth saying".
  const tierLine = formatCounts(result.tiers);
  if (tierLine !== '') lines.push(`tiers    ${tierLine}${result.untagged > 0 ? `  untagged=${result.untagged}` : ''}`);
  const waveLine = formatCounts(result.waves);
  if (waveLine !== '') lines.push(`waves    ${waveLine}`);
  const laneLine = formatCounts(result.lanes);
  if (laneLine !== '') lines.push(`lanes    ${laneLine}${result.unlaned > 0 ? `  unlaned=${result.unlaned}` : ''}`);
  lines.push(`ready    ${result.ready}`);
  emit(lines.join('\n'));
  return EXIT.OK;
}

// What the tool read, and what it could read. A tracker whose `Sizing` column carries the
// tier answers `plan next --tier L` with "no queued slices in tier L", which is also the
// answer when there is no L slice at all; this is the command that tells them apart, and
// the one an agent runs before editing a table the tool does not understand.
async function runLabels(root, flags) {
  const result = await planLabels(root);
  if (result.error) return fail(result.error, EXIT.USAGE, result.remedy);
  if (isJson(flags)) {
    emitJson({ ok: true, command: 'plan labels', ...result });
    return EXIT.OK;
  }
  const keys = Object.keys(result.columns);
  const width = Math.max(...keys.map((key) => key.length), 'wave'.length);
  const lines = [
    `repo     ${root}`,
    `template ${result.template}  (${result.source})`,
    `dirs     ${result.directories.join(', ')}`,
    '',
  ];
  for (const key of keys) {
    lines.push(`  ${key.padEnd(width)}  ${result.columns[key].join(', ') || '(none)'}`);
  }
  lines.push(`  ${'wave'.padEnd(width)}  ${result.wave.label.join(', ')} / ${result.wave.members.join(', ')}`);
  lines.push(`  ${'states'.padEnd(width)}  ${result.states.join(', ')}`);
  for (const doc of result.documents) {
    lines.push('', doc.name, `  header     ${doc.columns.join(' | ')}`);
    const hits = Object.entries(doc.matched)
      .filter(([, value]) => value !== null)
      .map(([key, value]) => `${key}: ${value}`);
    lines.push(`  matched    ${hits.join('  ') || '(none)'}`);
    if (doc.unmatched.length > 0) {
      lines.push(`  unmatched  ${doc.unmatched.join(', ')}`);
      lines.push(`  fix        name it under plans.columns in ${MANIFEST_FILE}: ${keys.join(', ')}`);
    }
  }
  emit(lines.join('\n'));
  return EXIT.OK;
}

// What is waiting on a person or a model, and who. Printed with the answer rather than by a
// second command: the reader deciding what to do next needs both facts at once.
function awaitingLines(result) {
  if (!result.awaitingReview?.length) return [];
  return [
    '',
    'awaiting review:',
    ...result.awaitingReview.map((row) => `  ${row.id}  ${row.doc}${row.reviewer ? `  reviewer: ${row.reviewer}` : ''}`),
  ];
}

async function runNext(root, id, flags) {
  const result = await planNext(root, id, { tier: flags.tier ?? null, wave: flags.wave ?? null, lane: flags.lane ?? null });
  if (result.error) return fail(result.error, EXIT.USAGE, result.remedy);
  if (isJson(flags)) {
    emitJson({ ok: true, command: 'plan next', ...result });
    return EXIT.OK;
  }
  if (!result.next) {
    const lines = [`repo     ${root}`, result.reason];
    if (result.blocked?.length) {
      lines.push('', 'blocked:');
      for (const row of result.blocked) {
        const unknown = row.unknownDependencies.length ? `  unknown: ${row.unknownDependencies.join(', ')}` : '';
        lines.push(`  ${row.id}  ${row.doc}  depends on: ${row.dependsOn || '(none)'}${unknown}`);
      }
    }
    lines.push(...awaitingLines(result));
    emit(lines.join('\n'));
    return EXIT.OK;
  }
  const next = result.next;
  const head = [
    `repo     ${root}`,
    `slice    ${next.id}  ${next.doc}`,
    `state    ${next.state}`,
    ...(next.tier ? [`tier     ${next.tier}`] : []),
    ...(next.lane ? [`lane     ${next.lane}`] : []),
    ...(next.reviewer ? [`reviewer ${next.reviewer}`] : []),
    ...(next.waves?.length ? [`wave     ${next.waves.join(", ")}`] : []),
    `depends  ${next.dependsOn || '(none)'}`,
    `bytes    ${next.sectionBytes}`,
    '',
    next.section || '(no section for this id)',
    ...awaitingLines(result),
  ];
  emit(head.join('\n'));
  return EXIT.OK;
}

async function runDone(root, id, sha, flags) {
  const mode = writeMode(flags);
  const result = await planDone(root, id, {
    sha,
    test: flags.test ?? null,
    state: flags.state ?? null,
    dryRun: !mode.apply,
  });
  if (result.error) return fail(result.error, EXIT.USAGE, result.remedy);
  // The `--diff` pair: the one changed tracker row . The sides ride on the
  // result from `planDone`, captured pre-write, so the diff is true in preview
  // and in apply alike. When nothing changed the sides are equal and the diff
  // renders empty.
  const diffs =
    flags.diff === true && result.beforeLine !== undefined
      ? [{ path: relative(root, result.file), before: result.beforeLine, after: result.afterLine }]
      : [];
  if (isJson(flags)) {
    emitJson({ ok: true, command: 'plan done', ...result, ...diffField(diffs, flags) });
    return EXIT.OK;
  }
  const lines = [`repo     ${root}`];
  if (result.dryRun) {
    lines.push(`dry-run  ${result.id}  ${result.doc}  line ${result.line}`);
    lines.push(result.wouldChange ? `would    ${result.from} -> ${result.to}` : `state    ${result.from}`);
    if (result.remedy) lines.push(`apply    ${result.remedy}`);
  } else {
    lines.push(`changed  ${result.changed ? 'yes' : 'no'}  ${result.id}  ${result.doc}  line ${result.line}`);
    lines.push(result.from === result.to ? `state    ${result.to}` : `state    ${result.from} -> ${result.to}`);
  }
  if (result.evidenceRecorded) lines.push(`evidence ${result.sha}${result.test ? `  test: ${result.test}` : ''}`);
  else if (result.evidenceNote) lines.push(`note     ${result.evidenceNote}`);
  emit(lines.join('\n'));
  // After the report: the report says what, the diff shows it .
  emitDiffs(diffs, flags);
  return EXIT.OK;
}
