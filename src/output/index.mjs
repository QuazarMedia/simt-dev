// Exit codes and the output layer.
//
// Agent tools optimise for tokens; terminal tools optimise for human eyes.
// Same data, different rendering. Nothing here emits ANSI, prompts, spinners or
// boxes, because a prompt is a hang for an agent and a spinner is noise in a log.
//
// See docs/plans/0002-simt-dev-cli.md section 6.

/** Stable machine codes. A non-zero exit always carries one of these. */
export const EXIT = {
  OK: 0,
  FAIL: 1, // a gate failed: drift, policy violation, missing evidence
  USAGE: 2, // bad arguments; the remedy is in the message
  CONFIG: 3, // simt-dev.json missing or invalid
  REGISTRY: 4, // skills.graph.json invalid: orphan, dangling edge, cycle
  UNSUPPORTED: 5, // the request cannot be satisfied on this platform or repo
};

const REMEDY = {
  [EXIT.USAGE]: 'run: simt-dev --help',
  [EXIT.CONFIG]: 'run: simt-dev init',
  [EXIT.REGISTRY]: 'run: simt-dev graph lint',
};

/**
 * Report a failure and return its exit code. Callers `return fail(...)` so the
 * code is impossible to forget.
 */
export function fail(message, code = EXIT.FAIL, remedy) {
  const resolved = remedy ?? REMEDY[code] ?? 'see: docs/decisions/README.md';
  process.stderr.write(`ERROR ${code} ${message}\nREMEDY ${resolved}\n`);
  return code;
}

/** Whether to emit plain text (default) or structured JSON. */
export function isJson(flags) {
  return flags.json === true;
}

export function isTty() {
  return process.stdout.isTTY === true && !process.env.NO_COLOR;
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
