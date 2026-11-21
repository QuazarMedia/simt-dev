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
// the tracker learn the SHA and the test command that closed it — the tracker
// machinery, called, never reimplemented.
//
// Two orders here are contracts rather than preferences:
//
//   start: worktree, brief, then row. Everything the row would claim exists before it
//   claims it, so a failed `worktree add` leaves the tracker untouched.
//
//   finish: gates, commit, row, merge, cleanup. The row records a SHA that only exists
//   after the commit, and if the row write then fails the message says which half
//   happened — the commit exists, the tracker does not know it — because a silent
//   half-state is how a tracker starts lying. The merge comes last because only then is
//   there a branch to merge, and the removal comes after it because a branch cannot be
//   deleted while a worktree has it checked out.
//
// `finish` is a main-checkout command. The commit is made on the slice branch in its
// worktree, but the merge and the removal happen in the checkout that owns the tracker:
// a worktree cannot delete the directory the shell is standing in, and a branch that is
// checked out cannot be merged into itself. Requiring the main checkout is what lets one
// command close the slice instead of leaving a merged branch and a worktree to clean up.
//
// The tracker itself always lives in the MAIN checkout. `start` flips the row there
// and `finish` records the evidence there, while the worktree carries only the
// slice's code: editing the same row in both places would make every merge of a
// finished slice a conflict on the one line that records it.

import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

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
import { commandRoot } from '../repo-root.mjs';
import { git, gitText } from '../sys/git.mjs';
import { abandonSlice } from './slice-abandon.mjs';

/**
 * The state a started slice moves to: the template's `started`-role state, not
 * a hard-coded word. A repository that renamed its states still starts slices,
 * and one that deleted the in-progress state fails closed in `plan done` on a
 * word its own template never defined.
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

/**
 * The checkout that owns the tracker: the main worktree when `root` is a linked one.
 *
 * `--git-common-dir` answers `.git` from the main checkout and `<main>/.git` from a
 * worktree, so resolving it against `root` and dropping the last component gives the
 * right answer in both shapes. A directory that is not a git repository at all falls
 * back to `root`: the plan machinery reads it from wherever it was pointed, and the
 * git commands below will have their own say about whether this is a repository.
 */
export async function mainCheckout(root) {
  try {
    const common = await gitText(root, ['rev-parse', '--git-common-dir']);
    return dirname(resolve(root, common));
  } catch {
    return root;
  }
}

/** Resolve symlinks so `/var` and `/private/var` are the same checkout (macOS). */
function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Whether `root` is the checkout that owns the tracker, not a linked worktree. */
async function isMainCheckout(root, main) {
  const top = await gitText(root, ['rev-parse', '--show-toplevel']).catch(() => null);
  return top !== null && canonicalPath(top) === canonicalPath(main);
}

/** The first line of a git failure, which is the one naming the conflict. */
function gitDetail(error) {
  return String(error?.stderr ?? error?.message ?? error).trim().split('\n')[0];
}

/**
 * Merge a committed slice into the main checkout, carry the tracker row in the merge
 * commit, then remove the worktree and its branch. Runs only from the main checkout:
 * `git worktree remove` cannot delete the directory its caller is standing in.
 *
 * A conflict aborts the merge before returning, so the main checkout is left as the
 * caller had it; the slice commit and its row are already recorded and are named by the
 * refusal. Cleanup is best-effort by contract: a worktree kept because it holds untracked
 * files is reported, not forced away, and its branch is kept with it.
 */
