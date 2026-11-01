// Exit codes and the output layer.
//
// Agent tools optimise for tokens; terminal tools optimise for human eyes.
// Same data, different rendering. Nothing here emits ANSI, prompts, spinners or
// boxes, because a prompt is a hang for an agent and a spinner is noise in a log.
//
// See docs/research/0002-simt-dev-cli.md section 6.

import { AsyncLocalStorage } from 'node:async_hooks';

import { CLI } from '../name.mjs';

/**
 * One call's presentation state.
 *
 * This was seven module-level `let`s - the JSON failure mode, the indent default, the byte
 * ceiling, the accumulated notices, the canonical command, the capture, the sink - and a
 * process could hold only one of each. `dispatch` and the tests both run more than one
 * command in a process, and an MCP server runs them concurrently: the second run's ceiling,
 * notices and command path landed in the first run's document, which is a document
 * describing an invocation that did not produce it.
 *
 * Async-local rather than threaded through a parameter: `emit` is called by seventy command
 * modules that have no context to pass, and changing every signature is the rewrite that
 * never lands. A store is per call and inherited by everything that call awaits.
 */
const stores = new AsyncLocalStorage();

/** What a run that never opened a store gets: the process defaults before any flag. */
const processState = () => ({
  jsonFailure: false,
  pretty: process.stdout.isTTY === true,
  maxBytes: 0,
  warnings: [],
  command: null,
  captured: null,
  sink: null,
});

const fallback = processState();

function state() {
  return stores.getStore() ?? fallback;
}

