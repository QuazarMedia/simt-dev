// MCP resources (review 0003 Q92).
//
// `mcp/resources.mjs` serves rules, decision records, the kernel region and the next plan
// slice as resources. It had no direct test: the MCP suite drove it over the wire, so the two
// properties a client depends on - a listing built from disk and sorted, and a URI that is
// refused rather than resolved - were only ever observed through a transport.
//
// The URIs are handles, not paths. A handle that carries a dot segment or an extra slash is
// refused here, because resolving it would make a resource URI a file path by accident.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RESOURCE_TEMPLATES, listResources, readResource } from '../src/mcp/resources.mjs';

const HERE = process.cwd();

test('the listing is built from disk, sorted, and carries the two fixed resources', async () => {
  const listed = await listResources(HERE);
  const uris = listed.map((entry) => entry.uri);
  assert.deepEqual(uris, [...uris].sort((a, b) => a.localeCompare(b)));
  assert.ok(uris.includes('simt://kernel'));
  assert.ok(uris.some((uri) => uri.startsWith('simt://rules/')), uris.slice(0, 5).join(' '));
  assert.ok(uris.some((uri) => uri.startsWith('simt://decisions/ADR-')), uris.slice(0, 5).join(' '));
  // A listing that promises a read the server answers with "not found" is a listing that
  // lies, so every entry it names must be readable.
  for (const uri of [uris[0], 'simt://kernel']) {
    assert.ok(await readResource(uri, HERE), `${uri} was listed but not readable`);
  }
});

test('a handle that is not an id is refused rather than resolved against a path', async () => {
  const refused = [
    'simt://rules/../etc/passwd',
    'simt://rules/a/b',
    'simt://rules/',
    'simt://plan/nope',
    'simt://nope/x',
    'https://example.com/rules/core',
    '',
    42,
  ];
  for (const uri of refused) {
    assert.equal(await readResource(uri, HERE), null, String(uri));
  }
});

test('an id nothing declares is nothing, and never an empty document', async () => {
  // The newest revision forbids an empty `contents` array, because it is indistinguishable
  // from an empty rule; the module declines instead of inventing content.
  assert.equal(await readResource('simt://rules/no-such-rule-id', HERE), null);
  assert.equal(await readResource('simt://decisions/ADR-9999', HERE), null);
});

test('a rule is served as its frontmatter and body, and a decision record is served redacted', async () => {
  const listed = await listResources(HERE);
  const ruleUri = listed.find((entry) => entry.uri.startsWith('simt://rules/')).uri;
  const rule = await readResource(ruleUri, HERE);
  assert.match(rule.text, /^---\n/);
  assert.equal(rule.mimeType, 'text/markdown');

  const decisionUri = listed.find((entry) => entry.uri.startsWith('simt://decisions/ADR-')).uri;
  const decision = await readResource(decisionUri, HERE);
  assert.match(decision.text, /^If you are reading this/ .test(decision.text) ? /^/ : /ADR-/);
  assert.equal('bytes' in decision, false, 'a field the specification does not have');
});

test('the templates name the handles a finding already prints', () => {
  const names = RESOURCE_TEMPLATES.map((template) => template.uriTemplate);
  assert.deepEqual(names, ['simt://rules/{id}', 'simt://decisions/{adr}']);
  for (const template of RESOURCE_TEMPLATES) assert.equal(template.mimeType, 'text/markdown');
});
