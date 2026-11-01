// simt tokens - what a reader loads, counted.
//
// Review 0002 S38 put the estate's always-on context at 90 KB per turn, 72% of it a
// paragraph an earlier root had already loaded, and could only say so by reading seven
// repositories by hand. This command is that reading, and it is the figure plan 0003's
// later slices are measured against: the context budget (S38 P7), the kernel split
//  and the workspace dedupe  all need a number that moves when the
// projection moves, or they are opinions.
//
// Three decisions keep the figure honest:
//
//   1. It is a READ. No write, no git object, no lock - the same ruling `compare`
//      follows. An agent running this to orient itself must not be able to change what
//      the next run will measure.
//   2. It exits 0. A measurement is not a verdict: a repository over budget is a fact
//      about the repository, and a command that went red for it would train people to
//      ignore the number it exists to print. The only failure is being pointed at a
//      directory that holds no repository to measure.
//   3. It counts bytes and calls the tokens an approximation every time it prints one.
//      See src/measure/context.mjs for what that costs and why.

import { resolve } from 'node:path';

import { EXIT, emit, emitJson, fail, isJson } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { discover } from '../compare/discover.mjs';
import { targetRoot } from '../workspace.mjs';
import {
  ALWAYS_ON_BUDGET_BYTES,
  BYTES_PER_TOKEN,
  annotate,
  measureRoot,
  mcpTools,
  totals,
} from '../measure/context.mjs';
import { measureSession } from '../measure/session.mjs';
import { sharedTotals } from '../projection/shared.mjs';
import { plainNumber } from '../util/fs.mjs';

function files(n) {
  return n === 1 ? '1 file' : `${plainNumber(n)} files`;
}

