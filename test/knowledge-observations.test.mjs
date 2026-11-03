// Plan 0004 W15: source observations and a bounded refresh that is only ever a plan.
//
// The unit is the observation, not the document: a source, the instant it was read, a
// digest, the source's own revision and a parse status. Three assertions carry the slice.
// A cosmetic change (line endings, trailing spaces) is `unchanged` only under a reviewed,
// versioned canonicalizer, and never at the cost of an amount or a date. A 304 is a new
// observation of the same content revision, not a new content revision. And a transport
// failure is `unknown`, because nothing was observed - the previous record must not stand
// in for a read that did not happen.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  CANONICALIZER_IDS,
  CHANGES,
  FRESHNESS_STATES,
  PARSE_STATUSES,
  applyResponse,
  canonicalize,
  checkDestination,
  checkRedirect,
  digestOf,
  freshness,
  invalidate,
  planRefresh,
  readObservation,
} from '../src/knowledge/observations.mjs';

const SOURCE = 'https://docs.example.org/rates';
const POLICY = { allowlist: ['example.org'], maxRequests: 2, maxBytes: 4096, maxRedirects: 1, schemes: ['https'] };
const STAMP = '2026-01-01T00:00:00Z';
const LATER = '2026-01-02T00:00:00Z';

const first = () =>
  applyResponse(null, { status: 200, body: '# Rates\n\nA 19 % rate applies.\n\nEffective 2025-01-01.\n', revision: '"v1"', source: SOURCE }, { fetchedAt: STAMP, policy: { canonicalizer: { id: 'line-endings-v1', version: 1 } } });

test('an observation is a record of a read, validated where it is written', () => {
  const read = readObservation({ source: SOURCE, fetchedAt: STAMP, digest: digestOf('x'), revision: '"v1"', parseStatus: 'parsed', canonicalizer: { id: 'line-endings-v1', version: 1 }, scope: { start: 0, end: 12 } });
  assert.deepEqual(read.problems, undefined);
  assert.equal(read.observation.source, SOURCE);
  assert.equal(read.observation.parseStatus, 'parsed');
  assert.deepEqual(read.observation.scope, { start: 0, end: 12 });

  assert.match(readObservation({ source: SOURCE, fetchedAt: '2026-01-01' }).problems.join('\n'), /fetchedAt must be an ISO instant/);
  assert.match(readObservation({ source: SOURCE, fetchedAt: STAMP, digest: 'md5-1' }).problems.join('\n'), /digest must be sha256/);
  assert.match(readObservation({ source: SOURCE, fetchedAt: STAMP, parseStatus: 'probably' }).problems.join('\n'), /parseStatus must be one of/);
  assert.match(readObservation({ source: SOURCE, fetchedAt: STAMP, canonicalizer: { id: 'tidy', version: 1 } }).problems.join('\n'), /canonicalizer must be one of/);
  assert.deepEqual(CANONICALIZER_IDS, ['line-endings-v1']);
  assert.deepEqual(PARSE_STATUSES, ['parsed', 'unsupported', 'failed']);
});

