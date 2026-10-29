// simt agent-hook <event> | agent-hooks install | agent-hooks status
//
// Three commands, one subject: the rules the tool projects, enforced while the agent is
// working rather than when git is committing. `agent-hook` is the entry point a harness
// calls; it reads one JSON payload on stdin and answers in that harness's dialect.
// `install` writes the entry into each harness's own config, and `status` reports what
// each harness will do and what still has to be trusted by hand.
//
// The entry point is on a hot path — it runs before every shell command an agent wants
// to run — so it imports the policy module, the decision, the renderer and nothing that
// walks the repository. A hook that measured the tree before answering would be exactly
// the latency the plan's acceptance criterion exists to prevent.
//
// A second event, `prompt-submit`, delivers rather than decides: it needs the manifest,
// the index and the packet assembly, so it is reached through a dynamic `import()` that
// only that event takes. A tool call therefore still pays for nothing that walks the
// repository, and the one path that does pays for it once per prompt instead of once per
// command.
//
// A denial exits 2, which is what every harness in the table reads as "block". A mistake
// in the hook's own invocation must NOT exit 2: a typo in a config would then block every
// tool call. Failures of this command exit 1, which a harness reports as a failed hook,
// and that is the right blast radius for a hook that is broken rather than refusing.

import { mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { commitJournal, journaledWriteFile } from '../journal.mjs';
import { diffField, emitDiffs, readBefore } from '../diff.mjs';

import { EXIT, emit, emitJson, fail, isJson, note, writeMode } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { ALLOW_ENV, EVENTS, POLICY_IDS, SESSION_ENV } from '../agenthooks/policy.mjs';
import { decide, factsFor } from '../agenthooks/decide.mjs';
import { repoRoot } from '../repo-root.mjs';
import {
  adapter,
  adapters,
  decisionJson,
  factsFrom,
  hookPath,
  hookRows,
  installedIn,
  rendered,
} from '../agenthooks/render.mjs';

export async function agentHookCommand(args, flags) {
  const event = args[0];
  if (!EVENTS.includes(event)) {
    return fail(`unknown agent event \`${event ?? ''}\``, EXIT.FAIL, `known events: ${EVENTS.join(', ')}`);
  }

  const id = flags.harness ?? args[1];
  const row = id ? adapter(id) : null;
  if (row === null) {
    return fail(
      id === undefined ? `agent-hook needs --harness` : `unknown harness \`${id}\``,
      EXIT.FAIL,
      `--harness <id>, one of: ${adapters().map((a) => a.id).join(', ')}`,
    );
  }

  const { payload, empty, error } = await readPayload();
  if (empty || error) {
    // Nothing to check is not a violation. A harness that calls the hook with nothing on
    // stdin, or with a payload we cannot parse, has not told us that anything is wrong;
    // blocking there would stop real work on no evidence, which is how a hook gets
    // uninstalled the same afternoon it was installed.
    note(`note     ${id}: ${empty ? 'no payload on stdin' : `payload is not JSON (${error})`}; nothing to check`);
    return EXIT.OK;
  }

  // Delivery, not decision: the packet goes into the prompt and the exit code stays 0
  // whatever happens. The module behind it is the one thing here that reads the
  // repository, and the tool-call path above must not pay for it, so the door is a
  // dynamic import that only this event opens.
  if (event === 'prompt-submit') {
    const { deliverPrompt } = await import('../agenthooks/prompt.mjs');
    const delivered = await deliverPrompt(row, payload);
    if (delivered.skipped) {
      note(`note     ${id}: no packet delivered (${delivered.skipped})`);
      return EXIT.OK;
    }
    emit(JSON.stringify(delivered.json));
    return EXIT.OK;
  }

  if (event === 'post-tool-use') {
    const { deliverLessonRecall } = await import('../memory/lessons.mjs');
    const recalled = await deliverLessonRecall(row, payload, { root: flags.root });
    if (recalled.skipped) {
      note(`note     ${id}: no lesson recalled (${recalled.skipped})`);
      return EXIT.OK;
    }
    emit(JSON.stringify(recalled.json));
    return EXIT.OK;
  }

  // `--root` outranks the payload: a packaged hook runs from the plugin directory and the
  // harness's environment variable names the project, so a payload cwd that is the plugin's
  // own working directory must not win. The repository-install path passes no flag, and the
  // payload's cwd is what the harness reports. The answer is then resolved to the
  // repository's top level: a harness reports the directory it happens to be in, and an
  // agent works from subdirectories, so every repository-relative fact (the lease file,
  // `.gitmodules`) must resolve against the root git itself uses, not the cwd (review
  // 0003 Q16).
  const { root: payloadRoot, command, writes, session: payloadSession } = factsFrom(row, payload, { root: flags.root });
  const root = repoRoot(payloadRoot);
  // A relative write path is relative to the directory the harness is in, not to the
  // repository root the facts resolve against: an agent editing `keep.mjs` from `src/`
  // means `src/keep.mjs`, and a path joined to the wrong base is a path the lease file
  // will never meet (review 0003 Q16).
  // Writes are `{path, ...edit}` rows (Q17): the path resolves against the harness
  // cwd, the edit detail travels untouched so the region check sees the old_string.
  const writesAbsolute = writes.map((w) => {
    const path = typeof w === 'string' ? w : w?.path;
    const abs = typeof path === 'string' && isAbsolute(path) ? path : join(payloadRoot, path);
    return typeof w === 'string' ? abs : { ...w, path: abs };
  });
  const facts = await factsFor(root, { command, writes: writesAbsolute });
  // Harness hook processes rarely carry SIMT_SESSION, so the payload's own
  // session id is the fallback: without it an agent is blocked by its own
  // lease (review 0003 Q20). The environment still wins when it names one.
  const session =
    typeof process.env[SESSION_ENV] === 'string' && process.env[SESSION_ENV] !== ''
      ? process.env[SESSION_ENV]
      : (payloadSession ?? '');
  const decision = decide({ event, facts, env: { ...process.env, [SESSION_ENV]: session } });

  // Both notes are about a conclusion the author is about to draw: a lift that did
  // nothing because of a typo, and a lift that is the reason the command they expected to
  // be stopped was not.
  if (decision.unknown.length > 0) {
    note(`note     ${ALLOW_ENV} names no policy: ${decision.unknown.join(', ')}; known: ${POLICY_IDS.join(', ')}`);
  }
  if (decision.lifted.length > 0) {
    note(`note     allowed by ${ALLOW_ENV}: ${decision.lifted.join(', ')}`);
  }

  const json = decisionJson(row, decision);
  if (json === null) return EXIT.OK;

  if (root) {
    try {
      const { recordHookDenial } = await import('../memory/lessons.mjs');
      await recordHookDenial(root, {
        harness: row.id,
        event,
        policies: decision.blocked,
        messages: decision.messages,
        command,
        writes,
      });
    } catch {
      // Recording a lesson candidate must never block or alter the hook decision.
    }
  }

  emit(JSON.stringify(json));
  for (const message of decision.messages) note(`blocked  ${message}`);
  return row.denyExit;
}

export async function agentHooksCommand(sub, args, flags) {
  const root = flags.root ?? args[0] ?? process.cwd();
  if (sub === 'install') return installHooks(root, flags);
  if (sub === 'status') return hooksStatus(root, flags);
  return fail(`unknown agent-hooks subcommand ${sub}`, EXIT.USAGE, `run: ${CLI} agent-hooks status`);
}

async function installHooks(root, flags) {
  const mode = writeMode(flags);
  // The delivery is a second entry in the same config, and a repository asks for it by
  // declaring a `brief` key rather than by having the entry. Read through a dynamic
  // import for the same reason the hook delivers through one.
  const { promptOptIn } = await import('../agenthooks/prompt.mjs');
  const { listPromotedLessons } = await import('../memory/lessons.mjs');
  const [optIn, promotedLessons] = await Promise.all([
    promptOptIn(root),
    listPromotedLessons(root).catch(() => []),
  ]);
  const hasLessons = promotedLessons.length > 0;
  const plan = [];
  for (const row of adapters()) {
    const path = hookPath(row.id);
    const existing = await readIfExists(join(root, path));
    const result = rendered(row, existing, { prompt: optIn.optedIn, post: hasLessons });
    plan.push({
      id: row.id,
      path,
      action: result.error ? 'refused' : result.action,
      error: result.error,
      text: result.text,
      prompt: row.prompt === null || row.prompt === undefined ? null : optIn.optedIn ? 'declared' : 'not declared',
    });
  }

  // One line for the repository, not one per adapter: the opt-in is a property of the
  // repository, and someone who has not declared it is told how once.
  const promptLine = plan.some((p) => p.prompt !== null) && !optIn.optedIn
    ? [`PROMPT   not opted in (${optIn.why}); add "brief": {} to the manifest to deliver the packet on every prompt`]
    : [];

  // The readers this tool does not write an entry for, reported rather than skipped in
  // silence: a command that writes four files and says nothing about the fifth harness
  // in the repository reads as "that one is covered too".
  const others = [];
  for (const r of hookRows()) {
    if (r.path === null) others.push({ id: r.id, path: null, state: 'none', note: r.note });
    else if (adapter(r.id) === null) others.push({ id: r.id, path: r.path, state: 'other', note: r.note });
  }

  const refused = plan.filter((p) => p.error);

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
        ok: refused.length === 0,
        command: 'agent-hooks install',
        root,
        dryRun: true,
        plan: plan.map(({ text, ...rest }) => rest),
        notWritten: others,
        filesWritten: false,
        ...diffField(diffs, flags),
      });
      return refused.length > 0 ? EXIT.FAIL : EXIT.OK;
    }
    emit(
      [
        `repo     ${root}`,
        ...plan.map((p) => `${p.action.toUpperCase().padEnd(9)} ${p.id.padEnd(12)} ${p.path}${p.error ? `  (${p.error})` : ''}`),
        ...others.map((o) => `${o.state === 'none' ? 'NO FILE ' : 'NOT OURS'} ${o.id.padEnd(12)} ${o.path ?? '(no hooks file is documented)'}`),
        ...promptLine,
        '',
        refused.length > 0
          ? `REFUSED  ${refused.length} config file(s) could not be read; nothing written`
          :        `PLAN     nothing written; apply with: ${CLI} agent-hooks install --yes`,
      ].join('\n'),
      { maxBytes: flags.maxBytes ?? 0 },
    );
    // After the report: the report says what, the diff shows it (R50).
    emitDiffs(diffs, flags);
    return refused.length > 0 ? EXIT.FAIL : EXIT.OK;
  }

  // Refused beats partial: a config this tool cannot parse is one it must not rewrite,
  // and writing the other three while one is unreadable leaves the repository in a state
  // where the report it just printed is no longer true.
  if (refused.length > 0) {
    return fail(`refused to write ${refused.map((p) => `${p.path} (${p.error})`).join('; ')}`, EXIT.FAIL);
  }

  // Journaled so `undo` restores this run (R49).
  const journal = [];
  const written = [];
  for (const p of plan.filter((x) => x.action !== 'unchanged')) {
    await mkdir(join(root, dirname(p.path)), { recursive: true });
    await journaledWriteFile(root, journal, join(root, p.path), p.text);
    written.push(p);
  }
  await commitJournal(root, 'agent-hooks install', journal);

  const notes = [];
  for (const p of written) {
    const trust = adapter(p.id).trust;
    if (trust) notes.push(`${p.id}: ${trust}`);
  }
  if (written.length === 0) notes.push('every documented hooks file already carried this tool’s entry');

  if (isJson(flags)) {
    emitJson({
      ok: true,
      command: 'agent-hooks install',
      root,
      plan: plan.map(({ text, ...rest }) => rest),
      notWritten: others,
      written: written.map((p) => p.path),
      filesWritten: true,
      notes,
      ...diffField(diffs, flags),
    });
    return EXIT.OK;
  }
  emit(
    [
      `repo     ${root}`,
      ...plan.map((p) => `${p.action.toUpperCase().padEnd(9)} ${p.id.padEnd(12)} ${p.path}`),
      ...others.map((o) => `${o.state === 'none' ? 'NO FILE ' : 'NOT OURS'} ${o.id.padEnd(12)} ${o.path ?? '(no hooks file is documented)'}`),
      ...promptLine,
      '',
      `WROTE    ${written.length} hooks file(s); each one runs ${CLI} agent-hook before the tool call`,
    ].join('\n'),
    { maxBytes: flags.maxBytes ?? 0 },
  );
  // After the report: the report says what, the diff shows it (R50).
  emitDiffs(diffs, flags);
  for (const o of others) note(`note     ${o.id}: not written - ${o.note}`);
  for (const n of notes) note(`note     ${n}`);
  note(`note     never committed or pushed (ADR-001); review, then commit yourself`);
  return EXIT.OK;
}

