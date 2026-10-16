import { EXIT, emit, emitJson, fail, isJson, writeMode } from '../output/index.mjs';
import { formatCounts, planDone, planNext, planStatus } from '../plan/index.mjs';
import { CLI } from '../name.mjs';

// Preview unless --yes, and --dry-run wins even then. A tracker row marked done
// for a commit that was never written is a claim the next reader will believe.

export async function planCommand(sub, args, flags) {
  const root = flags.root ?? process.cwd();
  if (sub === 'status') return runStatus(root, flags);
  if (sub === 'next') return runNext(root, args[0] ?? null, flags);
  if (sub === 'done') {
    if (!args[0]) return fail('plan done needs a slice id', EXIT.USAGE, `run: ${CLI} plan next`);
    return runDone(root, args[0], args[1] ?? null, flags);
  }
  if (!sub) {
    return fail('plan needs a subcommand', EXIT.USAGE, `run: ${CLI} plan status  |  ${CLI} plan next  |  ${CLI} plan done <id>`);
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
    lines.push(`${doc.name}  slices=${doc.slices}  ${formatCounts(doc.counts, result.stateOrder)}`);
  }
  lines.push('', `total    ${formatCounts(result.totals, result.stateOrder) || '-'}`);
  lines.push(`ready    ${result.ready}`);
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}

async function runNext(root, id, flags) {
  const result = await planNext(root, id);
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
    emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }
  const next = result.next;
  const head = [
    `repo     ${root}`,
    `slice    ${next.id}  ${next.doc}`,
    `state    ${next.state}`,
    `depends  ${next.dependsOn || '(none)'}`,
    `bytes    ${next.sectionBytes}`,
    '',
    next.section || '(no section for this id)',
  ];
  emit(head.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
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
  if (isJson(flags)) {
    emitJson({ ok: true, command: 'plan done', ...result });
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
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}
