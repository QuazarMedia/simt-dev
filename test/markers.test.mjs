import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compose, diff, inject, parse, BEGIN, END } from '../src/projection/markers.mjs';
import { provenanceDigest } from '../src/projection/rules.mjs';

const HAND = ['# My Project', '', 'Hand-written guidance that must survive.', ''].join('\n');

test('markers: an absent region parses as absent, not as malformed', () => {
  const state = parse(HAND);
  assert.equal(state.status, 'absent');
});

test('markers: parse round-trips and recovers the provenance sha', () => {
  const region = compose('body line', { sha: 'abc1234', sources: ['rules/core.md'] });
  const state = parse(`${HAND}\n${region}\n`);
  assert.equal(state.status, 'ok');
  assert.equal(state.sha, 'abc1234');
  assert.match(state.body, /simt-dev:sources=rules\/core\.md/);
  assert.match(state.before, /Hand-written guidance/);
});

test('markers: injecting preserves every byte outside the region', () => {
  const before = `${HAND}\n${compose('v1', { sha: 'aaaaaaa' })}\n\n## Local section\n\nlocal only.\n`;
  const after = inject(before, 'v2', { sha: 'bbbbbbb' });
  assert.equal(after.action, 'updated');
  assert.match(after.text, /Hand-written guidance that must survive\./);
  assert.match(after.text, /## Local section/);
  assert.match(after.text, /local only\./);
  assert.match(after.text, /^v2$/m);
  assert.doesNotMatch(after.text, /^v1$/m);
});

test('markers: inject is idempotent', () => {
  // The property that keeps CI from flaking: running sync twice must be a no-op.
  const once = inject(HAND, 'the body', { sha: 'abc1234' });
  const twice = inject(once.text, 'the body', { sha: 'abc1234' });
  assert.equal(twice.action, 'unchanged');
  assert.equal(twice.text, once.text);

  const third = inject(twice.text, 'the body', { sha: 'abc1234' });
  assert.equal(third.text, once.text);
});

test('markers: a missing region is added without destroying the document', () => {
  const result = inject(HAND, 'new body', { sha: 'abc1234' });
  assert.equal(result.action, 'added');
  assert.match(result.text, /Hand-written guidance/);
  assert.match(result.text, /new body/);
  assert.ok(result.text.startsWith('# My Project'));
});

test('markers: a doc without a trailing newline is handled', () => {
  const noNewline = '# Title\n\ntext';
  const result = inject(noNewline, 'body', { sha: 'abc1234' });
  assert.equal(result.action, 'added');
  assert.ok(result.text.startsWith('# Title\n\ntext\n'));
  assert.equal(inject(result.text, 'body', { sha: 'abc1234' }).action, 'unchanged');
});

test('markers: an unbalanced begin is malformed, never silently appended to', () => {
  // Appending a second region here would duplicate every rule in the document
  // while reporting success. This is the failure the engine exists to prevent.
  const broken = `${HAND}\n${BEGIN}\nbody with no end\n`;
  const state = parse(broken);
  assert.equal(state.status, 'malformed');
  assert.match(state.reason, /no matching end marker/);

  const result = inject(broken, 'new', { sha: 'abc1234' });
  assert.equal(result.action, 'malformed');
  assert.equal(result.text, broken, 'a malformed document must not be rewritten');
});

test('markers: an end before any begin is malformed', () => {
  const broken = `${HAND}\n${END}\n${BEGIN}\nbody\n${END}\n`;
  const state = parse(broken);
  assert.equal(state.status, 'malformed');
  assert.match(state.reason, /end marker before any begin/);
});

test('markers: two regions are reported rather than merged', () => {
  const broken = `${BEGIN}\na\n${END}\n${BEGIN}\nb\n${END}\n`;
  assert.equal(parse(broken).status, 'malformed');
});

test('markers: nested markers are malformed', () => {
  assert.equal(parse(`${BEGIN}\na\n${BEGIN}\nb\n${END}\n`).status, 'malformed');
  assert.equal(parse(`${BEGIN}\na\n${END}\n${END}\n`).status, 'malformed');
});

test('markers: markers inside a fenced code block are documentation, not control', () => {
  // A repo whose AGENTS.md explains this mechanism must not confuse the engine.
  const doc = [
    '# Rules',
    '',
    '## How the projection works',
    '',
    '```markdown',
    `${BEGIN}`,
    'example body',
    `${END}`,
    '```',
    '',
  ].join('\n');
  const state = parse(doc);
  assert.equal(state.status, 'absent');

  const result = inject(doc, 'real body', { sha: 'abc1234' });
  assert.equal(result.action, 'added');
  // The documented example survives; the real region is added after it.
  assert.match(result.text, /```markdown/);
  assert.match(result.text, /example body/);
  assert.match(result.text, /real body/);
  assert.equal(inject(result.text, 'real body', { sha: 'abc1234' }).action, 'unchanged');
});

test('markers: diff reports without writing', () => {
  const meta = { sha: 'abc1234' };
  const current = inject(HAND, 'v1', meta).text;
  assert.deepEqual(diff(current, 'v1', meta), { action: 'unchanged' });
  assert.deepEqual(diff(current, 'v2', meta), { action: 'updated' });
  assert.deepEqual(diff(HAND, 'v1', meta), { action: 'added' });
  assert.equal(diff(`${BEGIN}\nunclosed\n`, 'v1', meta).action, 'malformed');
});

test('markers: a changed sha alone counts as drift', () => {
  // The body is byte-identical but was produced by an older simt-dev. That is
  // exactly the drift the provenance header exists to surface, so `simt-dev check`
  // must not treat it as unchanged.
  const old = inject(HAND, 'body', { sha: 'aaaaaaa' }).text;
  const same = { sha: 'aaaaaaa' };
  const newer = { sha: 'bbbbbbb' };
  assert.equal(diff(old, 'body', same).action, 'unchanged');
  assert.equal(diff(old, 'body', newer).action, 'updated');
  assert.equal(parse(old).sha, 'aaaaaaa');
});

test('markers: compose refuses to write a stamp it could not read back', () => {
  // The failure this prevents: `headSha()` used to fall back to the string `unknown`,
  // the marker grammar reads `[0-9a-f]{7,40}`, so the tool wrote a stamp its own parser
  // rejected — and then compared that stamp against a real pin as though the two were
  // versions. Every npm install got one, because the published tarball has no `.git`.
  // A writer that cannot emit an unreadable value is what makes that unrepresentable.
  for (const bad of [undefined, null, '', 'unknown', 'not-a-sha', 'ABC1234', 'abc123', 42, {}]) {
    assert.throws(() => compose('body', { sha: bad }), /compose: sha/, `accepted ${JSON.stringify(bad)}`);
  }
  // And what it does accept is exactly what the reader accepts, in both surfaces.
  const region = compose('body', { sha: 'abc1234' });
  assert.equal(parse(region).sha, 'abc1234');
  assert.equal(parse(compose('body', { sha: 'abc1234' }, 'hash'), 'hash').sha, 'abc1234');
  assert.equal(parse(compose('body', { sha: 'a'.repeat(40) })).sha, 'a'.repeat(40));
});

test('markers: a content digest is a stamp the grammar accepts', async () => {
  // The stamp is now a digest of `rules/` and `graph/` rather than a commit id, so it
  // is 40 hex characters. This asserts the real value is readable by the real parser,
  // which is the property that failed: writing and reading must share one grammar.
  const digest = await provenanceDigest();
  assert.match(digest, /^[0-9a-f]{40}$/);
  const state = parse(compose('body', { sha: digest }));
  assert.equal(state.sha, digest);
  // Stable across calls: a stamp that changed when nothing changed would report drift
  // on every run, which is the estate's own rule that a report must be a fact.
  assert.equal(await provenanceDigest(), digest);
});

test('markers: compose emits begin before end and carries the header inside', () => {
  const region = compose('x', { sha: 'abc1234', sources: ['a', 'b'] });
  assert.ok(region.startsWith(BEGIN));
  assert.ok(region.indexOf(BEGIN) < region.indexOf('simt-dev:sha'));
  assert.ok(region.indexOf('simt-dev:sha') < region.indexOf(END));
});

test('markers: compose is already in the shape a formatter would write it', () => {
  // The regression, and it was found by committing to a real repo: simt-space has a
  // prettier pre-commit hook. It rewrote the freshly generated region on the very
  // first commit - a blank line after the header comment, plus the trailing newline -
  // and `check` reported drift on a repo whose own tooling was working correctly. A
  // projection that emits text a formatter will change is a fight it loses, so it
  // emits the formatter's shape from the start.
  const region = compose('body line', { sha: 'abc1234' });
  assert.ok(region.endsWith('\n'), 'the region must end with a newline');
  const lines = region.replace(/\n$/, '').split('\n');
  assert.equal(lines.at(-1), END, 'the last line is the end marker, with nothing after it');
  const header = lines.findIndex((l) => l.startsWith('<!-- Generated content. Do not edit by hand'));
  assert.ok(header > 0, 'the do-not-edit comment must be inside the region');
  const bodyAt = lines.indexOf('body line');
  assert.equal(lines[bodyAt - 1], '', 'a blank line separates the header comment from the body');
});
// Added after bunnyland-server's `git diff --check` gate reported
// `AGENTS.md:573: new blank line at EOF` on a freshly adopted file. The suite was
// green through the defect because every assertion compared the region BODY, and
// the stray byte sat after END where no comparison looked.
test('adding a region leaves exactly one newline at end of file', () => {
  for (const prefix of ['', 'line one', 'line one\n', 'a\n\n']) {
    const { text } = inject(prefix, 'BODY', { sha: 'abc1234' });
    assert.ok(!text.endsWith('\n\n'), `blank line at EOF for ${JSON.stringify(prefix)}`);
    assert.ok(text.endsWith(`${END}\n`), `region not terminated once for ${JSON.stringify(prefix)}`);
  }
});

test('the added and updated paths agree on the bytes around the region', () => {
  const meta = { sha: 'abc1234' };
  const added = inject('intro\n', 'BODY', meta).text;
  const updated = inject(added, 'BODY2', meta).text;
  assert.ok(updated.endsWith(`${END}\n`), 'an update must leave the region terminated');
  assert.ok(!updated.endsWith('\n\n'), 'an update must not introduce a trailing blank line');
});

// simt-blog's `format:check` failed on a correct generated region: prettier treats
// an HTML comment after a paragraph as a new block and inserts the separating
// blank line itself. The region must already be in that shape, or a repo whose
// formatter works correctly is permanently red on a file the tool owns.
test('the region carries a blank line on both sides of the body', () => {
  const { text } = inject('prose\n', 'BODY', { sha: 'abc1234' });
  const bodyStart = text.indexOf('BODY');
  assert.ok(text.slice(bodyStart - 2, bodyStart) === '\n\n', 'no blank line before the body');
  assert.ok(text.slice(bodyStart + 4, bodyStart + 6) === '\n\n', 'no blank line before END');
  assert.ok(text.endsWith(`${END}\n`), 'region must still terminate exactly once');
});