async function landSlice(main, { branch, worktree, row }) {
  const head = await gitText(main, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null);
  if (head === null || head === 'HEAD') {
    return { error: 'the main checkout has no branch checked out' };
  }
  try {
    await git(main, ['merge', '--no-ff', '--no-commit', branch]);
  } catch (error) {
    await git(main, ['merge', '--abort']).catch(() => {});
    return { error: gitDetail(error) };
  }
  const merging = await gitText(main, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).catch(() => null);
  if (merging === null) {
    return { error: `${branch} has no commits that ${head} does not already have` };
  }
  if (row !== null) {
    try {
      await git(main, ['add', '--', relative(main, row)]);
    } catch (error) {
      await git(main, ['merge', '--abort']).catch(() => {});
      return { error: `the tracker row could not be staged: ${gitDetail(error)}` };
    }
  }
  let mergeSha;
  try {
    await git(main, ['commit', '--no-edit']);
    mergeSha = await gitText(main, ['rev-parse', 'HEAD']);
  } catch (error) {
    await git(main, ['merge', '--abort']).catch(() => {});
    return { error: `the merge could not be committed: ${gitDetail(error)}` };
  }

  let worktreeRemoved = false;
  let worktreeReason = null;
  try {
    await git(main, ['worktree', 'remove', worktree]);
    worktreeRemoved = true;
  } catch (error) {
    worktreeReason = gitDetail(error);
  }
  let branchDeleted = false;
  let branchReason = worktreeRemoved ? null : 'the branch is still checked out in the worktree';
  if (worktreeRemoved) {
    try {
      await git(main, ['branch', '-d', branch]);
      branchDeleted = true;
    } catch (error) {
      branchReason = gitDetail(error);
    }
  }
  return { mergeSha, head, worktreeRemoved, worktreeReason, branchDeleted, branchReason };
}

/**
 * The branch and worktree a slice owns. Both derive from the id: one id, one spelling.
 * The worktree lives under machine-local state: a worktree inside
 * the checkout would be recorded as an embedded gitlink and would change the tree id.
 */
