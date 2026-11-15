// Shared fixtures for the MCP suites: the binary path, a promisified exec, the request
// shapes every revision is asked in, and the session runner. Extracted when the suite
// crossed the line ceiling; a second copy of a request builder is a second idea of the
// protocol.

import { execFile, spawn } from 'node:child_process';
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
 */
function converse(raw) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [BIN, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', rej);
    child.on('close', () => res({ stdout, stderr }));
    child.stdin.end(raw);
  });
}

export { BIN, exec, req, at, converse };
