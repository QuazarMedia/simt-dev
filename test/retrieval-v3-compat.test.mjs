import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { before, test } from 'node:test';
import { promisify } from 'node:util';

import { SQLITE_FILE } from '../src/index/persist.mjs';
import { PROTOCOL_VERSION } from '../src/mcp/server.mjs';
import { ensureGit, git, tempDir, simt } from './fixture.mjs';
import { ROOT } from './shipped-fixture.mjs';
import { converse, req } from './mcp-fixture.mjs';

const exec = promisify(execFile);
let bin;

before(async () => {
  const install = await tempDir('installed-retrieval-v3-');
  const env = { ...process.env, npm_config_cache: join(install, 'cache') };
  const { stdout } = await exec('npm', ['pack', '--json', '--pack-destination', install], { cwd: ROOT, env });
  const packed = JSON.parse(stdout);
  const [{ name, filename }] = Array.isArray(packed) ? packed : Object.values(packed);
  await writeFile(join(install, 'package.json'), '{"private":true}');
  await exec(
    'npm',
    ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(install, filename)],
    { cwd: install, env },
  );
  const installed = join(install, 'node_modules', name);
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies ?? {}, {});
  bin = join(installed, manifest.bin.simt);
});

async function consumer(files) {
  const root = await tempDir('retrieval-v3-consumer-');
  for (const [path, text] of Object.entries({ '.gitignore': '.simt/\n', ...files })) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  await ensureGit(root);
  return root;
}

