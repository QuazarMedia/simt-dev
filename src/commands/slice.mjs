// `simt slice start` and `simt slice finish`: one tracker row, one branch.
//
// A row in a tracker is a promise, and these are the two moments it is acted on.
// `start` isolates the work: a linked worktree on a branch named for the row, so the
// main checkout stays free for whatever else is running, and a task brief assembled in
// the main checkout at `.simt/local/briefs/<id>.md`, beside the worktree and outside
// its tree, where an agent picks it up. `finish` closes the loop the way the repository's own hook would:
// the declared gates run through the shared dispatcher first, because a command that
// commits for you may not assume a hook is installed to stop it, then the commit
// carries a Conventional subject built from the row's own title, and only then does
// the tracker learn the SHA and the test command that closed it — the R31 row
// machinery, called, never reimplemented.
//
// Two orders here are contracts rather than preferences:
//
//   start: worktree, brief, then row. Everything the row would claim exists before it
//   claims it, so a failed `worktree add` leaves the tracker untouched.
//
//   finish: gates, commit, row. The row records a SHA that only exists after the
//   commit, and if the row write then fails the message says which half happened —
//   the commit exists, the tracker does not know it — because a silent half-state is
//   how a tracker starts lying.
//
// The tracker itself always lives in the MAIN checkout. `start` flips the row there
// and `finish` records the evidence there, while the worktree carries only the
// slice's code: editing the same row in both places would make every merge of a
// finished slice a conflict on the one line that records it.

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import { EXIT, emit, emitJson, fail, isJson, note, writeMode } from '../output/index.mjs';
import { planDone, planNext } from '../plan/index.mjs';
import { loadFormat } from '../plan/template.mjs';
import { assembleBrief } from '../brief/assemble.mjs';
import { renderGateReport, runGates, stagedFiles } from '../hooks/dispatcher.mjs';
import { GATES } from '../hooks/gates.mjs';
import { indexTreeId, passEntryForGate, readLedger } from '../ledger/index.mjs';
import {
  DEFAULT_TTL_SECONDS,
  activeLeases,
  canonicalLeasePath,
  readLeases,
  withLeaseLock,
  writeLeases,
} from '../lease.mjs';
import { SESSION_ENV } from '../agenthooks/policy.mjs';
import { assertVersionPin } from '../package-version.mjs';
import { coreIgnoreCase } from '../repo-root.mjs';
import { readManifest } from '../projection/manifest.mjs';
import { CLI, MANIFEST_FILE } from '../name.mjs';
import { LOCAL_DIR } from '../state.mjs';

const exec = promisify(execFile);

/**
 * The state a started slice moves to: the template's `started`-role state, not
 * a hard-coded word. A repository that renamed its states still starts slices,
 * and one that deleted the in-progress state fails closed in `plan done` on a
 * word its own template never defined (review 0003 Q23).
 */
async function startedState(main) {
  const loaded = await loadFormat(main);
  if (loaded.error) return { error: loaded.error, remedy: loaded.remedy };
  const { format } = loaded;
  return { state: format.startedWrite ?? format.canonical('in-progress') ?? 'In progress' };
}

/**
 * A Conventional Commits type: one lower-case word, optionally scoped, optionally
 * marked breaking. The scope a `finish` builds is the slice id, so this flag is the
 * subject's only free input — a title cannot say whether a slice was a feat, a fix or
 * a chore, and deriving it from the words would be a guess no reader could argue with.
 */
const TYPE = /^[a-z]+(?:\([a-z0-9][a-z0-9._-]*\))?!?$/;

async function git(root, args) {
  const { stdout } = await exec('git', ['-C', root, ...args], { maxBuffer: 32 << 20 });
  return stdout.trim();
}

/**
 * The checkout that owns the tracker: the main worktree when `root` is a linked one.
 *
 * `--git-common-dir` answers `.git` from the main checkout and `<main>/.git` from a
 * worktree, so resolving it against `root` and dropping the last component gives the
 * right answer in both shapes. A directory that is not a git repository at all falls
 * back to `root`: the plan machinery reads it from wherever it was pointed, and the
 * git commands below will have their own say about whether this is a repository.
 */
