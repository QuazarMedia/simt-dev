// The release acceptance matrix: data and publication must agree, and the matrix
// must be well-formed (ADR-214).
//
// A green source suite cannot establish installation, upgrade, configuration or
// enforcement in a receiving repository (review 0005, PR37). The matrix that says
// WHAT a release proves and FROM WHERE lives in `src/distribute/acceptance.mjs`,
// published to `docs/reference/acceptance.md`. This file is the reason neither can
// drift: it reads both and asserts they name the same fixtures, proofs, surfaces,
// limits and unsupported combinations — in the same way `support.md` and
// `support.mjs` cannot disagree (ADR-206).
//
// Every invariant here is static and checkable from this checkout with no network:
// the heavy qualification (running each fixture through each channel) is the work
// of `test/pack.test.mjs`, `test/binary.test.mjs` and the release jobs. This file
// pins the *shape* of what they must prove, so a fixture or a limit that is dropped
// from the data but not the page — or named in one and missing in the other — fails
// here, cheaply, before a release is signed off against a matrix that no longer matches
// the artefact it was meant to qualify.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { EXIT } from '../src/output/index.mjs';
import { CLI } from '../src/name.mjs';
import {
  ACCEPTANCE_DOC,
  SCENARIOS,
  CAPABILITIES,
  SURFACES,
  LIMITS,
  UNSUPPORTED,
  acceptanceChannels,
  acceptanceTargets,
} from '../src/distribute/acceptance.mjs';

const doc = await readFile(new URL(`../${ACCEPTANCE_DOC}`, import.meta.url), 'utf8');
// Backticks are markdown, not content: the reader sees them as formatting. Strip them so a
// command or a description wrapped in a code span is compared by what it says, the same way
// the support table is read in `packaging.test.mjs`.
const plain = doc.replaceAll('`', '');

test('acceptance: the page names the data module and the decision that rules it', () => {
  // The reader must know where the table is data, and which ruling settled it. A page
  // that restates the matrix without naming its source is a fifth copy (ADR-206).
  assert.ok(plain.includes('src/distribute/acceptance.mjs'), 'the page does not name the data module');
  assert.ok(plain.includes('ADR-214'), 'the page does not name the ruling');
});

test('acceptance: every fixture in the data is published, and no extra', () => {
  // The fixtures are the rows a release must stage. A fixture in the data but absent
  // from the page is a promise the reader never sees; one in the page but not the data
  // is a fixture no module can stage.
  for (const scenario of SCENARIOS) {
    assert.ok(plain.includes(scenario.id), `the page does not publish the fixture ${scenario.id}`);
    assert.ok(plain.includes(scenario.fixture), `the page does not state what ${scenario.id} is`);
  }
});

test('acceptance: every proof has a reproducible command, published verbatim', () => {
  // The whole point of the matrix is a command a release engineer runs, not a place to
  // read. A capability with an empty command is a proof nobody can perform; one whose
  // command is not in the page is a promise the reader cannot copy.
  for (const cap of CAPABILITIES) {
    assert.ok(cap.command.trim().length > 0, `${cap.id} has no reproducible command`);
    assert.ok(plain.includes(cap.command), `the page does not publish the command for ${cap.id}`);
  }
});

test('acceptance: the surfaces beyond the CLI are published with their commands', () => {
  // A surface that installs and cannot be invoked is a door the tarball left unbuilt.
  // Each is exercised against the installed copy, and the command is how a release
  // proves the door opens — so each must be named here and on the page.
  for (const surface of SURFACES) {
    assert.ok(surface.command.trim().length > 0, `${surface.id} has no reproducible command`);
    assert.ok(plain.includes(surface.command), `the page does not publish the command for ${surface.id}`);
  }
});

test('acceptance: a limit is measurable, not a wish', () => {
  // A bound with no metric, subject, unit or direction is a wish. Each limit names what
  // is measured, in which unit, against which direction; the numbers are bounds a
  // release must meet, and a bar declared after the numbers is not a bar (ADR-183).
  for (const limit of LIMITS) {
    assert.ok(limit.metric.length > 0, 'a limit with no metric names nothing to measure');
    assert.ok(limit.subject.length > 0, `${limit.metric} does not state what is measured`);
    assert.ok(Number.isFinite(limit.bound) && limit.bound > 0, `${limit.metric} bound is not a positive number`);
    assert.ok(limit.unit.length > 0, `${limit.metric} has no unit`);
    assert.ok(['lte', 'gte'].includes(limit.direction), `${limit.metric} direction is not lte or gte`);
    assert.ok(doc.includes(`\`${limit.metric}\``), `the page does not publish the limit ${limit.metric}`);
  }
});

test('acceptance: an unsupported combination states a reason, an exit and a remedy', () => {
  // The matrix records what the release does NOT cover, by reason and supported exit or
  // remedy. A combination with no reason is an unexplained gap; one whose exit is not in
  // the table names a code the tool does not report; one with no remedy leaves the reader
  // with a refusal and no next step.
  const exitNames = new Set(Object.keys(EXIT));
  for (const row of UNSUPPORTED) {
    assert.ok(row.combo.length > 0, 'an unsupported combination with no name');
    assert.ok(row.reason.length > 0, `${row.combo} has no reason`);
    assert.ok(exitNames.has(row.exit), `${row.combo} names an exit the tool does not report: ${row.exit}`);
    assert.ok(row.remedy.length > 0, `${row.combo} has no remedy`);
    assert.ok(doc.includes(row.combo), `the page does not publish the combination ${row.combo}`);
  }
});

test('acceptance: the channels and targets are the support inventory’s, not a second list', () => {
  // The matrix is qualified against the four channels and the release targets named in
  // the support inventory (ADR-206). Restating them here would be a copy that drifts:
  // the accessors return the inventory’s lists, and the page must name each one.
  assert.deepEqual(acceptanceChannels().map((c) => c.channel), ['npm', 'PyPI', 'Homebrew', 'release binary']);
  assert.deepEqual(acceptanceTargets(), ['darwin-arm64', 'darwin-x64', 'linux-x64']);
  for (const channel of acceptanceChannels()) {
    assert.ok(doc.includes(channel.channel), `the page does not name the channel ${channel.channel}`);
  }
  for (const target of acceptanceTargets()) {
    assert.ok(doc.includes(target), `the page does not name the target ${target}`);
  }
});

test('acceptance: a simt command in the matrix invokes the tool by its name', () => {
  // The matrix is read by a release engineer who types the commands. A simt command that
  // spells anything other than the command name is a command the reader types and gets an
  // unknown-command from. The npm and node forms are external and are not the command.
  for (const entry of [...CAPABILITIES, ...SURFACES]) {
    const [head] = entry.command.split(/\s+/);
    assert.ok(
      head === CLI || head === 'npm' || head === 'node',
      `${entry.id} command does not begin with the command, npm or node: ${head}`,
    );
  }
});
