// Plan 0004 W41: trust boundaries, injection and secret minimisation.
//
// What the suite pins: retrieved material is evidence and cannot change policy; a derived chunk
// keeps its parent's label; an adapter call is validated for operation, argv, path, URL and size
// before dispatch; a diagnostic is redacted before it is recorded; a denied path is not indexed;
// and the assurance report names unmediated routes and the shared-account limit instead of
// implying mediation it does not have.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  assuranceReport,
  canonicalPath,
  checkAdapterCall,
  inheritLabels,
  labelSource,
  mayChangePolicy,
  mayIndex,
  redactDiagnostics,
} from '../src/work/trust.mjs';

const allowlist = { api: ['read-object', 'write-object'], ssh: ['read-file'] };

test('content is labelled by where it came from, and only policy may change policy', () => {
  assert.equal(labelSource({ origin: 'repo-policy' }), 'control');
  assert.equal(labelSource({ origin: 'reviewed-contract' }), 'contract');
  assert.equal(labelSource({ origin: 'pdf' }), 'evidence');
  assert.equal(labelSource({ origin: 'web' }), 'evidence');
  assert.equal(mayChangePolicy('evidence'), false);
  assert.equal(mayChangePolicy('contract'), false);
  assert.equal(mayChangePolicy('control'), true);
});

test('a derived chunk keeps the label of what it derived from', () => {
  const chunks = inheritLabels([{ id: 'c1' }, { id: 'c2' }], 'evidence');
  assert.deepEqual(chunks.map((chunk) => chunk.label), ['evidence', 'evidence']);
  assert.deepEqual(inheritLabels([{ id: 'c1' }], 'contract'), [{ id: 'c1', label: 'contract' }]);
});

test('a path resolves inside its root or is refused', () => {
  assert.equal(canonicalPath({ path: 'docs/rates.md', root: '/repo' }), '/repo/docs/rates.md');
  assert.equal(canonicalPath({ path: '../etc/passwd', root: '/repo' }), null);
  assert.equal(canonicalPath({ path: '/etc/passwd' }), null);
  assert.equal(canonicalPath({ path: '' }), null);
  assert.equal(canonicalPath({ path: 'a\\b' }), 'a/b');
});

test('an undeclared adapter or operation is refused before dispatch', () => {
  assert.match(checkAdapterCall({ adapter: 'browser', operation: 'click', allowlist }).reason, /not declared/);
  assert.match(checkAdapterCall({ adapter: 'api', operation: 'delete-object', allowlist }).reason, /does not declare the operation/);
  assert.equal(checkAdapterCall({ adapter: 'api', operation: 'read-object', allowlist }).allowed, true);
});

test('argv, path, URL and size are validated', () => {
  assert.equal(checkAdapterCall({ adapter: 'api', operation: 'read-object', allowlist, argv: ['a\nb'] }).allowed, false);
  assert.equal(checkAdapterCall({ adapter: 'api', operation: 'read-object', allowlist, path: '../secret', root: '/repo' }).allowed, false);
  assert.equal(checkAdapterCall({ adapter: 'api', operation: 'read-object', allowlist, url: 'http://example.test' }).allowed, false);
  assert.equal(checkAdapterCall({ adapter: 'api', operation: 'read-object', allowlist, url: 'https://user:pw@example.test' }).allowed, false);
  assert.equal(checkAdapterCall({ adapter: 'api', operation: 'read-object', allowlist, url: 'https://example.test/rates' }).allowed, true);
  assert.match(checkAdapterCall({ adapter: 'api', operation: 'read-object', allowlist, size: 5_000_000 }).reason, /exceeds/);
  assert.equal(checkAdapterCall({ adapter: 'api', operation: 'read-object', allowlist, size: 10 }).allowed, true);
});

test('a diagnostic is redacted before it is recorded', () => {
  const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123';
  const redacted = redactDiagnostics(`failed with ${token}`);
  assert.doesNotMatch(redacted.text, /ghp_abcdefghijklmnopqrstuvwxyz0123/);
  assert.equal(redacted.changed, true);
  assert.equal(redactDiagnostics('nothing to hide').changed, false);
});

test('a denied path is not indexed, summarised or quoted', () => {
  assert.deepEqual(mayIndex({ path: 'secrets/keys.md', deniedPaths: ['secrets'] }), {
    indexed: false,
    reason: 'secrets/keys.md is under a denied path; its content is not indexed, summarised or quoted',
  });
  assert.equal(mayIndex({ path: 'docs/rates.md', deniedPaths: ['secrets'] }).indexed, true);
  assert.equal(mayIndex({ path: 'secrets.md', deniedPaths: ['secrets'] }).indexed, true);
  assert.equal(mayIndex({}).indexed, false);
});

test('a hostile source cannot invoke another adapter or widen the effect set', () => {
  const hostile = labelSource({ origin: 'tool-result' });
  assert.equal(hostile, 'evidence');
  assert.equal(mayChangePolicy(hostile), false);
  assert.equal(checkAdapterCall({ adapter: 'ssh', operation: 'write-object', allowlist }).allowed, false);
});

test('the assurance report names what is not mediated and what a shared account cannot do', () => {
  const report = assuranceReport({ adapters: [{ name: 'api', mediated: true }, { name: 'browser' }] });
  assert.deepEqual(report.mediated, ['api']);
  assert.deepEqual(report.unmediatedRoutes, ['browser']);
  assert.match(report.sharedUserLimits, /cannot separate actors/);
  assert.equal(report.requiresPlatformAuthorization, true);
});

test('the module is deterministic and reads nothing', async () => {
  assert.deepEqual(assuranceReport({ adapters: [{ name: 'api', mediated: true }] }), assuranceReport({ adapters: [{ name: 'api', mediated: true }] }));
  const source = await readFile(new URL('../src/work/trust.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});