async function mainCheckout(root) {
  try {
    const common = await git(root, ['rev-parse', '--git-common-dir']);
    return dirname(resolve(root, common));
  } catch {
    return root;
  }
}

/**
 * The branch and worktree a slice owns. Both derive from the id: one id, one spelling.
 * The worktree lives under machine-local state (review 0003 Q19): a worktree inside
 * the checkout would be recorded as an embedded gitlink and would change the tree id.
 */
function places(main, id) {
  const slug = id.toLowerCase();
  return {
    branch: `slice/${slug}`,
    worktree: join(main, LOCAL_DIR, 'worktrees', slug),
  };
}

/**
 * The Conventional subject for a finished slice: `<type>(<id>): <title>`.
 *
 * The description is the row's own title, so the message says what the plan said it
 * would do — whitespace collapsed, a trailing period dropped (slice-commit wants an
 * imperative subject with no trailing period), and the id itself as the fallback when
 * a tracker has no title column rather than an empty description after the colon.
 */
function subjectFor(type, id, title) {
  const description = String(title ?? '').replace(/\s+/g, ' ').trim().replace(/\.$/, '') || id;
  return `${type}(${id.toLowerCase()}): ${description}`;
}

/** Resolve one named slice through `plan next`, which already knows missing and ambiguous. */
async function resolveSlice(main, id) {
  const found = await planNext(main, id);
  if (found.error) return { error: found.error, remedy: found.remedy ?? `run: ${CLI} plan status` };
  if (!found.next) return { error: found.reason ?? `${id} has no section`, remedy: `run: ${CLI} plan status` };
  return { slice: found.next };
}

/** The session holding the slice, or null when the caller named none: a person
 *  at a terminal has no session, and starting without one proceeds unleased
 *  rather than refusing the work. */
function sliceSession(flags) {
  const session = flags.session ?? process.env[SESSION_ENV] ?? null;
  return typeof session === 'string' && session !== '' ? session : null;
}

/**
 * The slice's lease path, in the spelling the pre-edit hook compares: the
 * worktree directory, repository-relative. Entries carry `kind: 'slice'` so a
 * later schema (review 0003 Q74) can tell slice claims from path claims; the
 * v1 reader keeps the extra fields without understanding them.
 */
function sliceLeaseRel(main, worktree) {
  return canonicalLeasePath(main, worktree, { ignoreCase: coreIgnoreCase(main) });
}

/**
 * Claim the slice for one session: a second session starting the same slice
 * is refused with the holder's name instead of racing it to the worktree.
 * A claim held by this session is refreshed; anything else on the file is
 * left alone.
 */
