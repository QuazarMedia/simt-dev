// `simt docs readme` — put the README's command list back in step with the spec.
//
// Shape copied from `ci` and `ignore`: the plan is printed first, nothing is written
// without `--yes`, `--diff` shows the same plan as a unified diff, and `undo` restores
// it. The rendering itself lives in `src/docs/commands.mjs` so a test can compare the
// README against it without running this command.

import { join } from 'node:path';

import { EXIT, fail, present, writeMode } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { applyPlan, change } from '../write/plan.mjs';
import { diffField, emitDiffs, readBefore } from '../diff.mjs';
import { commandRoot } from '../repo-root.mjs';
import { BEGIN, END, README_FILE, renderCommandBlock, replaceBlock } from '../docs/commands.mjs';

export async function docsCommand(sub, args, flags) {
  if (sub !== 'readme') {
    return fail(`unknown docs page \`${sub}\``, EXIT.USAGE, `run: ${CLI} docs readme`);
  }
  const root = commandRoot(flags);
  const path = join(root, README_FILE);

  let before;
  try {
    before = await readBefore(path);
  } catch (error) {
    return fail(
      `${README_FILE} could not be read: ${error.message}`,
      EXIT.FAIL,
      `fix the file's permissions, then re-run: ${CLI} docs readme`,
    );
  }
  if (before === null) {
    return fail(`no ${README_FILE} in ${root}`, EXIT.FAIL, `run this where ${README_FILE} is`);
  }

  const after = replaceBlock(before, renderCommandBlock());
  if (after === null) {
    return fail(
      `${README_FILE} carries no ${BEGIN} ... ${END} region`,
      EXIT.FAIL,
      `put the two marker lines where the command list belongs, then: ${CLI} docs readme --yes`,
    );
  }

  const mode = writeMode(flags);
  const action = after === before ? 'unchanged' : 'write';
  const payload = {
    ok: true,
    command: 'docs',
    page: 'readme',
    root,
    file: README_FILE,
    action,
    written: mode.apply && action === 'write',
  };

  if (action === 'unchanged') {
    present(payload, () => `current  ${README_FILE}`, flags);
    return EXIT.OK;
  }

  const diff = [{ path: README_FILE, before, after }];
  if (!mode.apply) {
    // A rehearsal says which flag it is waiting for, because "not written" is the same
    // sentence for `--dry-run` and for a missing `--yes`, and the two have different fixes.
    present(
      { ...payload, ...diffField(diff, flags) },
      () => `plan  ${README_FILE}: the command list follows the spec${mode.dryRun ? ' (--dry-run)' : ' (re-run with --yes to write)'}`,
      flags,
    );
    emitDiffs(diff, flags);
    return EXIT.OK;
  }

  await applyPlan(root, [change({ path, before, after, owner: 'docs readme', reason: 'the command list follows the spec' })], {
    mode,
    label: 'docs readme',
  });
  present(
    { ...payload, ...diffField(diff, flags) },
    () => `write  ${README_FILE}  (${Buffer.byteLength(after)} bytes)`,
    flags,
  );
  emitDiffs(diff, flags);
  return EXIT.OK;
}
