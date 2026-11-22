// The studio's read bridge: every /api route answers the door's own object (ADR-212).
//
// Parity is structural, not copied: `run` resolves the same registry the CLI dispatches
// and seals through the same envelope, so a document cannot differ by transport
// (ADR-035). The one route that cannot go through `run` is check: the command writes
// its line cache, and the studio writes nothing - so it calls checkRepo without
// writeCache and seals the payload through the same sink and finaliser.

import { resolve } from 'node:path';

import { run, renderJson } from '../run.mjs';
import { checkRepo } from '../commands/sync.mjs';
import { boardPayload } from './board.mjs';
import { evidenceChains } from './evidence.mjs';
import { HELM_UNRUNNABLE, helmCatalog, helmRow } from './helm.mjs';
import { harnessPayload } from './harness.mjs';
import { knowledgeGraph } from './knowledge.mjs';
import { EXIT, emitJson, jsonCommand, withOutputState, withSink } from '../output/index.mjs';
import { finaliseJson } from '../output/envelope.mjs';
import { within } from '../trust/paths.mjs';
import { CLI } from '../name.mjs';

const ROUTES = new Map([
  ['/api/status', { command: 'status' }],
  ['/api/tokens', { command: 'tokens' }],
  ['/api/tokens/session', { command: 'tokens', session: true }],
  ['/api/check', { check: true }],
  ['/api/plan', { command: 'plan status' }],
  ['/api/plan/next', { command: 'plan next', id: true }],
  ['/api/board', { board: true }],
  ['/api/evidence', { command: 'evidence' }],
  ['/api/evidence/chains', { chains: true }],
  ['/api/harness', { harness: true }],
  ['/api/helm', { helm: true }],
  ['/api/knowledge/graph', { knowledgeGraph: true }],
  ['/api/knowledge/why', { command: 'knowledge why', scope: true }],
  ['/api/knowledge/rank', { command: 'knowledge rank', scope: true, query: true }],
  ['/api/work', { command: 'work inspect' }],
]);

/**
 * Seal one payload the way the dispatcher seals a command's answer: the command name,
 * the schema version and the exit code come from the same machinery, not from a second
 * rendering that could drift from the first.
 */
async function sealedDocument(command, body) {
  const produced = await withOutputState(() =>
    withSink(async () => {
      jsonCommand(command);
      return body();
    }),
  );
  return finaliseJson(produced.documents, { code: produced.code }).documents[0];
}

function denied(status, error, remedy) {
  return { status, document: { ok: false, error, remedy } };
}

/**
 * Answer one studio API request as data: an HTTP status and the document to serialize.
 *
 * The server owns headers and the socket; this module owns only the answer, so the
 * parity tests can ask it without a listener. A door that answered with a verdict
 * (a red check, an empty plan) is a 200 carrying that verdict - the refusal shape is
 * for requests the door itself refused.
 *
 * @param {string} root the repository the studio was opened on
 * @param {URL} url the request URL, already parsed against the loopback authority
 * @returns {Promise<{status: number, document: object}>}
 */
