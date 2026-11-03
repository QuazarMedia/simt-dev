// Every command a plan names has to dispatch, or say why it does not (ADR-194).
//
// W23 was closed `Complete` on a module and its unit test while the acceptance line of the same
// row required CLI/MCP parity for four doors none of which existed. Nothing failed, because
// nothing compared the plan's own words with the command table. This test does that comparison
// over the plan's text, so the next row cannot be closed on a true statement that is not the
// claim being made.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { SPEC_PATHS } from '../src/commands/spec.mjs';

const PLAN = new URL('../docs/research/0004-knowledge-and-remote-work-intelligence-plan.md', import.meta.url);

/**
 * Commands the plan names and this binary deliberately does not dispatch.
 *
 * An excused command is not a footnote: the second test below fails when one of these becomes
 * dispatchable, so the record cannot outlive the truth it describes.
 */
const PROPOSED = new Map([
  ['verify run', 'it executes validators, so it belongs to an executor this package does not ship; `simt verify select` names what such a run would do'],
]);

test('every command plan 4 names either dispatches or is excused with a reason', async () => {
  const text = await readFile(PLAN, 'utf8');
  const named = new Set();
  for (const match of text.matchAll(/`simt ([a-z][a-z-]*(?: [a-z][a-z-]*)?)/g)) {
    // `simt-dev` is the package, not a command: the backtick form is how the plan writes the
    // tool's own name, and matching it would invent a verb.
    if (match[1] !== 'simt-dev') named.add(match[1]);
  }
  assert.ok(named.size > 0, 'the plan names no command, which means this test read the wrong file');
  const missing = [...named].filter((path) => !SPEC_PATHS.includes(path) && !PROPOSED.has(path)).sort();
  assert.deepEqual(missing, [], `named by the plan and absent from the command table: ${missing.join(', ')}`);
});

test('an excused command is still not dispatchable, so the excuse cannot go stale', () => {
  for (const [path, reason] of PROPOSED) {
    assert.ok(reason.length > 20, `${path} is excused without a reason a reader can act on`);
    assert.ok(!SPEC_PATHS.includes(path), `${path} now dispatches; remove it from the excuse list`);
  }
});
