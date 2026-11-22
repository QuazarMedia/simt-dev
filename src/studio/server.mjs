// The studio socket: one loopback listener, guarded by a per-launch token (ADR-212).
//
// ADR-187 kept the rollout socket-free because a default run must never listen. This
// server is the narrow exception: it exists only while `simt studio` runs, binds only
// 127.0.0.1, and every request is checked against the authority it was meant for. The
// token is one-shot - the first load trades it for a cookie and the URL is redirected
// clean - so a token copied from a terminal scrollback cannot start a second session.

import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apiAnswer } from './api.mjs';
import { streamEvents } from './events.mjs';
import { within } from '../trust/paths.mjs';

const STUDIO_HOST = '127.0.0.1';
export const STUDIO_DEFAULT_PORT = 4310;

const COOKIE = 'simt_studio';
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');

// The shell loads nothing from outside this origin (ADR-075): no CDN, no web font,
// no analytics. `frame-ancestors 'none'` keeps another page from framing the session.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const SECURITY_HEADERS = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

// The shell is every file under public/, served by extension. Containment keeps a
// crafted path inside the directory (ADR-205); an unknown type or file is a refusal,
// never a directory listing.
const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
]);

/** Constant-time equality: hash both sides so length never short-circuits the compare. */
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

function cookieValue(header) {
  for (const part of String(header ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return null;
}

function refusal(res, status, error, remedy) {
  const body = JSON.stringify({ ok: false, error, remedy });
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

/** One bounded JSON body, read only for the two control routes. */
async function controlBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('the control body is over the 1 MiB bound');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw new Error(`the control body is not JSON (${error.message})`);
  }
}

/**
 * Start the studio server on the loopback interface.
 *
 * `port` 0 asks the OS for an ephemeral port; the resolved one is returned. `root` is
 * the repository every /api read answers about. The optional `onRequest` receives the
 * accepted request's method, URL and Host after the loopback check, so a test can assert
 * the request set without changing production behaviour. The caller owns the lifetime:
 * `close()` ends the listener and every open connection, so a SIGINT leaves no socket
 * behind.
 */
export async function startStudioServer({ port = STUDIO_DEFAULT_PORT, root, onRequest } = {}) {
  const token = randomBytes(32).toString('base64url');
  let tokenLive = true;
  let boundPort = port;

  const server = createServer(async (req, res) => {
    const authority = `${STUDIO_HOST}:${boundPort}`;
    const host = String(req.headers.host ?? '');
    // DNS-rebinding defense: the page must have been addressed by the loopback name
    // this socket bound, not by a name that merely resolved to it.
    if (host !== authority && host !== `localhost:${boundPort}`) {
      return refusal(res, 403, 'STUDIO_FOREIGN_HOST', 'open the studio by the loopback URL it printed');
    }
    onRequest?.({ method: req.method, path: req.url, host });
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${authority}` && origin !== `http://localhost:${boundPort}`) {
      return refusal(res, 403, 'STUDIO_FOREIGN_ORIGIN', 'requests must come from the studio page itself');
    }
    const controlPost = req.method === 'POST' && String(req.url ?? '').startsWith('/api/control/');
    if (req.method !== 'GET' && req.method !== 'HEAD' && !controlPost) {
      return refusal(res, 405, 'STUDIO_READ_ONLY', 'the studio reads; only /api/control accepts a write');
    }

    const url = new URL(req.url, `http://${authority}`);
    const queryToken = url.searchParams.get('token');
    if (queryToken !== null) {
      // The exchange is the token's only use, on the shell route only. After it fires
      // the token is dead: a replayed query is refused even when the secret matches.
      if (url.pathname !== '/' || !tokenLive || !sameSecret(queryToken, token)) {
        return refusal(res, 403, 'STUDIO_TOKEN_REFUSED', 'open the fresh URL the running studio printed');
      }
      tokenLive = false;
      res.writeHead(303, {
        ...SECURITY_HEADERS,
        'set-cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        location: '/',
      });
      return res.end();
    }

    if (!sameSecret(cookieValue(req.headers.cookie), token)) {
      return refusal(res, 401, 'STUDIO_NO_SESSION', 'open the URL the running studio printed; it carries the one-time token');
    }

    if (url.pathname === '/api/events') {
      return streamEvents({
        root,
        req,
        res,
        headers: {
          ...SECURITY_HEADERS,
          'content-type': 'text/event-stream; charset=utf-8',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        },
      });
    }

    if (url.pathname.startsWith('/api/')) {
      let body = null;
      if (req.method === 'POST') {
        try {
          body = await controlBody(req);
        } catch (error) {
          return refusal(res, 400, 'STUDIO_CONTROL_BODY', error.message);
        }
      }
      let answer;
      try {
        answer = await apiAnswer(root, url, body);
      } catch (error) {
        return refusal(res, 500, 'STUDIO_API_FAILED', `the read failed: ${error.message}`);
      }
      const answerBody = JSON.stringify(answer.document);
      res.writeHead(answer.status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' });
      return res.end(req.method === 'HEAD' ? undefined : answerBody);
    }

    let rel;
    try {
      rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    } catch {
      return refusal(res, 404, 'STUDIO_UNKNOWN_ROUTE', 'the studio serves its shell and the /api routes');
    }
    const file = join(PUBLIC_DIR, rel);
    const type = CONTENT_TYPES.get(extname(file));
    if (!type || !within(PUBLIC_DIR, file).ok) {
      return refusal(res, 404, 'STUDIO_UNKNOWN_ROUTE', 'the studio serves its shell and the /api routes');
    }
    let body;
    try {
      body = await readFile(file);
    } catch {
      return refusal(res, 404, 'STUDIO_UNKNOWN_ROUTE', 'the studio serves its shell and the /api routes');
    }
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': type });
    res.end(req.method === 'HEAD' ? undefined : body);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, STUDIO_HOST, () => {
      server.removeListener('error', reject);
      boundPort = server.address().port;
      resolve();
    });
  });

  return {
    port: boundPort,
    token,
    url: `http://${STUDIO_HOST}:${boundPort}/?token=${token}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}