// simt mcp - the line protocol.
//
// `handle()` is pure, so most of this file tests it without a pipe. The end-to-end test at
// the end exists because the failure nobody catches otherwise is a stray byte of prose on
// stdout: the client then shows nothing and reports no error, because from its side the
// stream is simply malformed.

import assert from 'node:assert/strict';
import { test } from 'node:test';
// The pre-push gate runs this suite in a detached worktree under the temp
// directory. With no workspace declared, the sibling heuristic treats that
// parent as a workspace and `compare` scans every scratch directory beside it.
// These tests are about the protocol, not workspace discovery, so decline it.
process.env.SIMT_DEV_WORKSPACE = 'off';

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Readable } from 'node:stream';
import { handle, serve, PROTOCOL_VERSION, RPC, SUPPORTED_VERSIONS, META } from '../src/mcp/server.mjs';
import { TOOLS, toolNames, ERROR_SHAPE } from '../src/mcp/tools.mjs';
import { assertValid } from '../src/mcp/schema.mjs';
import { CLI } from '../src/name.mjs';
import { desiredRegion } from '../src/projection/rules.mjs';
import { planNext } from '../src/plan/index.mjs';

import { BIN, exec, req, at, converse } from './mcp-fixture.mjs';

// --- protocol ------------------------------------------------------------------

test('mcp: initialize answers with the protocol version and the read-only instruction', async () => {
  const r = await handle(req('initialize', { protocolVersion: PROTOCOL_VERSION }), TOOLS, { packageVersion: '9.9.9' });
  assert.equal(r.result.protocolVersion, PROTOCOL_VERSION);
  assert.equal(r.result.serverInfo.version, '9.9.9');
  assert.match(r.result.instructions, /Read-only/);
  // One entry point, named as a tool. The instruction used to name a CLI command the
  // caller could not invoke, while the tool description called itself the entry point and
  // the prompt pointed at a third one (Q56).
  assert.match(r.result.instructions, /Call `skills_brief` first/);
});

test('mcp: an unsupported protocol version gets ours, not an echo of theirs', async () => {
  // Echoing a version we do not implement is a lie the client cannot detect until a
  // feature silently misbehaves.
  const r = await handle(req('initialize', { protocolVersion: '1999-01-01' }), TOOLS);
  assert.equal(r.result.protocolVersion, PROTOCOL_VERSION);
});

// --- the version matrix -------------------------------------------------------

test('mcp: every supported revision completes a handshake', async () => {
  // The review's acceptance criterion, one revision at a time. A revision that only
  // works when nobody asks for it is a revision this server does not speak.
  for (const version of SUPPORTED_VERSIONS) {
    const legacy = await handle(req('initialize', { protocolVersion: version }), TOOLS, { packageVersion: '1.2.3' });
    assert.equal(legacy.result.protocolVersion, version, `initialize did not hold ${version}`);
    assert.equal(legacy.result.serverInfo.version, '1.2.3');
    assert.ok(legacy.result.capabilities.tools, `${version}: no tools capability`);

    const list = await handle(at(version, 'tools/list'), TOOLS);
    assert.ok(Array.isArray(list.result.tools), `${version}: tools/list did not answer`);
    assert.ok(list.result.tools.length > 0, `${version}: an empty tool list is not a handshake`);
  }
});

test('mcp: 2026-07-28 is stateless, so a per-request _meta replaces the handshake', async () => {
  // Two consecutive requests at different revisions, with no initialize between them. A
  // server that remembered the first would answer the second with the wrong shape.
  const newest = await handle(at('2026-07-28', 'tools/list'), TOOLS);
  assert.equal(newest.result.resultType, 'complete');
  assert.equal(newest.result._meta[META.SERVER_INFO].name, 'simt-dev');

  const oldest = await handle(at('2025-06-18', 'tools/list'), TOOLS);
  assert.ok(!('resultType' in oldest.result), 'a 2025-06-18 client asked for a pre-2026-07-28 result');
  assert.ok(!('_meta' in oldest.result));
});

test('mcp: a per-request version this server does not speak is refused, by name', async () => {
  // `initialize` answers with its own version because the spec tells it to. A request
  // that names its version in _meta has no fallback left - there is no handshake to
  // renegotiate - so an unsupported one is an error at the one place the client checks.
  const r = await handle(at('2027-01-01', 'tools/list'), TOOLS);
  assert.equal(r.error.code, RPC.UNSUPPORTED_VERSION);
  assert.match(r.error.message, /2027-01-01/);
  for (const v of SUPPORTED_VERSIONS) assert.match(r.error.message, new RegExp(v));
});