test('a refresh plan may not address a private destination, a stray host or an undeclared port', () => {
  assert.equal(checkDestination(SOURCE, POLICY).ok, true);
  assert.equal(checkDestination('https://docs.example.org/deep/page', POLICY).ok, true, 'a subdomain of an allowlisted host');

  const refused = (url, policy = POLICY) => checkDestination(url, policy);
  assert.match(refused('http://docs.example.org/rates').reason, /scheme http is not one of https/);
  assert.match(refused('https://evil-example.org/rates').reason, /not in the declared allowlist/);
  assert.match(refused('https://example.org.evil.test/rates').reason, /not in the declared allowlist/);
  assert.match(refused('https://localhost/rates').reason, /private destination/);
  assert.match(refused('https://127.0.0.1/rates').reason, /private destination/);
  assert.match(refused('https://10.1.2.3/rates').reason, /private destination/);
  assert.match(refused('https://192.168.0.5/rates').reason, /private destination/);
  assert.match(refused('https://172.20.0.1/rates').reason, /private destination/);
  assert.match(refused('https://169.254.169.254/latest').reason, /private destination/, 'the metadata address');
  assert.match(refused('https://[::1]/rates').reason, /private destination/);
  assert.match(refused('https://docs.example.org:8443/rates').reason, /port 8443/);
  assert.match(refused('https://user:secret@docs.example.org/rates').reason, /may not carry credentials/);
  assert.match(refused('https://docs.example.org/rates', { ...POLICY, allowlist: [] }).reason, /no allowlist is declared/);

  assert.equal(checkRedirect('https://docs.example.org/moved', POLICY, { hops: 0 }).ok, true);
  assert.match(checkRedirect('https://127.0.0.1/admin', POLICY, { hops: 0 }).reason, /private destination/, 'a redirect is a destination too');
  assert.match(checkRedirect('http://docs.example.org/plain', POLICY, { hops: 0 }).reason, /scheme http is not one of https/, 'a downgrade is refused as a scheme, not as a host');
  assert.match(checkRedirect('https://docs.example.org/moved', POLICY, { hops: 1 }).reason, /redirect budget of 1 is exhausted/);
});

test('a refresh carries the conditional request and its budget, and sends nothing by itself', () => {
  const observation = first().observation;
  const plan = planRefresh(observation, POLICY, { fetchedAt: LATER });
  assert.equal(plan.allowed, true);
  assert.deepEqual(plan.refusals, []);
  assert.deepEqual(plan.request.headers, { 'if-none-match': '"v1"' });
  assert.equal(plan.request.method, 'GET');
  assert.deepEqual(plan.request.budget, { requests: 2, bytes: 4096 });

  const initial = planRefresh({ source: SOURCE }, POLICY);
  assert.deepEqual(initial.request.headers, {}, 'a first read has nothing to be conditional on');

  const exhausted = planRefresh(observation, { ...POLICY, maxRequests: 0 });
  assert.equal(exhausted.allowed, false);
  assert.match(exhausted.refusals.join(' '), /request budget is exhausted/);

  const nowhere = planRefresh(null, POLICY);
  assert.equal(nowhere.allowed, false);
  assert.match(nowhere.refusals.join(' '), /no source to refresh/);
});

test('a cosmetic change is unchanged under a reviewed canonicalizer, and cannot hide an amount or a date', () => {
  const policy = { canonicalizer: { id: 'line-endings-v1', version: 1 } };
  const base = applyResponse(null, { status: 200, body: 'A 19 % rate applies.\nEffective 2025-01-01.\n', source: SOURCE }, { fetchedAt: STAMP, policy });
  const cosmetic = applyResponse(base.observation, { status: 200, body: 'A 19 % rate applies.   \r\nEffective 2025-01-01.\r\n' }, { fetchedAt: LATER, policy });
  assert.equal(cosmetic.changed, 'unchanged', 'line endings and trailing spaces are not a content change');
  assert.equal(cosmetic.observation.fetchedAt, LATER, 'the observation is still new');
  assert.notEqual(cosmetic.observation.rawDigest, base.observation.rawDigest, 'the raw bytes are kept beside the canonical digest');
  assert.equal(cosmetic.observation.digest, base.observation.digest);

  const operative = applyResponse(base.observation, { status: 200, body: 'A 21 % rate applies.\nEffective 2025-01-01.\n' }, { fetchedAt: LATER, policy });
  assert.equal(operative.changed, 'changed');

  const dateOnly = applyResponse(base.observation, { status: 200, body: 'A 19 % rate applies.\nEffective 2026-01-01.\n' }, { fetchedAt: LATER, policy });
  assert.equal(dateOnly.changed, 'changed', 'a moved date is an operative change');

  const plain = applyResponse(null, { status: 200, body: 'A 19 % rate applies.\nEffective 2025-01-01.\n', source: SOURCE }, { fetchedAt: STAMP });
  const raw = applyResponse(plain.observation, { status: 200, body: 'A 19 % rate applies.\nEffective 2025-01-01.\r\n' }, { fetchedAt: LATER });
  assert.equal(raw.changed, 'changed', 'without a canonicalizer nothing is ignored');

  const canonical = canonicalize('A 19 % rate applies.  \r\nEffective 2025-01-01.\r\n', { canonicalizer: { id: 'line-endings-v1', version: 1 } });
  assert.match(canonical.text, /19 %/);
  assert.match(canonical.text, /2025-01-01/);
  assert.throws(() => canonicalize('x', { canonicalizer: { id: 'tidy', version: 1 } }), /is not one of line-endings-v1/);
  assert.throws(() => canonicalize('x', { canonicalizer: { id: 'line-endings-v1', version: 2 } }), /is version 1, not 2/);
});

