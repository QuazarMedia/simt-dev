// Q15 parity: every MCP tool answers what its CLI command answers.
//
// The review's acceptance criterion is literal — `tools/call` structured content
// equals the CLI `--json` result minus the envelope — and the cores exist to make
// it true by construction: both surfaces call `checkRepo`, `diagnose`,
// `rulesCatalogue`, `rulesWhyFacts`, `skillsBriefFacts`, `skillsFindFacts`,
// `skillsShowFacts` and `skillsWhyFacts`. This test holds that construction,
// over the checkout itself, so a future second copy fails here rather than in
// a reader's session.
//
// The envelope is the transport, not the answer: the CLI's `schemaVersion`,
// `ok`/`command`, and the fields only one surface carries (`sha` on the MCP
// list, `root` on the CLI list, the workspace display note on CLI find).
// Everything else must be identical, field for field.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOLS } from '../src/mcp/tools.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const BIN = resolve(ROOT, 'bin', 'simt.mjs');
const exec = promisify(execFile);

const tool = (name) => {
  const found = TOOLS.find((t) => t.name === name);
  assert.ok(found, `no MCP tool named ${name}`);
  return found;
};

async function cli(...args) {
  // A gate command leaves non-zero when the repo is red; the document on stdout
  // is still the answer, so a failing exit must not fail the comparison.
  const { stdout } = await exec('node', [BIN, ...args, '--json'], { cwd: ROOT }).catch((error) => error);
  return JSON.parse(stdout);
}

/** The CLI document minus the transport: what the answer is, not how it arrived. */
function answer(doc, ...drop) {
  const { schemaVersion, ok, command, ...rest } = doc;
  for (const key of drop) delete rest[key];
  return rest;
}

test('parity: check answers the full gate on both surfaces', async () => {
  const mcp = await tool('check').run({ root: ROOT });
  const raw = await cli('check', '--root', ROOT);
  // The verdict travels separately from the findings on the CLI; the findings
  // must still be identical, finding for finding.
  assert.equal(mcp.ok, raw.ok);
  assert.deepEqual({ root: mcp.root, findings: mcp.findings }, answer(raw));
});

test('parity: doctor answers the findings on both surfaces', async () => {
  const mcp = await tool('doctor').run({ root: ROOT });
  const command = answer(await cli('doctor', '--root', ROOT));
  assert.deepEqual(mcp, command);
});

test('parity: rules_list answers the catalogue on both surfaces', async () => {
  const mcp = await tool('rules_list').run({ root: ROOT });
  const command = await cli('rules', 'list', '--root', ROOT);
  assert.deepEqual(mcp.rules, command.rules);
  assert.deepEqual(mcp.notes, command.notes);
});

test('parity: rules_why answers both directions on both surfaces', async () => {
  for (const what of ['test-gate', 'ADR-006', 'android']) {
    const mcp = await tool('rules_why').run({ what });
    const command = answer(await cli('rules', 'why', what));
    assert.deepEqual(mcp, command, `rules_why ${what} differs between the surfaces`);
  }
});

test('parity: skills_brief answers the selection on both surfaces', async () => {
  const mcp = await tool('skills_brief').run({ root: ROOT, task: 'write a test' });
  const command = answer(await cli('skills', 'brief', '--root', ROOT, '--task', 'write a test'));
  assert.deepEqual(mcp, command);
});

test('parity: skills_find answers the search on both surfaces', async () => {
  const mcp = await tool('skills_find').run({ query: 'test' });
  // The workspace display note is CLI-only chrome around the same results.
  const command = answer(await cli('skills', 'find', 'test'), 'workspace');
  assert.deepEqual(mcp, command);
});

test('parity: skills_show and skills_why answer one skill on both surfaces', async () => {
  const index = await tool('skills_index').run({});
  assert.ok(index.entries.length > 0, 'the registry is empty; there is nothing to compare');
  const name = index.entries[0].name;

  const showMcp = await tool('skills_show').run({ root: ROOT, name });
  const showCli = answer(await cli('skills', 'show', name, '--root', ROOT));
  assert.deepEqual(showMcp, showCli);

  const whyMcp = await tool('skills_why').run({ root: ROOT, name });
  const whyCli = answer(await cli('skills', 'why', name, '--root', ROOT));
  // `skills why` is not an MCP tool; `skills_why` answers `skills why --json`.
  assert.deepEqual(whyMcp, whyCli);
});