test('mcp: an older client keeps the revision it negotiated, without being asked again', async () => {
  // The residue of the removed handshake, and the reason `serve` holds state at all: a
  // 2025-06-18 client negotiates once and then sends bare requests forever after.
  const state = { version: null };
  await handle(req('initialize', { protocolVersion: '2025-06-18' }), TOOLS, { state });
  assert.equal(state.version, '2025-06-18');
  const later = await handle(req('tools/list'), TOOLS, { state });
  assert.ok(!('resultType' in later.result), 'a bare request inherited the newest revision');
});

test('mcp: server/discover advertises the revisions, the capabilities and the identity', async () => {
  // MUST from 2026-07-28, and the stdio way a client finds out which shape it is talking
  // to before committing to one.
  const r = await handle(at('2026-07-28', 'server/discover'), TOOLS, { packageVersion: '1.2.3' });
  assert.deepEqual(r.result.supportedVersions, SUPPORTED_VERSIONS);
  assert.equal(r.result._meta[META.SERVER_INFO].version, '1.2.3');
  assert.ok(r.result.capabilities.tools);
  assert.match(r.result.instructions, /Read-only/);
});

test('mcp: list results carry a cache lifetime from 2026-07-28 and nothing before it', async () => {
  for (const version of ['2026-07-28']) {
    for (const method of ['tools/list', 'server/discover']) {
      const r = await handle(at(version, method), TOOLS);
      assert.ok(Number.isInteger(r.result.ttlMs), `${method} at ${version} has no ttlMs`);
      assert.ok(['public', 'private'].includes(r.result.cacheScope), `${method} at ${version}`);
    }
  }
  const older = await handle(at('2025-11-25', 'tools/list'), TOOLS);
  assert.ok(!('ttlMs' in older.result), 'a field the revision does not define was invented for it');
});

test('mcp: ping answers an older client and is refused to a 2026-07-28 one', async () => {
  for (const version of ['2025-06-18', '2025-11-25']) {
    assert.equal((await handle(at(version, 'ping'), TOOLS)).result.resultType, undefined, version);
  }
  // Removed in 2026-07-28, so a client that still sends it is told that, rather than
  // getting a success it would read as support.
  const gone = await handle(at('2026-07-28', 'ping'), TOOLS);
  assert.equal(gone.error.code, RPC.METHOD);
  assert.match(gone.error.message, /removed in 2026-07-28/);
});

test('mcp: a notification produces no response at all', async () => {
  // Not an empty object, not a null id: no response.
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, TOOLS), null);
  // A request with no id is a notification by the spec's own definition, whatever its method.
  assert.equal(await handle({ jsonrpc: '2.0', method: 'ping' }, TOOLS), null);
});

test('mcp: an unknown method is a protocol error, not silence', async () => {
  // Something this server has never heard of. It used to assert `resources/list` here,
  // which is the assertion that had to die when resources landed: a method this server
  // does not implement, not one it does.
  const r = await handle(req('resources/watch', { uri: 'simt://rules/core' }), TOOLS);
  assert.equal(r.error.code, RPC.METHOD);
  assert.match(r.error.message, /unknown method "resources\/watch"/);
});

test('mcp: a malformed request is a request error', async () => {
  for (const bad of [null, 'string', [], { jsonrpc: '2.0', id: 1 }]) {
    const r = await handle(bad, TOOLS);
    assert.equal(r.error.code, RPC.REQUEST, `expected a request error for ${JSON.stringify(bad)}`);
  }
});

test('mcp: an unknown tool is a method error naming the way to discover it', async () => {
  const r = await handle(req('tools/call', { name: 'nope', arguments: {} }), TOOLS);
  assert.equal(r.error.code, RPC.METHOD);
  assert.match(r.error.message, /tools\/list/);
});

test('mcp: a tool that fails is a RESULT with isError, never a protocol error', async () => {
  // An MCP client renders an exception as an error dialog and never shows the answer.
  // "this repo has no region" is an answer, and the useful part of it.
  const tools = [
    {
      name: 'boom',
      description: 'always fails',
      inputSchema: { type: 'object' },
      async run() {
        throw Object.assign(new Error('no region'), { remedy: `run: ${CLI} sync` });
      },
    },
  ];
  const r = await handle(req('tools/call', { name: 'boom', arguments: {} }), tools);
  assert.equal(r.error, undefined);
  assert.equal(r.result.isError, true);
  const payload = JSON.parse(r.result.content[0].text);
  assert.equal(payload.error, 'no region');
  assert.equal(payload.remedy, `run: ${CLI} sync`);
});

