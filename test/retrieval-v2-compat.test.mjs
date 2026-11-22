import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { before, test } from 'node:test';
import { promisify } from 'node:util';

import { SQLITE_FILE } from '../src/index/persist.mjs';
import { PROTOCOL_VERSION } from '../src/mcp/server.mjs';
import { ensureGit, tempDir, simt } from './fixture.mjs';
import { ROOT } from './shipped-fixture.mjs';
import { converse, req } from './mcp-fixture.mjs';

const exec = promisify(execFile);
let bin;
const evidence = JSON.stringify({
  units: [{ id: 'rates', path: 'guide.md', kind: 'document', language: 'en',
    text: 'Rates apply to bills in the current period.', authority: 4, scope: { jurisdiction: 'CA' } }],
  scope: { jurisdiction: 'CA' },
});

before(async () => {
  const install = await tempDir('installed-retrieval-');
  const env = { ...process.env, npm_config_cache: join(install, 'cache') };
  const { stdout } = await exec('npm', ['pack', '--json', '--pack-destination', install], { cwd: ROOT, env });
  const [{ name, filename }] = JSON.parse(stdout);
  await writeFile(join(install, 'package.json'), '{"private":true}');
  await exec('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(install, filename)],
    { cwd: install, env });
  const installed = join(install, 'node_modules', name);
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies ?? {}, {});
  bin = join(installed, manifest.bin.simt);
});

async function consumer(files) {
  const root = await tempDir('retrieval-consumer-');
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
  const { stdout, stderr, code } = await converse(raw, { bin, cwd: root, timeout: 8000 });
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

const matrix = [
  ['Node and TypeScript', 'src/rate.ts', 'export function rate() { return 1; }\n',
    { 'package.json': '{"name":"ledger","type":"module","scripts":{"test":"node --test"}}',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
      'test/rate.test.mjs': 'import { rate } from "../src/rate.ts";\nif (!rate()) throw new Error("rate");\n' }],
  ['Python and uv', 'src/rate.py', 'def rate():\n    return 1\n',
    { 'pyproject.toml': '[project]\nname = "ledger"\nversion = "0.1.0"\n', 'uv.lock': 'version = 1\n' }],
  ['Go', 'rate.go', 'package ledger\nfunc Rate() int { return 1 }\n', { 'go.mod': 'module example.invalid/ledger\n' }],
  ['Rust', 'src/lib.rs', 'pub fn rate() -> u32 { 1 }\n',
    { 'Cargo.toml': '[package]\nname = "ledger"\nversion = "0.1.0"\n' }],
  ['Kotlin and Android', 'app/src/main/kotlin/Rate.kt', 'package ledger\nfun rate(): Int = 1\n',
    { 'settings.gradle.kts': 'rootProject.name = "ledger"\ninclude(":app")\n',
      'app/build.gradle.kts': 'plugins { id("com.android.application") }\n' }],
  ['knowledge only', 'guide.md', '# Rate\n\nThe billing rate is 1.\n', { 'evidence.json': evidence }],
  ['mixed monorepo', 'packages/ledger/rate.mjs', 'export function rate() { return 1; }\n',
    { 'package.json': '{"name":"root","type":"module","workspaces":["packages/*"]}',
      'packages/ledger/package.json': '{"name":"ledger","type":"module"}',
      'packages/reader/pyproject.toml': '[project]\nname = "reader"\nversion = "0.1.0"\n',
      'packages/reader/reader.py': 'def read():\n    return 1\n',
      'evidence.json': evidence }],
];

for (const [name, path, body, files] of matrix) {
  test(`installed retrieval commands run in a ${name} receiving repository`, async () => {
    const root = await consumer({ ...files, [path]: body });
    await cli(root, ['init', '--yes']);
    const projection = await readFile(join(root, 'AGENTS.md'), 'utf8');
    await cli(root, ['index', '--retrieval', 'v2']);
    await writeFile(join(root, path), body.replace('1', '2'));
    const task = `Review ${path} and document the current rate.`;
    assert.ok((await cli(root, ['brief', task, '--retrieval', 'v2'])).text.length);
    const map = await cli(root, ['map', '--task', `Review ${path}`, '--retrieval', 'v2']);
    assert.equal(map.files[0].path, path);
    const alternateLocale = await cli(root, ['map', '--task', `Review ${path}`, '--retrieval', 'v2'], { env: { LC_ALL: 'C' } });
    assert.deepEqual(alternateLocale, map);
    const impact = await cli(root, ['impact', path, '--retrieval', 'v2']);
    assert.equal(impact.file, path);
    assert.ok(Array.isArray(impact.importers));
    assert.equal((await cli(root, ['why', path])).path, path);
    const gate = await cli(root, ['gate', '--changed', '--precise']);
    const tests = await cli(root, ['tests', '--run', '--changed', '--precise']);
    assert.deepEqual(tests.selected, gate.selected);
    const check = await simt(['check', '--changed', '--json'], { cwd: root, bin });
    const parsed = JSON.parse(check.stdout);
    assert.equal(parsed.command, 'check');
    assert.ok(parsed.findings.some(({ file, status }) => file === 'AGENTS.md' && status === 'current'));
    if (files['evidence.json']) {
      const rank = await cli(root, ['knowledge', 'rank', '--input', 'evidence.json', '--query', 'billing rate', '--retrieval', 'v2']);
      assert.equal(rank.ranked[0].id, 'rates');
    }
    assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), projection);
  });
}

