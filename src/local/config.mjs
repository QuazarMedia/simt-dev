// Local model configuration in `simt.json` / `simt-dev.json` (plan 0003 R37, ADR-075, ADR-090).
//
// Local models are optional and off by default. When `local` is absent from the manifest,
// no socket is ever opened. When configured:
//
//   "local": {
//     "chat":  { "url": "http://127.0.0.1:11434/v1", "model": "qwen2.5-coder:7b" },
//     "embed": { "url": "http://127.0.0.1:11434/v1", "model": "nomic-embed-code" }
//   }
//
// Non-loopback URLs are refused unless `--allow-remote` is explicitly passed (ADR-075).

import { EXIT, fail } from '../output/index.mjs';
import { MANIFEST_FILE } from '../name.mjs';
import { readManifest } from '../projection/manifest.mjs';

/** Default per-request timeout for local model probes and requests, in milliseconds. */
export const DEFAULT_LOCAL_TIMEOUT_MS = 5000;

const ROLES = ['chat', 'embed'];

const IPV4_LOOPBACK = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/**
 * Whether a parsed URL hostname resolves strictly to the local loopback interface.
 *
 * Accepts `localhost` (and `*.localhost`), IPv4 `127.0.0.0/8`, and IPv6 `::1`.
 * Wildcard bind addresses (`0.0.0.0`, `::`) and LAN/remote hosts return false.
 */
export function isLoopbackHost(hostname) {
  if (typeof hostname !== 'string') return false;
  const clean = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!clean) return false;
  if (clean === 'localhost' || clean.endsWith('.localhost')) return true;
  if (IPV4_LOOPBACK.test(clean)) return true;
  if (clean === '::1' || clean === '0:0:0:0:0:0:0:1') return true;
  return false;
}

/**
 * Whether a URL string is a valid HTTP(S) loopback URL with no embedded credentials.
 */
export function isLoopbackUrl(urlString) {
  if (typeof urlString !== 'string' || urlString.trim().length === 0) return false;
  let parsed;
  try {
    parsed = new URL(urlString.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  return isLoopbackHost(parsed.hostname);
}

/**
 * Normalise an OpenAI-compatible base URL and append an endpoint path under `/v1`.
 *
 * Accepts base URLs written either with or without a trailing `/v1` (for example
 * `http://127.0.0.1:11434` or `http://127.0.0.1:11434/v1`) so Ollama, llama.cpp
 * `llama-server`, LM Studio and MLX configs work identically.
 */
export function resolveEndpointUrl(baseUrl, endpointPath = '') {
  const trimmedBase = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  const baseWithV1 = trimmedBase.endsWith('/v1') ? trimmedBase : `${trimmedBase}/v1`;
  const cleanPath = String(endpointPath ?? '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/^v1(?:\/+|$)/, '');
  return cleanPath ? `${baseWithV1}/${cleanPath}` : baseWithV1;
}

function parseEndpoint(role, entry, { allowRemote = false } = {}) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return { endpoint: null, finding: `\`local.${role}\` must be an object with \`url\` and \`model\`` };
  }

  const rawUrl = typeof entry.url === 'string' ? entry.url.trim() : '';
  if (!rawUrl) {
    return { endpoint: null, finding: `\`local.${role}.url\` is required` };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return { endpoint: null, finding: `\`local.${role}.url\` (${rawUrl}) is not a valid URL` };
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return {
      endpoint: null,
      finding: `\`local.${role}.url\` (${rawUrl}) must use http:// or https://`,
    };
  }

  if (parsedUrl.username !== '' || parsedUrl.password !== '') {
    return {
      endpoint: null,
      finding: `\`local.${role}.url\` must not embed credentials in the URL`,
    };
  }

  const model = typeof entry.model === 'string' ? entry.model.trim() : '';
  if (!model) {
    return { endpoint: null, finding: `\`local.${role}.model\` is required` };
  }

  const timeoutMs = entry.timeoutMs === undefined ? DEFAULT_LOCAL_TIMEOUT_MS : entry.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    return {
      endpoint: null,
      finding: `\`local.${role}.timeoutMs\` must be a positive whole number`,
    };
  }

  const loopback = isLoopbackHost(parsedUrl.hostname);
  const baseUrl = resolveEndpointUrl(rawUrl, '');
  const blocked = !loopback && !allowRemote;

  if (blocked) {
    return {
      endpoint: {
        role,
        url: rawUrl,
        baseUrl,
        model,
        timeoutMs,
        loopback: false,
        blocked: true,
      },
      remoteBlocked: true,
      finding: `\`local.${role}.url\` (${rawUrl}) is not a loopback address; non-loopback URLs are refused without --allow-remote (ADR-075)`,
    };
  }

  return {
    endpoint: {
      role,
      url: rawUrl,
      baseUrl,
      model,
      timeoutMs,
      loopback,
      blocked: false,
    },
    remoteBlocked: false,
    finding: null,
  };
}