export function places(main, id) {
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

/**
 * The trailer of every commit this tool writes: attribution to the tool, in the
 * form git renders as a co-author. The slice-commit rule ends every message it
 * defines with the same line, so a commit the tool writes and one an agent
 * writes from the rule agree on attribution. Module-local: one caller needs no
 * export, and an export is a promise to a caller (deadcode).
 */
const CO_AUTHOR = 'Co-Authored-By: Simt Dev <noreply@simt.space>';

/** Resolve one named slice through `plan next`, which already knows missing and ambiguous. */
export async function resolveSlice(main, id) {
  const found = await planNext(main, id);
  if (found.error) return { error: found.error, remedy: found.remedy ?? `run: ${CLI} plan status` };
  if (!found.next) return { error: found.reason ?? `${id} has no section`, remedy: `run: ${CLI} plan status` };
  return { slice: found.next };
}

/**
 * The id for a prompt slice: a slug of the prompt text, capped so the branch and
 * worktree names it feeds stay short. Whitespace and punctuation fold to one hyphen,
 * and empty text falls back to `slice` rather than naming the slice after nothing.
 */
function slugify(text) {
  const slug = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug === '' ? 'slice' : slug;
}

/**
 * The record a prompt slice writes in place of a tracker row. A prompt slice is not in
 * a plan, so `planDone` has no row to flip and `planNext` has no section to read; the
 * record is the only place its existence is stated, and it is what `finish` and
 * `abandon` fall back to when the tracker has no row for the id. It lives beside the
 * briefs, under the local state directory, not in the tree the slice commits.
 */
export function recordPath(main, id) {
  return join(main, LOCAL_DIR, 'slices', `${id.toLowerCase()}.json`);
}

async function writeSliceRecord(main, id, record) {
  const path = recordPath(main, id);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return path;
}

export async function readSliceRecord(main, id) {
  try {
    return JSON.parse(await readFile(recordPath(main, id), 'utf8'));
  } catch {
    return null;
  }
}

/** The session holding the slice, or null when the caller named none: a person
 *  at a terminal has no session, and starting without one proceeds unleased
 *  rather than refusing the work. */
export function sliceSession(flags) {
  const session = flags.session ?? process.env[SESSION_ENV] ?? null;
  return typeof session === 'string' && session !== '' ? session : null;
}

/**
 * The slice's lease path, in the spelling the pre-edit hook compares: the
 * worktree directory, repository-relative. Entries carry `kind: 'slice'` so a
 * later schema can tell slice claims from path claims; the
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
/**
 * Take back the worktree and branch a failed `start` created.
 *
 * `--force` becomes `rm -rf` becomes a prune, the same order the abandon path uses: a
 * half-created tree must not be what decides whether the next start can run (A26).
 * Only the parts this attempt created are removed; a path or branch that existed before
 * the attempt made `worktree add` fail, and deleting either would destroy another
 * caller's work.
 */
async function discardWorktree(main, worktree, branch, { removeTree = true, deleteBranch = true } = {}) {
  if (removeTree) {
    await git(main, ['worktree', 'remove', '--force', worktree]).catch(async () => {
      await rm(worktree, { recursive: true, force: true }).catch(() => {});
      await git(main, ['worktree', 'prune']).catch(() => {});
    });
  }
  if (deleteBranch) await git(main, ['branch', '-D', branch]).catch(() => {});
}

async function branchExists(main, branch) {
  try {
    await git(main, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export async function releaseSlice(main, id, session) {
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
  const root = commandRoot(flags);
  if (sub === 'start') {
    // Prompt mode: `simt slice start -- "<text>"`. The `--` is the marker, so the
    // positional after it is the prompt, not a tracker id — there is no row to start,
    // and the id is derived from the text (or pinned with --id) rather than read.
    if (flags.dashdash === true) {
      const prompt = args[0];
      if (prompt === undefined || prompt === '') {
        return fail(`${CLI} slice start -- needs a prompt after --`, EXIT.USAGE, `run: ${CLI} slice start -- "<text>"`);
      }
      const id = flags.id ?? slugify(prompt);
      return startSlice(root, id, flags, prompt);
    }
    const id = args[0];
    if (!id) return fail(`${CLI} slice start needs a slice id`, EXIT.USAGE, `run: ${CLI} plan next`);
    return startSlice(root, id, flags, null);
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

async function startSlice(root, id, flags, prompt) {
  const mode = writeMode(flags);
  const main = await mainCheckout(root);
  const promptMode = prompt !== null;
  // A prompt slice has no tracker row: the title is the prompt, and the record file —
  // not `planDone` — is what `finish` and `abandon` will read.
  let title;
  let doc;
  if (promptMode) {
    title = prompt;
    doc = prompt;
  } else {
    const resolved = await resolveSlice(main, id);
    if (resolved.error) return fail(resolved.error, EXIT.USAGE, resolved.remedy);
    ({ title, doc } = resolved.slice);
  }
  const { branch, worktree } = places(main, id);
  // The brief lives beside the worktree, not in it: a file inside the worktree
  // is untracked content in the slice's own tree, and the tree id must name
  // the code, not the briefing.
  const briefPath = join(main, LOCAL_DIR, 'briefs', `${id.toLowerCase()}.md`);
  const leaseRel = sliceLeaseRel(main, worktree);
  const session = sliceSession(flags);
  const task = `${id}: ${String(title ?? '').trim()}`;
  const apply = promptMode
    ? `run: ${CLI} slice start --yes -- ${JSON.stringify(prompt)}`
    : `run: ${CLI} slice start ${id} --yes`;
  const record = recordPath(main, id);

  // The row first, dry, against the main checkout: it is the only part of `start`
  // that can refuse for a reason about the tracker rather than about git, and a
  // preview that discovers it late is a preview that half-described the work.
  // A prompt slice has no row to flip, so there is nothing to preview here.
  const started = promptMode ? { state: null } : await startedState(main);
  if (started.error) return fail(started.error, EXIT.USAGE, started.remedy);
  const preview = promptMode
    ? null
    : await planDone(main, id, { state: started.state, dryRun: true });
  if (preview !== null && preview.error) return fail(preview.error, EXIT.USAGE, preview.remedy ?? `run: ${CLI} plan status`);

  const leaseLine = session === null ? 'lease    (no session: pass --session or set SIMT_SESSION to lease the slice)' : `lease    slice ${id} as ${session} (claimed on apply)`;
  const stateLine = promptMode
    ? `state    (no tracker row; recorded at ${relative(main, record)})`
    : `state    ${preview.from} -> ${preview.to}`;
  const stateJson = promptMode
    ? { row: false, record: relative(main, record) }
    : { from: preview.from, to: preview.to, changed: preview.wouldChange };

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
        state: stateJson,
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
      stateLine,
      `finish   from ${main}: ${CLI} slice finish ${id}`,
      `apply    ${apply}`,
    ];
    emit(lines.join('\n'));
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

  // `worktree add` fails on a path or branch that already exists. Neither belongs to this
  // start, so cleanup must remove only what this attempt created (A26).
  const worktreeExisted = existsSync(worktree);
  const branchExisted = await branchExists(main, branch);
  try {
    await git(main, ['worktree', 'add', '-b', branch, worktree]);
  } catch (error) {
    const detail = String(error.stderr ?? error.message ?? error).trim().split('\n')[0];
    // The lease was claimed before the tree existed, and `git worktree add` may already
    // have created the branch before it failed. A start that has no tree has no claim and
    // no branch either, or the slice is blocked until the TTL (A26).
    await discardWorktree(main, worktree, branch, { removeTree: !worktreeExisted, deleteBranch: !branchExisted });
    if (lease !== null) await releaseSlice(main, id, session);
    return fail(`the worktree could not be created: ${detail}`, EXIT.FAIL, `run: git -C ${main} worktree list`);
  }

  await mkdir(dirname(briefPath), { recursive: true });
  await writeFile(briefPath, packet.packed.text, 'utf8');

  // Normal slices flip the tracker row; prompt slices write the record file that stands
  // in for it. Both are the "started" mark, and both land after the worktree exists so a
  // failed `worktree add` leaves neither behind.
  let row = null;
  if (promptMode) {
    await writeSliceRecord(main, id, { id, title, kind: 'prompt', createdAt: new Date().toISOString() });
  } else {
    // `planDone` can throw when the tracker cannot be written; a start that has a tree
    // must take that tree down on either shape of failure (A26).
    try {
      row = await planDone(main, id, { state: started.state, dryRun: false });
    } catch (error) {
      row = { error: String(error?.message ?? error), remedy: `run: ${CLI} plan status` };
    }
    if (row.error) {
      // The brief and the tree are both this start's; without the row nothing has
      // started, so take them back down rather than leaving a slice to clean up (A26).
      await discardWorktree(main, worktree, branch);
      if (lease !== null) await releaseSlice(main, id, session);
      return fail(`${branch} exists with its brief, but the tracker row was not updated: ${row.error}`, EXIT.FAIL, row.remedy ?? `run: ${CLI} plan status`);
    }
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
      state: promptMode
        ? { row: false, record: relative(main, record) }
        : { from: row.from, to: row.to, changed: row.changed },
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
    promptMode
      ? `state    (no tracker row; recorded at ${relative(main, record)})`
      : `state    ${row.from} -> ${row.to}`,
    `finish   from ${main}: ${CLI} slice finish ${id}`,
  ];
  emit(lines.join('\n'));
  return EXIT.OK;
}

/**
 * Split the declared gates into the ones that must run and the ones the ledger
 * already proves: a gate with a passing entry on exactly this staged tree, and
 * no later failure for the same gate on the same tree, does not run again.
 * That is the double gate the review verified — the dispatcher, then the
 * commit hook — and the seed of the gate-run cache.
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
  // A prompt slice has no tracker row: the record file stands in for it, and the
  // finish commits and releases the lease without flipping a row.
  const record = resolved.error ? await readSliceRecord(main, id) : null;
  if (resolved.error && record === null) {
    return fail(resolved.error, EXIT.USAGE, resolved.remedy);
  }
  const promptMode = record !== null;
  const title = promptMode ? record.title : resolved.slice.title;
  const doc = promptMode ? record.title : resolved.slice.doc;
  const recRel = relative(main, recordPath(main, id));
  const { branch, worktree } = places(main, id);
  // The checkout whose staged tree is the slice: the worktree when it exists, so a caller
  // can inspect the plan from either checkout. Applying is stricter - see below.
  const work = existsSync(worktree) ? worktree : root;

  const type = String(flags.type ?? 'feat');
  if (!TYPE.test(type)) {
    return fail(`${type} is not a Conventional Commits type`, EXIT.USAGE, `example: run: ${CLI} slice finish ${id} --type fix`);
  }
  const subject = subjectFor(type, id, title);
  const test = flags.test ?? null;

  // A manifest that does not parse fails closed: the gates cannot be read, so nothing
  // may commit through them. No manifest at all is a valid answer — `runGates` turns
  // it into a note and an empty pass, the same way the hook does.
  const manifest = await readManifest(work);
  if (manifest.error) {
    return fail(`${MANIFEST_FILE}: ${manifest.error}`, EXIT.CONFIG, `fix ${MANIFEST_FILE}, or run: ${CLI} init`);
  }
  const declared = manifest.manifest?.gates?.preCommit ?? [];
  const apply = `run: ${CLI} slice finish ${id}${test ? ` --test ${JSON.stringify(test)}` : ''} --yes`;

  const staged = await stagedFiles(work);
  const split = await splitGates(work, declared, manifest.manifest);

  if (!mode.apply) {
    let row = null;
    if (!promptMode) {
      row = await planDone(main, id, { sha: null, test, dryRun: true });
      if (row.error) return fail(row.error, EXIT.USAGE, row.remedy ?? `run: ${CLI} plan status`);
    }
    const stateLine = promptMode ? `state    (no tracker row; recorded at ${recRel})` : `state    ${row.from} -> ${row.to}`;
    const stateJson = promptMode ? { row: false, record: recRel } : { from: row.from, to: row.to, changed: row.wouldChange };
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
        state: stateJson,
        land: existsSync(worktree) ? { from: main, branch, merge: true, remove: true } : null,
        remedy: apply,
      });
      return EXIT.OK;
    }
    const lines = [
      `repo     ${root}`,
      `slice    ${id}  ${doc}`,
      `worktree ${relative(main, work)}${existsSync(worktree) ? '' : '  (missing: finish will refuse)'}`,
      `gates    pre-commit  ${gateLine} (run on apply)`,
      `staged   ${staged.length} file(s)${staged.length === 0 ? '  (finish refuses without one)' : ''}`,
      `subject  ${subject}`,
      stateLine,
      `land     ${branch} -> ${main}, then remove the worktree (on apply from the main checkout)`,
      `apply    ${apply}`,
    ];
    emit(lines.join('\n'));
    return EXIT.OK;
  }

  // The commit lands on the slice branch or not at all, and the checkout has to be the
  // main one: the merge and the worktree removal that follow cannot be done from inside
  // the worktree they remove.
  if (!(await isMainCheckout(root, main))) {
    return fail(
      `run ${CLI} slice finish from the main checkout, not the slice worktree`,
      EXIT.USAGE,
      `run: cd ${main} && ${CLI} slice finish ${id} --yes`,
    );
  }
  if (!existsSync(worktree)) {
    return fail(
      `no worktree for ${id} at ${relative(main, worktree)}`,
      EXIT.USAGE,
      `run: ${CLI} slice start ${id}`,
    );
  }
  // `start` already flipped the tracker row in the main checkout, and that edit is
  // meant to travel with the merge; every other change would be merged under the
  // slice's name, so only the row is allowed to be dirty.
  const rowRel = promptMode ? null : relative(main, resolved.slice.path);
  // `gitText` trims its output, so the first line's leading status column is gone; the
  // path starts after the two status characters whether or not that space survived.
  const porcelainPath = (line) => line.slice(2).trim();
  const mainDirty = String(await gitText(main, ['status', '--porcelain', '--untracked-files=no']).catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .filter((line) => rowRel === null || porcelainPath(line) !== rowRel);
  if (mainDirty.length > 0) {
    return fail(
      `the main checkout has uncommitted changes (${mainDirty.slice(0, 3).map(porcelainPath).join(', ')}), so the slice cannot be merged into it`,
      EXIT.USAGE,
      `commit or stash them, then rerun: ${apply}`,
    );
  }

  const head = await gitText(work, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null);
  if (head !== branch) {
    return fail(
      `the slice worktree is not on ${branch}: HEAD is ${head ?? 'unknown'}`,
      EXIT.USAGE,
      `run: git -C ${work} switch ${branch}`,
    );
  }

  if (staged.length === 0) {
    return fail(`${work} has nothing staged to commit`, EXIT.USAGE, `stage what the slice changed, then rerun: ${apply}`);
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
      : await runGates('pre-commit', { root: work, manifest: manifestForGates });
  if (freshGates.error) return fail(freshGates.error, EXIT.USAGE);

  // A gate that rewrites the tree (the formatter restaging) moves the commit
  // off the tree the skipped gates passed on. Their evidence is stale, so they
  // run once on the new tree; those results stand, the way fresh results do.
  let skipped = split.skipped;
  if (skipped.length > 0 && split.tree !== null) {
    const afterTree = await indexTreeId(work).catch(() => null);
    if (afterTree !== null && afterTree !== split.tree) {
      const { entries } = await readLedger(work).catch(() => ({ entries: [] }));
      const stale = skipped.filter((s) => passEntryForGate(entries, s.name, afterTree) === null);
      if (stale.length > 0) {
        const rerun = await runGates('pre-commit', {
          root: work,
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
        remedy: `run: ${CLI} hooks run pre-commit --root ${work}`,
        gates: gates.gates,
      });
      return EXIT.FAIL;
    }
    for (const n of gates.notes ?? []) note(`note     ${n}`);
    emit(renderGateReport('pre-commit', declared, gates).join('\n'));
    return EXIT.FAIL;
  }

  let sha = null;
  const message = `${subject}\n\n${CO_AUTHOR}`;
  try {
    await git(work, ['commit', '-m', message]);
    sha = await gitText(work, ['rev-parse', 'HEAD']);
  } catch (error) {
    const detail = String(error.stderr ?? error.message ?? error).trim().split('\n')[0];
    return fail(`the gates passed but the commit failed: ${detail}`, EXIT.FAIL, `run: git -C ${work} commit -m ${JSON.stringify(message)}`);
  }

  let row = null;
  if (!promptMode) {
    // The commit is the thing that happened; a tracker write that fails after it does not
    // undo it. Name the sha and the one command that records it, rather than leaving a
    // row queued with no way to finish it (A27).
    try {
      row = await planDone(main, id, { sha, test, dryRun: false });
    } catch (error) {
      row = { error: String(error?.message ?? error) };
    }
    if (row.error) {
      return fail(
        `${sha} is committed, but the tracker row could not record it: ${row.error}`,
        EXIT.FAIL,
        `run: ${CLI} plan done ${id} ${sha}`,
      );
    }
  }

  // The commit and the row are the slice's record; the merge and the removal are what
  // make the checkout usable again. A merge failure is reported with the commit it could
  // not land, because both facts are true and only one of them is in the tracker.
  const land = await landSlice(main, { branch, worktree, row: promptMode ? null : row.file });
  if (land.error) {
    return fail(
      `${sha} is committed${promptMode ? '' : ' and the row recorded'}, but the merge into ${main} failed: ${land.error}`,
      EXIT.FAIL,
      `commit the tracker row if it is still uncommitted, then run: git -C ${main} merge --no-ff ${branch}`,
    );
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
      land: {
        merge: land.mergeSha,
        head: land.head,
        worktree: land.worktreeRemoved ? 'removed' : 'kept',
        branch: land.branchDeleted ? 'deleted' : 'kept',
        ...(land.worktreeReason === null ? {} : { note: land.worktreeReason }),
      },
      ...(promptMode
        ? { state: { row: false, record: recRel } }
        : {
            evidence: { recorded: row.evidenceRecorded, sha: row.sha, test: row.test, note: row.evidenceNote },
            row: { file: relative(main, row.file), line: row.line, from: row.from, to: row.to, changed: row.changed },
          }),
    });
    return EXIT.OK;
  }

  for (const n of gates.notes ?? []) note(`note     ${n}`);
  const lines = [
    `repo     ${root}`,
    `slice    ${id}  ${doc}`,
    ...renderGateReport('pre-commit', declared, gates),
    `commit   ${sha}  ${subject}`,
  ];
  if (promptMode) {
    lines.push(`state    (no tracker row; recorded at ${recRel})`);
  } else {
    lines.push(`state    ${row.from} -> ${row.to}`);
    lines.push(`record   ${relative(main, row.file)} line ${row.line}  (committed with the merge)`);
    if (row.evidenceRecorded) lines.push(`evidence ${sha}${test ? `  test: ${test}` : ''}`);
    else if (row.evidenceNote) lines.push(`note     ${row.evidenceNote}`);
  }
  lines.push(`merge    ${land.mergeSha}  ${branch} -> ${land.head}`);
  lines.push(
    land.worktreeRemoved
      ? `removed  ${relative(main, worktree)}`
      : `kept     ${relative(main, worktree)} (${land.worktreeReason})`,
  );
  lines.push(land.branchDeleted ? `deleted  ${branch}` : `kept     ${branch} (${land.branchReason})`);
  emit(lines.join('\n'));
  return EXIT.OK;
}