test('installed MCP refuses a cold brief without building and matches warm CLI fields', async () => {
  const root = await consumer({ 'rate.mjs': 'export function rate() { return 1; }\n' });
  const task = 'Change rate in rate.mjs and document the rate.';
  const [cold] = await calls(root, ['brief', { task, retrieval: 'v2' }]);
  assert.equal(cold.isError, true);
  assert.match(cold.content[0].text, /index/);
  await assert.rejects(access(join(root, SQLITE_FILE)), { code: 'ENOENT' });
  await cli(root, ['index', '--retrieval', 'v2']);
  const [brief, check, impact] = await calls(root, ['brief', { task, retrieval: 'v2' }],
    ['check', { changed: true }], ['impact', { targets: ['rate.mjs#rate'], retrieval: 'v2' }]);
  const unpack = (result) => {
    assert.equal(result.isError, false, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  assert.equal(unpack(brief).text, (await cli(root, ['brief', task, '--retrieval', 'v2'])).text);
  const checked = await cli(root, ['check', '--changed'], { exit: 1 });
  assert.deepEqual(unpack(check).findings, checked.findings);
  const cliImpact = await cli(root, ['impact', 'rate.mjs#rate', '--retrieval', 'v2']);
  assert.deepEqual(unpack(impact).targets, cliImpact.targets);
  assert.deepEqual(unpack(impact).structural, cliImpact.structural);
});

test('installed index upgrades v5 and leaves a newer file byte-identical', async () => {
  const root = await consumer({ 'rate.mjs': 'export function rate() { return 1; }\n' });
  await cli(root, ['index']);
  const path = join(root, SQLITE_FILE);
  const v5 = new DatabaseSync(path);
  try {
    v5.exec(`drop table fts;
      create virtual table fts using fts5(body, node_id unindexed, kind unindexed, tokenize = 'unicode61 remove_diacritics 2');
      insert into fts(body, node_id, kind) select body, node_id, kind from fts_legacy order by rowid;
      drop table fts_legacy;
      drop index idx_symbols_folded_name;
      update meta set value = '5' where key = 'schema';
      pragma user_version = 5`);
  } finally {
    v5.close();
  }
  await cli(root, ['index', '--retrieval', 'v2']);
  const newer = new DatabaseSync(path);
  try {
    assert.equal(newer.prepare('pragma user_version').get().user_version, 6);
    newer.exec("update meta set value = '7' where key = 'schema'; pragma user_version = 7");
  } finally {
    newer.close();
  }
  const saved = await readFile(path);
  await cli(root, ['index', '--retrieval', 'v2']);
  assert.deepEqual(await readFile(path), saved);
  const mapped = await cli(root, ['map', '--task', 'rate', '--retrieval', 'v2']);
  assert.equal(mapped.files[0].path, 'rate.mjs');
});
