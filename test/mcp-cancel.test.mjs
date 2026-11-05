// Cancellation, as the protocol describes it and as this server implements it.
//
// A client sends `notifications/cancelled` with the id of a call it no longer wants. The
// server must stop the work and still answer the original request, because a client that
// never receives that answer is waiting forever on a request it has already abandoned.
//
// Nothing tested this. The wiring is in `serve` (a peek at each line, because the loop is
// blocked awaiting the tool) and in the tools (which check the signal between rows), and
// an untested wiring is one refactor away from a hang that only a client sees.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';

import { handle, serve } from '../src/mcp/server.mjs';
import { TOOLS } from '../src/mcp/tools.mjs';

const exec = promisify(execFile);
const req = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });

const line = (message) => `${JSON.stringify(message)}\n`;

/** A tool that cannot finish without being told to: it resolves only when its signal aborts. */
function waitingTool() {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const tool = {
    name: 'waiting',
    description: 'starts and waits until the client cancels it',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async run(args, ctx) {
      entered();
      await new Promise((resolve) => {
        if (ctx.signal.aborted) return resolve();
        ctx.signal.addEventListener('abort', resolve, { once: true });
      });
      throw Object.assign(new Error('cancelled before it finished'), { remedy: null });
    },
  };
  return { tool, started };
}

test('mcp: a cancelled call aborts the tool and is still answered', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const written = [];
  output.on('data', (chunk) => written.push(...String(chunk).split('\n').filter(Boolean)));

  const { tool, started } = waitingTool();
  const served = serve([tool], { input, output });

  input.write(line({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 't', version: '0' } } }));
  input.write(line({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'waiting', arguments: {} } }));
  // Wait for the tool to be running, so the cancellation cannot arrive before there is
  // anything to cancel: a test that raced would pass for the wrong reason on a fast machine.
  await started;
  input.write(line({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 8, reason: 'user asked' } }));
  input.end();
  await served;

  const replies = written.map((entry) => JSON.parse(entry));
  const answer = replies.find((reply) => reply.id === 8);
  assert.ok(answer, 'a cancelled call must still be answered, or the client waits forever');
  assert.equal(answer.result.isError, true);
  assert.match(answer.result.structuredContent.error, /cancelled/);
});

test('mcp: a cancelled compare stops between rows and answers as an error', async () => {
  // The abort is checked at the top of each worker, so a cancellation is only observable
  // when the estate is larger than the pool: with as many rows as workers every row has
  // already started by the time the first progress note can be answered.
  const ws = await mkdtemp(join(tmpdir(), 'simt-mcp-cancel-'));
  try {
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    for (const name of names) {
      await mkdir(join(ws, name), { recursive: true });
      await exec('git', ['init', '-q', '-b', 'main'], { cwd: join(ws, name) });
    }
    const seen = [];
    const controller = new AbortController();
    const answer = await handle(
      req('tools/call', { name: 'compare', arguments: { root: ws, concurrency: 2 }, _meta: { progressToken: 'p2' } }),
      TOOLS,
      {
        signal: controller.signal,
        notify: (notification) => {
          seen.push(notification);
          controller.abort();
        },
      },
    );

    assert.equal(answer.result.isError, true, 'a cancelled call is an error answer, not a short one');
    assert.match(answer.result.structuredContent.error, /cancelled by client/);
    assert.ok(seen.length < names.length, 'the pool stopped instead of building every row');
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

/** A waiting tool that records whether its signal ever fired. */
function trackedTool() {
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let aborted = false;
  return {
    tool: {
      name: 'waiting',
      description: 'starts and waits until the client cancels it',
      inputSchema: { type: 'object', properties: {}, required: [] },
      async run(_args, ctx) {
        entered();
        await new Promise((resolve) => {
          if (ctx.signal.aborted) { aborted = true; return resolve(); }
          ctx.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true });
        });
        throw Object.assign(new Error('cancelled before it finished'), { remedy: null });
      },
    },
    started,
    wasAborted: () => aborted,
  };
}

test('mcp: a cancel matches the string form of a numeric request id (A36)', async () => {
  const input = new PassThrough();
  const written = [];
  const { tool, started, wasAborted } = trackedTool();
  const served = serve([tool], {
    input,
    output: { write: (chunk) => { written.push(String(chunk)); return true; } },
  });

  input.write(line({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'waiting', arguments: {} } }));
  await started;
  input.write(line({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: '9' } }));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(wasAborted(), false, 'a different id must not abort the call');

  input.write(line({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: '8' } }));
  input.end();
  await served;

  assert.equal(wasAborted(), true, 'the string form of the in-flight numeric id must abort');
  const answer = written.map((entry) => JSON.parse(entry)).find((reply) => reply.id === 8);
  assert.ok(answer, 'the cancelled call must still be answered');
  assert.equal(answer.result.isError, true);
});
