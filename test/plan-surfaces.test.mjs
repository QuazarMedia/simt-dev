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

test('every command plan 4 names dispatches', async () => {
  const text = await readFile(PLAN, 'utf8');
  const named = new Set();
  for (const match of text.matchAll(/`simt ([a-z][a-z-]*(?: [a-z][a-z-]*)?)/g)) {
    // `simt-dev` is the package, not a command: the backtick form is how the plan writes the
    // tool's own name, and matching it would invent a verb.
    if (match[1] !== 'simt-dev') named.add(match[1]);
  }
  assert.ok(named.size > 0, 'the plan names no command, which means this test read the wrong file');
  const missing = [...named].filter((path) => !SPEC_PATHS.includes(path)).sort();
  assert.deepEqual(missing, [], `named by the plan and absent from the command table: ${missing.join(', ')}`);
});