/**
 * Parse and validate the `local` block of a manifest. Pure: never opens a file or socket.
 */
export function parseLocalConfig(manifest, { allowRemote = false } = {}) {
  const block = manifest?.local;
  if (block === undefined || block === null) {
    return { configured: false, chat: null, embed: null, findings: [], remoteBlocked: false };
  }
  if (typeof block !== 'object' || Array.isArray(block)) {
    return {
      configured: true,
      chat: null,
      embed: null,
      findings: ['`local` must be an object'],
      remoteBlocked: false,
    };
  }

  const findings = [];
  let remoteBlocked = false;

  for (const key of Object.keys(block)) {
    if (!ROLES.includes(key)) {
      findings.push(`\`local.${key}\` is not a recognised local model role (expected \`chat\` or \`embed\`)`);
    }
  }

  const parsedRoles = { chat: null, embed: null };
  for (const role of ROLES) {
    const raw = block[role];
    if (raw === undefined || raw === null) continue;
    const parsed = parseEndpoint(role, raw, { allowRemote });
    parsedRoles[role] = parsed.endpoint;
    if (parsed.remoteBlocked) remoteBlocked = true;
    if (parsed.finding) findings.push(parsed.finding);
  }

  const configured =
    parsedRoles.chat !== null ||
    parsedRoles.embed !== null ||
    findings.length > 0;

  return {
    configured,
    chat: parsedRoles.chat,
    embed: parsedRoles.embed,
    findings,
    remoteBlocked,
  };
}

/**
 * Read and validate the `local` block from a repository's manifest on disk.
 */
export async function readLocalConfig(root, { allowRemote = false } = {}) {
  const { manifest, exists, error } = await readManifest(root);
  if (!exists) {
    return {
      configured: false,
      chat: null,
      embed: null,
      findings: [],
      remoteBlocked: false,
      manifestExists: false,
      manifestError: null,
    };
  }
  if (error !== null || manifest === null) {
    return {
      configured: false,
      chat: null,
      embed: null,
      findings: [`${MANIFEST_FILE} is ${error ?? 'unreadable'}`],
      remoteBlocked: false,
      manifestExists: true,
      manifestError: error ?? 'unreadable',
    };
  }
  return {
    ...parseLocalConfig(manifest, { allowRemote }),
    manifestExists: true,
    manifestError: null,
  };
}

/**
 * The guard every model consumer shares (R37's distill, R39's critic and bench).
 *
 * A `--local`-shaped call without a usable chat endpoint is a configuration
 * error, never a silent fallback to the deterministic path: a caller who asked
 * for the model and got the deterministic answer would read that answer as the
 * model's — and the reverse, reading model output as deterministic, is worse.
 * Second real user arrived with the critic, so the guard moved here from the
 * distiller's `runEngine` (ADR-002).
 *
 * Returns `{ chat }` on success or `{ exit }` with the failure already shaped
 * (the same pass-through shape the command layer returns).
 */
export function chatEndpoint(config) {
  if (config.manifestError !== null) {
    return { exit: fail(`${MANIFEST_FILE}: ${config.manifestError}`, EXIT.CONFIG) };
  }
  if (!config.configured || !config.chat || config.findings.length > 0) {
    const detail = !config.configured
      ? 'no local model is configured'
      : config.remoteBlocked
        ? 'the configured chat endpoint is non-loopback and was refused'
        : 'the local configuration has errors';
    return {
      exit: fail(
        `--local needs a usable local chat endpoint: ${detail}`,
        EXIT.CONFIG,
        `configure local.chat in ${MANIFEST_FILE} (plan 0003 R37), or run without --local for the deterministic path`,
      ),
    };
  }
  return { chat: config.chat };
}
