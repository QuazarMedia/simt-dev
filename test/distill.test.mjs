// The distiller (plan 0003 R38, ADR-090, ADR-075).
//
// Verifies:
//   1. The deterministic outline engine: heading skeleton plus the first content
//      of each section, cut to the budget, every line citing its source line —
//      byte-stable across calls and cheaper than the source it compresses.
//   2. `simt distill <skill|doc>` writes the proposal to `.simt/distilled/`
//      with provenance frontmatter, never reads a socket with `--local` absent,
//      and never touches the source it distilled.
//   3. `--local` proposes from the configured chat model, refuses to run without
//      one, verifies the model's citations against the source it numbered, and
//      records `verified: false` instead of trusting fabricated line ranges.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  ENGINE_OUTLINE,
  buildLocalPrompt,
  digestOf,
  outlineSummary,
  proposalFrontmatter,
  promptHash,
  sourceDigest,
  verifyCitations,
} from '../src/distill/engine.mjs';
import { distillTarget } from '../src/distill/distill.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt-dev.mjs');
const exec = promisify(execFile);

process.env.SIMT_DEV_WORKSPACE = 'off';
process.env.NO_COLOR = '1';

async function runCli(args, env = {}) {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args], {
      maxBuffer: 16 << 20,
      env: { ...process.env, NO_COLOR: '1', SIMT_DEV_WORKSPACE: 'off', ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function withNoSocketAllowed(fn) {
  let connectAttempts = 0;
  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    connectAttempts += 1;
    throw new Error(`unexpected socket connect attempt (${connectAttempts})`);
  };
  try {
    const res = await fn();
    assert.equal(connectAttempts, 0, `expected 0 socket connections, saw ${connectAttempts}`);
    return res;
  } finally {
    net.Socket.prototype.connect = origConnect;
  }
}

/** A scratch repo root holding docs/notes.md, removed when the test ends. */
const DOC = [
  '# Notes',
  '',
  '## Setup',
  'Run npm install before anything else.',
  '',
  '## Gates',
  'The gate fails the push, never the commit.',
  'Remedies name a command the reader can run.',
  '',
  '## Field: no heading content below this line',
];

async function scratchDocRoot() {
  const root = await mkdtemp(join(tmpdir(), 'simt-distill-'));
  process.once('exit', () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', 'notes.md'), `${DOC.join('\n')}\n`);
  return root;
}

// --- engine -------------------------------------------------------------------

const SOURCE = `# Setup
Run npm install.

## Gates
The gate fails the push.
 remedies name a command.
`;

test('R38: the outline engine picks headings plus the first content under each', () => {
  const { body } = outlineSummary(SOURCE, 0);
  const lines = body.split('\n');
  assert.equal(lines.length, 4, body);
  assert.match(lines[0], /^>\[L1\] # Setup$/);
  assert.match(lines[1], /^>\[L2\] Run npm install\.$/);
  assert.match(lines[2], /^>\[L4\] ## Gates$/);
  assert.match(lines[3], /^>\[L5\] The gate fails the push\.$/);

  const check = verifyCitations(body, SOURCE.split('\n').length);
  assert.deepEqual(check.faults, []);
  assert.ok(check.ok);
});

test('R38: the outline engine is byte-stable and enforces its budget', () => {
  const a = outlineSummary(SOURCE, 64);
  const b = outlineSummary(SOURCE, 64);
  assert.equal(a.body, b.body);
  const bytes = Buffer.byteLength(a.body, 'utf8');
  assert.ok(bytes <= 64, `body is ${bytes} bytes against 64`);
  assert.ok(bytes < Buffer.byteLength(SOURCE) - 0, 'a distillation that is not smaller is not a distillation');

  // 0 means unlimited: the whole skeleton renders.
  assert.ok(outlineSummary(SOURCE, 0).body.length >= a.body.length);
});

test('R38: the outline engine survives a heading-less doc and a fence toggle', () => {
  const fenced = 'text before\n```\nnot a heading # No\n```\nfirst content line';
  const { body } = outlineSummary(fenced, 0);
  // No headings: the first unfenced content line is the anchor, and fenced text
  // is never picked (a fence's content is code, not a claim).
  assert.match(body, /^>\[L1\] text before$/m, body);
  assert.ok(!body.includes('not a heading # No'), body);
});

test('R38: verifyCitations rejects fabricated and reversed ranges', () => {
  assert.deepEqual(verifyCitations('fine [L1] here', 3).faults, []);
  assert.deepEqual(verifyCitations('range [L1-L3] ok', 3).faults, []);
  const bad = verifyCitations('past [L9] end', 3);
  assert.equal(bad.ok, false);
  assert.match(bad.faults[0], /outside the source/);
  assert.equal(verifyCitations('backwards [L3-L1]', 3).ok, false);
});

test('R38: digests bind the recipe, the source digest does not', () => {
  const engine = ENGINE_OUTLINE;
  assert.notEqual(digestOf(SOURCE, engine, 512), digestOf(SOURCE, engine, 1024));
  assert.notEqual(digestOf(SOURCE, engine, 512), digestOf(SOURCE, 'local', 512));
  assert.equal(sourceDigest(SOURCE), sourceDigest(SOURCE));
  assert.notEqual(sourceDigest(SOURCE), sourceDigest(`${SOURCE}x`));
});

test('R38: the local prompt numbers the source lines it asks the model to cite', () => {
  const prompt = buildLocalPrompt('docs/notes.md', SOURCE, 512);
  assert.match(prompt, /^1: # Setup$/m);
  assert.match(prompt, /^2: Run npm install\.$/m);
  assert.match(prompt, /\[L12-L15\]/, 'the citation format must be shown to be corrected');
  const hash = promptHash(prompt);
  assert.match(hash, /^sha256-/);
  assert.equal(promptHash(prompt), promptHash(buildLocalPrompt('docs/notes.md', SOURCE, 512)));
});

// --- proposal artefact ---------------------------------------------------------

test('R38: the proposal frontmatter carries provenance and no wall-clock', () => {
  const fm = proposalFrontmatter({ source: 'docs/notes.md', digest: 'sha256-abc', engine: 'outline', budget: 512, verified: true });
  assert.match(fm, /^---\n/);
  assert.match(fm, /^source: docs\/notes\.md$/m);
  assert.match(fm, /^digest: sha256-abc$/m);
  assert.match(fm, /^engine: outline$/m);
  assert.match(fm, /^verified: true$/m);
  assert.match(fm, /^status: proposal$/m);
  assert.ok(!fm.match(/20\d\d/), `no date may appear: ${fm}`);
  const unverified = proposalFrontmatter({ source: 'a', digest: 'd', engine: 'e', budget: 1, verified: false });
  assert.match(unverified, /^verified: false$/m);
});

// --- command -------------------------------------------------------------------

test('R38: distill writes a proposal without opening a socket, and leaves the source alone', async () => {
  const root = await scratchDocRoot();
  const before = await readFile(join(root, 'docs', 'notes.md'), 'utf8');

  const result = await withNoSocketAllowed(() => distillTarget(['docs/notes.md'], { root, budget: 0 }));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.engine, ENGINE_OUTLINE);
  assert.equal(result.target.kind, 'doc');
  assert.equal(result.target.source, 'docs/notes.md');
  assert.ok(result.verified);
  assert.match(result.metric.note, /experimental/);

  const p = join(root, result.proposal.path);
  const proposal = await readFile(p, 'utf8');
  assert.match(proposal, /^source: docs\/notes\.md$/m);
  assert.match(proposal,/^engine: outline$/m);
  assert.match(proposal, /^verified: true$/m);
  assert.match(proposal, /^status: proposal$/m);
  // Every line says where it came from; none exist if the source did not.
  for (const line of proposal.split('\n').filter((l) => l.startsWith('>'))) {
    assert.match(line, /^>\[L\d+\] /, line);
  }

  // The cache is the answer: a repeated request re-reads the proposal instead of
  // deriving it again.
  const again = await distillTarget(['docs/notes.md'], { root, budget: 0 });
  assert.equal(again.proposal.state, 'cached');
  const refreshed = await distillTarget(['docs/notes.md'], { root, budget: 0, refresh: true });
  assert.equal(refreshed.proposal.state, 'fresh');
  assert.equal((await readFile(p, 'utf8')), proposal, 'a refresh of unchanged source must be byte-identical');

  assert.equal(await readFile(join(root, 'docs', 'notes.md'), 'utf8'), before, 'the source is not the distiller to edit');
});

test('R38: the budget decides what the outline carries', async () => {
  const root = await scratchDocRoot();
  const result = await distillTarget(['docs/notes.md'], { root, budget: 96 });
  const proposal = await readFile(join(root, result.proposal.path), 'utf8');
  const body = proposal.slice(proposal.indexOf('\n\n') + 2);
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  assert.ok(bodyBytes <= 96, `body is ${bodyBytes} bytes against 96`);
  assert.ok(result.citations < 8, `a 96-byte budget cannot carry the whole skeleton (${result.citations})`);
});

test('R38: an unknown name is a failure that names what would resolve it', async () => {
  const root = await scratchDocRoot();
  const { code, stderr } = await runCli(['distill', 'no-such-thing', '--root', root]);
  assert.equal(code, 1);
  assert.match(stderr, /no skill named/);

  const missingUsage = await runCli(['distill']);
  assert.equal(missingUsage.code, 2);
});

test('R38: a path that escapes the root is refused', async () => {
  const root = await scratchDocRoot();
  const { code, stderr } = await runCli(['distill', '../outside.md', '--root', root]);
  assert.equal(code, 1, stderr);
  assert.match(stderr, /outside/);
});

// --- the local proposer ----------------------------------------------------------

async function startStubServer(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let jsonBody = null;
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        jsonBody = raw ? JSON.parse(raw) : null;
      } catch {
        jsonBody = null;
      }
      requests.push({ method: req.method, url: req.url, body: jsonBody });
      handler(req, res, jsonBody);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  return {
    requests,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

async function scratchLocalRoot(url, model = 'stub-model') {
  const root = await scratchDocRoot();
  await writeFile(
    join(root, 'simt.json'),
    `${JSON.stringify({ local: { chat: { url, model } } }, null, 2)}\n`,
  );
  return root;
}

test('R38: --local without a configured endpoint fails rather than silently outlining', async () => {
  const root = await scratchDocRoot();
  const { code, stderr } = await runCli(['distill', 'docs/notes.md', '--root', root, '--local']);
  assert.equal(code, 3, stderr);
  assert.match(stderr, /local chat endpoint/);
  assert.match(stderr, /without --local/);
});

test('R38: --local proposes from the configured model, citing checked line ranges', async () => {
  const server = await startStubServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'x',
      model: 'stub-model',
      choices: [{ message: { content: 'It demands node 22.\n[L2] "Run npm install." runs.\n[L7-L7] "The gate fails the push."' } }],
      usage: { total_tokens: 11 },
    }));
  });
  let root;
  let result;
  try {
    root = await scratchLocalRoot(server.baseUrl);
    const { code, stdout } = await runCli(['distill', 'docs/notes.md', '--root', root, '--local', '--json']);
    assert.equal(code, 0, stdout);
    result = JSON.parse(stdout);
    assert.match(result.engine, /^local:stub-model \(prompt sha256-/, result.engine);
    assert.ok(result.verified, stdout);
    const proposal = await readFile(join(root, result.proposal.path), 'utf8');
    assert.match(proposal, /^engine: local:stub-model \(prompt sha256-/m);
    assert.match(proposal, /\[L7-L7\]/m);
    assert.ok(result.citations >= 2, stdout);

    // The numbered source is in the prompt, or the model's citations are
    // uncheckable, which is the failure this command exists to prevent.
    const req = server.requests.find((r) => r.url.endsWith('/chat/completions'));
    assert.ok(req, 'expected a chat request');
    assert.equal(req.body.temperature, 0);
    assert.equal(req.body.stream, false);
    assert.match(req.body.messages[1].content, /\n1: # Notes\n/);
  } finally {
    await server.close();
  }
});

test('R38: a model citation past the end of the source is stored unverified', async () => {
  const server = await startStubServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'x',
      model: 'stub-model',
      choices: [{ message: { content: 'A claim nobody can check [L999].\n[L100-L102] invented range.' } }],
    }));
  });
  let root;
  try {
    root = await scratchLocalRoot(server.baseUrl);
    const { code, stdout } = await runCli(['distill', 'docs/notes.md', '--root', root, '--local', '--json']);
    assert.equal(code, 0, stdout);
    const result = JSON.parse(stdout);
    assert.equal(result.verified, false);
    assert.ok(result.faults.some((f) => f.includes('L999')), stdout);
    const proposal = await readFile(join(root, result.proposal.path), 'utf8');
    assert.match(proposal, /^verified: false$/m, 'an untrustworthy proposal must say so, not miss it');
  } finally {
    await server.close();
  }
});
