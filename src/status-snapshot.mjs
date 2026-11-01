// The aggregate behind bare `simt status` (review 0003 Q82).
//
// `status --line` answers one question in milliseconds: the gate state as of the last
// check. Bare `status` was a usage error, and its comment justified that by claiming
// `plan` without a subcommand behaved the same way - `plan` exits 0 and prints its
// tracker. The question bare `status` was refusing is the one a UI's home view and a
// harness status line ask: what is the state of this repository.
//
// Every slot is read through the module that owns it - the check cache, hook routing,
// the agent-hook table, the ledger, the lease file, the plan tracker, the journal -
// because a second implementation of any of them is a second answer to the same
// question, and the quiet one is the one a reader acts on. A slot that cannot answer
// carries its error and leaves the rest of the snapshot intact: an unreadable manifest
// must not blind a caller to the evidence and the leases that did answer.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { adapters, hookPath, installedIn } from './agenthooks/render.mjs';
import { readHooksState, wantsShim } from './compare/hooksstate.mjs';
import { repoContext } from './context.mjs';
import { listJournalSets } from './journal.mjs';
import { activeLeases, readLeases } from './lease.mjs';
import { hasTestEvidence, readLedger } from './ledger/index.mjs';
import { CLI } from './name.mjs';
import { planStatus } from './plan/index.mjs';
import { currentHead, readCheckCache, renderStatusLine } from './status.mjs';
import { gitText } from './sys/git.mjs';

/** One slot's failure is that slot's answer, never the snapshot's. */
async function slot(compute) {
  try {
    return await compute();
  } catch (error) {
    return { error: error.message };
  }
}

async function checkSlot(root) {
  const record = await readCheckCache(root);
  if (record === null) return null;
  const head = await currentHead(root);
  const stale = head !== null && record.head !== null && head !== record.head;
  return {
    at: record.at,
    head: record.head,
    stale,
    line: renderStatusLine(record, stale),
    rulesOk: record.rulesOk,
    hooksOk: record.hooksOk,
    gatesRun: record.gatesRun,
    gatesTotal: record.gatesTotal,
    blocking: record.blocking,
    warnings: record.warnings,
  };
}

async function gitHooksSlot(root) {
  const { manifest, exists, error } = await repoContext(root).manifest();
  if (error) return { error };
  const state = await readHooksState(root, { declaresGate: (event) => wantsShim(manifest, exists, event) });
  return {
    hooksPath: state.current,
    liveDir: state.liveDir,
    events: state.installed.map((i) => ({ event: i.event, present: i.present, stale: i.stale })),
    foreign: state.foreign.length,
    gates: exists ? { preCommit: manifest?.gates?.preCommit ?? [], prePush: manifest?.gates?.prePush ?? [] } : null,
  };
}

/**
 * Which harnesses will decide a tool call.
 *
 * The summary, not the report: `agent-hooks status` owns the detail, including whether a
 * file drifted from what `install` would write and whether the prompt event is opted
 * into. What is shared is the definition of "installed" - `installedIn` reads the same
 * document the hook runs from, so this slot cannot say present about an entry that
 * `install` did not write.
 */
