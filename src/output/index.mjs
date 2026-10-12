// Exit codes and the output layer.
//
// Agent tools optimise for tokens; terminal tools optimise for human eyes.
// Same data, different rendering. Nothing here emits ANSI, prompts, spinners or
// boxes, because a prompt is a hang for an agent and a spinner is noise in a log.
//
// See docs/plans/0002-simt-dev-cli.md section 6.

import { CLI } from '../name.mjs';
/** Stable machine codes. A non-zero exit always carries one of these. */
export const EXIT = {
  OK: 0,
  FAIL: 1, // a gate failed: drift, policy violation, missing evidence
  USAGE: 2, // bad arguments; the remedy is in the message
  CONFIG: 3, // simt.json missing or invalid
  REGISTRY: 4, // skills.graph.json invalid: orphan, dangling edge, cycle
  UNSUPPORTED: 5, // the request cannot be satisfied on this platform or repo
};

const REMEDY = {
  // Every default remedy below is `${CLI}` and not the package name, because this
  // package installs exactly one binary and `package.json`'s `bin` map says which:
  // `simt`. A remedy naming `simt-dev` is a command the reader types and gets
  // `unknown command` from, which is the one answer that leaves them with no next
  // step at all - and it was this default, printed on every bad invocation.
  [EXIT.USAGE]: `run: ${CLI} --help`,
  [EXIT.CONFIG]: `run: ${CLI} init`,
  [EXIT.REGISTRY]: `run: ${CLI} graph lint`,
};

/**
 * Report a failure and return its exit code. Callers `return fail(...)` so the
 * code is impossible to forget.
 */
export function fail(message, code = EXIT.FAIL, remedy) {
  // The fallback must be a command, never a path. `docs/decisions/` was the old
  // default and it was only ever resolvable from inside simt-dev's own checkout;
  // a reader in a consumer repo got a remedy naming a file that does not exist
  // where they are. Every remedy here is something the reader can run.
  const resolved = remedy ?? REMEDY[code] ?? `run: ${CLI} --help`;
  process.stderr.write(`ERROR ${code} ${message}\nREMEDY ${resolved}\n`);
  return code;
}

/** Whether to emit plain text (default) or structured JSON. */
export function isJson(flags) {
  return flags.json === true;
}

/**
 * Whether this invocation may change the filesystem, and whether it is a rehearsal.
 *
 * This is the only place that decides, because there was a third copy of the same
 * arithmetic in the commands and they did not agree: `upgrade` consulted `--yes`
 * and ignored `--dry-run`, so `--yes --dry-run` wrote; `skills install` read
 * neither. A flag pair that means the same thing to a person must mean the same
 * thing to every command, or `--dry-run` stops being a promise.
 *
 * `dryRun` is reported separately from `apply` because a run that was not
 * authorised is a dry run in effect even when nobody asked for one, and the report
 * has to say which happened rather than echoing the flags back.
 */
export function writeMode(flags) {
  const dryRun = flags.dryRun === true;
  return { dryRun, apply: flags.yes === true && !dryRun };
}

/**
 * Emit a block of text under a heading, respecting --max-bytes.
 * Truncation is always announced with an explicit line, never a silent ellipsis:
 * an agent that cannot tell a truncated answer from a complete one will guess.
 */
export function emit(text, { maxBytes = 0, stream = process.stdout } = {}) {
  const body = text.endsWith('\n') ? text : `${text}\n`;
  const bytes = Buffer.byteLength(body);
  if (maxBytes > 0 && bytes > maxBytes) {
    const slice = Buffer.from(body).subarray(0, maxBytes).toString('utf8');
    const cut = slice.lastIndexOf('\n');
    stream.write(cut > 0 ? `${slice.slice(0, cut)}\n` : slice);
    stream.write(`TRUNCATED ${bytes - maxBytes} bytes omitted, rerun with --max-bytes 0\n`);
    return false;
  }
  stream.write(body);
  return true;
}

export function emitJson(value, { stream = process.stdout } = {}) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Print to stderr so machine-readable stdout stays parseable. Used for
 * diagnostics that accompany a real result, never for the result itself.
 */
export function note(message, { stream = process.stderr } = {}) {
  stream.write(`${message}\n`);
}
