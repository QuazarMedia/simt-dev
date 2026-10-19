// Zero-dependency OpenAI-compatible client for local model servers (plan 0003 R37):
// Ollama, llama.cpp `llama-server`, LM Studio and MLX servers over `http://127.0.0.1:<port>/v1/...`.
//
// Two hard invariants (ADR-075, ADR-090):
//   1. When `local` is unset in the manifest, no socket is ever opened.
//   2. Non-loopback URLs are refused before any socket is opened unless `allowRemote`
//      (`--allow-remote`) is explicitly set.

import {
  DEFAULT_LOCAL_TIMEOUT_MS,
  isLoopbackUrl,
  parseLocalConfig,
  readLocalConfig,
  resolveEndpointUrl,
} from './config.mjs';

function guardEndpoint(endpoint, { allowRemote = false } = {}) {
  if (!endpoint || typeof endpoint !== 'object') {
    return { ok: false, error: 'local model endpoint is not configured', refusedRemote: false };
  }
  const rawUrl = typeof endpoint.url === 'string' ? endpoint.url.trim() : '';
  if (!rawUrl) {
    return { ok: false, error: 'local model endpoint is missing `url`', refusedRemote: false };
  }
  const model = typeof endpoint.model === 'string' ? endpoint.model.trim() : '';
  if (!model) {
    return { ok: false, error: 'local model endpoint is missing `model`', refusedRemote: false };
  }
  const loopback = isLoopbackUrl(rawUrl);
  if (!loopback && !allowRemote) {
    return {
      ok: false,
      refusedRemote: true,
      error: `refused non-loopback URL ${rawUrl} without --allow-remote (ADR-075)`,
    };
  }
  return {
    ok: true,
    url: rawUrl,
    baseUrl: resolveEndpointUrl(rawUrl, ''),
    model,
    timeoutMs: Number.isInteger(endpoint.timeoutMs) && endpoint.timeoutMs > 0
      ? endpoint.timeoutMs
      : DEFAULT_LOCAL_TIMEOUT_MS,
    loopback,
  };
}

