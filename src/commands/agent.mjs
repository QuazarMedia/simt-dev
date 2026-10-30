// simt agents install | simt agents status
//
// Two commands, one subject: the one agent this tool ships, written into each
// harness's own agents directory. `install` writes the file, and `status`
// reports what each harness carries and what still has to be installed.
//
// An agent is a file the tool owns whole — markdown with a frontmatter the
// harness documents, or a TOML file for Codex — not a config entry to merge.
// So the install is a byte comparison: created, unchanged, updated. There is no
// parse that can fail and no partial state, which is what makes this command
// shorter than `agent-hooks install`.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { commitJournal } from '../journal.mjs';
import { diffField, emitDiffs, readBefore } from '../diff.mjs';
import { EXIT, emit, emitJson, fail, isJson, note, writeMode } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import {
  adapter,
  adapters,
  agentPath,
  agentRows,
  loadAgent,
  planAgents,
  rendered,
  writeAgentPlan,
} from '../agents/render.mjs';

export async function agentsCommand(sub, args, flags) {
  const root = flags.root ?? args[0] ?? process.cwd();
  if (sub === 'install') return installAgents(root, flags);
  if (sub === 'status') return agentsStatus(root, flags);
  return fail(`unknown agents subcommand ${sub}`, EXIT.USAGE, `run: ${CLI} agents status`);
}

// The label for a reader the run did not write, by the state that names why:
// `none` documents no agents file, `other` is a reader this tool does not write,
// `skipped` was an adapter the caller did not ask for (ADR-107).
const OTHER_LABEL = { none: 'NO FILE ', other: 'NOT OURS', skipped: 'SKIPPED ' };

async function installAgents(root, flags) {
  const mode = writeMode(flags);
  // `--harness` narrows the install to one reader (ADR-107). The id is validated
  // against the same table the loop reads, so a typo fails before anything is
  // planned; the remedy names the ids the way `agent-hook` does.
  const selected = flags.harness;
  if (selected !== undefined && adapter(selected) === null) {
    return fail(
      `unknown harness \`${selected}\``,
      EXIT.USAGE,
      `--harness <id>, one of: ${adapters().map((a) => a.id).join(', ')}`,
    );
  }

  const plan = await planAgents(root, { harness: selected });

  // The readers this tool does not write a file for, reported rather than skipped in
  // silence: a command that writes six files and says nothing about the two harnesses
  // that document no agents file reads as "those are covered too". A narrowed install
  // adds a third state: an adapter that is this tool's but was not requested (ADR-107).
  const others = [];
  for (const r of agentRows()) {
    if (r.path === null) others.push({ id: r.id, path: null, state: 'none', note: r.note });
    else if (adapter(r.id) === null) others.push({ id: r.id, path: r.path, state: 'other', note: r.note });
    else if (selected !== undefined && r.id !== selected) {
      others.push({ id: r.id, path: r.path, state: 'skipped', note: 'not requested; install without --harness to write every harness' });
    }
  }

  // The `--diff` pairs, read before anything is written so the before side is
  // true in preview and in apply alike (R50).
  const diffs =
    flags.diff === true
      ? await Promise.all(
        plan
          .filter((p) => p.action !== 'unchanged')
          .map(async (p) => ({ path: p.path, before: await readBefore(join(root, p.path)), after: p.text })),
      )
      : [];

  if (!mode.apply) {
    if (isJson(flags)) {
      emitJson({
        ok: true,
        command: 'agents install',
        root,
        dryRun: true,
        plan: plan.map(({ text, ...rest }) => rest),
        notWritten: others,
        filesWritten: false,
        ...diffField(diffs, flags),
      });
      return EXIT.OK;
    }
    emit(
      [
        `repo     ${root}`,
        ...plan.map((p) => `${p.action.toUpperCase().padEnd(9)} ${p.id.padEnd(12)} ${p.path}`),
        ...others.map((o) => `${OTHER_LABEL[o.state]} ${o.id.padEnd(12)} ${o.path ?? '(no agents file is documented)'}`),
        '',
        `PLAN     nothing written; apply with: ${CLI} agents install --yes`,
      ].join('\n'),
      { maxBytes: flags.maxBytes ?? 0 },
    );
    // After the report: the report says what, the diff shows it (R50).
    emitDiffs(diffs, flags);
    return EXIT.OK;
  }

  // Journaled so `undo` restores this run (R49).
  const journal = [];
  const written = await writeAgentPlan(root, journal, plan);
  await commitJournal(root, 'agents install', journal);

  if (isJson(flags)) {
    emitJson({
      ok: true,
      command: 'agents install',
      root,
      plan: plan.map(({ text, ...rest }) => rest),
      notWritten: others,
      written,
      filesWritten: true,
      ...diffField(diffs, flags),
    });
    return EXIT.OK;
  }
  emit(
    [
      `repo     ${root}`,
      ...plan.map((p) => `${p.action.toUpperCase().padEnd(9)} ${p.id.padEnd(12)} ${p.path}`),
      ...others.map((o) => `${OTHER_LABEL[o.state]} ${o.id.padEnd(12)} ${o.path ?? '(no agents file is documented)'}`),
      '',
      `WROTE    ${written.length} agent file(s)`,
    ].join('\n'),
    { maxBytes: flags.maxBytes ?? 0 },
  );
  // After the report: the report says what, the diff shows it (R50).
  emitDiffs(diffs, flags);
  for (const o of others) note(`note     ${o.id}: not written - ${o.note}`);
  if (written.length === 0) note('note     every documented agents file already carried this agent');
  note(`note     never committed or pushed (ADR-001); review, then commit yourself`);
  return EXIT.OK;
}

