// ST15: the studio is qualified as a consumer receives it (ADR-031, ADR-207, ADR-228).
//
// The tarball, not the checkout, answers: pack, install into a standalone consumer, then
// open the installed binary in both fixture shapes. The surface row and the two sanitized
// transcripts are checked against the code SHA they claim.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { request as httpRequest } from 'node:http';

import { git, tempDir } from './fixture.mjs';
import { httpReq, treeDigest } from './studio-fixture.mjs';
import { DISPOSITIONS, NAMED_SURFACES } from '../src/surface.mjs';

const exec = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const STUDIO_SHA = '5823334';
const QUALIFIED = ['test/fixtures/studio/qualification-document.json', 'test/fixtures/studio/qualification-code.json'];
const URL_LINE = /open (http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+))/;
const NO_ESTATE = Object.fromEntries(Object.entries({ ...process.env, SIMT_DEV_WORKSPACE: 'off' }).filter(([name]) => !/^npm_config_/i.test(name)));

async function run(command, args, options = {}) {
  try {
    const { stdout, stderr } = await exec(command, args, { maxBuffer: 32 << 20, ...options });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, out: `${error.stdout ?? ''}${error.stderr ?? error}` };
  }
}

function post(port, path, body, cookie) {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers: { cookie, 'content-type': 'application/json', 'content-length': Buffer.byteLength(JSON.stringify(body)) } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolvePromise({ status: res.statusCode, body: text }));
    });
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

async function installedStudio(bin, cwd) {
  const child = spawn(bin, ['studio', '--no-open', '--port', '0'], { cwd, env: NO_ESTATE, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  const started = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`studio did not start: ${out} ${err}`)), 15000);
    child.on('exit', (code) => reject(new Error(`studio exited ${code}: ${out} ${err}`)));
    const poll = setInterval(() => {
      const match = out.match(URL_LINE);
      if (match) {
        clearTimeout(timer);
        clearInterval(poll);
        resolvePromise({ port: Number(match[2]), token: match[3] });
      }
    }, 20);
  });
  const exchange = await httpReq(started.port, { path: `/?token=${started.token}` });
  assert.equal(exchange.status, 303, exchange.body);
  const cookie = exchange.headers['set-cookie'][0].split(';')[0];
  return {
    ...started,
    cookie,
    stop: () => new Promise((resolvePromise) => {
      if (child.exitCode !== null) return resolvePromise(child.exitCode);
      child.kill('SIGINT');
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolvePromise(-1); }, 5000);
      child.on('exit', (code) => { clearTimeout(timer); resolvePromise(code); });
    }),
  };
}

test('the surface row and both transcripts name the studio qualification', async () => {
  const studio = DISPOSITIONS.find((entry) => entry.id === 'studio');
  assert.equal(studio.stability, 'optional');
  assert.equal(studio.qualification, STUDIO_SHA);
  assert.ok(NAMED_SURFACES.some(([name, id]) => name === 'studio' && id === 'studio'));
  const page = await readFile(join(ROOT, 'docs/reference/surface.md'), 'utf8');
  assert.match(page, new RegExp(`\\\| \`studio\` \\\| optional \\\| studio \\\|[^\\n]*${STUDIO_SHA}`));
  for (const file of QUALIFIED) {
    const transcript = JSON.parse(await readFile(join(ROOT, file), 'utf8'));
    assert.equal(transcript.schema, 'simt.studio.qualification/1');
    assert.equal(transcript.install, 'npm-packed-tarball');
    assert.equal(transcript.standalone, true);
    assert.equal(transcript.qualifiedSha, STUDIO_SHA);
    assert.deepEqual(transcript.externalRequests, []);
    assert.ok(transcript.steps.length >= 5);
    assert.equal(transcript.passed, true);
  }
});

test('the packed install opens both fixture shapes and completes a guarded round-trip', { timeout: 120000 }, async (t) => {
  const stage = await mkdtemp(join(tmpdir(), 'simt-studio-release-'));
  const pack = join(stage, 'pack');
  await mkdir(pack);
  const packed = await run('npm', ['pack', '--pack-destination', pack], { cwd: ROOT, env: NO_ESTATE });
  assert.equal(packed.code, 0, packed.out);
  const tarball = (await readdir(pack)).find((name) => name.endsWith('.tgz'));
  assert.ok(tarball, `npm pack wrote no tarball: ${packed.out}`);
  const consumer = join(stage, 'consumer');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'studio-consumer', private: true, type: 'module' }));
  const installed = await run('npm', ['install', '--no-audit', '--no-fund', '--offline', join(pack, tarball)], { cwd: consumer, env: NO_ESTATE });
  assert.equal(installed.code, 0, installed.out);
  const bin = join(consumer, 'node_modules', '.bin', 'simt');

  for (const [shape, files] of [
    ['document-corpus', { 'README.md': '# corpus\n', 'docs/guide.md': '# guide\n', 'handbook/index.md': '# handbook\n' }],
    ['code-repository', { 'README.md': '# code\n', 'src/index.mjs': 'export const value = 1;\n', 'test/index.test.mjs': "import test from 'node:test';\n", 'package.json': JSON.stringify({ type: 'module' }) }],
  ]) {
    const repo = await tempDir(`simt-studio-${shape}-`);
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(dirname(join(repo, rel)), { recursive: true });
      await writeFile(join(repo, rel), body);
    }
    await git(['init', '-q'], { cwd: repo });
    await git(['add', '-A'], { cwd: repo });
    await git(['commit', '-qm', 'fixture'], { cwd: repo });
    const before = await treeDigest(repo);
    const studio = await installedStudio(bin, repo);
    t.after(() => studio.stop());
    const status = await httpReq(studio.port, { path: '/api/status', headers: { cookie: studio.cookie } });
    assert.equal(status.status, 200, status.body);
    assert.equal(JSON.parse(status.body).ok, true);
    const helm = await httpReq(studio.port, { path: '/api/helm?path=status', headers: { cookie: studio.cookie } });
    assert.equal(helm.status, 200, helm.body);
    assert.equal(JSON.parse(helm.body).document.command, 'status');
    const preview = await post(studio.port, '/api/control/preview', { command: 'work setup', args: [], flags: { scope: 'handbook', path: 'handbook', kind: 'document' } }, studio.cookie);
    assert.equal(preview.status, 200, preview.body);
    const plan = JSON.parse(preview.body);
    assert.equal(plan.ok, true);
    assert.equal(await treeDigest(repo), before, 'preview wrote the repository');
    const apply = await post(studio.port, '/api/control/apply', { command: 'work setup', args: [], flags: { scope: 'handbook', path: 'handbook', kind: 'document' }, digest: plan.digest }, studio.cookie);
    assert.equal(apply.status, 200, apply.body);
    assert.ok((await readFile(join(repo, 'simt.json'), 'utf8')).length > 0);
    const undoPreview = await post(studio.port, '/api/control/preview', { command: 'undo', args: [], flags: {} }, studio.cookie);
    assert.equal(undoPreview.status, 200, undoPreview.body);
    const undoPlan = JSON.parse(undoPreview.body);
    const undo = await post(studio.port, '/api/control/apply', { command: 'undo', args: [], flags: {}, digest: undoPlan.digest }, studio.cookie);
    assert.equal(undo.status, 200, undo.body);
    await assert.rejects(() => readFile(join(repo, 'simt.json')), /ENOENT/);
    assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), files['README.md'], 'undo did not restore the tracked bytes');
  }
});
