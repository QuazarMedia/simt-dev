// Local model adapter (plan 0003 R37, ADR-075, ADR-090).
//
// Verifies:
//   1. When `local` is unset in `simt.json` / `simt-dev.json`, no socket is ever opened.
//   2. Non-loopback URLs are refused without `--allow-remote` before any socket is opened.
//   3. OpenAI-compatible client (`localModels`, `localChat`, `localEmbed`, `probeLocal`)
//      and `simt local doctor` pass against a stub server (Ollama, llama.cpp `llama-server`,
//      LM Studio, MLX shapes).

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  DEFAULT_LOCAL_TIMEOUT_MS,
  isLoopbackHost,
  isLoopbackUrl,
  parseLocalConfig,
  readLocalConfig,
  resolveEndpointUrl,
} from '../src/local/config.mjs';
import { localChat, localEmbed, localModels, probeLocal } from '../src/local/client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt.mjs');
const exec = promisify(execFile);

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

async function startStubServer(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let jsonBody = null;
      try {
        jsonBody = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        jsonBody = null;
      }
      requests.push({ method: req.method, url: req.url, body: jsonBody });
      handler(req, res, jsonBody);
    });
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    port: addr.port,
    requests,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

test('R37: isLoopbackHost, isLoopbackUrl, and resolveEndpointUrl validate and normalise endpoints', () => {
  assert.equal(DEFAULT_LOCAL_TIMEOUT_MS, 5000);

  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('127.255.0.9'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('ollama.localhost'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('[::1]'), true);

  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('192.168.1.20'), false);
  assert.equal(isLoopbackHost('api.openai.com'), false);

  assert.equal(isLoopbackUrl('http://127.0.0.1:11434/v1'), true);
  assert.equal(isLoopbackUrl('http://localhost:8080'), true);
  assert.equal(isLoopbackUrl('http://[::1]:1234/v1'), true);
  assert.equal(isLoopbackUrl('http://127.0.0.1@evil.example.com/v1'), false);
  assert.equal(isLoopbackUrl('https://api.example.com/v1'), false);
  assert.equal(isLoopbackUrl('ws://127.0.0.1:11434/v1'), false);

  assert.equal(resolveEndpointUrl('http://127.0.0.1:11434', '/models'), 'http://127.0.0.1:11434/v1/models');
  assert.equal(resolveEndpointUrl('http://127.0.0.1:11434/v1', '/chat/completions'), 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(resolveEndpointUrl('http://127.0.0.1:11434/v1/', '/v1/embeddings'), 'http://127.0.0.1:11434/v1/embeddings');
});

test('R37: with `local` unset, no socket is ever opened', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'simt-local-unset-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(join(root, 'simt.json'), `${JSON.stringify({ id: 'unset-repo', stack: ['node'] }, null, 2)}\n`);

  const throwingFetch = () => {
    throw new Error('fetch must not be called when local is unset');
  };

  await withNoSocketAllowed(async () => {
    const cfg = await readLocalConfig(root);
    assert.equal(cfg.configured, false);
    assert.equal(cfg.chat, null);
    assert.equal(cfg.embed, null);
    assert.deepEqual(cfg.findings, []);

    const probe = await probeLocal(root, { fetchImpl: throwingFetch });
    assert.equal(probe.ok, true);
    assert.equal(probe.configured, false);
    assert.equal(probe.status, 'unconfigured');
    assert.equal(probe.socketsOpened, 0);

    const chatRes = await localChat(null, { prompt: 'hello', fetchImpl: throwingFetch });
    assert.equal(chatRes.ok, false);
    assert.equal(chatRes.socketOpened, false);

    const embedRes = await localEmbed(null, { input: 'hello', fetchImpl: throwingFetch });
    assert.equal(embedRes.ok, false);
    assert.equal(embedRes.socketOpened, false);

    const modelsRes = await localModels(null, { fetchImpl: throwingFetch });
    assert.equal(modelsRes.ok, false);
    assert.equal(modelsRes.socketOpened, false);
  });

  const cliText = await runCli(['local', 'doctor', '--root', root]);
  assert.equal(cliText.code, 0, cliText.stderr);
  assert.match(cliText.stdout, /local\s+\(unset\)\s+optional adapter is off; no socket opened/);
  assert.match(cliText.stdout, /sockets\s+0/);

  const cliDefaultGroup = await runCli(['local', '--root', root, '--json']);
  assert.equal(cliDefaultGroup.code, 0, cliDefaultGroup.stderr);
  const payload = JSON.parse(cliDefaultGroup.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.configured, false);
  assert.equal(payload.socketsOpened, 0);
});