test('mcp: a throwing handler keeps the request id; unparseable input gets id null (Q12)', async () => {
  // One shared try used to answer a handler throw as a parse error with `id: null`,
  // and the client waited forever for request 7's answer. Parse and handling fail
  // on separate paths now, each with the id its failure owns. The throw is injected
  // by handing `serve` a tools table that cannot answer `tools/list`.
  const lines = [
    `${JSON.stringify(req('tools/list', {}, 7))}\n`,
    'this is not json\n',
  ];
  const written = [];
  const code = await serve(null, {
    input: Readable.from(lines),
    output: { write: (chunk) => { written.push(String(chunk)); return true; } },
    packageVersion: '9.9.9',
  });
  assert.equal(code, 0);
  const [handlerFailure, parseFailure] = written.join('').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(handlerFailure.id, 7, 'the handler failure answers the request it threw in');
  assert.equal(handlerFailure.error.code, RPC.INTERNAL);
  assert.equal(parseFailure.id, null, 'unparseable input has no id to answer to');
  assert.equal(parseFailure.error.code, RPC.PARSE);
});

test('mcp: a progressToken turns tool progress into notifications (Q38)', async () => {
  // The plumbing is generic: any tool calling `ctx.onProgress` emits one
  // `notifications/progress` per call, and a tool that never reports emits none.
  const seen = [];
  const tools = [
    {
      name: 'slow',
      description: 'reports twice',
      inputSchema: { type: 'object' },
      async run(args, ctx) {
        ctx?.onProgress?.(1, 2);
        ctx?.onProgress?.(2, 2);
        return { ok: true };
      },
    },
  ];
  const r = await handle(
    req('tools/call', { name: 'slow', arguments: {}, _meta: { progressToken: 'tok-1' } }),
    tools,
    { notify: (n) => seen.push(n) },
  );
  assert.equal(r.result.structuredContent.ok, true);
  assert.deepEqual(
    seen.map((n) => [n.method, n.params]),
    [
      ['notifications/progress', { progressToken: 'tok-1', progress: 1, total: 2 }],
      ['notifications/progress', { progressToken: 'tok-1', progress: 2, total: 2 }],
    ],
  );
  const quiet = await handle(req('tools/call', { name: 'slow', arguments: {} }), tools, {
    notify: () => assert.fail('no token, no notifications'),
  });
  assert.equal(quiet.result.structuredContent.ok, true);
});

