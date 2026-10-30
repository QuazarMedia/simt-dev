// simt mcp - the line protocol.
//
// `handle()` is pure, so most of this file tests it without a pipe. The end-to-end test at
// the end exists because the failure nobody catches otherwise is a stray byte of prose on
// stdout: the client then shows nothing and reports no error, because from its side the
// stream is simply malformed.

import assert from 'node:assert/strict';
import { test } from 'node:test';
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

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt.mjs');
const exec = promisify(execFile);

const req = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });

// --- protocol ------------------------------------------------------------------

test('mcp: initialize answers with the protocol version and the read-only instruction', async () => {
  const r = await handle(req('initialize', { protocolVersion: PROTOCOL_VERSION }), TOOLS, { packageVersion: '9.9.9' });
  assert.equal(r.result.protocolVersion, PROTOCOL_VERSION);
  assert.equal(r.result.serverInfo.version, '9.9.9');
  assert.match(r.result.instructions, /Read-only/);
});

test('mcp: an unsupported protocol version gets ours, not an echo of theirs', async () => {
  // Echoing a version we do not implement is a lie the client cannot detect until a
  // feature silently misbehaves.
  const r = await handle(req('initialize', { protocolVersion: '1999-01-01' }), TOOLS);
  assert.equal(r.result.protocolVersion, PROTOCOL_VERSION);
});

// --- the version matrix -------------------------------------------------------

/** A request that identifies its revision the way that revision does it. */
const at = (version, method, params = {}, id = 1) =>
  req(method, { ...params, _meta: { [META.PROTOCOL_VERSION]: version } }, id);

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
  const r = await handle(req('resources/subscribe', { uri: 'simt://rules/core' }), TOOLS);
  assert.equal(r.error.code, RPC.METHOD);
  assert.match(r.error.message, /unknown method "resources\/subscribe"/);
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

