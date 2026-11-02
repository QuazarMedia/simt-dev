// Which harnesses an agent command speaks to.
//
// Before this, `agents install` and `agent-hooks install` wrote every harness this tool
// renders unless `--harness` narrowed them. That made the default decision for the
// repository: a Laravel shop that adopted the tool for Cursor acquired a `.codex` and a
// `.gemini` directory nobody there would open, and every install rewrote six files to
// keep four of them identical.
//
// Now the repository decides once. `init --harness <id>` records the harness in the
// manifest's `surfaces`, and the agent commands read that declaration. A repository that
// declared nothing has selected nothing, so there is nothing to write and the command
// says which of the two ways to fix it - rather than guessing "all of them" again.
import { readManifest } from '../projection/manifest.mjs';
import { CLI } from '../name.mjs';
import { adapter, adapters } from './render.mjs';

/** The sentence every no-scope refusal ends with. One spelling, three commands. */
function noScopeRemedy() {
  const ids = adapters().map((row) => row.id);
  return `add "surfaces": ["${ids[0]}"] to the manifest, or pass --harness <id> (one of: ${ids.join(', ')})`;
}

/**
 * The harnesses one command should write, and where that answer came from.
 *
 * `--harness` is a statement about this run. Without it the manifest's `surfaces` is a
 * statement about the repository, and a surface id this tool renders no agent file for
 * (a reader with no agents directory) is filtered out rather than reported as a failure:
 * declaring it is not an error, it just has nothing to write here.
 *
 * @param {string} root
 * @param {{harness?: string}} [flags]
 * @returns {Promise<{ids?: string[], harnesses?: object[], source?: string, error?: string, remedy?: string}>}
 */
export async function resolveHarnessScope(root, flags = {}) {
  const known = new Set(adapters().map((row) => row.id));
  if (flags.harness !== undefined) {
    if (!known.has(flags.harness)) {
      return {
        error: `unknown harness \`${flags.harness}\``,
        remedy: `--harness <id>, one of: ${[...known].join(', ')}`,
      };
    }
    return { ids: [flags.harness], harnesses: [adapter(flags.harness)], source: 'flag' };
  }

  const { manifest } = await readManifest(root).catch(() => ({ manifest: null }));
  const declared = Array.isArray(manifest?.surfaces) ? manifest.surfaces.filter((id) => typeof id === 'string') : [];
  const ids = declared.filter((id) => known.has(id));
  if (ids.length === 0) {
    return {
      ids: [],
      harnesses: [],
      source: 'none',
      remedy: `nothing to do: no harness is selected. ${noScopeRemedy()}`,
    };
  }
  return { ids, harnesses: ids.map((id) => adapter(id)).filter(Boolean), source: 'surfaces' };
}

/** The line a command prints when it wrote nothing because nothing was selected. */
export function noScopeLine(root, command) {
  return [
    `repo     ${root}`,
    'SKIP     no harness is selected, so this command has nothing to write',
    `remedy   ${noScopeRemedy()}`,
    `         then: ${CLI} ${command} --yes`,
  ].join('\n');
}
