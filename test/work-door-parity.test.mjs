// A45: every document door the spec exposes is one MCP tool, with the spec's required
// arguments. The existing door suite exercises five tools; this one is the inventory.

import assert from 'node:assert/strict';
import test from 'node:test';

import { SPEC } from '../src/commands/spec.mjs';
import { TOOLS } from '../src/mcp/tools.mjs';

const GROUPS = new Set(['knowledge', 'verify', 'work', 'action']);
const doors = SPEC.filter((row) => GROUPS.has(row.path.split(' ')[0]) && row.mcp !== undefined);

/** The required arguments the spec's usage names, in the tools' argument spelling. */
const expectedRequired = (row) => {
  const usage = row.usage ?? '';
  const required = [];
  if (/<claim-id>/.test(usage)) required.push('id');
  if (/--(input|claims|journal)\b/.test(usage)) required.push('document');
  return required.sort();
};

test('every document door has one tool with the spec required arguments (A45)', () => {
  assert.ok(doors.length > 0, 'the spec no longer exposes any document door');

  for (const row of doors) {
    const tool = TOOLS.find((entry) => entry.name === row.mcp.name);
    assert.ok(tool, `${row.path} names the tool ${row.mcp.name}, which the server does not define`);
    assert.deepEqual(
      [...(tool.inputSchema.required ?? [])].sort(),
      expectedRequired(row),
      `${row.mcp.name} requires different arguments than ${row.path} declares`,
    );
  }
});