test('mcp: the tool descriptions fit the 2 KB budget the plan set', () => {
  // plan 0003 R41: a cacheable tools/list kept to at most 2 KB through terse
  // descriptions. The budget is measured on the description prose - the mechanism the
  // plan names - and not on the whole payload, which stays full: ADR-068 requires both
  // the structured and the text shape declared, and schemas cut to fit a byte count
  // would need a superseding ADR the tracker does not carry.
  const total = TOOLS.reduce((n, t) => n + Buffer.byteLength(t.description, 'utf8'), 0);
  assert.ok(total <= 2048, `${total} bytes of description against the 2 KB budget`);
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
    const { stdout } = await exec('node', [
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
  const { stdout } = await exec('node', [BIN, 'mcp', '--list', '--json']);
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

test('mcp: every revision lists rules, decisions, the kernel and the next slice', async () => {
  for (const version of SUPPORTED_VERSIONS) {
    const r = await handle(at(version, 'resources/list'), TOOLS);
    const { resources } = r.result;
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
  const listed = await handle(at('2026-07-28', 'resources/list'), TOOLS);
  const first = listed.result.resources.find((x) => x.uri.startsWith('simt://decisions/'));
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
  const listed = await handle(at('2026-07-28', 'resources/list'), TOOLS);
  const entry = listed.result.resources.find((x) => x.uri === 'simt://kernel');
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
  const listed = await handle(at('2026-07-28', 'resources/list'), TOOLS);
  const entry = listed.result.resources.find((x) => x.uri === 'simt://plan/next');
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
  const listed = await handle(at('2026-07-28', 'resources/list'), TOOLS, opts);
  assert.equal(listed.result.resources.find((x) => x.uri === 'simt://plan/next'), undefined);
  // The kernel rides along, because it renders read-only facts about any directory -
  // and with a size, because a listing without one is a budget a client cannot make.
  const kernel = listed.result.resources.find((x) => x.uri === 'simt://kernel');
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

// --- end to end over a real pipe ------------------------------------------------

/**
 * Feed lines to `simt mcp` and collect the session.
 *
 * `spawn` rather than `execFile` with an `input` option, because there is no such option:
 * the child's stdin would never be closed, the server would wait forever for EOF, and the
 * test would hang rather than fail. Ending stdin explicitly is what makes EOF arrive.
 */
function converse(raw) {
  return new Promise((res, rej) => {
    const child = spawn('node', [BIN, 'mcp']);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', rej);
    child.on('close', () => res({ stdout, stderr }));
    child.stdin.end(raw);
  });
}

test('mcp: a real session answers on the protocol channel and nothing else', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'simt-mcp-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'requirements.txt'), 'flask\n');
  await writeFile(join(dir, 'pyproject.toml'), '[project]\nname = "x"\n');
  await writeFile(join(dir, 'src', 'main.py'), 'x = 1\n');

  const { stdout, stderr } = await converse(
    [
      req('initialize', { protocolVersion: PROTOCOL_VERSION }, 1),
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      req('tools/list', {}, 2),
      req('tools/call', { name: 'doctor', arguments: { root: dir } }, 3),
      req('tools/call', { name: 'check', arguments: { root: dir } }, 4),
      req('tools/call', { name: 'rules_list', arguments: { root: dir } }, 5),
    ].map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
  // Every line parsed as JSON, so stdout carried no prose. This is the assertion that
  // catches a stray note() or emit() in the transport.
  const messages = stdout.trim() === '' ? [] : stdout.trim().split('\n').map((l) => JSON.parse(l));

  assert.equal(messages.length, 5, 'the notification must not produce a response');
  assert.deepEqual(messages.map((m) => m.id), [1, 2, 3, 4, 5], 'responses must be in request order');
  assert.equal(stderr, '', 'diagnostics belong on stderr, and there should be none here');

  assert.equal(messages[1].result.tools.length, TOOLS.length);

  const doctor = JSON.parse(messages[2].result.content[0].text);
  assert.ok(doctor.stack.includes('python'), 'doctor must classify the fixture repo');
  assert.ok(doctor.facts.includes('has-pyproject'));
  assert.ok(Array.isArray(doctor.findings), 'doctor must carry the findings, not just the fingerprint');

  // check on an unadopted repo: a successful call whose answer says unmanaged.
  assert.equal(messages[3].result.isError, false);
  const check = JSON.parse(messages[3].result.content[0].text);
  assert.equal(check.ok, false);
  assert.equal(check.findings[0].status, 'absent');

  const rules = JSON.parse(messages[4].result.content[0].text);
  assert.ok(rules.rules.some((r) => r.id === 'python' && r.selected));
  assert.ok(rules.rules.every((r) => Array.isArray(r.adrs)));
});

test('mcp: rules_why answers both directions, over a real session', async () => {
  // review 0001 S05: `rules_why` destructured `{ rules }` from `loadRules`, which returns
  // an ARRAY. Every call died on the first `.filter`, for every argument shape - a P0 that
  // stayed open because this file exercised only 3 of the 10 tools, and not this one.
  // Driven over the protocol rather than through `run()` because the crash was reachable
  // from a real editor: an isError result that looks like a broken server.
  const { stdout, stderr } = await converse(
    [
      req('initialize', { protocolVersion: PROTOCOL_VERSION }, 1),
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      // by decision: which rules rest on it
      req('tools/call', { name: 'rules_why', arguments: { what: 'ADR-006' } }, 2),
      // by rule: which decisions settle it
      req('tools/call', { name: 'rules_why', arguments: { what: 'python' } }, 3),
      // a rule citing no decision reports that, rather than an empty answer
      req('tools/call', { name: 'rules_why', arguments: { what: 'container' } }, 4),
      // and a name that exists nowhere is an error naming the way to find the real ones
      req('tools/call', { name: 'rules_why', arguments: { what: 'nope' } }, 5),
      req('tools/call', { name: 'rules_why', arguments: { what: 'ADR-999' } }, 6),
    ].map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
  assert.equal(stderr, '', 'diagnostics belong on stderr, and there should be none here');
  const messages = stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(messages.map((m) => m.id), [1, 2, 3, 4, 5, 6], 'every request must be answered');

  // A thrown Error becomes isError with `remedy: null`. Asserting isError false on all
  // three real lookups is the assertion that would have caught S05: the crash arrived as
  // isError, not as a hang or an empty payload, so only an explicit check finds it.
  for (const id of [2, 3, 4]) {
    assert.equal(messages[id - 1].result.isError, false, `request ${id} failed: ${messages[id - 1].result.content[0].text}`);
  }

  const byDecision = JSON.parse(messages[1].result.content[0].text);
  assert.equal(byDecision.direction, 'decision');
  assert.equal(byDecision.id, 'ADR-006');
  assert.ok(byDecision.rules.includes('core'), 'ADR-006 is cited by core');
  // The record ships inside the package. The full record travels in `adr`, and the
  // effective ruling in `inForce`, so a superseded record is never read as current.
  assert.equal(byDecision.adr.id, 'ADR-006');
  assert.ok(byDecision.inForce.id, 'the decision answer names what is in force');

  const byRule = JSON.parse(messages[2].result.content[0].text);
  assert.equal(byRule.direction, 'rule');
  assert.equal(byRule.id, 'python');
  assert.equal(byRule.uncited, false);
  assert.deepEqual(byRule.adrs.map((d) => d.id), ['ADR-006']);
  assert.ok(byRule.adrs.every((d) => d.missing === undefined), 'every citation must resolve to a record');

  const uncited = JSON.parse(messages[3].result.content[0].text);
  assert.equal(uncited.uncited, true, 'a rule citing no decision reports that, not silence');

  for (const [index, wanted] of [[4, /no rule with id/], [5, /no decision record ADR-999/]]) {
    assert.equal(messages[index].result.isError, true, `request ${index + 1} should be an error`);
    const payload = JSON.parse(messages[index].result.content[0].text);
    assert.match(payload.error, wanted);
  }
});

test('mcp: invalid JSON is answered, and the session continues', async () => {
  // A parse error must not end the session; a client that sends one bad line should get
  // an error for that line and keep working.
  const { stdout } = await converse('not json\n{"jsonrpc":"2.0","id":9,"method":"server/discover"}\n');
  const messages = stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(messages[0].error.code, RPC.PARSE);
  // The session survived the bad line and answered the next request, which is the whole
  // claim. `server/discover` rather than `ping` because the default revision no longer
  // has the latter.
  assert.deepEqual(messages[1].result.supportedVersions, SUPPORTED_VERSIONS);
});

test('mcp: every tool answers, and every answer matches the schema it declared', async () => {
  // The review's second acceptance criterion, and the one that catches a payload that
  // grew a field nobody wrote down. Minimal arguments only (S20): a tool that cannot be
  // called with the least a client would send is a tool whose schema describes a call
  // no client makes.
  const state = { version: null };
  await handle(req('initialize', { protocolVersion: '2025-11-25' }), TOOLS, { state });

  // The arguments a client sends when it knows nothing: the required ones and nothing else.
  const minimal = {
    skills_brief: { task: 'write a test' },
    skills_show: { name: 'nonexistent-skill' },
    skills_why: { name: 'core' },
    skills_find: { query: 'test' },
    rules_why: { what: 'ADR-001' },
    plan_done: { id: 'no-such-slice' },
    federation_query: { query: 'what calls the keep helper' },
  };

  for (const tool of TOOLS) {
    const args = minimal[tool.name] ?? {};
    // The arguments must be the ones the schema requires and no more.
    for (const key of tool.inputSchema.required ?? []) {
      assert.ok(key in args, `${tool.name} needs "${key}", and this test cannot guess it`);
    }
    assert.ok(tool.outputSchema, `${tool.name} declares no outputSchema, so nothing can check its answer`);

    const r = await handle(req('tools/call', { name: tool.name, arguments: args }, 7), TOOLS, { state });
    assert.ok(r.result, `${tool.name} returned a protocol error: ${JSON.stringify(r.error)}`);
    assert.ok('structuredContent' in r.result, `${tool.name} returned text only`);
    // Both blocks describe one call. A client reading the text and a client reading the
    // structure must not be able to see two different answers.
    const text = JSON.parse(r.result.content[0].text.replace(/\\nTRUNCATED .*$/, ''));
    assert.deepEqual(text, r.result.structuredContent, `${tool.name}: text and structuredContent disagree`);

    if (r.result.isError) {
      assertValid(r.result.structuredContent, ERROR_SHAPE, `${tool.name} failure`);
      continue;
    }
    assertValid(r.result.structuredContent, tool.outputSchema, `${tool.name} success`);
  }
});

test('mcp: the annotations say what the tools are', async () => {
  // Every tool but one is a reader, and the declaration is per tool because the next
  // tool may not be one. A client that believes a tool is read-only will cache its
  // answer — and federation_query spawns a repo-declared command, so it must not
  // wear the read-only hint that invites auto-approval (Q13).
  const state = { version: null };
  await handle(req('initialize', { protocolVersion: '2025-11-25' }), TOOLS, { state });
  const list = await handle(req('tools/list'), TOOLS, { state });
  for (const t of list.result.tools) {
    if (t.name === 'federation_query') {
      assert.equal(t.annotations?.readOnlyHint, false, 'federation_query must not claim to be read-only');
      assert.equal(t.annotations?.openWorldHint, true, 'federation_query must warn that it reaches beyond the model');
      continue;
    }
    assert.equal(t.annotations?.readOnlyHint, true, `${t.name} does not declare itself read-only`);
    assert.equal(t.annotations?.idempotentHint, true, `${t.name} does not declare itself idempotent`);
  }
});

test('mcp: --list answers without reading stdin', async () => {
  // An editor that has misconfigured the command has to be able to ask what it exposes
  // without hanging on a pipe nobody is writing to.
  const { stdout } = await exec('node', [BIN, 'mcp', '--list'], { input: '' });
  assert.match(stdout, /all read-only except federation_query/);
  assert.match(stdout, /Nothing here writes to your repositories/);
});

test('mcp: brief reads the index and never builds one', async () => {
  // `brief` is the one tool every argument of which is optional, so the generic loop above
  // reaches it with `{}` and a root of the process's cwd. That is exactly how a read-only
  // tool can quietly write: the packet assembly builds an index when it finds none, and a
  // call would then leave a cache in whatever repository the editor happened to sit in.
  // The declaration and the behaviour have to agree, so this test warms a fixture by
  // hand and asserts that the cold call wrote nothing.
  const dir = await mkdtemp(join(tmpdir(), 'simt-brief-'));
  await writeFile(join(dir, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'keep.mjs'), 'export function keep(value) { return value; }\n');
  await exec('git', ['init', '-q', dir]);
  await exec('git', ['-C', dir, 'add', '-A']);
  await exec('git', [
    '-C', dir,
    '-c', 'user.email=tests@simt.invalid',
    '-c', 'user.name=simt-dev tests',
    '-c', 'commit.gpgsign=false',
    'commit', '-qm', 'initial',
  ]);

  const state = { version: null };
  await handle(req('initialize', { protocolVersion: '2025-11-25' }), TOOLS, { state });
  const call = (id) => handle(req('tools/call', { name: 'brief', arguments: { root: dir, task: 'fix src/keep.mjs' } }, id), TOOLS, { state });

  const cold = await call(2);
  assert.equal(cold.result.isError, true, 'an index-less repository is a stated failure, not an empty packet');
  assertValid(cold.result.structuredContent, ERROR_SHAPE, 'brief failure');
  assert.match(cold.result.structuredContent.remedy, new RegExp(`${CLI} index`));
  await assert.rejects(
    access(join(dir, '.simt')),
    'brief built an index, which no tool here may do',
  );

  // Warm it the way a person would, then ask again.
  await exec('node', [BIN, 'index', '--root', dir]);

  const warm = await call(3);
  assert.equal(warm.result.isError, false, JSON.stringify(warm.result));
  const brief = TOOLS.find((t) => t.name === 'brief');
  assertValid(warm.result.structuredContent, brief.outputSchema, 'brief success');
  const packet = warm.result.structuredContent;
  assert.match(packet.text, /src\/keep\.mjs/, 'the packet names the file the task mentions');
  assert.ok(packet.bytes > 0 && packet.bytes <= 2048, `packet was ${packet.bytes} bytes`);
});