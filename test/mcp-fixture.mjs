// Shared fixtures for the MCP suites: the binary path, a promisified exec, the request
// shapes every revision is asked in, and the session runner. Extracted when the suite
// crossed the line ceiling; a second copy of a request builder is a second idea of the
// protocol.

import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { META } from '../src/mcp/server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt.mjs');
const exec = promisify(execFile);

const req = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });

/** A request that identifies its revision the way that revision does it. */
const at = (version, method, params = {}, id = 1) =>
  req(method, { ...params, _meta: { [META.PROTOCOL_VERSION]: version } }, id);

/**
 * Feed lines to `simt mcp` and collect the session.
 *
 * `spawn` rather than `execFile` with an `input` option, because there is no such option:
 * the child's stdin would never be closed, the server would wait forever for EOF, and the
 * test would hang rather than fail. Ending stdin explicitly is what makes EOF arrive.
 *
 * `--no-warnings` on the argv: on a Node where node:sqlite is still experimental
 * (the 22.x CI pin), the child prints an ExperimentalWarning to stderr on first
 * index use, and the session's stderr must stay empty for the transport
 * assertions. Runtime noise is not a server diagnostic. It rides the argv, not
 * `options.execArgv`: `spawn` ignores that option - only `fork` reads it - and
 * the first fix attempt shipped with a flag that never reached the child.
 */
function converse(raw, { bin = BIN, cwd, timeout } = {}) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, ['--no-warnings', bin, 'mcp'], {
      cwd, timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', rej);
    child.on('close', (code) => res({ stdout, stderr, code }));
    child.stdin.end(raw);
  });
}

/**
 * A live `simt mcp` session. `converse` runs a whole exchange; this lets a test
 * finish the handshake before it changes outside state, so a timing assertion
 * measures the request and not the child's startup.
 */
function session() {
  const child = spawn(process.execPath, ['--no-warnings', BIN, 'mcp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const pending = new Map();
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', () => {
      for (const waiter of pending.values()) waiter.reject(new Error('mcp closed before answering'));
      pending.clear();
      resolve({ stdout, stderr });
    });
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    stdout += `${line}\n`;
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return {
    request(message) {
      return new Promise((resolve, reject) => {
        pending.set(message.id, { resolve, reject });
        child.stdin.write(`${JSON.stringify(message)}\n`);
      });
    },
    async close() {
      child.stdin.end();
      return closed;
    },
  };
}

export { BIN, exec, req, at, converse, session };