async function hooksStatus(root, flags) {
  const rows = [];
  const problems = [];

  for (const row of adapters()) {
    const path = hookPath(row.id);
    const existing = await readIfExists(join(root, path));
    if (existing === null) {
      rows.push({ id: row.id, path, state: 'absent', entries: 0, prompt: row.prompt ? 'absent' : null, note: null });
      continue;
    }
    let config;
    try {
      config = JSON.parse(existing);
    } catch (e) {
      rows.push({ id: row.id, path, state: 'unreadable', entries: 0, prompt: row.prompt ? 'unknown' : null, note: e.message });
      problems.push(`${path} is not valid JSON: ${e.message}`);
      continue;
    }
    // A file that parses but is not an object cannot hold a hooks table, and `install`
    // refuses to write into one. Status has to agree with it, or one question gets two
    // answers and the quiet one is the one a reader acts on.
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      rows.push({ id: row.id, path, state: 'unreadable', entries: 0, prompt: row.prompt ? 'unknown' : null, note: 'not a JSON object' });
      problems.push(`${path} is not a JSON object, so this tool will not write into it`);
      continue;
    }
    const found = installedIn(row, config).length;
    const prompts = row.prompt ? installedIn(row, config, EVENTS[1]).length : 0;
    rows.push({
      id: row.id,
      path,
      state: found > 0 ? 'present' : 'absent',
      entries: found,
      prompt: row.prompt ? (prompts > 0 ? 'present' : 'absent') : null,
      note: found > 0 ? (row.trust ?? null) : null,
    });
  }

  // The readers whose hooks are not a file this tool can write — plugins, or a vendor
  // page that documents none — are reported from the same table that documents them,
  // rather than from a second list of the harnesses this command happens to know.
  for (const r of hookRows()) {
    if (r.path === null) rows.push({ id: r.id, path: null, state: 'none', entries: 0, note: r.note });
    else if (adapter(r.id) === null) rows.push({ id: r.id, path: r.path, state: 'other', entries: 0, note: r.note });
  }

  if (isJson(flags)) {
    emitJson({ ok: problems.length === 0, command: 'agent-hooks status', root, harnesses: rows, problems });
    return problems.length === 0 ? EXIT.OK : EXIT.FAIL;
  }

  const lines = [`repo     ${root}`];
  for (const r of rows) {
    const state = { present: 'PRESENT ', absent: 'ABSENT  ', unreadable: 'INVALID ', none: 'NO FILE ', other: 'NOT OURS' }[r.state];
    lines.push(`${state} ${r.id.padEnd(12)} ${r.path ?? '(no hooks file is documented)'}`);
    if (r.state === 'absent') lines.push(`          ${' '.repeat(12)} install: ${CLI} agent-hooks install --yes`);
    // The second event is a separate answer to a separate question: a harness can carry
    // the tool hook and not the delivery, and a reader who is told "PRESENT" would
    // otherwise conclude the packet arrives on every prompt.
    if (r.prompt) lines.push(`          ${' '.repeat(12)} prompt-submit: ${r.prompt}`);
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

/**
 * Read the one payload the harness has already written to stdin.
 *
 * A terminal on stdin means a person ran this by hand, and reading would hang until they
 * pressed Ctrl-D — so the isTTY check is the difference between a diagnostic and a
 * command that looks like it has frozen.
 */
async function readPayload() {
  if (process.stdin.isTTY) return { payload: {}, empty: true };
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return { payload: {}, empty: true };
  try {
    return { payload: JSON.parse(text) };
  } catch (e) {
    return { payload: {}, error: e.message };
  }
}