export async function tokensCommand(positional, flags) {
  if (flags.session !== undefined) {
    const session = await measureSession(flags.session);
    if (!session.ok) {
      return fail(session.error, EXIT.CONFIG, session.remedy);
    }
    if (isJson(flags)) {
      emitJson({
        ok: true,
        command: 'tokens',
        mode: 'session',
        session: session.path,
        bytesPerToken: BYTES_PER_TOKEN,
        rules: session.rules,
        fileReads: session.fileReads,
        toolOutput: session.toolOutput,
        total: session.total,
      });
      return EXIT.OK;
    }
    const lines = [
      `tokens   ${session.path}  (session)`,
      `rules       ${plainNumber(session.rules.bytes)} B  ~${plainNumber(session.rules.tokens)} tokens  (${plainNumber(session.rules.share)}%)`,
      `file reads  ${plainNumber(session.fileReads.bytes)} B  ~${plainNumber(session.fileReads.tokens)} tokens  (${plainNumber(session.fileReads.share)}%)`,
      `tool output ${plainNumber(session.toolOutput.bytes)} B  ~${plainNumber(session.toolOutput.tokens)} tokens  (${plainNumber(session.toolOutput.share)}%)`,
      `total       ${plainNumber(session.total.bytes)} B  ~${plainNumber(session.total.tokens)} tokens`,
    ];
    emit(lines.join('\n'));
    return EXIT.OK;
  }

  // `targetRoot` owns the precedence, so `tokens`, `compare` and `upgrade` cannot
  // disagree about which directory was named (ADR-014).
  const target = await targetRoot(flags, positional);
  const root = resolve(target.root);

  const found = await discover(root);
  if (flags.repos) {
    if (found.error) {
      return fail(`${root}: ${found.error}`, EXIT.CONFIG, 'pass --root <path>');
    }
    if (found.repos.length === 0) {
      return fail(
        `${root} contains no git repositories`,
        EXIT.CONFIG,
        `point --root at the directory holding the repositories, or at one repository without --repos`,
      );
    }
    // `discover` sorts, and the order decides which root owns a shared paragraph. A
    // second sort here would move duplicate bytes between roots and make the workspace
    // figure irreproducible.
  } else if (found.shape === 'workspace') {
    return fail(
      `${root} holds repositories rather than being one`,
      EXIT.CONFIG,
      `measure one with: ${CLI} tokens --root <path>, or every repository under it with: ${CLI} tokens --repos --root ${root}`,
    );
  }
  const roots = flags.repos ? found.repos : [root];

  const rows = [];
  for (const path of roots) rows.push(await measureRoot(path));
  annotate(rows);

  const measured = totals(rows);
  // The workspace copy, counted once (ADR-084). A figure that measured the regions and
  // ignored the file the rules moved into would show a saving the reader's context never
  // saw, so it is in the total from the first run rather than as an afterthought.
  const shared = await sharedTotals(rows);
  const summary = {
    ...measured,
    sharedBytes: shared.bytes,
    estateBytes: measured.generatedBytes + shared.bytes,
    sharedFiles: shared.files,
  };
  const mcp = mcpTools();

  if (isJson(flags)) {
    emitJson({
      ok: true,
      command: 'tokens',
      root,
      mode: flags.repos ? 'repositories' : 'repository',
      source: target.source,
      budget: { bytes: ALWAYS_ON_BUDGET_BYTES, bytesPerToken: BYTES_PER_TOKEN },
      mcp,
      roots: rows.map(({ documents, ...row }) => row),
      totals: summary,
    });
    return EXIT.OK;
  }

  const lines = [];
  if (flags.repos) {
    lines.push(`tokens   ${root}  ${plainNumber(summary.roots)} repositories  (${target.source})`);
    for (const row of rows) {
      const budget = row.budget.over ? `  over budget by ${plainNumber(row.budget.overBy)} B` : '';
      lines.push(
        `${row.name}  generated ${plainNumber(row.generatedBytes)} B  duplicate ${plainNumber(row.redundancy.duplicateBytes)} B  unique ${plainNumber(row.redundancy.uniqueBytes)} B${budget}`,
      );
      for (const finding of row.findings) lines.push(`note     ${row.name}: ${finding}`);
    }
    const share =
      summary.generatedBytes === 0 ? 0 : Math.round((summary.duplicateBytes / summary.generatedBytes) * 100);
    lines.push(
      `totals   generated ${plainNumber(summary.generatedBytes)} B  duplicate ${plainNumber(summary.duplicateBytes)} B (${plainNumber(share)}% of generated)  unique ${plainNumber(summary.uniqueBytes)} B  repeat ${plainNumber(summary.repeatBytes)} B  ~${plainNumber(summary.tokens)} tokens`,
    );
    // Only when there is a copy to count. The line a reader sees most is the one that
    // says what their whole estate loads, and adding a second number to it that is
    // usually zero is how a report stops being read.
    if (summary.sharedBytes > 0) {
      lines.push(
        `shared   ${plainNumber(summary.sharedBytes)} B carried once in ${plainNumber(summary.sharedFiles.length)} user-level file(s)  estate total ${plainNumber(summary.estateBytes)} B`,
      );
      for (const f of summary.sharedFiles) lines.push(`  ${f.path}  ${plainNumber(f.bytes)} B  ${plainNumber(f.rules)} rule(s)`);
    }
  } else {
    const row = rows[0];
    lines.push(`tokens   ${row.path}`);
    lines.push(`state    ${row.adoption}  surfaces ${row.surfaces.length === 0 ? '(AGENTS.md only)' : row.surfaces.join(', ')}`);
    for (const channel of row.channels) {
      lines.push(
        `${channel.channel.padEnd(9)}${files(channel.files)}  ${plainNumber(channel.generatedBytes)} B generated  ${plainNumber(channel.readerBytes)} B read`,
      );
    }
    const verdict = row.budget.over ? `over by ${plainNumber(row.budget.overBy)} B` : 'within budget';
    lines.push(
      `always-on ${plainNumber(row.generatedBytes)} B generated  ~${plainNumber(row.generatedTokens)} tokens  budget ${plainNumber(row.budget.bytes)} B  ${verdict}`,
    );
    // The same reason as the `--repos` line, and it matters more here: measuring one
    // repository is the default, so a reader who owns the workspace copy and never saw it
    // counted would read a saving their own session does not get.
    if (summary.sharedBytes > 0) {
      lines.push(
        `shared   ${plainNumber(summary.sharedBytes)} B carried once in ${plainNumber(summary.sharedFiles.length)} user-level file(s)  always-on for you: ${plainNumber(summary.estateBytes)} B`,
      );
      for (const f of summary.sharedFiles) lines.push(`  ${f.path}  ${plainNumber(f.bytes)} B  ${plainNumber(f.rules)} rule(s)`);
    }
    lines.push(
      `redundant ${plainNumber(row.redundancy.duplicateBytes)} B repeats an earlier repository  ${plainNumber(row.redundancy.repeatBytes)} B repeats an earlier document here  ${plainNumber(row.redundancy.uniqueBytes)} B unique of ${plainNumber(row.redundancy.blockBytes)} B counted in blocks`,
    );
    for (const finding of row.findings) lines.push(`note     ${finding}`);
  }
  lines.push(
    `mcp      tools/list ${plainNumber(mcp.bytes)} B of ${plainNumber(mcp.tools)} tools  (the same for every repository, so it is not in any total)`,
  );

  emit(lines.join('\n'));
  return EXIT.OK;
}