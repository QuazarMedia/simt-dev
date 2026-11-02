// `simt docs commands` — put the command reference back in step with the spec.
//
// The reference used to be a block in README.md, which put 240 lines of command list above
// the first paragraph of prose and made every new command a README edit. It is now
// `docs/commands/`: an index that carries the flat list and one page per group, all
// rendered from `src/commands/spec.mjs`. Shape copied from the other writers: the plan is
// printed first, nothing is written without `--yes`, `--diff` shows the same plan as a
// unified diff, and `undo` restores it.

import { join } from 'node:path';

import { EXIT, fail, present, writeMode } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { applyPlan, change, pending } from '../write/plan.mjs';
import { diffField, emitDiffs, readBefore } from '../diff.mjs';
import { commandRoot } from '../repo-root.mjs';
import { DOCS_DIR, renderCommandPages } from '../docs/commands.mjs';

export async function docsCommand(sub, args, flags) {
  if (sub !== 'commands') {
    return fail(
      `unknown docs page \`${sub}\``,
      EXIT.USAGE,
      `run: ${CLI} docs commands`,
    );
  }
  const root = commandRoot(flags);
  const pages = renderCommandPages();
  const changes = [];
  for (const [path, after] of pages) {
    let before;
    try {
      before = await readBefore(join(root, path));
    } catch (error) {
      return fail(
        `${path} could not be read: ${error.message}`,
        EXIT.FAIL,
        `fix the file's permissions, then re-run: ${CLI} docs commands`,
      );
    }
    changes.push(
      change({
        path,
        before,
        after,
        owner: 'docs commands',
        reason: 'the command reference follows the spec',
      }),
    );
  }

  const stale = pending(changes);
  const mode = writeMode(flags);
  const payload = {
    ok: true,
    command: 'docs',
    page: 'commands',
    root,
    files: [...pages.keys()],
    action: stale.length === 0 ? 'unchanged' : 'write',
    written: mode.apply && stale.length > 0,
  };

  if (stale.length === 0) {
    present(payload, () => `current  ${DOCS_DIR}`, flags);
    return EXIT.OK;
  }

  if (!mode.apply) {
    present(
      { ...payload, ...diffField(changes, flags) },
      () =>
        `plan  ${DOCS_DIR}: ${stale.map((c) => c.path).join(', ')}${
          mode.dryRun ? ' (--dry-run)' : ' (re-run with --yes to write)'
        }`,
      flags,
    );
    emitDiffs(changes, flags);
    return EXIT.OK;
  }

  await applyPlan(root, changes, { mode, label: 'docs commands' });
  present(
    { ...payload, ...diffField(changes, flags) },
    () => `write  ${DOCS_DIR}  (${stale.length} file${stale.length === 1 ? '' : 's'})`,
    flags,
  );
  emitDiffs(changes, flags);
  return EXIT.OK;
}