export async function apiAnswer(root, url) {
  const route = ROUTES.get(url.pathname);
  if (!route) {
    return denied(404, 'STUDIO_UNKNOWN_ROUTE', `the studio serves ${[...ROUTES.keys()].join(', ')}`);
  }

  const args = [];
  if (route.id) {
    const id = url.searchParams.get('id');
    if (id !== null && id !== '') {
      // Containment is the filesystem's answer, not the spelling's (ADR-205): a slice
      // id is a name, but `../` and absolute paths are reads of somewhere else.
      const containment = within(root, resolve(root, id));
      if (!containment.ok) {
        return denied(403, 'STUDIO_PATH_DENIED', `the read stays inside the repository: ${containment.reason}`);
      }
      args.push(id);
    }
  }
  const flags = { json: true };
  if (route.session) {
    const session = url.searchParams.get('session');
    if (session === null || session.trim() === '') {
      return denied(400, 'STUDIO_SESSION_REQUIRED', 'tokens --session requires a local transcript path');
    }
    flags.session = session;
  }
  if (route.query) {
    const query = url.searchParams.get('query');
    const scope = url.searchParams.get('scope');
    if (query === null || query.trim() === '' || scope === null || scope === '') {
      return denied(400, 'STUDIO_QUERY_REQUIRED', 'knowledge rank needs a query and its declared scope');
    }
    flags.query = query;
    flags.scope = scope;
  } else if (route.scope) {
    const id = url.searchParams.get('id');
    const scope = url.searchParams.get('scope');
    if (id === null || id === '' || scope === null || scope === '') {
      return denied(400, 'STUDIO_SCOPE_REQUIRED', 'knowledge why needs one claim id and its declared scope');
    }
    args.push(id);
    flags.scope = scope;
  }

  if (route.check) {
    const document = await sealedDocument('check', async () => {
      const { ok, findings } = await checkRepo(root, {});
      emitJson({ ok, command: 'check', root, findings });
      return ok ? EXIT.OK : EXIT.FAIL;
    });
    return { status: 200, document };
  }

  if (route.board) {
    const document = await sealedDocument('board', async () => {
      emitJson(await boardPayload(root));
      return EXIT.OK;
    });
    return { status: 200, document };
  }

  if (route.chains) {
    const document = await sealedDocument('evidence chains', async () => {
      const payload = await evidenceChains(root, { claim: url.searchParams.get('claim') });
      emitJson(payload);
      return payload.ok ? EXIT.OK : EXIT.FAIL;
    });
    return { status: 200, document };
  }

  if (route.knowledgeGraph) {
    const document = await sealedDocument('knowledge graph', async () => {
      const payload = await knowledgeGraph(root, url.searchParams.get('scope'));
      emitJson(payload);
      return payload.ok ? EXIT.OK : EXIT.FAIL;
    });
    return { status: 200, document };
  }

  if (route.harness) {
    const document = await sealedDocument('harness', async () => {
      const payload = await harnessPayload(root);
      emitJson(payload);
      return payload.ok ? EXIT.OK : EXIT.FAIL;
    });
    return { status: 200, document };
  }

  if (route.helm) {
    const path = url.searchParams.get('path');
    if (path === null || path === '') {
      const document = await sealedDocument('helm', async () => {
        emitJson({ ok: true, command: 'helm', root, commands: helmCatalog() });
        return EXIT.OK;
      });
      return { status: 200, document };
    }
    const row = helmRow(path);
    if (row === null) {
      return denied(403, 'STUDIO_HELM_WRITER_DENIED', `the helm runs read-only doors only; \`${path}\` is not in the spec's read-only rows`);
    }
    if (HELM_UNRUNNABLE.has(row.path)) {
      return denied(403, 'STUDIO_HELM_NOT_RUNNABLE', `\`${row.path}\` is a read with no document answer here; copy the command and run it in a terminal`);
    }
    let args = [];
    let flags = {};
    try {
      const rawArgs = url.searchParams.get('args');
      const rawFlags = url.searchParams.get('flags');
      args = rawArgs === null || rawArgs === '' ? [] : JSON.parse(rawArgs);
      flags = rawFlags === null || rawFlags === '' ? {} : JSON.parse(rawFlags);
    } catch {
      return denied(400, 'STUDIO_HELM_BAD_INPUT', 'args and flags must be JSON arrays and objects');
    }
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      return denied(400, 'STUDIO_HELM_BAD_INPUT', 'args must be an array of strings');
    }
    if (flags === null || typeof flags !== 'object' || Array.isArray(flags)) {
      return denied(400, 'STUDIO_HELM_BAD_INPUT', 'flags must be a JSON object');
    }
    const allowed = new Set([...(row.flags ?? []), 'json']);
    for (const [name, value] of Object.entries(flags)) {
      if (!allowed.has(name)) return denied(400, 'STUDIO_HELM_UNKNOWN_FLAG', `\`${name}\` is not a flag of \`${row.path}\``);
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        return denied(400, 'STUDIO_HELM_BAD_INPUT', `\`${name}\` must be a scalar value`);
      }
    }
    const result = await run(row.path, { args, flags: { ...flags, json: true }, root });
    const document = renderJson(result);
    if (document !== null) {
      const answer = await sealedDocument('helm', async () => {
        emitJson({ ok: true, command: 'helm', root, path: row.path, document });
        return EXIT.OK;
      });
      return { status: 200, document: answer };
    }
    return denied(400, 'STUDIO_HELM_REFUSED', result.error?.message ?? `\`${row.path}\` refused`);
  }

  const result = await run(route.command, { args, flags, root });
  const document = renderJson(result);
  if (document !== null) return { status: 200, document };

  // The door refused. Re-emit its refusal through the same envelope so the studio's
  // refusal document is the CLI's refusal document, field for field.
  const error = result.error ?? {
    message: 'the door produced no document',
    remedy: `run: ${CLI} ${route.command}`,
    exitCode: result.code,
  };
  const refusal = await sealedDocument(route.command, async () => {
    emitJson({ ok: false, error: error.message, remedy: error.remedy, exitCode: error.exitCode ?? result.code });
    return result.code;
  });
  return { status: result.code === EXIT.USAGE || result.code === EXIT.CONFIG ? 400 : 500, document: refusal };
}