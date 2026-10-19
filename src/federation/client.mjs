// The federation client: one stdio MCP conversation, spoken directly (plan 0003 R26).
//
// simt-dev carries no runtime dependency, and an external code-graph server speaks MCP over
// stdio, which is newline-delimited JSON-RPC. That is a shape small enough to speak without
// a client library, so this file is the whole client: start the server, initialize, ask one
// tool for one text answer, and return that answer or the reason there is none.
//
// Two rules make it safe to put inside a brief:
//
//   * It never throws. A command that is not installed, a server that exits, one that
//     answers with a protocol error, one that never answers at all — every one of them
//     comes back as `{ error }` for the caller to render as a sentence. A brief that died
//     because an optional server misbehaved would be a brief nobody keeps installed.
//   * It always cleans up, and it always ends. The child is killed on the first answer, on
//     an error and on the timeout, and the timeout is a real bound on a server that has
//     forgotten how to read. Federation adds a wait with a ceiling, never an open one.
//
// The conversation is exactly three messages deep, which is the minimum MCP allows:
// `initialize`, the `notifications/initialized` acknowledgement, then one `tools/call`.

import { spawn } from 'node:child_process';

/**
 * The protocol revision this client opens with.
 *
 * Not this tool's newest — an external server predates it far more often than not — but the
 * oldest revision every MCP server of the current generation is required to accept. A
 * server that answers with a revision of its own is answering, and the reply is not
 * second-guessed: this is a client for asking, not for negotiating.
 */
const PROTOCOL_VERSION = '2025-06-18';

/** The longest a single server may take before the client stops waiting, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 5000;

const CLIENT_INFO = { name: 'simt-dev', version: '1' };

/** The first non-blank text part of a result, or null when the result carries none. */
function textOf(result) {
  if (result === null || typeof result !== 'object') return null;
  const content = Array.isArray(result.content) ? result.content : [];
  for (const part of content) {
    if (part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
      if (part.text.trim().length > 0) return part.text;
    }
  }
  return null;
}

/** One sentence for a JSON-RPC error object. */
function reasonOf(error) {
  if (error === null || typeof error !== 'object') return 'the server returned an error';
  if (typeof error.message === 'string' && error.message.length > 0) return error.message;
  if (error.code !== undefined) return `the server answered with error code ${error.code}`;
  return 'the server returned an error';
}

/**
 * Ask one server, over stdio, for one text answer to one question.
 *
 * @param {object} request
 * @param {string} request.command the executable to start
 * @param {string[]} [request.args] its arguments
 * @param {string} [request.cwd] the directory to start it in
 * @param {string} request.tool the MCP tool to call
 * @param {string} [request.argument] the argument the question is placed in
 * @param {string} request.query the question
 * @param {number} [request.timeoutMs] how long to wait, in milliseconds
 * @returns `{ text }` on an answer, `{ error }` on anything else — never a rejection
 */
export async function callTool({
  command,
  args = [],
  cwd = undefined,
  tool,
  argument = 'query',
  query,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd });
    } catch (error) {
      resolve({ error: `could not start \`${command}\` (${error.message})` });
      return;
    }

    let settled = false;
    let buffer = '';
    let nextId = 1;
    const pending = new Map();

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {
        // The pipe may already be gone; nothing to close in that case.
      }
      try {
        child.kill('SIGKILL');
      } catch {
        // A process that has already exited cannot be killed again.
      }
      resolve(payload);
    };

    const timer = setTimeout(() => finish({ error: `no answer within ${timeoutMs} ms` }), timeoutMs);

    child.on('error', (error) => finish({ error: `could not start \`${command}\` (${error.message})` }));
    child.on('exit', (code) => {
      if (!settled) finish({ error: `the server exited with code ${code} before answering` });
    });
    // stderr is not this client's to interpret, but it has to be read: an unread pipe fills
    // and a server blocked on its own diagnostics never reaches the answer.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.length > 0) {
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            message = null;
          }
          const id = message !== null && typeof message === 'object' ? message.id : undefined;
          const waiter = id !== undefined ? pending.get(id) : undefined;
          if (waiter !== undefined) {
            pending.delete(id);
            waiter(message);
          }
        }
        index = buffer.indexOf('\n');
      }
    });

    const request = (method, params) =>
      new Promise((done) => {
        const id = nextId;
        nextId += 1;
        pending.set(id, done);
        try {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        } catch (error) {
          pending.delete(id);
          finish({ error: `could not talk to \`${command}\` (${error.message})` });
        }
      });

    const notify = (method, params) => {
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
      } catch {
        // A notification that cannot be written is a server that is already gone, and the
        // exit handler reports that with a better sentence than this one could.
      }
    };

    (async () => {
      await request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      });
      notify('notifications/initialized', {});
      const answer = await request('tools/call', { name: tool, arguments: { [argument]: query } });
      if (answer.error !== undefined) {
        finish({ error: reasonOf(answer.error) });
        return;
      }
      const text = textOf(answer.result);
      if (text === null) {
        finish({ error: `\`${tool}\` returned no text` });
        return;
      }
      finish({ text });
    })().catch((error) => finish({ error: error.message }));
  });
}