async function claimSlice(main, id, leaseRel, session) {
  try {
    return await withLeaseLock(main, async () => {
      const read = await readLeases(main);
      if (read.error !== null) return { error: read.error, path: read.path };
      const held = activeLeases(read);
      const other = held.find(
        (l) => l.session !== session && ((l.kind === 'slice' && l.slice === id) || (leaseRel !== null && l.path === leaseRel)),
      );
      if (other) return { conflict: other };
      const mine = {
        path: leaseRel,
        session,
        kind: 'slice',
        slice: id,
        expiresAt: Date.now() + DEFAULT_TTL_SECONDS * 1000,
      };
      const kept = held.filter((l) => !(l.kind === 'slice' && l.slice === id && l.session === session));
      const path = await writeLeases(main, [...kept, mine]);
      return { mine, path };
    });
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Release this session's claim on the slice. Best-effort by design: `finish`
 * calls it after the commit exists, so a lease failure is a note about a TTL
 * that will clean itself up, never a second failure stacked on a success.
 */
async function releaseSlice(main, id, session) {
  if (session === null) return { released: false };
  try {
    return await withLeaseLock(main, async () => {
      const read = await readLeases(main);
      if (read.error !== null) return { error: read.error };
      const held = activeLeases(read);
      const mine = held.filter((l) => l.kind === 'slice' && l.slice === id && l.session === session);
      if (mine.length === 0) return { released: false };
      await writeLeases(
        main,
        held.filter((l) => !mine.includes(l)),
      );
      return { released: true };
    });
  } catch (error) {
    return { error: error.message };
  }
}

export async function sliceCommand(sub, args, flags) {
  const root = flags.root ?? process.cwd();
  if (sub === 'start') {
    const id = args[0];
    if (!id) return fail(`${CLI} slice start needs a slice id`, EXIT.USAGE, `run: ${CLI} plan next`);
    return startSlice(root, id, flags);
  }
  if (sub === 'finish') {
    const id = args[0];
    if (!id) return fail(`${CLI} slice finish needs a slice id`, EXIT.USAGE, `run: ${CLI} plan next`);
    return finishSlice(root, id, flags);
  }
  if (sub === 'abandon') {
    const id = args[0];
    if (!id) return fail(`${CLI} slice abandon needs a slice id`, EXIT.USAGE, `run: ${CLI} plan next`);
    return abandonSlice(root, id, flags);
  }
  return fail(
    `unknown slice subcommand ${sub}`,
    EXIT.USAGE,
    `run: ${CLI} slice start <id>  |  ${CLI} slice finish <id>  |  ${CLI} slice abandon <id>`,
  );
}

async function startSlice(root, id, flags) {
  const mode = writeMode(flags);
  const main = await mainCheckout(root);
  const resolved = await resolveSlice(main, id);
  if (resolved.error) return fail(resolved.error, EXIT.USAGE, resolved.remedy);
  const { title, doc } = resolved.slice;
  const { branch, worktree } = places(main, id);
  // The brief lives beside the worktree, not in it: a file inside the worktree
  // is untracked content in the slice's own tree, and the tree id must name
  // the code, not the briefing (review 0003 Q19, Q23).
  const briefPath = join(main, LOCAL_DIR, 'briefs', `${id.toLowerCase()}.md`);
  const leaseRel = sliceLeaseRel(main, worktree);
  const session = sliceSession(flags);
  const task = `${id}: ${String(title ?? '').trim()}`;
  const apply = `run: ${CLI} slice start ${id} --yes`;

  const started = await startedState(main);
  if (started.error) return fail(started.error, EXIT.USAGE, started.remedy);
  // The row first, dry, against the main checkout: it is the only part of `start`
  // that can refuse for a reason about the tracker rather than about git, and a
  // preview that discovers it late is a preview that half-described the work.
  const preview = await planDone(main, id, { state: started.state, dryRun: true });
  if (preview.error) return fail(preview.error, EXIT.USAGE, preview.remedy ?? `run: ${CLI} plan status`);

  const leaseLine = session === null ? 'lease    (no session: pass --session or set SIMT_SESSION to lease the slice)' : `lease    slice ${id} as ${session} (claimed on apply)`;

  if (!mode.apply) {
    if (isJson(flags)) {
      emitJson({
        ok: true,
        command: 'slice start',
        root,
        id,
        title,
        dryRun: true,
        branch,
        worktree: relative(main, worktree),
        brief: { path: relative(main, briefPath), bytes: null },
        lease: session === null ? null : { slice: id, path: leaseRel, session },
        state: { from: preview.from, to: preview.to, changed: preview.wouldChange },
        remedy: apply,
      });
      return EXIT.OK;
    }
    const lines = [
      `repo     ${root}`,
      `slice    ${id}  ${doc}`,
      `branch   ${branch}`,
      `worktree ${relative(main, worktree)}`,
      `brief    ${relative(main, briefPath)} (assembled on apply)`,
      leaseLine,
      `state    ${preview.from} -> ${preview.to}`,
      `apply    ${apply}`,
    ];
    emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }

  // Assemble before anything is created: a packet that cannot be built must leave the
  // repository exactly as it was, rather than a worktree nobody can brief and a row
  // still waiting. `build` defaults on — this is a command a person asked for, not a
  // prompt-submit delivery, so a cold index is built rather than reported.
  const packet = await assembleBrief({ root: main, task });
  if (packet.error) {
    return fail(`the brief for ${id} could not be assembled: ${packet.error}`, EXIT.FAIL, `run: ${CLI} brief ${JSON.stringify(task)}`);
  }
  if (packet.cold) {
    return fail(`the index at ${main} is empty and will not build here`, EXIT.UNSUPPORTED, `run: ${CLI} index`);
  }

  // Claimed before the worktree exists: a second session starting the same slice
  // is refused here, not after a worktree that then has to be taken back down.
  let lease = null;
  if (session !== null) {
    const claimed = await claimSlice(main, id, leaseRel, session);
    if (claimed.error) {
      return fail(`the slice could not be leased: ${claimed.error}`, EXIT.FAIL, `run: ${CLI} lease to see every claim`);
    }
    if (claimed.conflict) {
      const holder = claimed.conflict.session;
      const until = new Date(claimed.conflict.expiresAt).toISOString();
      return fail(
        `${id} is already started by session ${holder} (lease until ${until})`,
        EXIT.FAIL,
        `wait for the TTL or ask ${holder} to finish or abandon it; run: ${CLI} lease to see every claim`,
      );
    }
    lease = claimed.mine;
  }

  try {
    await git(main, ['worktree', 'add', '-b', branch, worktree]);
  } catch (error) {
    const detail = String(error.stderr ?? error.message ?? error).trim().split('\n')[0];
    return fail(`the worktree could not be created: ${detail}`, EXIT.FAIL, `run: git -C ${main} worktree list`);
  }

  await mkdir(dirname(briefPath), { recursive: true });
  await writeFile(briefPath, packet.packed.text, 'utf8');

  const row = await planDone(main, id, { state: started.state, dryRun: false });
  if (row.error) {
    return fail(`${branch} exists with its brief, but the tracker row was not updated: ${row.error}`, EXIT.FAIL, row.remedy ?? `run: ${CLI} plan status`);
  }

  const bytes = Buffer.byteLength(packet.packed.text);
  if (session === null) note('note     no session: the slice is not leased; a second start will not see this one');
  if (isJson(flags)) {
    emitJson({
      ok: true,
      command: 'slice start',
      root,
      id,
      title,
      branch,
      worktree: relative(main, worktree),
      brief: { path: relative(main, briefPath), bytes },
      lease,
      state: { from: row.from, to: row.to, changed: row.changed },
    });
    return EXIT.OK;
  }
  const lines = [
    `repo     ${root}`,
    `slice    ${id}  ${doc}`,
    `branch   ${branch}`,
    `worktree ${relative(main, worktree)}`,
    `brief    ${relative(main, briefPath)}  ${bytes} bytes`,
    lease === null ? 'lease    (none)' : `lease    slice ${id} as ${session}`,
    `state    ${row.from} -> ${row.to}`,
  ];
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}

/**
 * Split the declared gates into the ones that must run and the ones the ledger
 * already proves: a gate with a passing entry on exactly this staged tree, and
 * no later failure for the same gate on the same tree, does not run again.
 * That is the double gate the review verified — the dispatcher, then the
 * commit hook — and the seed of the gate-run cache (review 0003 Q23).
 *
 * Fail-closed throughout: no tree, no ledger, a version mismatch, or an
 * unknown gate all mean the gate runs. An entry recorded under another binary
 * is not evidence for this one, so a pin mismatch disables the cache and
 * routes through `runGates`, which fails on the mismatch itself.
 */
async function splitGates(root, declared, manifestDoc) {
  if (!Array.isArray(declared) || declared.length === 0) return { fresh: [], skipped: [], tree: null };
  if (assertVersionPin(manifestDoc)) return { fresh: [...declared], skipped: [], tree: null };
  const stagedTree = await indexTreeId(root).catch(() => null);
  if (stagedTree === null) return { fresh: [...declared], skipped: [], tree: null };
  const { entries } = await readLedger(root).catch(() => ({ entries: [] }));
  const fresh = [];
  const skipped = [];
  for (const name of declared) {
    if (GATES[name] === undefined) {
      fresh.push(name);
      continue;
    }
    const pass = passEntryForGate(entries, name, stagedTree);
    if (pass === null) fresh.push(name);
    else skipped.push({ name, at: pass.ts });
  }
  return { fresh, skipped, tree: stagedTree };
}

/** A gate result that did not run: the ledger line is the evidence. */
function cachedResult({ name, at }) {
  return {
    name,
    status: 'passed',
    detail: `already passed on this tree at ${at} (ledger); not re-run`,
    cached: true,
  };
}

async function finishSlice(root, id, flags) {
  const mode = writeMode(flags);
  const main = await mainCheckout(root);
  const resolved = await resolveSlice(main, id);
  if (resolved.error) return fail(resolved.error, EXIT.USAGE, resolved.remedy);
  const { title, doc } = resolved.slice;
  const { branch, worktree } = places(main, id);

  const type = String(flags.type ?? 'feat');
  if (!TYPE.test(type)) {
    return fail(`${type} is not a Conventional Commits type`, EXIT.USAGE, `example: run: ${CLI} slice finish ${id} --type fix`);
  }
  const subject = subjectFor(type, id, title);
  const test = flags.test ?? null;

  // A manifest that does not parse fails closed: the gates cannot be read, so nothing
  // may commit through them. No manifest at all is a valid answer — `runGates` turns
  // it into a note and an empty pass, the same way the hook does.
  const manifest = await readManifest(root);
  if (manifest.error) {
    return fail(`${MANIFEST_FILE}: ${manifest.error}`, EXIT.CONFIG, `fix ${MANIFEST_FILE}, or run: ${CLI} init`);
  }
  const declared = manifest.manifest?.gates?.preCommit ?? [];
  const apply = `run: ${CLI} slice finish ${id}${test ? ` --test ${JSON.stringify(test)}` : ''} --yes`;

  const staged = await stagedFiles(root);
  const split = await splitGates(root, declared, manifest.manifest);

  if (!mode.apply) {
    const row = await planDone(main, id, { sha: null, test, dryRun: true });
    if (row.error) return fail(row.error, EXIT.USAGE, row.remedy ?? `run: ${CLI} plan status`);
    const gateLine =
      declared.length === 0
        ? '(none declared)'
        : `${declared.join(', ')}${split.skipped.length > 0 ? `  (already passed on this tree: ${split.skipped.map((s) => s.name).join(', ')})` : ''}`;
    if (isJson(flags)) {
      emitJson({
        ok: true,
        command: 'slice finish',
        root,
        id,
        dryRun: true,
        subject,
        staged,
        gates: { event: 'pre-commit', declared, skipped: split.skipped.map((s) => s.name) },
        state: { from: row.from, to: row.to, changed: row.wouldChange },
        remedy: apply,
      });
      return EXIT.OK;
    }
    const lines = [
      `repo     ${root}`,
      `slice    ${id}  ${doc}`,
      `gates    pre-commit  ${gateLine} (run on apply)`,
      `staged   ${staged.length} file(s)${staged.length === 0 ? '  (finish refuses without one)' : ''}`,
      `subject  ${subject}`,
      `state    ${row.from} -> ${row.to}`,
      `apply    ${apply}`,
    ];
    emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }

  // The commit lands on the slice branch or not at all: finishing from `main`
  // commits main's tree under the slice's subject, which is the defect this
  // guard closes (review 0003 Q23).
  const head = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null);
  if (head !== branch) {
    return fail(
      `not on the slice branch: HEAD is ${head ?? 'unknown'}, expected ${branch}`,
      EXIT.USAGE,
      `move to the slice worktree (${relative(main, worktree)}) and rerun: ${apply}`,
    );
  }

  if (staged.length === 0) {
    return fail(`${root} has nothing staged to commit`, EXIT.USAGE, `stage what the slice changed, then rerun: ${apply}`);
  }

  // The gates the hook would run, run here. This command is the one place a commit
  // happens where a hook could not have stopped it, so it runs the same dispatcher
  // over the same event, in the checkout that holds the staged diff — except the
  // gates the ledger already proves for this tree, which are reported, not re-run.
  const manifestForGates =
    split.fresh.length === declared.length
      ? manifest.manifest
      : { ...manifest.manifest, gates: { ...(manifest.manifest?.gates ?? {}), preCommit: split.fresh } };
  const freshGates =
    split.fresh.length === 0 && declared.length > 0
      ? { event: 'pre-commit', gates: [], failed: false, notes: [] }
      : await runGates('pre-commit', { root, manifest: manifestForGates });
  if (freshGates.error) return fail(freshGates.error, EXIT.USAGE);

  // A gate that rewrites the tree (the formatter restaging) moves the commit
  // off the tree the skipped gates passed on. Their evidence is stale, so they
  // run once on the new tree; those results stand, the way fresh results do.
  let skipped = split.skipped;
  if (skipped.length > 0 && split.tree !== null) {
    const afterTree = await indexTreeId(root).catch(() => null);
    if (afterTree !== null && afterTree !== split.tree) {
      const { entries } = await readLedger(root).catch(() => ({ entries: [] }));
      const stale = skipped.filter((s) => passEntryForGate(entries, s.name, afterTree) === null);
      if (stale.length > 0) {
        const rerun = await runGates('pre-commit', {
          root,
          manifest: { ...manifest.manifest, gates: { ...(manifest.manifest?.gates ?? {}), preCommit: stale.map((s) => s.name) } },
        });
        if (rerun.error) return fail(rerun.error, EXIT.USAGE);
        freshGates.gates.push(...rerun.gates);
        if (rerun.failed) freshGates.failed = true;
        for (const n of rerun.notes ?? []) freshGates.notes.push(n);
        skipped = skipped.filter((s) => !stale.some((t) => t.name === s.name));
      }
    }
  }

  const byName = new Map(freshGates.gates.map((g) => [g.name, g]));
  const combined = declared.map((name) => byName.get(name) ?? cachedResult(skipped.find((s) => s.name === name)));
  const gates = { ...freshGates, gates: combined };

  if (gates.failed) {
    const failed = gates.gates.filter((g) => g.status === 'failed').map((g) => g.name).join(', ');
    if (isJson(flags)) {
      emitJson({
        ok: false,
        command: 'slice finish',
        root,
        id,
        exitCode: EXIT.FAIL,
        error: `pre-commit gates failed: ${failed}`,
        remedy: `run: ${CLI} hooks run pre-commit --root ${root}`,
        gates: gates.gates,
      });
      return EXIT.FAIL;
    }
    for (const n of gates.notes ?? []) note(`note     ${n}`);
    emit(renderGateReport('pre-commit', declared, gates).join('\n'), { maxBytes: flags.maxBytes ?? 0 });
    return EXIT.FAIL;
  }

  let sha = null;
  try {
    await git(root, ['commit', '-m', subject]);
    sha = await git(root, ['rev-parse', 'HEAD']);
  } catch (error) {
    const detail = String(error.stderr ?? error.message ?? error).trim().split('\n')[0];
    return fail(`the gates passed but the commit failed: ${detail}`, EXIT.FAIL, `run: git -C ${root} commit -m ${JSON.stringify(subject)}`);
  }

  const row = await planDone(main, id, { sha, test, dryRun: false });
  if (row.error) {
    return fail(`${sha} is committed, but the tracker row could not record it: ${row.error}`, EXIT.FAIL, row.remedy ?? `run: ${CLI} plan status`);
  }

  // The slice is done: its lease goes with it. A failure here is a note — the
  // commit exists, and a lease the TTL will reap is not a second failure.
  const released = await releaseSlice(main, id, sliceSession(flags));
  if (released.error) note(`note     the slice lease could not be released (${released.error}); the TTL reaps it`);

  for (const s of skipped) note(`note     ${s.name}: already passed on this tree; not re-run`);
  if (isJson(flags)) {
    emitJson({
      ok: true,
      command: 'slice finish',
      root,
      id,
      title,
      commit: { sha, subject },
      gates: gates.gates,
      staged,
      evidence: { recorded: row.evidenceRecorded, sha: row.sha, test: row.test, note: row.evidenceNote },
      row: { file: relative(main, row.file), line: row.line, from: row.from, to: row.to, changed: row.changed },
    });
    return EXIT.OK;
  }

  for (const n of gates.notes ?? []) note(`note     ${n}`);
  const lines = [
    `repo     ${root}`,
    `slice    ${id}  ${doc}`,
    ...renderGateReport('pre-commit', declared, gates),
    `commit   ${sha}  ${subject}`,
    `state    ${row.from} -> ${row.to}`,
    `record   ${relative(main, row.file)} line ${row.line}  (edited, not staged: commit it with the merge)`,
  ];
  if (row.evidenceRecorded) lines.push(`evidence ${sha}${test ? `  test: ${test}` : ''}`);
  else if (row.evidenceNote) lines.push(`note     ${row.evidenceNote}`);
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}

/**
 * `simt slice abandon <id>`: take the slice back down. The worktree is
 * removed, the branch deleted, and the tracker row returns to the ready
 * state — abandonment is a state the tracker can see, not a worktree that
 * silently rots. Preview names everything that would be destroyed; `--yes`
 * is the consent to destroy it (review 0003 Q23).
 */
async function abandonSlice(root, id, flags) {
  const mode = writeMode(flags);
  const main = await mainCheckout(root);
  const resolved = await resolveSlice(main, id);
  if (resolved.error) return fail(resolved.error, EXIT.USAGE, resolved.remedy);
  const { doc } = resolved.slice;
  const { branch, worktree } = places(main, id);
  const session = sliceSession(flags);
  const apply = `run: ${CLI} slice abandon ${id} --yes`;

  const loaded = await loadFormat(main);
  if (loaded.error) return fail(loaded.error, EXIT.USAGE, loaded.remedy);
  const readyDisplay = loaded.format.canonical(loaded.format.ready) ?? 'Queued';
  const preview = await planDone(main, id, { state: readyDisplay, dryRun: true });
  if (preview.error) return fail(preview.error, EXIT.USAGE, preview.remedy ?? `run: ${CLI} plan status`);

  if (!mode.apply) {
    if (isJson(flags)) {
      emitJson({
        ok: true,
        command: 'slice abandon',
        root,
        id,
        dryRun: true,
        branch,
        worktree: relative(main, worktree),
        state: { from: preview.from, to: preview.to, changed: preview.wouldChange },
        remedy: apply,
      });
      return EXIT.OK;
    }
    const lines = [
      `repo     ${root}`,
      `slice    ${id}  ${doc}`,
      `remove   ${relative(main, worktree)} and branch ${branch} (on apply)`,
      `state    ${preview.from} -> ${preview.to}`,
      `apply    ${apply}`,
    ];
    emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }

  // Abandoning from inside the worktree would pull the floor out: the shell's
  // own directory is the thing being removed. Compared through git, not through
  // strings, because the caller's spelling of the path may differ in symlinks.
  const top = await git(root, ['rev-parse', '--show-toplevel']).catch(() => null);
  if (top !== null && (top === worktree || top.startsWith(`${worktree}/`))) {
    return fail(
      `cannot abandon ${id} from inside its worktree`,
      EXIT.USAGE,
      `move to the main checkout (${main}) and rerun: ${apply}`,
    );
  }

  const removed = [];
  try {
    await git(main, ['worktree', 'remove', '--force', worktree]);
    removed.push(`removed  ${relative(main, worktree)}`);
  } catch (error) {
    const detail = String(error.stderr ?? error.message ?? error).trim().split('\n')[0];
    removed.push(`kept     ${relative(main, worktree)} (${detail})`);
  }
  try {
    await git(main, ['branch', '-D', branch]);
    removed.push(`deleted  ${branch}`);
  } catch (error) {
    const detail = String(error.stderr ?? error.message ?? error).trim().split('\n')[0];
    removed.push(`kept     ${branch} (${detail})`);
  }

  const row = await planDone(main, id, { state: readyDisplay, dryRun: false });
  if (row.error) {
    return fail(
      `the worktree is down, but the tracker row was not updated: ${row.error}`,
      EXIT.FAIL,
      row.remedy ?? `run: ${CLI} plan status`,
    );
  }

  const released = await releaseSlice(main, id, session);
  const leaseLine =
    released.released === true
      ? `released the slice lease`
      : released.error
        ? `the slice lease could not be released (${released.error}); the TTL reaps it`
        : 'no slice lease was held';
  if (isJson(flags)) {
    emitJson({
      ok: true,
      command: 'slice abandon',
      root,
      id,
      branch,
      worktree: relative(main, worktree),
      lease: released.released === true ? { slice: id, session } : null,
      state: { from: row.from, to: row.to, changed: row.changed },
    });
    return EXIT.OK;
  }
  const lines = [`repo     ${root}`, `slice    ${id}  ${doc}`, ...removed, `state    ${row.from} -> ${row.to}`, `lease    ${leaseLine}`];
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}