test('R37: non-loopback URLs are refused without --allow-remote and open no socket', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'simt-local-remote-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const manifest = {
    id: 'remote-repo',
    local: {
      chat: { url: 'https://models.example.com/v1', model: 'qwen2.5-coder:7b' },
      embed: { url: 'http://192.0.2.55:11434/v1', model: 'nomic-embed-code' },
    },
  };
  await writeFile(join(root, 'simt-dev.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const throwingFetch = () => {
    throw new Error('fetch must not be called when non-loopback URL is refused');
  };

  await withNoSocketAllowed(async () => {
    const parsed = parseLocalConfig(manifest, { allowRemote: false });
    assert.equal(parsed.configured, true);
    assert.equal(parsed.remoteBlocked, true);
    assert.equal(parsed.findings.length, 2);

    const probe = await probeLocal(root, { allowRemote: false, fetchImpl: throwingFetch });
    assert.equal(probe.ok, false);
    assert.equal(probe.status, 'refused-remote');
    assert.equal(probe.remoteBlocked, true);
    assert.equal(probe.socketsOpened, 0);
    assert.equal(probe.chat.status, 'refused-remote');
    assert.equal(probe.embed.status, 'refused-remote');

    const directChat = await localChat(
      { url: 'https://models.example.com/v1', model: 'qwen2.5-coder:7b' },
      { prompt: 'hi', allowRemote: false, fetchImpl: throwingFetch },
    );
    assert.equal(directChat.ok, false);
    assert.equal(directChat.refusedRemote, true);
    assert.equal(directChat.socketOpened, false);

    const directEmbed = await localEmbed(
      { url: 'http://192.0.2.55:11434/v1', model: 'nomic-embed-code' },
      { input: 'hi', allowRemote: false, fetchImpl: throwingFetch },
    );
    assert.equal(directEmbed.ok, false);
    assert.equal(directEmbed.refusedRemote, true);
    assert.equal(directEmbed.socketOpened, false);
  });

  const refusedCli = await runCli(['local', 'doctor', '--root', root, '--json']);
  assert.equal(refusedCli.code, 3);
  const refusedPayload = JSON.parse(refusedCli.stdout);
  assert.equal(refusedPayload.ok, false);
  assert.equal(refusedPayload.status, 'refused-remote');
  assert.equal(refusedPayload.socketsOpened, 0);
  assert.match(refusedPayload.error, /not a loopback address/);
  assert.match(refusedPayload.remedy, /--allow-remote/);

  // With allowRemote: true, the remote guard lifts and the client uses fetchImpl.
  let fetchCalls = 0;
  const stubRemoteFetch = async (url) => {
    fetchCalls += 1;
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen2.5-coder:7b' }, { id: 'nomic-embed-code' }] }), {
        status: 200,
      });
    }
    if (url.endsWith('/v1/chat/completions')) {
      return new Response(
        JSON.stringify({ model: 'qwen2.5-coder:7b', choices: [{ message: { content: 'pong' } }] }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({ model: 'nomic-embed-code', data: [{ embedding: [0.1, 0.2, 0.3] }] }),
      { status: 200 },
    );
  };

  const allowedProbe = await probeLocal(root, { allowRemote: true, fetchImpl: stubRemoteFetch });
  assert.equal(allowedProbe.ok, true);
  assert.equal(allowedProbe.status, 'ok');
  assert.equal(allowedProbe.socketsOpened, 4);
  assert.equal(fetchCalls, 4);
});

