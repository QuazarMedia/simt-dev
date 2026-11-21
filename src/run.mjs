// `run(command, input)` - one command, as a result.
//
// The CLI prints and returns an exit code; that is right for a terminal and useless for a
// library, an MCP tool or a harness that wants the answer. Rather than rewrite seventy
// command modules to return values they do not currently compute, this runs the same
// handler through the output sink: the handler is unchanged, and what it would have
// written comes back as data.
//
// That is a boundary, not a second implementation. `dispatch` and `run` resolve the same
// registry, apply the same flag guard rails and call the same function, so a command
// cannot work in one and not the other - the failure would be invisible in the CLI, which
// is why `test/run.test.mjs` drives both surfaces.
//
// What a caller gets is not a rendering decision made for them: `text` and `documents` are
// both there when the command produced both, and `renderText`/`renderJson` are the two
// answers the CLI had. A caller that wants neither reads the fields a command exported
// (`src/api.mjs`).

import { EXIT, clearWarnings, jsonCommand, jsonFailMode, jsonIndentDefault, maxBytesLimit, warnings, withOutputState, withSink } from './output/index.mjs';
import { finaliseJson } from './output/envelope.mjs';
import { CLI } from './name.mjs';
import { GLOBAL_FLAGS, deprecatedFlags, resolveCommand } from './commands/index.mjs';

/** `--some-flag` for a flag key the parser handed back as `someFlag`. */
function spelled(key) {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function failure(command, code, message, remedy, domainCode) {
  return {
    command,
    ok: false,
    code,
    text: '',
    documents: [],
    notes: [],
    warnings: [],
    error: {
      message,
      remedy: remedy ?? `run: ${CLI} --help`,
      exitCode: code,
      // A handler with its own machine-readable refusal keeps it. The CLI still prints
      // the message; a library caller can branch on the code without parsing prose.
      ...(domainCode === undefined ? {} : { code: domainCode }),
    },
  };
}

/**
 * Run one command path and answer with what it produced.
 *
 * @param {string} command the dispatch key: `status`, `plan next`, `hooks install`
 * @param {{args?: string[], flags?: object, root?: string}} [input]
 */
export async function run(command, { args = [], flags = {}, root } = {}) {
  const resolved = await resolveCommand(command);
  if (resolved === null) return failure(command, EXIT.USAGE, `unknown command \`${command}\``);
  const path = resolved.path;

  // The guard rails the dispatcher applies, applied here for the same reason: a library
  // caller that passes `--frozen` to `status` must be told, not quietly served a default.
  for (const key of Object.keys(flags)) {
    if (GLOBAL_FLAGS.has(key) || resolved.declared.has(spelled(key))) continue;
    return failure(path, EXIT.USAGE, `--${spelled(key)} is not a flag of \`${path}\``);
  }
  for (const [flag, allowed] of Object.entries(resolved.values)) {
    const value = flags[flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
    if (value !== undefined && !allowed.includes(value)) {
      return failure(path, EXIT.USAGE, `--${flag} takes ${allowed.join(', ')}; received ${value}`);
    }
  }

  clearWarnings();
  jsonCommand(path);
  jsonIndentDefault(flags.pretty === true);
  maxBytesLimit(flags.maxBytes);
  jsonFailMode(flags.json === true);

  const effective = root === undefined ? flags : { root, ...flags };
  try {
    const produced = await withOutputState(() => withSink(() => resolved.run(args, effective)));
    // The same finaliser the dispatcher uses: a library caller and a terminal caller must
    // not disagree about the exit code a document carries, or whether a flag was superseded.
    const finalised = finaliseJson(produced.documents, {
      code: produced.code,
      deprecated: Object.fromEntries(deprecatedFlags(path, flags)),
    });
    return {
      command: path,
      ok: finalised.code === EXIT.OK,
      code: finalised.code,
      text: produced.text,
      documents: finalised.documents,
      notes: produced.notes,
      warnings: warnings(),
      error: produced.error,
    };
  } catch (error) {
    // The CLI has always turned a thrown handler into a reported failure; a library
    // caller used to get a rejected promise and no result at all. A handler's own
    // exit code, remedy and domain code survive, so this is the same refusal, carried
    // as data.
    const code = Number.isInteger(error?.exitCode) && error.exitCode > 0 ? error.exitCode : EXIT.FAIL;
    return failure(
      path,
      code,
      error?.message ?? String(error),
      error?.remedy,
      typeof error?.code === 'string' ? error.code : undefined,
    );
  }
}

/** The text the command printed, as one string. Empty when it answered in JSON. */
export function renderText(result) {
  return result.text;
}

/**
 * The document the command emitted, or null when it answered as text.
 *
 * A command that emits a stream (NDJSON) has more than one document and gets an array:
 * collapsing a stream to its first element is how a caller silently loses rows.
 */
export function renderJson(result) {
  if (result.documents.length === 0) return null;
  return result.documents.length === 1 ? result.documents[0] : result.documents;
}
