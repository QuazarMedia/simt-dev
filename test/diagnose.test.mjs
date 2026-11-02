// `doctor`'s diagnosis (review 0003 Q92).
//
// `commands/doctor.mjs` exposes `diagnose` and `serialisedFindings` so the CLI and the MCP
// `doctor` tool answer from one computation. It had no direct test: the doctor suite ran the
// command, so the JSON half of that pair - the closure-free shape a script reads - was only
// ever observed through a spawned process.
//
// What is asserted here is the division: `diagnose` answers with findings and a code, and
// `serialisedFindings` is lossless for the fields a consumer needs and refuses to carry the
// `apply` closures only `--fix` can use.

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { diagnose, serialisedFindings } from '../src/commands/doctor.mjs';
import { tempDir } from './fixture.mjs';

test('a repository it can read is a diagnosis, not a failure', async () => {
  const root = await tempDir('doctor-');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node --test' } }, null, 2));
  await writeFile(join(root, 'AGENTS.md'), '# fixture\n');
  const diagnosis = await diagnose(root, {});
  assert.equal(diagnosis.failure, null);
  assert.equal(diagnosis.code, 0);
  assert.ok(Array.isArray(diagnosis.findings));
  assert.ok(diagnosis.result.stack.includes('node'), JSON.stringify(diagnosis.result.stack));
});

test('a manifest that does not parse is a finding carrying its parse error, not a healthy config', async () => {
  const root = await tempDir('doctor-');
  await writeFile(join(root, 'simt.json'), '{ not json\n');
  const diagnosis = await diagnose(root, {});
  const finding = diagnosis.findings.find((f) => f.id === 'manifest-unreadable');
  assert.ok(finding, JSON.stringify(diagnosis.findings.map((f) => f.id)));
  // The finding names the file AND what is wrong with it; a detail that named only the file
  // would send the reader to look for a problem the tool already knows.
  assert.match(finding.detail, /simt\.json: unparseable/);
  // `doctor` reports rather than gates: a tree it can describe is a completed diagnosis.
  assert.equal(diagnosis.code, 0);
});

test('the serialised findings carry what a script needs and drop the closure it cannot use', async () => {
  const findings = [
    { id: 'A', severity: 'warn', detail: 'd', remedy: 'r', safe: true, fixed: true, apply: () => {} },
    { id: 'B', severity: 'error', detail: 'd2', remedy: 'r2', why: 'manual', safe: false, apply: async () => {} },
  ];
  const serialised = serialisedFindings(findings);
  assert.deepEqual(serialised[0], { id: 'A', severity: 'warn', detail: 'd', remedy: 'r', why: null, safe: true, fixed: true });
  assert.deepEqual(serialised[1], { id: 'B', severity: 'error', detail: 'd2', remedy: 'r2', why: 'manual', safe: false, fixed: false });
  assert.equal('apply' in serialised[0], false, 'a function reached the JSON document');
  // JSON-safe by construction: a closure here throws at serialisation time, not at read time.
  assert.doesNotThrow(() => JSON.stringify(serialised));
});