test('R37: local client and `simt local doctor` pass against a stub OpenAI-compatible server', async (t) => {
  const stub = await startStubServer((req, res, body) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'qwen2.5-coder:7b' }, { id: 'nomic-embed-code' }],
        }),
      );
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-stub-1',
          model: body?.model ?? 'qwen2.5-coder:7b',
          choices: [{ index: 0, message: { role: 'assistant', content: `ack:${body?.messages?.[0]?.content ?? ''}` } }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        }),
      );
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/embeddings') {
      const inputs = Array.isArray(body?.input) ? body.input : [body?.input ?? ''];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          model: body?.model ?? 'nomic-embed-code',
          data: inputs.map((_, index) => ({
            object: 'embedding',
            index,
            embedding: [0.25, -0.5, 0.75, 1.0],
          })),
          usage: { prompt_tokens: 3, total_tokens: 3 },
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `not found: ${req.url}` } }));
  });
  t.after(() => stub.close());

  const root = await mkdtemp(join(tmpdir(), 'simt-local-stub-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  // Configure chat without `/v1` suffix and embed with `/v1` suffix to test both forms.
  await writeFile(
    join(root, 'simt.json'),
    `${JSON.stringify(
      {
        id: 'stub-repo',
        local: {
          chat: { url: stub.baseUrl, model: 'qwen2.5-coder:7b' },
          embed: { url: `${stub.baseUrl}/v1`, model: 'nomic-embed-code' },
        },
      },
      null,
      2,
    )}\n`,
  );

  // 1. Direct client calls against the stub server.
  const cfg = await readLocalConfig(root);
  assert.equal(cfg.configured, true);
  assert.deepEqual(cfg.findings, []);

  const modelsRes = await localModels(cfg.chat);
  assert.equal(modelsRes.ok, true);
  assert.deepEqual(modelsRes.models, ['qwen2.5-coder:7b', 'nomic-embed-code']);

  const chatRes = await localChat(cfg.chat, { prompt: 'summarise skill' });
  assert.equal(chatRes.ok, true);
  assert.equal(chatRes.content, 'ack:summarise skill');
  assert.equal(chatRes.model, 'qwen2.5-coder:7b');
  assert.equal(chatRes.usage.total_tokens, 6);

  const embedRes = await localEmbed(cfg.embed, { input: ['chunk one', 'chunk two'] });
  assert.equal(embedRes.ok, true);
  assert.equal(embedRes.dimensions, 4);
  assert.equal(embedRes.embeddings.length, 2);
  assert.deepEqual(embedRes.embeddings[0], [0.25, -0.5, 0.75, 1.0]);

  // 2. CLI `simt local doctor` in text and JSON modes against the stub server.
  const doctorText = await runCli(['local', 'doctor', '--root', root]);
  assert.equal(doctorText.code, 0, doctorText.stderr);
  assert.match(doctorText.stdout, /local\s+ok/);
  assert.match(doctorText.stdout, /chat\s+ok\s+qwen2\.5-coder:7b/);
  assert.match(doctorText.stdout, /embed\s+ok\s+nomic-embed-code.*dimensions=4/);
  assert.match(doctorText.stdout, /sockets\s+4/);

  const doctorJson = await runCli(['local', 'doctor', '--root', root, '--json']);
  assert.equal(doctorJson.code, 0, doctorJson.stderr);
  const payload = JSON.parse(doctorJson.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.status, 'ok');
  assert.equal(payload.socketsOpened, 4);
  assert.equal(payload.chat.ok, true);
  assert.equal(payload.chat.modelListed, true);
  assert.equal(payload.embed.ok, true);
  assert.equal(payload.embed.dimensions, 4);
  assert.equal(payload.embed.modelListed, true);
});

test('R37: malformed config and unreachable servers report clear remedies', async (t) => {
  const broken = parseLocalConfig({
    local: {
      chat: { url: 'ftp://127.0.0.1:11434', model: '' },
      embed: { url: 'http://127.0.0.1:11434/v1', model: 'embed-1', timeoutMs: 0 },
      extraRole: {},
    },
  });
  assert.equal(broken.configured, true);
  assert.ok(broken.findings.some((f) => f.includes('extraRole')));
  assert.ok(broken.findings.some((f) => f.includes('http:// or https://')));
  assert.ok(broken.findings.some((f) => f.includes('timeoutMs')));

  // Stub server that returns 404 on /v1/models, text completion on chat, and times out on slow route.
  const stub = await startStubServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'models endpoint disabled' }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'model runner crashed' } }));
      return;
    }
    if (req.url === '/slow/v1/chat/completions') {
      // Never responds within timeoutMs.
      return;
    }
    res.writeHead(500);
    res.end();
  });
  t.after(() => stub.close());

  const timedOut = await localChat(
    { url: `${stub.baseUrl}/slow`, model: 'llama-local', timeoutMs: 120 },
    { prompt: 'ping' },
  );
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.error, /timed out after 120 ms/);

  const root = await mkdtemp(join(tmpdir(), 'simt-local-fail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, 'simt.json'),
    `${JSON.stringify(
      {
        id: 'fail-repo',
        local: {
          chat: { url: stub.baseUrl, model: 'broken-model' },
        },
      },
      null,
      2,
    )}\n`,
  );

  const failedCli = await runCli(['local', 'doctor', '--root', root, '--json']);
  assert.equal(failedCli.code, 1);
  const failedPayload = JSON.parse(failedCli.stdout);
  assert.equal(failedPayload.ok, false);
  assert.equal(failedPayload.status, 'unreachable');
  assert.match(failedPayload.error, /model runner crashed/);
  assert.match(failedPayload.remedy, /local doctor/);
});

