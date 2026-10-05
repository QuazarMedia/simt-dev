import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RULE_FILES, scanDocument, summarise } from '../src/projection/conflicts.mjs';
import { __internals } from '../src/projection/conflicts.mjs';

const { PROBES } = __internals;

function severityOf(text, id) {
  const found = scanDocument(text, 'AGENTS.md').filter((f) => f.id === id);
  return found[0]?.severity;
}

test('a prohibition restating a ruling is a duplicate, not a conflict', () => {
  // bunnyland's real CONTRIBUTING line, verbatim.
  const text =
    '- **Do not** use `uv run pytest` - the console entrypoint can miss the `uv` import path.';
  assert.equal(severityOf(text, 'bare-console-entrypoint'), 'duplicate');
});

test('the prohibition test survives markdown bold', () => {
  // Regression: `Do **not** use` did not match /\bdo not\b/, so a repo correctly
  // restating the rule was reported as violating it.
  assert.equal(severityOf('Do not use `uv run pytest` here.', 'bare-console-entrypoint'), 'duplicate');
  assert.equal(severityOf('**Do not** use `uv run pytest` here.', 'bare-console-entrypoint'), 'duplicate');
  assert.equal(severityOf('__Never__ use `uv run pytest` here.', 'bare-console-entrypoint'), 'duplicate');
});

test('an instruction to do the forbidden thing is a conflict', () => {
  const text = '8. Committed and pushed with a conventional message.';
  const found = scanDocument(text, 'AGENTS.md');
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'autonomous-push');
  assert.equal(found[0].severity, 'conflict');
  assert.equal(found[0].adr, 'ADR-001');
});

test('the ADR-005 ceiling alone is a duplicate, never a conflict', () => {
  // Regression: ADR-005 is deliberately two-tier so both the 400 review trigger
  // and the 1000 ceiling survive. Restating only the ceiling under-specifies; it
  // does not contradict the ruling.
  assert.equal(
    severityOf('Split any file once it exceeds 1000 lines.', 'file-length-hard-split'),
    'duplicate',
  );
});

test('npx --no-install cannot drift, so it is never a package-runner hit', () => {
  // Regression: `npx --no-install` fetches nothing, so it cannot pull a version the
  // project did not declare.
  const probe = PROBES.find((p) => p.id === 'package-runner');
  assert.equal('npx --no-install prettier'.match(probe.re), null);
  assert.notEqual('npx prettier --write'.match(probe.re), null);
  assert.equal(severityOf('Run prettier with npx --no-install.', 'package-runner'), undefined);
});

test('a single-threshold file-length rule is still a duplicate, never a conflict', () => {
  assert.equal(severityOf('Keep every file under 400 lines.', 'file-length-hard-split'), 'duplicate');
  assert.equal(severityOf('File length: 500 lines max', 'file-length-hard-split'), 'duplicate');
});

test('a bare instruction to use a package runner is a conflict', () => {
  // No prohibition anywhere near it: the text tells an agent to do the forbidden
  // thing, which is exactly what must block init.
  assert.equal(severityOf('Run prettier with npx prettier --write.', 'package-runner'), 'conflict');
  assert.equal(severityOf('Use npx tsc.', 'package-runner'), 'conflict');
});

test('uv run pytest -m is the module form and is not a hit', () => {
  assert.equal(severityOf('Run `uv run -m pytest`.', 'bare-console-entrypoint'), undefined);
});

test('findings carry a line number and a quotable single-line quote', () => {
  const text = `# Title\n\nintro\n\n8. Committed and pushed with a conventional message\n`;
  const [finding] = scanDocument(text, 'AGENTS.md');
  assert.equal(finding.line, 5);
  assert.ok(!finding.quote.includes('\n'), 'quote must be one line');
  assert.match(finding.quote, /Committed and pushed/);
});

test('every finding names the ruling it comes from', () => {
  const text = 'Committed and pushed. Run `uv run pytest`. Split any file once it exceeds 1000 lines.';
  for (const finding of scanDocument(text, 'AGENTS.md')) {
    assert.match(finding.adr, /^ADR-\d{3}$/);
    assert.ok(finding.canonical.length > 0, `${finding.id} must carry the canonical rule`);
  }
});

test('probe ids are unique', () => {
  const ids = PROBES.map((p) => p.id);
  assert.deepEqual(ids, [...new Set(ids)]);
});

test('the known estate outlier is detected and the known restatements are not conflicts', () => {
  // The 2026-10-05 audit found exactly one contradiction across all 16 repos.
  const garmin = scanDocument(
    '| 8 | Committed and pushed with a conventional message | not optional |',
    'simt-garmin/AGENTS.md',
  );
  assert.equal(garmin.filter((f) => f.severity === 'conflict').length, 1);
  assert.equal(garmin[0].adr, 'ADR-001');

  for (const text of [
    '**Do not** use `uv run pytest`; it can silently run against the wrong environment.',
    'Split any file once it exceeds 1000 lines.',
  ]) {
    assert.equal(
      scanDocument(text, 'AGENTS.md').filter((f) => f.severity === 'conflict').length,
      0,
      text,
    );
  }
});

test('summarise counts conflicts and duplicates separately', () => {
  const findings = scanDocument(
    'Committed and pushed. Do not use `uv run pytest`. Split any file once it exceeds 1000 lines.',
    'AGENTS.md',
  );
  const summary = summarise(findings);
  assert.equal(summary.conflicts, 1);
  assert.equal(summary.duplicates, 2);
  assert.equal(summary.total, 3);
  assert.deepEqual(summary.byAdr, ['ADR-001', 'ADR-005', 'ADR-010']);
});

test('RULE_FILES covers the documents a repo actually uses for rules', () => {
  assert.ok(RULE_FILES.includes('AGENTS.md'));
  assert.ok(RULE_FILES.includes('CLAUDE.md'));
  assert.ok(RULE_FILES.includes('CONTRIBUTING.md'));
});

test('an unrelated document produces no findings', () => {
  assert.deepEqual(scanDocument('# Blog\n\nWrite posts about maps.\n', 'blog-post-schema.md'), []);
});