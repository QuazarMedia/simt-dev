// The simt-commands skill is the agent's command reference: it is what a
// harness loads before an agent meets this binary, so a command group that
// lands in the spec without reaching the skill is a surface the agent never
// learns exists. The 2026-11-04 doors (knowledge, work, verify, action,
// adapter) sat three days unmentioned after landing; this is the check that
// closes that class of drift.
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

test('skill: every command group in the spec is named in the simt-commands skill', async () => {
  const body = await readFile(SKILL, 'utf8');
  const groups = [...new Set(SPEC.map((row) => row.path.split(' ')[0]))];
  const excused = new Set(UNNAMED_GROUPS.map((row) => row.group));
  const missing = groups.filter(
    (group) => !excused.has(group) && !new RegExp(`\\b${group}\\b`).test(body),
  );
  assert.deepEqual(
    missing,
    [],
    `groups in the spec the skill never names: ${missing.join(', ')} - add them to the skill, ` +
      `or a reasoned row to UNNAMED_GROUPS`,
  );
});

test('skill: a group excused in UNNAMED_GROUPS is actually absent from the skill', async () => {
  // An excuse that no longer holds is drift in the test itself: the group got
  // named in the skill, so the row is dead weight hiding the next omission.
  const body = await readFile(SKILL, 'utf8');
  for (const row of UNNAMED_GROUPS) {
    assert.ok(
      !new RegExp(`\\b${row.group}\\b`).test(body),
      `${row.group} is named in the skill; drop its UNNAMED_GROUPS row`,
    );
  }
});
