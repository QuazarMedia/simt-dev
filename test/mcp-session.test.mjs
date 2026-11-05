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
// --- end to end over a real pipe ------------------------------------------------

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
    work_inspect: {},
    knowledge_why: {
      id: 'c1',
      document: { claims: [{ id: 'c1', subject: 's', predicate: 'p', type: 'number', value: 1 }] },
    },
    verify_plan: { document: { obligations: [], capabilities: [] } },
    verify_select: { document: { changed: ['docs/a.md'] } },
    verify_status: { document: { obligations: [{ id: 'o1', state: 'pass' }], evidence: [] } },
    action_status: { document: { journal: [] } },
    knowledge_export: { document: { facts: [] } },
    knowledge_import: { document: { schema: 'simt.bundle/1', version: 1, facts: [] } },
    action_review: { document: { contract: { commit: 'abc123' }, target: { incarnation: 'inc-1', class: 'document' }, before: { 'doc:1': 'sha256-before' }, authorization: { digest: 'sha256-auth' }, postconditions: [{ id: 'p1' }] } },
    adapter_check: { document: { text: '{"name":"a"}' } },
    verify_contracts: { document: { contract: { obligations: [] }, observations: [] } },
    verify_documents: { document: { output: {}, contract: {} } },
    verify_procedures: { document: { records: [{ id: 'a', calls: ['b'] }] } },
    lessons_discover: { document: { candidates: [{ id: '1', proposition: 'a repeated claim', kind: 'discovery', verified: false }] } },
    work_packet: { document: { units: [{ id: 'u1', text: 'the rule', obligations: ['o1'] }] } },
    index_overlay: { document: { node: { key: 'k', kind: 'claim', source: 'docs/a.md', provenance: 'staged', trust: 'observed', revision: 'staged:abc' } } },
    evidence_validate: { document: { records: [] } },
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
  const { stdout } = await exec(process.execPath, [BIN, 'mcp', '--list'], { input: '' });
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
  // Q56: the tool every surface names as the entry point must answer in a repository
  // nobody has indexed. It falls back to the skill packet - which is read from the
  // package, not the tree - and names the command that unlocks the repository packet.
  const briefTool = TOOLS.find((t) => t.name === 'brief');
  assert.equal(cold.result.isError, false, JSON.stringify(cold.result));
  assert.equal(cold.result.structuredContent.basis, 'registry');
  assert.match(cold.result.structuredContent.note, new RegExp(`${CLI} index`));
  // The skill set is a list, and an empty one in a scratch repository is honest: the
  // packet says what it excluded, and the note says what would fill it in.
  assert.ok(Array.isArray(cold.result.structuredContent.sections.skills));
  assertValid(cold.result.structuredContent, briefTool.outputSchema, 'brief fallback');
  await assert.rejects(
    access(join(dir, '.simt')),
    'brief built an index, which no tool here may do',
  );

  // Warm it the way a person would, then ask again.
  await exec(process.execPath, [BIN, 'index', '--root', dir]);

  const warm = await call(3);
  assert.equal(warm.result.isError, false, JSON.stringify(warm.result));
  const brief = TOOLS.find((t) => t.name === 'brief');
  assertValid(warm.result.structuredContent, brief.outputSchema, 'brief success');
  const packet = warm.result.structuredContent;
  assert.match(packet.text, /src\/keep\.mjs/, 'the packet names the file the task mentions');
  assert.ok(packet.bytes > 0 && packet.bytes <= 2048, `packet was ${packet.bytes} bytes`);
});
test('mcp: subscribing is refused with the reason, and never advertised', async () => {
  // Two facts that have to agree: the capability says no subscriptions, and a client that
  // asks anyway is told why. Advertising it and never sending an update, or refusing it as
  // "unknown method", both leave the client worse off than a named refusal.
  for (const method of ['resources/subscribe', 'resources/unsubscribe']) {
    const r = await handle(req(method, { uri: 'simt://kernel' }), TOOLS);
    assert.equal(r.error.code, RPC.METHOD);
    assert.match(r.error.message, /no change source/);
  }
  const init = await handle(at('2026-07-28', 'initialize'), TOOLS);
  assert.equal(init.result.capabilities.resources.subscribe, undefined, 'no subscription capability may be promised');
});