async function agentsStatus(root, flags) {
  const agent = await loadAgent();
  const rows = [];
  const problems = [];

  // The file this tool owns whole is compared against what `install` would write
  // right now, so status reads the same bytes install reads: a file that matches
  // the preview is present, anything else is drift an install will rewrite.
  for (const row of adapters()) {
    const path = agentPath(row.id);
    const existing = await readIfExists(join(root, path));
    if (existing === null) {
      rows.push({ id: row.id, path, state: 'absent', note: null });
      continue;
    }
    const present = rendered(row, agent, existing).action === 'unchanged';
    rows.push({
      id: row.id,
      path,
      state: present ? 'present' : 'drift',
      note: present ? null : 'differs from what install would write; run install to restore it',
    });
  }

  // The readers whose agents are not a file this tool can write — a vendor page
  // that documents none — are reported from the same table that documents them,
  // rather than from a second list of the harnesses this command happens to know.
  for (const r of agentRows()) {
    if (r.path === null) rows.push({ id: r.id, path: null, state: 'none', note: r.note });
    else if (adapter(r.id) === null) rows.push({ id: r.id, path: r.path, state: 'other', note: r.note });
  }

  if (isJson(flags)) {
    emitJson({ ok: problems.length === 0, command: 'agents status', root, harnesses: rows, problems });
    return problems.length === 0 ? EXIT.OK : EXIT.FAIL;
  }

  const lines = [`repo     ${root}`];
  for (const r of rows) {
    const state = { present: 'PRESENT ', absent: 'ABSENT  ', drift: 'DRIFT   ', none: 'NO FILE ', other: 'NOT OURS' }[r.state];
    lines.push(`${state} ${r.id.padEnd(12)} ${r.path ?? '(no agents file is documented)'}`);
    if (r.state === 'absent') lines.push(`          ${' '.repeat(12)} install: ${CLI} agents install --yes`);
    if (r.note) lines.push(`          ${' '.repeat(12)} ${r.note}`);
  }
  if (problems.length > 0) {
    lines.push('', 'problems:');
    for (const p of problems) lines.push(`  ${p}`);
  }
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return problems.length === 0 ? EXIT.OK : EXIT.FAIL;
}

async function readIfExists(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
