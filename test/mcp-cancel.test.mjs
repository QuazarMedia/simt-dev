// A36: JSON has no integer type, so a cancel may echo the request id as a string.

import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';

import { serve } from '../src/mcp/server.mjs';

const call = (id) => `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'slow', arguments: {} } })}\n`;
const cancel = (requestId) => `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId } })}\n`;

async function cancelledCall(requestId) {
  const input = new PassThrough();
  const written = [];
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const tools = [
    {
      name: 'slow',
      description: 'waits for its abort signal',
      inputSchema: { type: 'object' },
      async run(_args, ctx) {
        startedResolve();
        return await new Promise((resolve) => {
          const done = () => resolve({ ok: !ctx?.signal?.aborted });
          if (ctx?.signal?.aborted) return done();
          ctx?.signal?.addEventListener('abort', done, { once: true });
          setTimeout(done, 250);
        });
      },
    },
  ];

  const serving = serve(tools, {
    input,
    output: { write: (chunk) => { written.push(String(chunk)); return true; } },
    packageVersion: '9.9.9',
  });
  input.write(call(1));
  await started;
  input.write(cancel(requestId));
  input.end();

  assert.equal(await serving, 0);
  const messages = written.join('').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(messages.length, 1, 'the notification must not answer');
  return messages[0];
}

test('a cancel whose requestId is the string form of the in-flight id aborts it (A36)', async () => {
  const response = await cancelledCall('1');
  assert.equal(response.id, 1);
  assert.deepEqual(response.result.structuredContent, { ok: false });
});

test('a cancel naming a different request does not abort (A36)', async () => {
  const response = await cancelledCall('2');
  assert.equal(response.id, 1);
  assert.deepEqual(response.result.structuredContent, { ok: true });
});
