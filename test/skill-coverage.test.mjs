// The simt-commands skill is the agent's command reference: it is what a
// harness loads before an agent meets this binary, so a command group that
// lands in the spec without reaching the skill is a surface the agent never
// learns exists. The 2026-11-04 doors (knowledge, work, verify, action,
// adapter) sat three days unmentioned after landing; this is the check that
// closes that class of drift.
//
// A group counts as named only at the head of a code span - `simt <group>` or
// `<group> <verbs>` - because these names are ordinary English too. Reading
// `\b<group>\b` anywhere in the body passed on prose alone: "what this repo's
// work is" satisfied it with no command documented, which is the drift it
// exists to catch.
//
// The granularity is the GROUP, not the subcommand: the skill is a curated
// scenario-to-command mapping, not a catalog, so it may name a group's common
// verbs and leave the rest to `simt help <group>`. What it must not do is be
// silent about a group.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SPEC } from '../src/commands/spec.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = join(ROOT, 'skills', 'simt-commands', 'SKILL.md');

// A group the skill may leave unnamed, with the reason - the same shape as
// MCP_ONLY in spec.mjs. Name the group in the skill, or add a reasoned row
// here; do not loosen the test.
const UNNAMED_GROUPS = [
  {
    group: 'agent-hook',
    why: 'the harness entry point the hooks call with a payload, not a command an agent runs by hand',
  },
];

/**
 * The groups the skill names as commands: the first token of a code span,
 * after an optional `simt` prefix. Subcommands and verbs after it are the
 * group's own business.
 */
function commandGroups(body) {
  const heads = new Set();
  for (const span of body.matchAll(/`([^`]+)`/g)) {
    const head = span[1].trim().replace(/^simt\s+/, '').split(/\s+/)[0];
    if (head) heads.add(head);
  }
  return heads;
}

test('skill: every command group in the spec is named in the simt-commands skill', async () => {
  const named = commandGroups(await readFile(SKILL, 'utf8'));
  const groups = [...new Set(SPEC.map((row) => row.path.split(' ')[0]))];
  const excused = new Set(UNNAMED_GROUPS.map((row) => row.group));
  const missing = groups.filter((group) => !excused.has(group) && !named.has(group));
  assert.deepEqual(
    missing,
    [],
    `groups in the spec the skill never names as a command: ${missing.join(', ')} - add them to the skill, ` +
      `or a reasoned row to UNNAMED_GROUPS`,
  );
});

test('skill: a group excused in UNNAMED_GROUPS is actually absent from the skill', async () => {
  // An excuse that no longer holds is drift in the test itself: the group got
  // named in the skill, so the row is dead weight hiding the next omission.
  const named = commandGroups(await readFile(SKILL, 'utf8'));
  for (const row of UNNAMED_GROUPS) {
    assert.ok(!named.has(row.group), `${row.group} is named in the skill; drop its UNNAMED_GROUPS row`);
  }
});