test('a 304 keeps the content revision and records a new observation', () => {
  const base = first();
  const notModified = applyResponse(base.observation, { status: 304 }, { fetchedAt: LATER, policy: POLICY });
  assert.equal(notModified.changed, 'not-modified');
  assert.equal(notModified.observation.digest, base.observation.digest);
  assert.equal(notModified.observation.revision, '"v1"', 'the etag survives the not-modified response');
  assert.equal(notModified.observation.fetchedAt, LATER);
  assert.match(notModified.reason, /only the observation is new/);

  const orphan = applyResponse(null, { status: 304 }, { fetchedAt: LATER });
  assert.equal(orphan.changed, 'unknown');
  assert.equal(orphan.observation, null);
});

test('a transport failure is unknown, and the claims that depend on it are undetermined', () => {
  const failure = applyResponse(first().observation, { error: 'timeout' }, { fetchedAt: LATER });
  assert.equal(failure.changed, 'unknown');
  assert.equal(failure.observation, null, 'nothing was observed, so no record was produced');
  assert.match(failure.reason, /transport failure: timeout/);

  const claims = [
    { id: 'c-rate', evidence: [SOURCE] },
    { id: 'c-other', evidence: ['https://docs.example.org/other'] },
  ];
  assert.deepEqual(invalidate(claims, { source: SOURCE, changed: 'changed' }), { invalidated: ['c-rate'], undetermined: [] });
  assert.deepEqual(invalidate(claims, { source: SOURCE, changed: 'unchanged' }), { invalidated: [], undetermined: [] });
  assert.deepEqual(invalidate(claims, { source: SOURCE, changed: 'not-modified' }), { invalidated: [], undetermined: [] });
  assert.deepEqual(invalidate(claims, { source: SOURCE, changed: 'unknown' }), { invalidated: [], undetermined: ['c-rate'] });
});

test('freshness is judged against a clock the caller supplies', () => {
  const record = first().observation;
  assert.deepEqual(FRESHNESS_STATES, ['fresh', 'stale', 'unknown']);
  assert.deepEqual(CHANGES, ['changed', 'unchanged', 'not-modified', 'unknown']);

  assert.equal(freshness(record, { now: LATER, maxAgeSeconds: 86400 }).state, 'fresh');
  assert.equal(freshness(record, { now: LATER, maxAgeSeconds: 3600 }).state, 'stale');
  assert.equal(freshness(record, { now: LATER, maxAgeSeconds: 3600 }).ageSeconds, 86400);
  assert.equal(freshness(null, { now: LATER }).state, 'unknown');
  assert.equal(freshness({ ...record, parseStatus: 'failed' }, { now: LATER }).state, 'unknown');
  assert.equal(freshness({ ...record, fetchedAt: '2026-02-01T00:00:00Z' }, { now: LATER }).state, 'unknown', 'an observation from the future is not fresh');
  assert.throws(() => freshness(record, {}), /now must be an explicit ISO instant/);
  assert.throws(() => applyResponse(null, { status: 200, body: 'x' }, {}), /fetchedAt must be an ISO instant/);
});

test('the module plans a request and never opens one', async () => {
  const source = await readFile(new URL('../src/knowledge/observations.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:http|node:https|node:net|node:tls|fetch\(|XMLHttpRequest|WebSocket/);
  assert.doesNotMatch(source, /process\.env|Date\.now|new Date\(\)/);
});
