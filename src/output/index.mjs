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
 * Whether failures are reported as JSON.
 *
 * A failure is a result: the caller asked a question and the answer is "no, and
 * here is why". Written to stderr only, a caller parsing stdout under `--json`
 * gets an empty document and has to believe the exit code, which tells it that
 * something went wrong and nothing about what. So under `--json` the failure is
 * the result and it goes where results go.
 *
 * The default answers "plain text" because that is what every run before the flags
 * were parsed is, and those runs happen before anybody could have asked.
 */
let jsonFailure = false;

export function jsonFailMode(on = false) {
  jsonFailure = on;
}

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
  if (jsonFailure) {
    emitJson({ ok: false, error: message, remedy: resolved, exitCode: code });
    return code;
  }
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

/**
 * The shape of every JSON payload, in the payload.
 *
 * A reader parsing `--json` from an agent has no other way to detect that a field moved
 * or was renamed between releases: the parse still succeeds, and the reader's next lookup
 * returns undefined. The number is in every payload rather than in the documentation
 * because documentation is the thing that goes stale without failing anything, and the
 * failure this prevents is silent.
 *
 * Bumped when a payload changes in a way a reader would notice. Adding a field is not
 * that; removing, renaming or retyping one is.
 */
export const SCHEMA_VERSION = 1;

/**
 * Whether the next payload is indented.
 *
 * Set once per run from the flags, rather than threaded through every call site: the
 * alternative is twenty-five call sites each remembering to pass a value they do not
 * otherwise care about, and the one that forgets is the one a reader pipes somewhere
 * important. The default answers "is a person reading", which is the right answer
 * before anybody sets it.
 */
let prettyDefault = process.stdout.isTTY === true;

export function jsonIndentDefault(pretty = process.stdout.isTTY === true) {
  prettyDefault = pretty;
}

/**
 * Emit JSON, compact unless a human is reading it.
 *
 * Indentation is for a person, and an agent pays for it on every call: the same document
 * is a third again larger, and the reader is `JSON.parse`, not an eye. So the default is
 * compact, and `--pretty` asks for the readable form. The one exception is a TTY, where
 * the only consumer is a person: the compact document saves them nothing and costs them
 * the diff they were about to read.
 */
function withSchemaVersion(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && value.schemaVersion === undefined
    ? { schemaVersion: SCHEMA_VERSION, ...value }
    : value;
}

function stringifyJson(value, pretty) {
  return pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

/**
 * Shrink a payload to a byte ceiling by emptying its longest arrays first.
 *
 * Byte-cutting JSON produces a document that parses or exits non-zero, never both —
 * `why --json --max-bytes 120` used to exit 0 with half a token on stdout (Q10). An
 * importer owns nothing here: the trimmed arrays are named in `truncated`, so a reader
 * knows exactly which list lost how many items, and the document still parses.
 *
 * Returns the fitted payload, or null when no array-trimming fits (the caller then
 * answers with the `MAX_BYTES` error envelope instead).
 */
function fitJsonArrays(payload, maxBytes, pretty) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const slots = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      if (node.length > 0) slots.push({ node, path, length: node.length });
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
    } else if (node !== null && typeof node === 'object') {
      for (const key of Object.keys(node)) walk(node[key], path === '' ? key : `${path}.${key}`);
    }
  };
  walk(payload, '');
  if (slots.length === 0) return null;
  slots.sort((a, b) => b.length - a.length);
  const candidate = structuredClone(payload);
  const trimmed = [];
  const sizeOf = (extra) =>
    Buffer.byteLength(stringifyJson(extra ? { ...candidate, truncated: extra } : candidate, pretty));
  const segmentsOf = (path) =>
    path.split('.').flatMap((part) => {
      const m = /^(.*?)\[(\d+)\]$/.exec(part);
      return m ? [m[1], Number(m[2])] : [part];
    });
  for (const slot of slots) {
    const at = segmentsOf(slot.path);
    let target = candidate;
    for (let i = 0; i < at.length - 1; i += 1) target = target[at[i]];
    if (target === null || typeof target !== 'object') continue;
    target[at[at.length - 1]] = [];
    trimmed.push({ field: slot.path, omitted: slot.length });
    const extra = trimmed.length === 1
      ? { field: trimmed[0].field, omitted: trimmed[0].omitted, limit: maxBytes }
      : { fields: trimmed, limit: maxBytes };
    if (sizeOf(extra) <= maxBytes) return { ...candidate, truncated: extra };
  }
  return null;
}

export function emitJson(value, { stream = process.stdout, pretty = prettyDefault, maxBytes = 0 } = {}) {
  const payload = withSchemaVersion(value);
  const text = `${stringifyJson(payload, pretty)}\n`;
  // JSON is never byte-truncated: a cut document parses as a lie, and exit 0 calls it
  // true. Arrays shrink with a `truncated` record naming what lost how much, and a
  // document no trimming can fit becomes a `MAX_BYTES` error envelope (Q10, ADR-105).
  if (maxBytes > 0 && Buffer.byteLength(text) > maxBytes) {
    const fitted = fitJsonArrays(payload, maxBytes, pretty);
    if (fitted !== null) {
      stream.write(`${stringifyJson(fitted, pretty)}\n`);
      return false;
    }
    const envelope = withSchemaVersion({
      ...(payload !== null && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.command === 'string'
        ? { command: payload.command }
        : {}),
      ok: false,
      error: {
        code: 'MAX_BYTES',
        message: `output exceeded the --max-bytes ceiling of ${maxBytes} bytes`,
        remedy: 'rerun with --max-bytes 0 for the whole document',
      },
      truncated: { omitted: Buffer.byteLength(text) - maxBytes, limit: maxBytes },
    });
    stream.write(`${stringifyJson(envelope, pretty)}\n`);
    return false;
  }
  stream.write(text);
  return true;
}

/**
 * Print to stderr so machine-readable stdout stays parseable. Used for
 * diagnostics that accompany a real result, never for the result itself.
 */
export function note(message, { stream = process.stderr } = {}) {
  stream.write(`${message}\n`);
}