async function agentHooksSlot(root) {
  const harnesses = [];
  for (const row of adapters()) {
    const path = hookPath(row.id);
    let existing = null;
    try {
      existing = await readFile(join(root, path), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (existing === null) {
      harnesses.push({ id: row.id, path, state: 'absent' });
      continue;
    }
    if (row.file) {
      harnesses.push({ id: row.id, path, state: 'present' });
      continue;
    }
    let config;
    try {
      config = JSON.parse(existing);
    } catch {
      harnesses.push({ id: row.id, path, state: 'unreadable' });
      continue;
    }
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      harnesses.push({ id: row.id, path, state: 'unreadable' });
      continue;
    }
    harnesses.push({ id: row.id, path, state: installedIn(row, config).length > 0 ? 'present' : 'absent' });
  }
  return {
    wired: harnesses.filter((h) => h.state === 'present').length,
    total: harnesses.length,
    harnesses,
  };
}

async function evidenceSlot(root) {
  const { entries, errors } = await readLedger(root);
  let tree = null;
  try {
    tree = await gitText(root, ['rev-parse', 'HEAD^{tree}']);
  } catch {
    // No repository, no commits: there is no tree to have evidence for, and `null`
    // says that rather than \"no evidence\", which would read as a missing run.
    tree = null;
  }
  return {
    entries: entries.length,
    errors: errors.length,
    headTree: tree,
    testsRecorded: tree === null ? null : hasTestEvidence(entries, tree),
  };
}

async function leasesSlot(root) {
  const { leases, error } = await readLeases(root);
  if (error) return { error };
  const active = activeLeases({ leases });
  return { active: active.length, paths: active.map((lease) => lease.path) };
}

async function slicesSlot(root) {
  const status = await planStatus(root);
  if (status.error) return { error: status.error };
  return { ready: status.ready, totals: status.totals };
}

async function journalSlot(root) {
  const sets = await listJournalSets(root);
  return { sets: sets.length, last: sets[0] ?? null };
}

/**
 * The repository's state in one document.
 *
 * `ok` is the gate's verdict, not the snapshot's: a slot that failed to read is a fact
 * about this repository (unreadable state is a real condition), and folding it into
 * `ok` would turn a stale manifest into a failing gate no `sync` can fix.
 */
export async function statusSnapshot(root) {
  const [check, gitHooks, agentHooks, evidence, leases, slices, journal] = await Promise.all([
    slot(() => checkSlot(root)),
    slot(() => gitHooksSlot(root)),
    slot(() => agentHooksSlot(root)),
    slot(() => evidenceSlot(root)),
    slot(() => leasesSlot(root)),
    slot(() => slicesSlot(root)),
    slot(() => journalSlot(root)),
  ]);
  return {
    ok: (check?.blocking ?? 0) === 0,
    command: 'status',
    root,
    at: Date.now(),
    head: await currentHead(root),
    check,
    gitHooks,
    agentHooks,
    evidence,
    leases,
    slices,
    journal,
  };
}

function unavailable(label, slot) {
  return `${label.padEnd(9)}${slot.error}`;
}

/** The same snapshot, read as a person: one line per slot, and a pointer for the detail. */
export function renderSnapshot(snapshot) {
  const lines = [`repo     ${snapshot.root}`];
  if (snapshot.head !== null) lines.push(`head     ${snapshot.head}`);

  if (snapshot.check === null) lines.push(`check    no cache - run ${CLI} check`);
  else if (snapshot.check.error) lines.push(unavailable('check', snapshot.check));
  else lines.push(`check    ${snapshot.check.line}`);

  const hooks = snapshot.gitHooks;
  if (hooks.error) lines.push(unavailable('githooks', hooks));
  else {
    const wired = hooks.events.filter((e) => e.present && !e.stale).length;
    const foreign = hooks.foreign > 0 ? `, ${hooks.foreign} foreign hook(s)` : '';
    lines.push(`githooks ${wired}/${hooks.events.length} events wired${foreign}${hooks.hooksPath === null ? ` (git default: ${hooks.liveDir})` : ''}`);
  }

  const agent = snapshot.agentHooks;
  if (agent.error) lines.push(unavailable('agenthooks', agent));
  else lines.push(`agenthooks ${agent.wired}/${agent.total} harnesses wired - ${CLI} agent-hooks status`);

  const evidence = snapshot.evidence;
  if (evidence.error) lines.push(unavailable('evidence', evidence));
  else if (evidence.testsRecorded === null) lines.push(`evidence ${evidence.entries} run(s), no head tree to compare`);
  else lines.push(`evidence ${evidence.entries} run(s), ${evidence.testsRecorded ? 'a test run is recorded for this tree' : 'no test run for this tree'}`);

  const leases = snapshot.leases;
  if (leases.error) lines.push(unavailable('leases', leases));
  else lines.push(`leases   ${leases.active} active${leases.paths.length > 0 ? `: ${leases.paths.join(', ')}` : ''}`);

  const slices = snapshot.slices;
  if (slices.error) lines.push(unavailable('slices', slices));
  else {
    const counts = Object.entries(slices.totals).map(([state, count]) => `${count} ${state.toLowerCase()}`);
    lines.push(`slices   ${slices.ready} ready${counts.length > 0 ? ` - ${counts.join(', ')}` : ''}`);
  }

  const journal = snapshot.journal;
  if (journal.error) lines.push(unavailable('journal', journal));
  else lines.push(`journal  ${journal.sets} set(s)${journal.last === null ? '' : `, last ${journal.last}`}`);

  return lines.join('\n');
}
