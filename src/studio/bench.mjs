// The Bench room's documents: report, replay and calibration, through the bench door.
//
// The bench is an optional package (ADR-187). Its absence is a labelled state with the
// install next step, not a refusal page and never a second implementation of the report.

import { run, renderJson } from '../run.mjs';

const ABSENT = /the bench (is not installed|could not be loaded)|bench package could not be loaded/i;

function unavailable(result) {
  return {
    ok: true,
    absent: true,
    command: result.command,
    error: result.error?.message ?? 'the bench is not installed',
    remedy: 'install @simt-dev/bench alongside simt-dev, then reload the room',
  };
}

async function document(command, { root, args = [], flags = {} }) {
  const result = await run(command, { args, flags: { ...flags, json: true }, root });
  const doc = renderJson(result);
  if (doc !== null) return doc;
  if (!result.ok && ABSENT.test(result.error?.message ?? '')) return unavailable(result);
  return {
    ok: false,
    command,
    error: result.error?.message ?? `${command} returned no document`,
    remedy: result.error?.remedy ?? `run: simt ${command} in a terminal`,
  };
}

/** `bench report [--compare a b]`, exactly the CLI's document. */
export function benchPayload(root, compare = null) {
  const flags = Array.isArray(compare) && compare.length === 2 ? { compare } : {};
  return document('bench report', { root, flags });
}

/** An offline document door: `bench replay` or `bench calibrate`. */
export function benchInput(kind, root, input) {
  return document(`bench ${kind}`, { root, flags: { input } });
}