/** Give `body` its own presentation state, so two calls in one process cannot collide. */
export function withOutputState(body) {
  return stores.run(processState(), body);
}
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
export function jsonFailMode(on = false) {
  state().jsonFailure = on;
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
  // A library caller asked for a result, not a line on a terminal it does not own.
  if (state().sink !== null) {
    state().sink.error = { message, remedy: resolved, exitCode: code };
    return code;
  }
  if (state().jsonFailure) {
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
/**
 * Answer one command's result on the surface the caller asked for.
 *
 * Every command that has both a document and a text report was choosing between them by
 * hand, in the same five lines, in more than a dozen files - and a command that chose
 * slightly differently printed a report where a caller had asked for JSON, which is how a
 * script gets prose.
 *
 * The renderer is a thunk because the surface is decided first: a command asked for JSON
 * must not pay to render text nobody reads, and a caller cannot forget the branch.
 */
export function present(payload, renderText, flags) {
  if (isJson(flags)) {
    emitJson(payload);
    return 'json';
  }
  emit(renderText());
  return 'text';
}

export function emit(text, { maxBytes = state().maxBytes, stream = process.stdout } = {}) {
  const body = text.endsWith('\n') ? text : `${text}\n`;
  if (state().sink !== null) {
    state().sink.text.push(fitText(body, maxBytes));
    return true;
  }
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
// The byte ceiling is one flag with one reader: the envelope. Commands used to pass
// `flags.maxBytes ?? 0` at seventy-eight call sites, which is seventy-eight chances to pass
// a different number, or to forget and answer past the ceiling the caller set
//. A ceiling of zero or a value that is not a number is no ceiling, the same way the
// flag itself is read.
/** Set the byte ceiling every emit and every document inherits, from `--max-bytes`. */
export function maxBytesLimit(bytes) {
  const value = Number(bytes);
  state().maxBytes = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function jsonIndentDefault(pretty = process.stdout.isTTY === true) {
  state().pretty = pretty;
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
 * `why --json --max-bytes 120` used to exit 0 with half a token on stdout . An
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

/**
 * Warnings a run accumulated, carried into the JSON document it prints.
 *
 * The same reason stderr is separate from stdout: a caller reading a document cannot
 * see a note printed beside it. A command that ignored half of what it was asked still
 * has to succeed or fail the same way, so the note belongs IN the result, and the text
 * mode keeps the stderr line it already had.
 */
/**
 * The output sink for a library call, or null for a process.
 *
 * `run(command, input)` answers with the text, the documents, the notes and the failure a
 * command produced instead of writing them. The alternative - threading a `result` return
 * through seventy command modules - is the rewrite that never finishes, and the printing
 * commands have no return value to thread: they `return EXIT.OK` after calling `emit`.
 *
 * A sink is per call and never nested. The dispatcher keeps its own JSON capture below and
 * is not this: a sink answers "what did the command produce", the capture answers "hold the
 * document until the exit code exists".
 */
/** Collect a command's output instead of writing it, and answer with what it produced. */
export async function withSink(body) {
  if (state().sink !== null) throw new Error('an output sink is already open');
  const collecting = { text: [], documents: [], notes: [], error: null };
  state().sink = collecting;
  try {
    const code = await body();
    return {
      code: code ?? EXIT.OK,
      text: collecting.text.join(''),
      documents: collecting.documents,
      notes: collecting.notes,
      error: collecting.error,
    };
  } finally {
    state().sink = null;
  }
}

/**
 * The same cut `emit` makes on a stream, applied to a string: the ceiling is a promise
 * whichever surface reads it, and a library caller that got bytes past the limit it asked
 * for would be paying for what the flag exists to refuse.
 */
function fitText(body, maxBytes) {
  const bytes = Buffer.byteLength(body);
  if (maxBytes <= 0 || bytes <= maxBytes) return body;
  const slice = Buffer.from(body).subarray(0, maxBytes).toString('utf8');
  const cut = slice.lastIndexOf('\n');
  return cut > 0
    ? `${slice.slice(0, cut)}\nTRUNCATED ${bytes - maxBytes} bytes omitted, rerun with --max-bytes 0\n`
    : `${slice}TRUNCATED ${bytes - maxBytes} bytes omitted, rerun with --max-bytes 0\n`;
}

// The path the dispatcher resolved. A command should not restate it: the ones that did
// restated it wrongly (`plugin` printed `plugin claude`, `sync` printed `sync --check`),
// and a document whose `command` disagrees with the argv that produced it is worse than
// one with no `command` at all.
/** Set the command path every JSON document will carry, or clear it with null. */
export function jsonCommand(path) {
  state().command = path ?? null;
}

// A document cannot name the exit code before the command has returned one. The
// dispatcher captures what a command emits, then writes it once with the code attached;
// writing first is how `ok: false` shipped alongside exit 0.
/** Collect documents instead of writing them, so the dispatcher can add the exit code. */
export function jsonCaptureStart() {
  state().captured = [];
}

/** The captured documents and a reset, or an empty list when nothing was captured. */
export function jsonCaptureTake() {
  const docs = state().captured;
  state().captured = null;
  return docs;
}

/** Record a warning for the document this run prints. */
export function warn(message) {
  state().warnings.push(message);
}

/**
 * Drop what a previous run in this process recorded.
 *
 * The collector is per process and a process can dispatch more than once - the MCP
 * server and the tests both do. Without this, one command's notice appeared in the
 * next command's document, which parity between the two surfaces caught
 */
export function clearWarnings() {
  state().warnings = [];
}

/** The warnings this run has recorded, in order. */
export function warnings() {
  return state().warnings;
}

export function emitJson(value, { stream = process.stdout, pretty = state().pretty, maxBytes = state().maxBytes } = {}) {
  // `notices`, not `warnings`: `status` already reports a warning COUNT under that key,
  // and a document cannot mean two things by one name. The collision is named here
  // rather than bent into either shape.
  const carried =
    state().warnings.length > 0 && value !== null && typeof value === 'object' && !Array.isArray(value) && value.notices === undefined
      ? { ...value, notices: state().warnings }
      : value;
  const stamped =
    state().command !== null && carried !== null && typeof carried === 'object' && !Array.isArray(carried)
      ? { ...carried, command: state().command }
      : carried;
  if (state().sink !== null) {
    state().sink.documents.push(withSchemaVersion(stamped));
    return true;
  }
  if (state().captured !== null) {
    state().captured.push({ value: stamped });
    return true;
  }
  const payload = withSchemaVersion(stamped);
  const text = `${stringifyJson(payload, pretty)}\n`;
  // JSON is never byte-truncated: a cut document parses as a lie, and exit 0 calls it
  // true. Arrays shrink with a `truncated` record naming what lost how much, and a
  // document no trimming can fit becomes a `MAX_BYTES` error envelope (ADR-105).
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
  if (state().sink !== null) {
    state().sink.notes.push(message);
    return;
  }
  stream.write(`${message}\n`);
}
