// One transport policy for every local model request (ADR-204).
//
// The client used to validate the endpoint once and then hand the URL to `fetch`, which
// follows redirects by default and buffers whatever comes back. So a loopback endpoint
// could answer 302 to anywhere and the request would go there, a response had no upper
// bound, and a request could upload as much text as a caller passed. Each was a gap in
// the same rule - a local endpoint is one destination with a bounded exchange - and the
// rule now lives here, in one function every call goes through.
//
// The policy:
//
//   destination  the configured origin only. A redirect is followed when it stays on that
//                origin and within MAX_REDIRECTS hops; anything else is refused, and the
//                request never reaches the second host.
//   question     a request body over MAX_REQUEST_BYTES is refused before anything opens.
//   answer       a response over MAX_RESPONSE_BYTES - declared or streamed - is aborted.
//   credential   sent as a header and never appears in an error: a server that echoes it
//                back gets `[redacted]` in the message a caller reads.
//
// Timeouts cover the whole exchange (headers and body), because a server that sends
// headers and then stalls is the same failure as one that never answers.

import { DEFAULT_LOCAL_TIMEOUT_MS } from './config.mjs';

/** The largest request body this client will send, serialized. */
export const MAX_REQUEST_BYTES = 1 << 20;

/** The largest response body this client will read. */
export const MAX_RESPONSE_BYTES = 16 << 20;

/** How many same-origin redirects a request will follow. */
const MAX_REDIRECTS = 2;

const REDACTED = '[redacted]';

/**
 * Remove a credential from text that is about to reach a caller.
 *
 * Servers echo request details in error bodies - nginx's `Authorization: Bearer x` in a
 * 400 is the common one - and an error message is logged, pasted into a ticket and shown
 * by `local doctor`. The key itself is replaced wherever it appears, in either the bare
 * or the header form.
 */
export function redactSecrets(text, apiKey) {
  const value = String(text ?? '');
  if (typeof apiKey !== 'string' || apiKey.length === 0) return value;
  return value.split(apiKey).join(REDACTED);
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The request the transport will actually send: `redirect: 'manual'`, so a 3xx arrives as
 * a response this module reads instead of a decision `fetch` made.
 *
 * @returns {Promise<{ok: boolean, status: number|null, data: object|null, error: string|null, socketOpened: boolean, redirects: number}>}
 */
export async function requestJson(
  url,
  {
    method = 'GET',
    body = undefined,
    timeoutMs = DEFAULT_LOCAL_TIMEOUT_MS,
    apiKey = null,
    fetchImpl = globalThis.fetch,
    limits = {},
  } = {},
) {
  const maxRequest = limits.maxRequestBytes ?? MAX_REQUEST_BYTES;
  const maxResponse = limits.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const maxRedirects = limits.maxRedirects ?? MAX_REDIRECTS;

  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    if (Buffer.byteLength(payload) > maxRequest) {
      return {
        ok: false,
        status: null,
        data: null,
        error: `${method} ${url} was not sent: the request body is ${Buffer.byteLength(payload)} bytes, over the ${maxRequest}-byte limit`,
        socketOpened: false,
        redirects: 0,
      };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let socketOpened = false;
  try {
    let target = url;
    let redirects = 0;
    const allowed = originOf(url);
    for (;;) {
      const headers = {
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
        accept: 'application/json',
      };
      if (typeof apiKey === 'string' && apiKey.length > 0) {
        headers.authorization = `Bearer ${apiKey}`;
      }
      socketOpened = true;
      const response = await fetchImpl(target, {
        method,
        headers,
        body: payload,
        signal: controller.signal,
        redirect: 'manual',
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers?.get?.('location') ?? '';
        const next = location ? new URL(location, target).toString() : null;
        if (next === null) {
          return failure(`${method} ${target} answered ${response.status} with no Location`);
        }
        if (originOf(next) !== allowed) {
          return failure(
            `${method} ${target} was redirected to ${next}, which is not the configured endpoint ${allowed}; the request was refused`,
          );
        }
        if (redirects >= maxRedirects) {
          return failure(`${method} ${target} exceeded ${maxRedirects} redirects (last: ${next})`);
        }
        redirects += 1;
        target = next;
        continue;
      }

      const declared = Number(response.headers?.get?.('content-length') ?? '');
      if (Number.isFinite(declared) && declared > maxResponse) {
        return failure(`${method} ${target} declared ${declared} bytes, over the ${maxResponse}-byte response limit`);
      }

      const text = await readBounded(response, maxResponse, () =>
        failure(`${method} ${target} sent more than the ${maxResponse}-byte response limit`),
      );
      if (typeof text === 'object') return text;

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
        return failure(
          `${method} ${target} failed (${response.status}): ${redactSecrets(serverMsg, apiKey)}`,
          response.status,
          Buffer.byteLength(text),
        );
      }
      if (parsed === null || typeof parsed !== 'object') {
        return failure(`${method} ${target} returned non-JSON response`, response.status);
      }
      return {
        ok: true,
        status: response.status,
        data: parsed,
        error: null,
        socketOpened,
        redirects,
        requestBytes: payload === undefined ? 0 : Buffer.byteLength(payload),
        responseBytes: Buffer.byteLength(text),
      };
    }

    function failure(message, status = null, responseBytes = 0) {
      return {
        ok: false,
        status,
        data: null,
        error: message,
        socketOpened,
        redirects,
        requestBytes: payload === undefined ? 0 : Buffer.byteLength(payload),
        responseBytes,
      };
    }
  } catch (error) {
    const reason =
      error?.name === 'AbortError'
        ? `timed out after ${timeoutMs} ms`
        : error?.cause?.message ?? error?.message ?? String(error);
    return {
      ok: false,
      status: null,
      data: null,
      error: `${method} ${url} failed: ${redactSecrets(reason, apiKey)}`,
      socketOpened,
      redirects: 0,
      requestBytes: payload === undefined ? 0 : Buffer.byteLength(payload),
      responseBytes: 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a response body up to `limit` bytes, without trusting `content-length`.
 *
 * Returns the text, or the failure object the caller should return: a stream that never
 * ends is cut off here rather than buffered. `response.text()` would do neither.
 */
async function readBounded(response, limit, overflow) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text) > limit) return overflow();
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return overflow();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The data basis of one exchange, for a record that must not carry credentials or the
 * content itself: which model answered, where, and how much crossed the socket.
 */
export function dataBasis({ model, url, requestBytes, responseBytes, redirects = 0 }) {
  return {
    model,
    endpoint: originOf(url),
    requestBytes,
    responseBytes,
    redirects,
  };
}