async function requestJson(url, { method = 'GET', body = undefined, timeoutMs = DEFAULT_LOCAL_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    if (text.trim().length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!response.ok) {
      const serverMsg =
        parsed?.error?.message ??
        (typeof parsed?.error === 'string' ? parsed.error : null) ??
        (text.trim().slice(0, 160) || `HTTP ${response.status}`);
      return {
        ok: false,
        status: response.status,
        error: `${method} ${url} failed (${response.status}): ${serverMsg}`,
        socketOpened: true,
      };
    }
    if (parsed === null || typeof parsed !== 'object') {
      return {
        ok: false,
        status: response.status,
        error: `${method} ${url} returned non-JSON response`,
        socketOpened: true,
      };
    }
    return { ok: true, status: response.status, data: parsed, socketOpened: true };
  } catch (error) {
    const reason =
      error?.name === 'AbortError'
        ? `timed out after ${timeoutMs} ms`
        : error?.cause?.message ?? error?.message ?? String(error);
    return {
      ok: false,
      status: null,
      error: `${method} ${url} failed: ${reason}`,
      socketOpened: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Query `GET <baseUrl>/v1/models` on an OpenAI-compatible local server.
 */
export async function localModels(endpoint, { allowRemote = false, fetchImpl = globalThis.fetch } = {}) {
  const guard = guardEndpoint(endpoint, { allowRemote });
  if (!guard.ok) {
    return {
      ok: false,
      models: [],
      error: guard.error,
      refusedRemote: guard.refusedRemote,
      socketOpened: false,
    };
  }

  const targetUrl = resolveEndpointUrl(guard.baseUrl, '/models');
  const res = await requestJson(targetUrl, {
    method: 'GET',
    timeoutMs: guard.timeoutMs,
    fetchImpl,
  });
  if (!res.ok) {
    return {
      ok: false,
      models: [],
      status: res.status,
      error: res.error,
      refusedRemote: false,
      socketOpened: res.socketOpened,
    };
  }

  const rawList = Array.isArray(res.data.data)
    ? res.data.data
    : Array.isArray(res.data.models)
      ? res.data.models
      : [];
  const models = rawList
    .map((item) => (typeof item === 'string' ? item : item?.id ?? item?.name ?? ''))
    .map((id) => String(id).trim())
    .filter(Boolean);

  return {
    ok: true,
    models,
    status: res.status,
    error: null,
    refusedRemote: false,
    socketOpened: true,
  };
}

/**
 * Send a `POST <baseUrl>/v1/chat/completions` request to an OpenAI-compatible local server.
 */
export async function localChat(
  endpoint,
  {
    messages = undefined,
    prompt = '',
    system = undefined,
    temperature = 0,
    maxTokens = 256,
    allowRemote = false,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  const guard = guardEndpoint(endpoint, { allowRemote });
  if (!guard.ok) {
    return {
      ok: false,
      content: null,
      model: endpoint?.model ?? null,
      usage: null,
      error: guard.error,
      refusedRemote: guard.refusedRemote,
      socketOpened: false,
    };
  }

  const chatMessages = Array.isArray(messages) && messages.length > 0
    ? messages
    : [
        ...(system ? [{ role: 'system', content: String(system) }] : []),
        { role: 'user', content: String(prompt) },
      ];

  const targetUrl = resolveEndpointUrl(guard.baseUrl, '/chat/completions');
  const res = await requestJson(targetUrl, {
    method: 'POST',
    body: {
      model: guard.model,
      messages: chatMessages,
      temperature,
      ...(Number.isInteger(maxTokens) && maxTokens > 0 ? { max_tokens: maxTokens } : {}),
      stream: false,
    },
    timeoutMs: guard.timeoutMs,
    fetchImpl,
  });

  if (!res.ok) {
    return {
      ok: false,
      content: null,
      model: guard.model,
      usage: null,
      error: res.error,
      refusedRemote: false,
      socketOpened: res.socketOpened,
    };
  }

  const choice = Array.isArray(res.data.choices) ? res.data.choices[0] : null;
  const content =
    typeof choice?.message?.content === 'string'
      ? choice.message.content
      : typeof choice?.text === 'string'
        ? choice.text
        : null;

  if (content === null) {
    return {
      ok: false,
      content: null,
      model: guard.model,
      usage: null,
      error: `POST ${targetUrl} returned no choice content`,
      refusedRemote: false,
      socketOpened: true,
    };
  }

  return {
    ok: true,
    content,
    model: typeof res.data.model === 'string' ? res.data.model : guard.model,
    usage: res.data.usage ?? null,
    error: null,
    refusedRemote: false,
    socketOpened: true,
  };
}

/**
 * Send a `POST <baseUrl>/v1/embeddings` request to an OpenAI-compatible local server.
 */
export async function localEmbed(
  endpoint,
  { input, allowRemote = false, fetchImpl = globalThis.fetch } = {},
) {
  const guard = guardEndpoint(endpoint, { allowRemote });
  if (!guard.ok) {
    return {
      ok: false,
      embeddings: [],
      dimensions: 0,
      model: endpoint?.model ?? null,
      usage: null,
      error: guard.error,
      refusedRemote: guard.refusedRemote,
      socketOpened: false,
    };
  }

  const targetUrl = resolveEndpointUrl(guard.baseUrl, '/embeddings');
  const res = await requestJson(targetUrl, {
    method: 'POST',
    body: {
      model: guard.model,
      input: Array.isArray(input) ? input.map(String) : String(input ?? ''),
    },
    timeoutMs: guard.timeoutMs,
    fetchImpl,
  });

  if (!res.ok) {
    return {
      ok: false,
      embeddings: [],
      dimensions: 0,
      model: guard.model,
      usage: null,
      error: res.error,
      refusedRemote: false,
      socketOpened: res.socketOpened,
    };
  }

  const rawVectors = Array.isArray(res.data.data)
    ? res.data.data.map((entry) => entry?.embedding)
    : Array.isArray(res.data.embeddings)
      ? res.data.embeddings
      : Array.isArray(res.data.embedding)
        ? [res.data.embedding]
        : [];

  const validVectors = rawVectors.filter(
    (vec) => Array.isArray(vec) && vec.length > 0 && vec.every((n) => typeof n === 'number' && Number.isFinite(n)),
  );

  if (validVectors.length === 0) {
    return {
      ok: false,
      embeddings: [],
      dimensions: 0,
      model: guard.model,
      usage: null,
      error: `POST ${targetUrl} returned no valid embedding vector`,
      refusedRemote: false,
      socketOpened: true,
    };
  }

  return {
    ok: true,
    embeddings: validVectors,
    dimensions: validVectors[0].length,
    model: typeof res.data.model === 'string' ? res.data.model : guard.model,
    usage: res.data.usage ?? null,
    error: null,
    refusedRemote: false,
    socketOpened: true,
  };
}

function summarizeBlockedEndpoint(endpoint) {
  if (!endpoint) return null;
  return {
    role: endpoint.role,
    configured: true,
    ok: false,
    status: endpoint.blocked ? 'refused-remote' : 'skipped',
    url: endpoint.baseUrl,
    model: endpoint.model,
    loopback: endpoint.loopback,
    error: endpoint.blocked
      ? `refused non-loopback URL ${endpoint.url} without --allow-remote (ADR-075)`
      : 'skipped due to configuration errors',
  };
}

/**
 * Probe the capabilities of the repository's configured local model endpoints (`simt local doctor`).
 *
 * When `local` is unset in the manifest, returns `status: 'unconfigured'` with
 * `socketsOpened: 0` without calling `fetchImpl`. When any endpoint is non-loopback
 * and `allowRemote` is false, refuses with `status: 'refused-remote'` and `socketsOpened: 0`.
 */
export async function probeLocal(
  root,
  { manifest = undefined, allowRemote = false, fetchImpl = globalThis.fetch } = {},
) {
  const config =
    manifest !== undefined
      ? { ...parseLocalConfig(manifest, { allowRemote }), manifestExists: true, manifestError: null }
      : await readLocalConfig(root, { allowRemote });

  if (config.manifestError !== null) {
    return {
      ok: false,
      configured: false,
      status: 'invalid-manifest',
      allowRemote,
      remoteBlocked: false,
      socketsOpened: 0,
      chat: null,
      embed: null,
      findings: config.findings,
    };
  }

  if (!config.configured) {
    return {
      ok: true,
      configured: false,
      status: 'unconfigured',
      allowRemote,
      remoteBlocked: false,
      socketsOpened: 0,
      chat: null,
      embed: null,
      findings: [],
    };
  }

  if (config.findings.length > 0) {
    return {
      ok: false,
      configured: true,
      status: config.remoteBlocked ? 'refused-remote' : 'invalid-config',
      allowRemote,
      remoteBlocked: config.remoteBlocked,
      socketsOpened: 0,
      chat: summarizeBlockedEndpoint(config.chat),
      embed: summarizeBlockedEndpoint(config.embed),
      findings: config.findings,
    };
  }

  let socketsOpened = 0;
  const findings = [];
  let chatReport = null;
  let embedReport = null;

  if (config.chat) {
    const modelsRes = await localModels(config.chat, { allowRemote, fetchImpl });
    if (modelsRes.socketOpened) socketsOpened += 1;
    const chatRes = await localChat(config.chat, {
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 1,
      temperature: 0,
      allowRemote,
      fetchImpl,
    });
    if (chatRes.socketOpened) socketsOpened += 1;

    if (!chatRes.ok) findings.push(`chat probe failed: ${chatRes.error}`);

    chatReport = {
      role: 'chat',
      configured: true,
      ok: chatRes.ok,
      status: chatRes.ok ? 'ok' : 'unreachable',
      url: config.chat.baseUrl,
      model: config.chat.model,
      responseModel: chatRes.ok ? chatRes.model : null,
      loopback: config.chat.loopback,
      modelListed: modelsRes.ok ? modelsRes.models.includes(config.chat.model) : null,
      models: modelsRes.ok ? modelsRes.models : [],
      error: chatRes.ok ? null : chatRes.error,
    };
  }

  if (config.embed) {
    const modelsRes = await localModels(config.embed, { allowRemote, fetchImpl });
    if (modelsRes.socketOpened) socketsOpened += 1;
    const embedRes = await localEmbed(config.embed, {
      input: 'ping',
      allowRemote,
      fetchImpl,
    });
    if (embedRes.socketOpened) socketsOpened += 1;

    if (!embedRes.ok) findings.push(`embed probe failed: ${embedRes.error}`);

    embedReport = {
      role: 'embed',
      configured: true,
      ok: embedRes.ok,
      status: embedRes.ok ? 'ok' : 'unreachable',
      url: config.embed.baseUrl,
      model: config.embed.model,
      responseModel: embedRes.ok ? embedRes.model : null,
      loopback: config.embed.loopback,
      modelListed: modelsRes.ok ? modelsRes.models.includes(config.embed.model) : null,
      models: modelsRes.ok ? modelsRes.models : [],
      dimensions: embedRes.ok ? embedRes.dimensions : null,
      error: embedRes.ok ? null : embedRes.error,
    };
  }

  const ok =
    (chatReport === null || chatReport.ok) &&
    (embedReport === null || embedReport.ok);

  return {
    ok,
    configured: true,
    status: ok ? 'ok' : 'unreachable',
    allowRemote,
    remoteBlocked: false,
    socketsOpened,
    chat: chatReport,
    embed: embedReport,
    findings,
  };
}