test('mcp: compare pages with limit/cursor and reports progress (Q38)', async () => {
  // The estate that timed clients out pages instead: each answer names the next
  // start, and the last one names none. Progress totals the whole estate even
  // on a page, so the client can tell a slow page from a stuck one.
  const ws = await mkdtemp(join(tmpdir(), 'simt-mcp-compare-'));
  try {
    for (const name of ['a', 'b', 'c']) {
      await mkdir(join(ws, name), { recursive: true });
      await exec('git', ['init', '-q', '-b', 'main'], { cwd: join(ws, name) });
    }
    const seen = [];
    const call = (args, id = 7) =>
      handle(req('tools/call', { name: 'compare', arguments: args }, id), TOOLS, {
        notify: (n) => seen.push(n),
      });
    const first = await call({ root: ws, limit: 2 });
    assert.equal(first.result.structuredContent.repos.length, 2);
    const cursor = first.result.structuredContent.cursor;
    assert.ok(typeof cursor === 'string', 'a partial answer names its continuation');
    assert.equal(first.result.structuredContent.total, 3);
    const second = await call({ root: ws, cursor, limit: 2 });
    assert.equal(second.result.structuredContent.repos.length, 1);
    assert.equal(second.result.structuredContent.cursor, null, 'the last page names no continuation');
    const names = [
      ...first.result.structuredContent.repos,
      ...second.result.structuredContent.repos,
    ].map((r) => r.name);
    assert.deepEqual(names, ['a', 'b', 'c'], 'pages cover the estate in discovery order');

    const progressed = await handle(
      req('tools/call', { name: 'compare', arguments: { root: ws }, _meta: { progressToken: 'p1' } }),
      TOOLS,
      { notify: (n) => seen.push(n) },
    );
    assert.equal(progressed.result.structuredContent.repos.length, 3);
    const progress = seen.filter((n) => n.method === 'notifications/progress');
    assert.ok(progress.length === 3, `expected 3 progress notes, got ${progress.length}`);
    assert.deepEqual(
      progress.map((n) => n.params.progress).sort((a, b) => a - b),
      [1, 2, 3],
    );
    assert.ok(progress.every((n) => n.params.total === 3 && n.params.progressToken === 'p1'));
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test('mcp: truncation is announced in the text, never silent', async () => {
  const tools = [{ name: 'big', description: 'x', inputSchema: { type: 'object' }, async run() { return { blob: 'y'.repeat(500), maxBytes: 100 }; } }];
  const r = await handle(req('tools/call', { name: 'big', arguments: {} }), tools);
  assert.match(r.result.content[0].text, /^TRUNCATED \d+ bytes omitted; raise maxBytes$/m);
  // Q56: the structured block is the one a client indexes, so it cannot keep the whole
  // payload beside a text block that says something was cut.
  assert.equal(r.result.structuredContent.truncated, true);
  assert.ok(r.result.structuredContent.omittedBytes > 0);
  assert.ok(!('blob' in r.result.structuredContent), 'the untruncated payload came back in the other block');
});

test('mcp: the request envelope is checked before anything reads it (Q56)', async () => {
  const state = { version: null };
  const bare = await handle({ id: 1, method: 'server/discover' }, TOOLS, { state });
  assert.equal(bare.error.code, RPC.REQUEST, 'a request without jsonrpc:"2.0" was accepted');
  const objectId = await handle({ jsonrpc: '2.0', id: { n: 1 }, method: 'server/discover' }, TOOLS, { state });
  assert.equal(objectId.error.code, RPC.REQUEST);
  assert.equal(objectId.id, null, 'an id that cannot be matched must not be echoed as if it could');
});

test('mcp: arguments are checked against the schema the client was shown (Q56)', async () => {
  const state = { version: null };
  await handle(req('initialize', { protocolVersion: '2025-11-25' }), TOOLS, { state });
  const r = await handle(req('tools/call', { name: 'skills_show', arguments: {} }), TOOLS, { state });
  assert.equal(r.error.code, RPC.INVALID_PARAMS, JSON.stringify(r));
  assert.match(r.error.message, /missing required property "name"/);
  // A tool with no required arguments still accepts the empty object, which is what a
  // client that knows nothing sends.
  const ok = await handle(req('tools/call', { name: 'skills_brief', arguments: {} }), TOOLS, { state });
  assert.equal(ok.result.isError, false, JSON.stringify(ok.result));
});

test('mcp: an over-long request line is refused and the session survives (Q56)', async () => {
  const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { pad: 'x'.repeat(1 << 20) } });
  const { stdout } = await converse(`${line}\n{"jsonrpc":"2.0","id":9,"method":"server/discover"}\n`);
  const messages = stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(messages[0].error.code, RPC.REQUEST);
  assert.match(messages[0].error.message, /larger than \d+ bytes/);
  assert.deepEqual(messages[1].result.supportedVersions, SUPPORTED_VERSIONS);
});

test('mcp: skills_show says body:null and why, rather than prose in a field typed string|null (Q56)', async () => {
  const state = { version: null };
  await handle(req('initialize', { protocolVersion: '2025-11-25' }), TOOLS, { state });
  const index = await handle(req('tools/call', { name: 'skills_index', arguments: {} }), TOOLS, { state });
  const name = index.result.structuredContent.entries[0].name;
  const shown = await handle(req('tools/call', { name: 'skills_show', arguments: { name } }), TOOLS, { state });
  const packet = shown.result.structuredContent;
  assertValid(packet, TOOLS.find((t) => t.name === 'skills_show').outputSchema, 'skills_show');
  if (packet.body === null) assert.match(packet.reason, /body unavailable/);
  else assert.equal(packet.reason, null);
});

test('mcp: every tool declares a usable schema', () => {
  for (const tool of TOOLS) {
    assert.match(tool.name, /^[a-z][a-z_]*$/, `${tool.name} is not a snake_case tool name`);
    assert.ok(tool.description.length > 40, `${tool.name} needs a description worth reading`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(Array.isArray(tool.inputSchema.required));
    assert.equal(typeof tool.run, 'function');
  }
});

test('mcp: every description is short, and the total grows only with the surface', () => {
  // Plan 3's R41 capped the whole description prose at 2 KB when twelve tools shipped, and
  // those twelve spent 2,035 bytes of it. Plan 4's five doors cannot fit inside that ceiling
  // at any length, so the property is kept and the absolute is replaced: one description stays
  // short, and the total is allowed to grow only when a tool does (ADR-193).
  const CEILING = 240;
  const long = TOOLS.filter((tool) => Buffer.byteLength(tool.description, 'utf8') > CEILING).map(
    (tool) => `${tool.name}: ${Buffer.byteLength(tool.description, 'utf8')}`,
  );
  assert.deepEqual(long, [], `descriptions over the ${CEILING} byte ceiling`);
  const total = TOOLS.reduce((n, tool) => n + Buffer.byteLength(tool.description, 'utf8'), 0);
  assert.ok(total <= CEILING * TOOLS.length, `${total} bytes of description across ${TOOLS.length} tools`);
});

test('mcp: skills_brief and `skills brief` answer the same question identically', async () => {
  // Q15: the budget arithmetic was written twice and the copies had already
  // drifted — this one checked `deferred` *after* the budget and inlined a
  // deferred dependency, while `skills brief` checked it first and did not.
  // Both surfaces now call `skillsBriefFacts`, and this test holds them to the
  // same document. Two budgets, because one of them proves the budget is doing
  // something: 2,000 for a group of 13,503 and 20,000 for the same one.
  const brief = TOOLS.find((t) => t.name === 'skills_brief');
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  for (const budget of [2000, 20000]) {
    const mcp = await brief.run({ budget, skill: 'parallel-feature-team', root: ROOT });
    const { stdout } = await exec(process.execPath, [
      resolve(ROOT, 'bin', 'simt.mjs'),
      'skills', 'brief', '--root', ROOT, '--skill', 'parallel-feature-team',
      '--budget', String(budget), '--json',
    ]);
    const cli = JSON.parse(stdout);

    assert.deepEqual(
      mcp.resolved,
      cli.resolved,
      `budget ${budget}: the two surfaces resolved different skills`,
    );
    assert.deepEqual(
      mcp.deferred,
      cli.deferred,
      `budget ${budget}: the two surfaces deferred different skills`,
    );
    assert.deepEqual(
      mcp.excluded,
      cli.excluded,
      `budget ${budget}: the two surfaces excluded different skills`,
    );
    assert.equal(
      mcp.inlineBytes,
      cli.inlineBytes,
      `budget ${budget}: the two surfaces report different bytes`,
    );
    // And the budget is real in both, which is the property the two copies used to share
    // only by accident.
    assert.ok(mcp.inlineBytes <= budget, `${mcp.inlineBytes} bytes against a ${budget}-byte budget`);
  }
});

test('mcp: no mutating command is exposed as a tool', () => {
  // The load-bearing invariant of this file. Each of these writes, and each is meant to be
  // read as a diff by a human first (ADR-001, ADR-004). A model can call a tool; a model
  // cannot review a diff it never showed you.
  const FORBIDDEN = ['init', 'sync', 'upgrade', 'install', 'write', 'apply', 'commit', 'push', 'edit', 'create'];
  for (const name of toolNames()) {
    for (const banned of FORBIDDEN) {
      assert.ok(!name.includes(banned), `${name} looks mutating ("${banned}"); read-only surface only`);
    }
  }
});

test('mcp: every command that writes is reachable only from the CLI', async () => {
  const { stdout } = await exec(process.execPath, [BIN, 'mcp', '--list', '--json']);
  const { tools } = JSON.parse(stdout);
  const names = tools.map((t) => t.name);
  for (const mutating of ['init', 'sync', 'upgrade', 'skills install', 'hooks install']) {
    assert.ok(!names.includes(mutating), `${mutating} is exposed over MCP`);
  }
  assert.ok(names.includes('check') && names.includes('compare'), 'the read commands must be exposed');
});

// --- resources ------------------------------------------------------------------
//
// Every rule and every decision record is readable over `simt://`. The interesting part
// is not that the URIs work — it is that each revision answers in its OWN shape, because
// the two specifications disagree about what a missing resource is. That is why these
// tests run the matrix rather than asserting one behaviour.

test('mcp: the resources capability is declared without subscriptions', async () => {
  const r = await handle(req('initialize'), TOOLS, { packageVersion: '9.9.9' });
  // The empty object says "resources, but nothing that changes". A server advertising
  // subscribe or listChanged here would be promising a stream it cannot produce.
  assert.deepEqual(r.result.capabilities.resources, {});
  assert.equal(r.result.capabilities.resources.subscribe, undefined);
  assert.equal(r.result.capabilities.resources.listChanged, undefined);
});

/**
 * Every resource a revision lists, walking `nextCursor` as a client must.
 *
 * The listing paginates (review 0003 Q66). A test that reads one reply sees the first page
 * and mistakes it for the estate, which is exactly the mistake a client makes and the one
 * the cursor exists to prevent.
 */
async function listedResources(version, opts) {
  const all = [];
  let cursor;
  for (;;) {
    const reply = await handle(at(version, 'resources/list', cursor === undefined ? {} : { cursor }), TOOLS, opts);
    all.push(...reply.result.resources);
    if (!reply.result.nextCursor) return all;
    cursor = reply.result.nextCursor;
  }
}

test('mcp: every revision lists rules, decisions, the kernel and the next slice', async () => {
  for (const version of SUPPORTED_VERSIONS) {
    const resources = await listedResources(version);
    assert.ok(resources.length > 20, `${version} listed ${resources.length}`);
    // Sorted, so a client diffing two listings sees a change rather than a reshuffle.
    assert.deepEqual(resources.map((x) => x.uri), [...resources.map((x) => x.uri)].sort());
    for (const entry of resources) {
      assert.ok(
        /^simt:\/\/(rules|decisions)\//.test(entry.uri) || entry.uri === 'simt://kernel' || entry.uri === 'simt://plan/next',
        `${version} listed ${entry.uri}`,
      );
      assert.ok(entry.name && entry.mimeType === 'text/markdown' && Number.isInteger(entry.size));
    }
    assert.ok(resources.some((x) => x.uri === 'simt://rules/core'));
    assert.ok(resources.some((x) => x.uri.startsWith('simt://decisions/')));
    // One fixed resource, not one per client or per revision: the kernel renders for any
    // root, so it is always listed.
    assert.ok(resources.some((x) => x.uri === 'simt://kernel'));
  }
});

test('mcp: only the newest revision carries the cache fields on a list', async () => {
  // 2026-07-28 requires ttlMs and cacheScope on results; the two older revisions have
  // no such field, so sending one is a payload a client of that revision cannot parse
  // against the schema it knows.
  const newest = await handle(at('2026-07-28', 'resources/list'), TOOLS);
  assert.ok(newest.result.ttlMs > 0 && newest.result.cacheScope === 'private');
  for (const version of ['2025-11-25', '2025-06-18']) {
    const older = await handle(at(version, 'resources/list'), TOOLS);
    assert.equal(older.result.ttlMs, undefined, `${version} must not receive ttlMs`);
    assert.equal(older.result.cacheScope, undefined, `${version} must not receive cacheScope`);
  }
});

test('mcp: templates are listed, and they name the two schemes', async () => {
  for (const version of SUPPORTED_VERSIONS) {
    const r = await handle(at(version, 'resources/templates/list'), TOOLS);
    const uris = r.result.resourceTemplates.map((t) => t.uriTemplate);
    assert.deepEqual(uris.sort(), ['simt://decisions/{adr}', 'simt://rules/{id}']);
  }
});

test('mcp: a rule is readable, with its frontmatter reconstructed', async () => {
  const r = await handle(at('2026-07-28', 'resources/read', { uri: 'simt://rules/core' }), TOOLS);
  const [content] = r.result.contents;
  assert.equal(content.uri, 'simt://rules/core');
  assert.equal(content.mimeType, 'text/markdown');
  // The file on disk has frontmatter; a resource has none, so it is rebuilt or the
  // reader loses the identity it just listed. The keys are unprefixed: `simt-` is this
  // tool's own namespace, and a resource is read by a client that knows nothing about it.
  assert.match(content.text, /^---\n/);
  assert.match(content.text, /^id: core$/m);
  assert.match(content.text, /^priority: hard$/m);
  // Not the H1: `loadRules` hands back a body that no longer carries it, and the
  // identity the H1 carried is in the frontmatter above.
  assert.match(content.text, /^title: Shared rules$/m);
  assert.match(content.text, /^## Truth$/m);
});

test('mcp: a decision record is readable and carries no estate name', async () => {
  const first = (await listedResources('2026-07-28')).find((x) => x.uri.startsWith('simt://decisions/'));
  const r = await handle(at('2026-07-28', 'resources/read', { uri: first.uri }), TOOLS);
  const [content] = r.result.contents;
  assert.equal(content.mimeType, 'text/markdown');
  assert.match(content.text, /^# ADR-\d{3} /m);
  assert.match(content.text, /^Status: /m);
  assert.doesNotMatch(content.text, /docs\/decisions\//, 'a reader outside this estate cannot resolve that path');
});

test('mcp: the kernel resource is the region in kernel mode, whatever the repo declared', async () => {
  // The URI promises the kernel's bytes by its name. This checkout declares `full`
  // (the default, and the only measured-safe mode), and the read still renders the
  // kernel: the declared mode governs what `sync` writes to disk, not what a read path
  // may ask for (ADR-002).
  const entry = (await listedResources('2026-07-28')).find((x) => x.uri === 'simt://kernel');
  assert.ok(entry, 'the kernel resource is always listed');
  assert.ok(Number.isInteger(entry.size) && entry.size > 0, `listed size ${entry?.size}`);

  const r = await handle(at('2026-07-28', 'resources/read', { uri: 'simt://kernel' }), TOOLS);
  const [content] = r.result.contents;
  assert.equal(content.uri, 'simt://kernel');
  assert.equal(content.mimeType, 'text/markdown');
  // Listed size is read size: a client that budgets on the listing gets exactly the
  // bytes it budgeted for.
  assert.equal(Buffer.byteLength(content.text), entry.size);

  // And they are the bytes the projection itself renders, with the kernel's two
  // signatures: the hard class packed (core is `priority: hard`, the same rule the
  // rules resource serves alone), and every deferred rule named with the command that
  // fetches it - R08's accept criterion, made readable from outside the estate.
  const region = await desiredRegion(process.cwd(), { mode: 'kernel' });
  assert.equal(content.text, region.body);
  assert.match(content.text, /^## Core/m);
  assert.match(content.text, /Show it with: simt rules show/);
});

test('mcp: plan/next is listed and readable exactly when a slice is ready', async () => {
  // Asserted against the plan module rather than a snapshot, because the tracker moves
  // with every slice landed: the pairing a client relies on is that the listing and the
  // read come from the same source of truth and agree in both directions.
  const result = await planNext(process.cwd(), null);
  const entry = (await listedResources('2026-07-28')).find((x) => x.uri === 'simt://plan/next');
  if (result.error || !result.next) {
    assert.equal(entry, undefined, 'no slice was ready, yet plan/next was listed');
    return;
  }
  assert.ok(entry, `a slice was ready (${result.next.id}) and plan/next was not listed`);
  assert.ok(Number.isInteger(entry.size) && entry.size > 0);
  const r = await handle(at('2026-07-28', 'resources/read', { uri: 'simt://plan/next' }), TOOLS);
  const [content] = r.result.contents;
  assert.equal(content.mimeType, 'text/markdown');
  assert.equal(content.text, result.next.section);
  assert.equal(Buffer.byteLength(content.text), entry.size);
});

test('mcp: plan/next is not found in a repository without a plan, per revision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'simt-planres-'));
  const opts = { root: dir };
  const newest = await handle(at('2026-07-28', 'resources/read', { uri: 'simt://plan/next' }), TOOLS, opts);
  assert.equal(newest.error.code, RPC.RESOURCE_NOT_FOUND);
  const oldest = await handle(at('2025-06-18', 'resources/read', { uri: 'simt://plan/next' }), TOOLS, opts);
  assert.equal(oldest.error.code, RPC.RESOURCE_NOT_FOUND_LEGACY);
  const listedAll = await listedResources('2026-07-28', opts);
  assert.equal(listedAll.find((x) => x.uri === 'simt://plan/next'), undefined);
  // The kernel rides along, because it renders read-only facts about any directory -
  // and with a size, because a listing without one is a budget a client cannot make.
  const kernel = listedAll.find((x) => x.uri === 'simt://kernel');
  assert.ok(kernel && kernel.size > 0, 'the kernel resource must render for any root');
});

test('mcp: a missing resource is the error its revision specifies', async () => {
  // The whole reason this surface is versioned per revision: 2026-07-28 makes -32602
  // mandatory and keeps -32002 only for clients that already accept it, while
  // 2025-06-18 says the opposite.
  const newest = await handle(at('2026-07-28', 'resources/read', { uri: 'simt://rules/nope' }), TOOLS);
  assert.equal(newest.error.code, RPC.RESOURCE_NOT_FOUND);
  const oldest = await handle(at('2025-06-18', 'resources/read', { uri: 'simt://rules/nope' }), TOOLS);
  assert.equal(oldest.error.code, RPC.RESOURCE_NOT_FOUND_LEGACY);
  // Never an empty contents array: the newest specification forbids it precisely
  // because a client cannot tell it from a resource with no content.
  for (const version of SUPPORTED_VERSIONS) {
    const r = await handle(at(version, 'resources/read', { uri: 'simt://rules/nope' }), TOOLS);
    assert.ok(r.error, `${version} returned a result instead of an error`);
    assert.equal(r.result, undefined);
  }
});

test('mcp: a uri that is not ours, or tries to escape, is refused', async () => {
  // The specification requires a server to validate resource URIs and to sanitise paths
  // so a client cannot read outside what it listed.
  for (const uri of [
    'file:///etc/passwd',
    'simt://rules/../../etc/passwd',
    'simt://rules/',
    'simt://skills/build-system',
    'simt://rules/a/b',
    42,
    null,
  ]) {
    const r = await handle(at('2026-07-28', 'resources/read', { uri }), TOOLS);
    assert.ok(r.error, `refused to refuse ${JSON.stringify(uri)}`);
    assert.equal(r.error.code, RPC.RESOURCE_NOT_FOUND);
  }
});

// --- prompts --------------------------------------------------------------------
//
// Two templates for the two jobs the server is for. The tests here check the shape the
// specification cares about - capability, list, get, errors - and that the template text
// names the tools it teaches, because a prompt that describes work the server cannot do
// would be a lie with a message field.

test('mcp: prompts are a capability, listed with their arguments at every revision', async () => {
  for (const version of SUPPORTED_VERSIONS) {
    const init = await handle(req('initialize', { protocolVersion: version }), TOOLS);
    assert.deepEqual(init.result.capabilities.prompts, {});
    const list = await handle(at(version, 'prompts/list'), TOOLS);
    assert.deepEqual(list.result.prompts.map((p) => p.name), ['simt-brief', 'simt-slice']);
    const brief = list.result.prompts.find((p) => p.name === 'simt-brief');
    assert.ok(brief.arguments.some((a) => a.name === 'task' && a.required === true), 'the task argument is required');
    const slice = list.result.prompts.find((p) => p.name === 'simt-slice');
    assert.ok(slice.arguments.some((a) => a.name === 'id' && !a.required), 'the id argument is optional');
  }
  // The cache lifetime the list results carry from 2026-07-28, and must not before it.
  const newest = await handle(at('2026-07-28', 'prompts/list'), TOOLS);
  assert.ok(newest.result.ttlMs > 0 && newest.result.cacheScope === 'private');
  const older = await handle(at('2025-06-18', 'prompts/list'), TOOLS);
  assert.equal(older.result.ttlMs, undefined, 'a field the revision does not define was invented for it');
});

test('mcp: prompts/get returns the argument in a user message, at every revision', async () => {
  for (const version of SUPPORTED_VERSIONS) {
    const r =
      await handle(at(version, 'prompts/get', { name: 'simt-brief', arguments: { task: 'fix the compass drift' } }), TOOLS);
    assert.ok(r.result, `${version}: prompts/get errored: ${JSON.stringify(r.error)}`);
    const [message] = r.result.messages;
    assert.equal(message.role, 'user');
    assert.equal(message.content.type, 'text');
    assert.match(message.content.text, /fix the compass drift/);
    // A prompt names the tools; it does not pretend to have run them. The server is
    // read-only, and the template is written for an agent that can call.
    assert.match(message.content.text, /`brief` tool/);
  }
});

test('mcp: simt-slice answers with and without an id, and points at the kernel', async () => {
  const bare = await handle(at('2026-07-28', 'prompts/get', { name: 'simt-slice' }), TOOLS);
  const bareText = bare.result.messages[0].content.text;
  // Omission is the default reading: "the next slice" is what the request means.
  assert.match(bareText, /`plan_next` tool with no id/);
  // ADR-001, stated in the template because the agent that reads it is the one that
  // would otherwise push.
  assert.match(bareText, /Push only on explicit user approval/);

  const named = await handle(at('2026-07-28', 'prompts/get', { name: 'simt-slice', arguments: { id: 'S38' } }), TOOLS);
  const namedText = named.result.messages[0].content.text;
  assert.match(namedText, /id "S38"/);
  // The rules the agent commits under are read as the resource the prompt names - the
  // same bytes an adopting repository's own agent would start from.
  assert.match(namedText, /simt:\/\/kernel/);
});

test('mcp: an unknown prompt is a method error naming the way to discover one', async () => {
  const r = await handle(at('2026-07-28', 'prompts/get', { name: 'nope' }), TOOLS);
  assert.equal(r.error.code, RPC.METHOD);
  assert.match(r.error.message, /no prompt named "nope"/);
  assert.match(r.error.message, /prompts\/list/);
});