async function cli(root, args, { exit = 0, env = {} } = {}) {
  const result = await simt([...args, '--json'], { cwd: root, bin, env });
  assert.equal(result.code, exit, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function calls(root, ...requests) {
  const raw = [
    req('initialize', { protocolVersion: PROTOCOL_VERSION }),
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    ...requests.map(([name, args], index) => req('tools/call', { name, arguments: { ...args, root } }, index + 2)),
  ].map((row) => JSON.stringify(row)).join('\n') + '\n';
  const { stdout, stderr, code } = await converse(raw, { bin, cwd: root, timeout: 10000 });
  assert.equal(code, 0, stderr);
  const responses = stdout.trim().split('\n').map((row) => JSON.parse(row));
  assert.equal(responses.length, requests.length + 1, stdout);
  const byId = new Map(responses.map((row) => [row.id, row]));
  return requests.map((_, index) => {
    const response = byId.get(index + 2);
    assert.ok(response?.result, JSON.stringify(response));
    return response.result;
  });
}

test('installed v7 index upgrades v5 and v6 safely and keeps newer schemas byte-identical', async () => {
  const root = await consumer({
    'package.json': '{"name":"v7-mig-fixture","type":"module"}\n',
    'src/session.mjs': '// Prevent premature logout during browsing.\nexport function extendSession(ttl) { return ttl + 1000; }\n',
    'src/billing.mjs': 'export function invoiceTotal(items) { return items.length; }\n',
  });
  await git(['commit', '--allow-empty', '-m', 'prevent premature logout while browsing'], { cwd: root });
  await cli(root, ['index']);
  const dbPath = join(root, SQLITE_FILE);

  // Downgrade to v6 (no commit_fts, no concept_map, no string_literals, no hits_scores)
  const v6 = new DatabaseSync(dbPath);
  try {
    v6.exec(`
      drop table if exists commit_fts;
      drop table if exists concept_map;
      drop table if exists concept_sources;
      drop table fts;
      create virtual table fts using fts5(
        path_tokens, symbol_names, qual_names, signatures, headings, body,
        node_id unindexed, kind unindexed,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      delete from meta where key in ('commit_fts', 'concept_map', 'fts_constructs', 'hits_scores', 'commit_ir_records');
      update meta set value = '6' where key = 'schema';
      pragma user_version = 6;
    `);
  } finally {
    v6.close();
  }

  // Un-migrated v6 DB must still answer read queries cleanly without crashing or mutating.
  const v6Saved = await readFile(dbPath);
  const v6Map = await cli(root, ['map', '--task', 'extendSession']);
  assert.equal(v6Map.files[0].path, 'src/session.mjs');
  const v6Brief = await cli(root, ['brief', 'Update extendSession in src/session.mjs']);
  assert.ok(v6Brief.text.includes('src/session.mjs'));
  assert.deepEqual(await readFile(dbPath), v6Saved);

  // Explicit `simt index` upgrades v6 -> v7 and populates v7 tables.
  await cli(root, ['index']);
  const upgraded = new DatabaseSync(dbPath);
  try {
    assert.equal(upgraded.prepare('pragma user_version').get().user_version, 7);
    assert.equal(upgraded.prepare("select value from meta where key = 'schema'").get().value, '7');
    assert.equal(upgraded.prepare("select value from meta where key = 'commit_fts'").get().value, '1');
    assert.equal(upgraded.prepare("select value from meta where key = 'concept_map'").get().value, '1');
    assert.equal(upgraded.prepare("select value from meta where key = 'fts_constructs'").get().value, '1');
    assert.equal(upgraded.prepare("select value from meta where key = 'hits_scores'").get().value, '1');
    const cols = upgraded.prepare('pragma table_info(fts)').all().map((row) => row.name);
    assert.ok(cols.includes('invocations'));
    assert.ok(cols.includes('string_literals'));
    // Downgrade further to v5 and verify v5 -> v7 upgrade also succeeds.
    upgraded.exec(`
      drop table if exists commit_fts;
      drop table if exists concept_map;
      drop table if exists concept_sources;
      drop table fts;
      create virtual table fts using fts5(body, node_id unindexed, kind unindexed, tokenize = 'unicode61 remove_diacritics 2');
      delete from meta where key in ('fts_fields', 'lexical_terms', 'commit_fts', 'concept_map', 'fts_constructs', 'hits_scores', 'commit_ir_records');
      update meta set value = '5' where key = 'schema';
      pragma user_version = 5;
    `);
  } finally {
    upgraded.close();
  }

  await cli(root, ['index']);
  const v7 = new DatabaseSync(dbPath);
  try {
    assert.equal(v7.prepare('pragma user_version').get().user_version, 7);
    assert.equal(v7.prepare("select value from meta where key = 'fts_constructs'").get().value, '1');
    v7.exec("update meta set value = '99' where key = 'schema'; pragma user_version = 99");
  } finally {
    v7.close();
  }

  // ADR-115: newer schema version must remain byte-identical under index and read calls.
  const newerSaved = await readFile(dbPath);
  await cli(root, ['index']);
  assert.deepEqual(await readFile(dbPath), newerSaved);
  const newerMap = await cli(root, ['map', '--task', 'invoiceTotal']);
  assert.equal(newerMap.files[0].path, 'src/billing.mjs');
  assert.deepEqual(await readFile(dbPath), newerSaved);
});

test('installed MCP brief enforces cold-index safety and matches CLI across scopes, seen, and nash', async () => {
  const longBody = [
    ...Array.from({ length: 205 }, (_, i) => `// padding line ${i}`),
    'export function targetWindowHandler(x) {',
    '  return x + 1;',
    '}',
    'export function secondaryHelper(y) { return y * 2; }',
  ].join('\n') + '\n';

  const root = await consumer({
    'package.json': '{"name":"parity-fixture","type":"module","scripts":{"test":"node --test"}}\n',
    'src/large.mjs': longBody,
    'src/caller.mjs': 'import { targetWindowHandler } from "./large.mjs";\nexport function runCaller() { return targetWindowHandler(1); }\n',
    'test/large.test.mjs': 'import { targetWindowHandler } from "../src/large.mjs";\nif (!targetWindowHandler(1)) throw new Error("fail");\n',
  });

  // Cold check: MCP brief must refuse without creating .simt/index.sqlite.
  const [cold] = await calls(root, ['brief', { task: 'Fix targetWindowHandler in src/large.mjs', scopes: true }]);
  assert.equal(cold.isError, true);
  assert.match(cold.content[0].text, /index/);
  await assert.rejects(access(join(root, SQLITE_FILE)), { code: 'ENOENT' });

  await cli(root, ['index']);
  const unpack = (result) => {
    assert.equal(result.isError, false, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };

  const singleTask = 'Fix targetWindowHandler in src/large.mjs';
  const [mcpScoped] = await calls(root, ['brief', { task: singleTask, scopes: true }]);
  const cliScoped = await cli(root, ['brief', singleTask, '--scopes']);
  assert.equal(unpack(mcpScoped).text, cliScoped.text);
  assert.deepEqual(unpack(mcpScoped).scopes, cliScoped.scopes);
  assert.match(cliScoped.text, /src\/large\.mjs:\d+-\d+ targetWindowHandler/);

  const multiTask = 'Fix targetWindowHandler in src/large.mjs, and add tests for runCaller in src/caller.mjs.';
  const [mcpSeenNash] = await calls(root, ['brief', { task: multiTask, scopes: true, nash: true, seen: 'src/large.mjs' }]);
  const cliSeenNash = await cli(root, ['brief', multiTask, '--scopes', '--nash', '--seen', 'src/large.mjs']);
  assert.equal(unpack(mcpSeenNash).text, cliSeenNash.text);
  assert.deepEqual(unpack(mcpSeenNash).seen, cliSeenNash.seen);
  assert.deepEqual(unpack(mcpSeenNash).scopes, cliSeenNash.scopes);

  // Locale invariance (LC_ALL=C) on installed CLI brief and map.
  const lcBrief = await cli(root, ['brief', multiTask, '--scopes', '--nash', '--seen', 'src/large.mjs'], { env: { LC_ALL: 'C' } });
  assert.equal(lcBrief.text, cliSeenNash.text);
});

test('installed knowledge rank preserves Unicode and proof packets in an isolated consumer', async () => {
  const root = await consumer({
    'evidence.json': JSON.stringify({
      units: [
        { id: 'ar-note', path: 'docs/ar.md', kind: 'decision', language: 'ar', text: 'إلغاء الجلسة المبكر للمستخدم النشط', authority: 4, scope: { product: 'core' } },
        { id: 'cjk-note', path: 'docs/ja.md', kind: 'decision', language: 'ja', text: 'セッション更新のタイムアウト処理', authority: 4, scope: { product: 'core' } },
      ],
      scope: { product: 'core' },
    }),
  });
  await cli(root, ['init', '--yes']);
  const projection = await readFile(join(root, 'AGENTS.md'), 'utf8');
  const arRank = await cli(root, ['knowledge', 'rank', '--input', 'evidence.json', '--query', 'إلغاء الجلسة المبكر']);
  assert.equal(arRank.ranked[0].id, 'ar-note');
  const cjkRank = await cli(root, ['knowledge', 'rank', '--input', 'evidence.json', '--query', 'セッション更新']);
  assert.equal(cjkRank.ranked[0].id, 'cjk-note');
  assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), projection);
});
