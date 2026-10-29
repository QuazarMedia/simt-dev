// `simt slice start` and `simt slice finish`: one tracker row, one branch.
//
// A row in a tracker is a promise, and these are the two moments it is acted on.
// `start` isolates the work: a linked worktree on a branch named for the row, so the
// main checkout stays free for whatever else is running, and the task brief already on
// disk at `.simt/brief.md` — the same path the bench's brief arm writes — where an
// agent picks it up. `finish` closes the loop the way the repository's own hook would:
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
import { assembleBrief } from '../brief/assemble.mjs';
import { renderGateReport, runGates, stagedFiles } from '../hooks/dispatcher.mjs';
import { readManifest } from '../projection/manifest.mjs';
import { CLI, MANIFEST_FILE } from '../name.mjs';
import { LOCAL_DIR } from '../state.mjs';

const exec = promisify(execFile);

/** The state a started slice moves to, spelled the way the tracker template spells it. */
const STARTED = 'In progress';

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
  return fail(`unknown slice subcommand ${sub}`, EXIT.USAGE, `run: ${CLI} slice start <id>  |  ${CLI} slice finish <id>`);
}

async function startSlice(root, id, flags) {
  const mode = writeMode(flags);
  const main = await mainCheckout(root);
  const resolved = await resolveSlice(main, id);
  if (resolved.error) return fail(resolved.error, EXIT.USAGE, resolved.remedy);
  const { title, doc } = resolved.slice;
  const { branch, worktree } = places(main, id);
  const briefPath = join(worktree, LOCAL_DIR, 'brief.md');
  const task = `${id}: ${String(title ?? '').trim()}`;
  const apply = `run: ${CLI} slice start ${id} --yes`;

  // The row first, dry, against the main checkout: it is the only part of `start`
  // that can refuse for a reason about the tracker rather than about git, and a
  // preview that discovers it late is a preview that half-described the work.
  const preview = await planDone(main, id, { state: STARTED, dryRun: true });
  if (preview.error) return fail(preview.error, EXIT.USAGE, preview.remedy ?? `run: ${CLI} plan status`);

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

  try {
    await git(main, ['worktree', 'add', '-b', branch, worktree]);
  } catch (error) {
    const detail = String(error.stderr ?? error.message ?? error).trim().split('\n')[0];
    return fail(`the worktree could not be created: ${detail}`, EXIT.FAIL, `run: git -C ${main} worktree list`);
  }

  await mkdir(join(worktree, LOCAL_DIR), { recursive: true });
  await writeFile(briefPath, packet.packed.text, 'utf8');

  const row = await planDone(main, id, { state: STARTED, dryRun: false });
  if (row.error) {
    return fail(`${branch} exists with its brief, but the tracker row was not updated: ${row.error}`, EXIT.FAIL, row.remedy ?? `run: ${CLI} plan status`);
  }

  const bytes = Buffer.byteLength(packet.packed.text);
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
    `state    ${row.from} -> ${row.to}`,
  ];
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}

async function finishSlice(root, id, flags) {
  const mode = writeMode(flags);
  const main = await mainCheckout(root);
  const resolved = await resolveSlice(main, id);
  if (resolved.error) return fail(resolved.error, EXIT.USAGE, resolved.remedy);
  const { title, doc } = resolved.slice;

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

  if (!mode.apply) {
    const row = await planDone(main, id, { sha: null, test, dryRun: true });
    if (row.error) return fail(row.error, EXIT.USAGE, row.remedy ?? `run: ${CLI} plan status`);
    if (isJson(flags)) {
      emitJson({
        ok: true,
        command: 'slice finish',
        root,
        id,
        dryRun: true,
        subject,
        staged,
        gates: { event: 'pre-commit', declared },
        state: { from: row.from, to: row.to, changed: row.wouldChange },
        remedy: apply,
      });
      return EXIT.OK;
    }
    const lines = [
      `repo     ${root}`,
      `slice    ${id}  ${doc}`,
      `gates    pre-commit  ${declared.length > 0 ? declared.join(', ') : '(none declared)'} (run on apply)`,
      `staged   ${staged.length} file(s)${staged.length === 0 ? '  (finish refuses without one)' : ''}`,
      `subject  ${subject}`,
      `state    ${row.from} -> ${row.to}`,
      `apply    ${apply}`,
    ];
    emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }

  if (staged.length === 0) {
    return fail(`${root} has nothing staged to commit`, EXIT.USAGE, `stage what the slice changed, then rerun: ${apply}`);
  }

  // The gates the hook would run, run here. This command is the one place a commit
  // happens where a hook could not have stopped it, so it runs the same dispatcher
  // over the same event, in the checkout that holds the staged diff.
  const gates = await runGates('pre-commit', { root, manifest: manifest.manifest });
  if (gates.error) return fail(gates.error, EXIT.USAGE);

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
