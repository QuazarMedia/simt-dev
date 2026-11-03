// `simt agent-hooks explain` — what one harness payload is, in the policy table's terms.
//
// The hook runs on a hot path and answers one bit: allow or deny. When a harness looks
// wired and the wrong thing happens, the question a decision alone cannot answer is what
// the payload was read *as* — which effect class, which resources, which operation
// identity, and whether the boundary could honestly claim to have mediated it. This
// command reads one payload through the same adapter and the same table the hook uses and
// prints that reading.
//
// It decides nothing and writes nothing, and it exits 0 whenever it could read a payload:
// an explanation that failed a build would be a gate nobody asked for.

import { readFile } from 'node:fs/promises';

import { EXIT, emitJson, fail } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { factsFor } from '../agenthooks/decide.mjs';
import { absoluteWrites } from '../agenthooks/facts.mjs';
import { mediate, normaliseFacts } from '../agenthooks/normalize.mjs';
import { adapter, adapters, factsFrom } from '../agenthooks/render.mjs';
import { repoRoot } from '../repo-root.mjs';

const USAGE = `run: ${CLI} agent-hooks explain --harness <id> [--payload <file>] [--mediated]`;

/** A payload is one harness call, not a stream: the bound keeps a pipe from becoming the input. */
const MAX_PAYLOAD_BYTES = 1024 * 1024;

/**
 * The payload to read: the file named, or what a harness would have piped in.
 *
 * `empty` is not an error at the hook boundary, because "nothing to check" is not a
 * violation. Here it is one: the command was asked to explain something and was given
 * nothing.
 */
async function readPayload(flags) {
  const file = flags.payload;
  if (typeof file === 'string' && file !== '') {
    try {
      return { text: await readFile(file, 'utf8') };
    } catch (error) {
      return { error: `cannot read --payload ${file}: ${error.code ?? error.message}` };
    }
  }
  if (process.stdin.isTTY) return { empty: true };
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_PAYLOAD_BYTES) return { error: `the payload on stdin is over the ${MAX_PAYLOAD_BYTES} byte bound` };
    chunks.push(chunk);
  }
  return { text: Buffer.concat(chunks).toString('utf8') };
}

/**
 * Explain one payload.
 *
 * @param {string[]} args
 * @param {object} flags
 */
export async function agentHooksExplainCommand(args, flags) {
  if (args.length > 0) {
    return fail(`unknown agent-hooks explain argument ${args[0]}`, EXIT.USAGE, USAGE);
  }

  const id = flags.harness ?? null;
  const row = id ? adapter(id) : null;
  if (row === null) {
    return fail(
      id === null ? 'agent-hooks explain needs --harness' : `unknown harness \`${id}\``,
      EXIT.FAIL,
      `--harness <id>, one of: ${adapters().map((entry) => entry.id).join(', ')}`,
    );
  }

  const read = await readPayload(flags);
  if (read.error !== undefined) return fail(read.error, EXIT.USAGE, USAGE);
  if (read.empty) {
    return fail('agent-hooks explain needs a payload', EXIT.USAGE, 'pipe the harness JSON on stdin, or name --payload <file>');
  }

  let payload;
  try {
    payload = JSON.parse(read.text);
  } catch (error) {
    return fail(`the payload is not JSON (${error.message})`, EXIT.USAGE, USAGE);
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail('the payload is not a JSON object', EXIT.USAGE, USAGE);
  }

  // The same two steps the hook takes, in the same order: the adapter reads its own
  // dialect, then the policy facts resolve against the repository root git itself uses.
  const extracted = factsFrom(row, payload, { root: flags.root });
  const root = repoRoot(extracted.root);
  const facts = await factsFor(root, {
    command: extracted.command ?? null,
    writes: absoluteWrites(extracted.root, extracted.writes ?? []),
  });

  // `mediated` is what the boundary may claim, not what it wishes: without it the report
  // says observe-only, which is the honest answer for a boundary that only watches.
  emitJson({
    ok: true,
    command: 'agent-hooks explain',
    root,
    harness: row.id,
    described: normaliseFacts({ facts, harness: row.id }),
    mediation: mediate({ facts, env: process.env, harness: row.id, mediated: flags.mediated === true }),
  });
  return EXIT.OK;
}