test('R37: optional apiKey is parsed, validated, and defaults to absent', () => {
  const withKey = parseLocalConfig({ local: { chat: { url: 'http://127.0.0.1:8000/v1', model: 'm', apiKey: 'sk-test' } } });
  assert.equal(withKey.configured, true);
  assert.deepEqual(withKey.findings, []);
  assert.equal(withKey.chat.apiKey, 'sk-test');

  const withoutKey = parseLocalConfig({ local: { chat: { url: 'http://127.0.0.1:8000/v1', model: 'm' } } });
  assert.deepEqual(withoutKey.findings, []);
  assert.equal(withoutKey.chat.apiKey, '');

  const empty = parseLocalConfig({ local: { chat: { url: 'http://127.0.0.1:8000/v1', model: 'm', apiKey: '' } } });
  assert.ok(empty.findings.some((f) => f.includes('apiKey')));

  const notString = parseLocalConfig({ local: { chat: { url: 'http://127.0.0.1:8000/v1', model: 'm', apiKey: 123 } } });
  assert.ok(notString.findings.some((f) => f.includes('apiKey')));
});

test('R37: apiKey is sent as a Bearer header when set, and omitted when unset', async (t) => {
  const seenAuth = [];
  const stub = await startStubServer((req, res) => {
    seenAuth.push(req.headers.authorization ?? null);
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'm', choices: [{ message: { content: 'pong' } }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ embedding: [1, 2] }] }));
  });
  t.after(() => stub.close());

  const withKey = await localChat({ url: stub.baseUrl, model: 'm', apiKey: 'sk-secret' }, { prompt: 'hi' });
  assert.equal(withKey.ok, true);

  const withoutKey = await localChat({ url: stub.baseUrl, model: 'm' }, { prompt: 'hi' });
  assert.equal(withoutKey.ok, true);

  assert.equal(seenAuth.length, 2);
  assert.equal(seenAuth[0], 'Bearer sk-secret');
  assert.equal(seenAuth[1], null);
});

test('R37: doctor remedy distinguishes an unauthorised server from a down one', async (t) => {
  const authStub = await startStubServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'API key required' } }));
  });
  t.after(() => authStub.close());

  const authRoot = await mkdtemp(join(tmpdir(), 'simt-local-auth-'));
  t.after(() => rm(authRoot, { recursive: true, force: true }));
  await writeFile(
    join(authRoot, 'simt.json'),
    `${JSON.stringify({ id: 'auth-repo', local: { chat: { url: authStub.baseUrl, model: 'm' } } }, null, 2)}\n`,
  );

  const authCli = await runCli(['local', 'doctor', '--root', authRoot, '--json']);
  assert.equal(authCli.code, 1);
  const authPayload = JSON.parse(authCli.stdout);
  assert.equal(authPayload.status, 'unreachable');
  assert.match(authPayload.remedy, /apiKey/);
  assert.doesNotMatch(authPayload.remedy, /start the local model server/);

  const downStub = await startStubServer((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'internal error' } }));
  });
  t.after(() => downStub.close());

  const downRoot = await mkdtemp(join(tmpdir(), 'simt-local-down-'));
  t.after(() => rm(downRoot, { recursive: true, force: true }));
  await writeFile(
    join(downRoot, 'simt.json'),
    `${JSON.stringify({ id: 'down-repo', local: { chat: { url: downStub.baseUrl, model: 'm' } } }, null, 2)}\n`,
  );

  const downCli = await runCli(['local', 'doctor', '--root', downRoot, '--json']);
  const downPayload = JSON.parse(downCli.stdout);
  assert.equal(downPayload.status, 'unreachable');
  assert.match(downPayload.remedy, /start the local model server/);
});

test('R37: reasoning models are handled — content falls back to reasoning_content', async (t) => {
  const stub = await startStubServer((req, res, body) => {
    if (req.url === '/v1/chat/completions') {
      const prompt = body?.messages?.[0]?.content ?? '';
      if (prompt === 'reasoning-only') {
        // Tiny budget: content absent, output in reasoning_content.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: 'm', choices: [{ index: 0, message: { role: 'assistant', reasoning_content: 'The' } }] }));
        return;
      }
      if (prompt === 'empty') {
        // No content, no reasoning, no text -> still an error.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: 'm', choices: [{ index: 0, message: { role: 'assistant' } }] }));
        return;
      }
      // Normal: both present, the final answer must win.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'final', reasoning_content: 'thinking...' } }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ embedding: [1] }] }));
  });
  t.after(() => stub.close());

  const fallback = await localChat({ url: stub.baseUrl, model: 'm' }, { prompt: 'reasoning-only' });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.content, 'The');

  const preferred = await localChat({ url: stub.baseUrl, model: 'm' }, { prompt: 'normal' });
  assert.equal(preferred.ok, true);
  assert.equal(preferred.content, 'final');

  const empty = await localChat({ url: stub.baseUrl, model: 'm' }, { prompt: 'empty' });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /no choice content/);
});
