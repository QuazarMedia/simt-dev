import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadMcpRegistry, selectServers, validateMcpRegistry } from '../src/mcpconfig/registry.mjs';

/** A valid registry with one stdio server, for shape tests that mutate freely. */
function sample() {
  return {
    version: 1,
    servers: [
      {
        id: 'simt',
        name: 'simt-dev',
        summary: 'The simt-dev tool surface over MCP.',
        transport: { type: 'stdio', command: 'simt', args: ['mcp'] },
        capabilities: ['feature-slice', 'release'],
      },
    ],
  };
}

test('registry: the shipped catalogue loads and carries the simt entry', async () => {
  const { ok, registry, errors } = await loadMcpRegistry();
  assert.equal(ok, true, errors.join('\n'));
  const simt = registry.servers.find((server) => server.id === 'simt');
  assert.ok(simt, 'the simt server is the one this estate knows end to end');
  assert.equal(simt.transport.type, 'stdio');
  assert.equal(simt.transport.command, 'simt');
});

test('select: a task naming a capability selects the server', async () => {
  const { ok, registry } = await loadMcpRegistry();
  assert.equal(ok, true);
  const selected = selectServers(registry, { taskTokens: ['prepare', 'a', 'release'] });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].server.id, 'simt');
  assert.ok(selected[0].reasons.some((reason) => reason.startsWith('capability:')));
});

test('select: a task with no overlap selects nothing', async () => {
  const { ok, registry } = await loadMcpRegistry();
  assert.equal(ok, true);
  const selected = selectServers(registry, { taskTokens: ['xylophone'] });
  assert.deepEqual(selected, []);
});

test('select: a server without capabilities is never auto-offered', () => {
  const registry = sample();
  registry.servers[0].capabilities = [];
  // The task names the server's own word; name signal alone must not select it.
  const selected = selectServers(registry, { taskTokens: ['simt', 'mcp'] });
  assert.deepEqual(selected, []);
});

test('validate: a stdio transport without a command names its entry', () => {
  const registry = sample();
  delete registry.servers[0].transport.command;
  const errors = validateMcpRegistry(registry);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^simt: a stdio transport needs a non-empty `command`$/);
});

test('validate: duplicate ids are named', () => {
  const registry = sample();
  registry.servers.push({ ...registry.servers[0] });
  const errors = validateMcpRegistry(registry);
  assert.deepEqual(errors, ['servers[1]: duplicate `id` simt']);
});

test('validate: an unknown transport type is named', () => {
  const registry = sample();
  registry.servers[0].transport = { type: 'grpc', url: 'https://example.com' };
  const errors = validateMcpRegistry(registry);
  assert.deepEqual(errors, ['simt: `transport.type` must be "stdio" or "http"']);
});

test('load: an explicit path wins, and a broken file reports its errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcpconfig-'));
  try {
    const path = join(dir, 'mcp.json');
    await writeFile(path, JSON.stringify({ version: 1, servers: [{ id: 'broken' }] }));
    const { ok, errors } = await loadMcpRegistry({ registry: path });
    assert.equal(ok, false);
    assert.ok(errors.every((error) => error.startsWith('broken:')), errors.join('\n'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
