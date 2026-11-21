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
import { EXIT, emitJson, jsonCommand, withOutputState, withSink } from '../output/index.mjs';
import { finaliseJson } from '../output/envelope.mjs';
import { within } from '../trust/paths.mjs';
import { CLI } from '../name.mjs';

const ROUTES = new Map([
  ['/api/status', { command: 'status' }],
  ['/api/check', { check: true }],
  ['/api/plan', { command: 'plan status' }],
  ['/api/plan/next', { command: 'plan next', id: true }],
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

  if (route.check) {
    const document = await sealedDocument('check', async () => {
      const { ok, findings } = await checkRepo(root, {});
      emitJson({ ok, command: 'check', root, findings });
      return ok ? EXIT.OK : EXIT.FAIL;
    });
    return { status: 200, document };
  }

  const result = await run(route.command, { args, flags: { json: true }, root });
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