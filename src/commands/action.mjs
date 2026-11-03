// `simt action status` — where an operation stands, from the journal it left behind.
//
// Plan 4's fourth door (W20). The state machine writes before it dispatches, so a journal read
// after a crash is the only honest answer to "did the request leave the process?". This door
// replays it and reports what that state permits: whether the run is resumable, whether an
// effect may be in flight, which recovery applies, whether the recorded intent was authorized,
// and what the adapter can actually promise. It records nothing and reconciles nothing.

import { EXIT, fail, present } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { chooseRecovery, UNDO_SCOPE } from '../actions/recovery.mjs';
import { checkAuthorization, intentDigest, scopeOf } from '../actions/intent.mjs';
import { executionGuarantee, replay } from '../actions/machine.mjs';
import { readJsonDocument } from './doc-input.mjs';

const USAGE = `run: ${CLI} action status --journal <file>`;

/**
 * @param {object} doc
 * @returns {object}
 */
export function actionStatusFacts(doc) {
  const journal = Array.isArray(doc) ? doc : Array.isArray(doc.journal) ? doc.journal : null;
  if (journal === null) return { error: 'the document needs a journal list' };
  const run = replay(journal);
  const state = run.state ?? 'failed';
  const intent = doc !== null && typeof doc === 'object' && !Array.isArray(doc) && doc.intent !== null && typeof doc.intent === 'object' ? doc.intent : null;
  return {
    ok: true,
    command: 'action status',
    events: journal.length,
    ...run,
    recovery: run.state === null ? null : chooseRecovery({ state, reconcilable: doc.reconcilable === true, compensation: doc.compensation ?? null }),
    authorization:
      intent === null
        ? null
        : {
            digest: intentDigest(intent),
            scope: scopeOf(intent),
            check: checkAuthorization(intent, doc.authorization ?? null),
          },
    guarantee: executionGuarantee({
      serverDeduplication: doc.serverDeduplication === true,
      atomicPrecondition: doc.atomicPrecondition === true,
    }),
    undo: UNDO_SCOPE,
  };
}

export async function actionStatusCommand(args, flags) {
  if (args.length > 0) return fail(`unknown action status argument ${args[0]}`, EXIT.USAGE, USAGE);
  const read = await readJsonDocument(flags, 'journal');
  if (read.error !== undefined) return fail(read.error, EXIT.USAGE, USAGE);
  const payload = actionStatusFacts(read.doc);
  if (payload.error !== undefined) return fail(payload.error, EXIT.FAIL, 'a document of {"journal": [...]}, or a bare journal array');
  present(payload, () => render(payload), flags);
  return EXIT.OK;
}

function render(payload) {
  const lines = [
    `events     ${payload.events}`,
    `state      ${payload.state ?? '(empty journal)'}`,
    `resumable  ${payload.resumable ? 'yes' : 'no'}`,
    `in flight  ${payload.inFlight ? 'maybe: the effect may have left the process' : 'no'}`,
  ];
  if (payload.reason !== null) lines.push(`reason     ${payload.reason}`);
  if (payload.recovery !== null) lines.push(`recovery   ${payload.recovery.choice ?? JSON.stringify(payload.recovery)}`);
  if (payload.recovery !== null && payload.recovery.reason) lines.push(`because    ${payload.recovery.reason}`);
  if (payload.authorization !== null) {
    lines.push(`intent     ${payload.authorization.digest}  ${payload.authorization.scope}`);
    lines.push(`authorized ${payload.authorization.check.state}`);
  }
  lines.push(`guarantee  ${payload.guarantee.promise}  (${payload.guarantee.reason})`);
  lines.push(`undo       ${payload.undo.reason}`);
  return lines.join('\n');
}
