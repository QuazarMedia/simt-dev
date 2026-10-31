import assert from 'node:assert/strict';
import test from 'node:test';
import { MCP_ONLY, SPEC } from '../src/commands/spec.mjs';
import { TOOLS } from '../src/mcp/tools.mjs';

const rows = SPEC.filter((row) => row.mcp);
const byTool = new Map(rows.map((row) => [row.mcp.name, row]));
const toolNames = TOOLS.map((tool) => tool.name);
const camel = (flag) => flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

test('every MCP tool is a spec row, and every row that names a tool has one', () => {
  // The four command lists this review found disagreeing are why the spec exists; an MCP
  // tool list kept beside it is the same failure one file over.
  // A tool with no row is allowed only when the spec says which tool and why, so the
  // exception is a decision a reader can find rather than a hole in the table.
  const excused = new Map(MCP_ONLY.map((entry) => [entry.tool, entry.why]));
  const withoutRow = toolNames.filter((name) => !byTool.has(name) && !(excused.get(name) ?? '').length > 10);
  assert.deepEqual(withoutRow, [], 'tools with no spec row and no stated reason');
  assert.deepEqual([...byTool.keys()].filter((name) => !toolNames.includes(name)), [], 'rows naming a tool that does not exist');
});

test('a row exposes over MCP only flags the command itself declares', () => {
  // The other direction of the same drift: a tool accepting a flag no row declares would
  // be a capability with no source, and one nobody can find by reading the spec.
  for (const row of rows) {
    const own = new Set(row.flags ?? []);
    const extra = row.mcp.flags.filter((flag) => !own.has(flag));
    assert.deepEqual(extra, [], `${row.path} exposes undeclared flags`);
  }
});

test('every flag a row exposes is a property its tool actually accepts', () => {
  // A flag the spec advertises and the transport refuses is worse than a missing tool:
  // the list says yes, and the call fails on a parameter the caller was told about.
  const missing = [];
  for (const tool of TOOLS) {
    const row = byTool.get(tool.name);
    if (!row) continue;
    const properties = new Set(Object.keys(tool.inputSchema?.properties ?? {}));
    for (const flag of row.mcp.flags) if (!properties.has(camel(flag))) missing.push(`${tool.name}: --${flag}`);
  }
  assert.deepEqual(missing, [], 'exposed flags the tool schema does not accept');
});

test('a tool name is a lower-case identifier, so it survives every client', () => {
  for (const name of toolNames) assert.match(name, /^[a-z][a-z0-9_]*$/, name);
});
