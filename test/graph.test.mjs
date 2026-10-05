import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { lintRegistry, loadRegistry } from '../src/graph/load.mjs';
import { KNOWN_TAGS } from '../src/resolve/fingerprint.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = await readFile(resolve(ROOT, 'graph', 'skills.graph.json'), 'utf8');
const real = JSON.parse(REGISTRY);

/** Deep clone so each test can mutate freely. */
function clone() {
  return JSON.parse(REGISTRY);
}

function codes(registry) {
  return lintRegistry(registry).sync;
}

test('registry: the real registry has no structural errors', () => {
  // Guards against a rule being added that the current data violates.
  assert.deepEqual(codes(clone()), []);
});

test('registry: lint is clean against the filesystem too', async () => {
  // The strongest check in the suite: every declared source path exists and its
  // measured bytes match. Catches renames, deletions and silent drift.
  const { ok, errors } = await loadRegistry();
  assert.equal(ok, true, errors.join('\n'));
});

test('registry: every skill is reachable and addressable', () => {
  const names = real.skills.map((s) => s.name);
  assert.equal(new Set(names).size, names.length, 'duplicate skill name');
  for (const skill of real.skills) {
    assert.ok(skill.keywords.length > 0, `${skill.name} has no keywords`);
    assert.ok(skill.capabilities.length > 0, `${skill.name} has no capability`);
    assert.ok(skill.stack.length > 0, `${skill.name} has no stack`);
  }
});

test('registry: every capability has at least one covering skill', () => {
  const covered = new Set(real.skills.flatMap((s) => s.capabilities));
  const orphans = real.capabilities.map((c) => c.id).filter((id) => !covered.has(id));
  assert.deepEqual(orphans, [], `orphan capabilities: ${orphans.join(', ')}`);
});

test('registry: stack tags are all emitted by fingerprint', () => {
  // A tag the detector cannot produce matches nothing, silently, forever.
  const used = new Set(real.skills.flatMap((s) => s.stack));
  const unknown = [...used].filter((tag) => !KNOWN_TAGS.has(tag));
  assert.deepEqual(unknown, [], `tags fingerprint() cannot emit: ${unknown.join(', ')}`);
});

test('registry: deferred is derived, never chosen', () => {
  // A hand-edited `deferred: false` on a 384 KB skill would put the whole
  // Cloudflare reference into a context window. This is the check that prevents it.
  const threshold = real.deferredThreshold;
  for (const skill of real.skills) {
    const shouldDefer = skill.bytes > threshold;
    if (shouldDefer) assert.equal(skill.deferred, true, `${skill.name} should be deferred`);
    else assert.notEqual(skill.deferred, true, `${skill.name} should not be deferred`);
  }
});

test('registry: milestone-commit is the only alias and it terminates', () => {
  const aliases = real.skills.filter((s) => s.aliasOf);
  assert.deepEqual(aliases.map((s) => `${s.name}->${s.aliasOf}`), ['milestone-commit->slice-commit']);
});

test('lint: detects a duplicate skill name', () => {
  const g = clone();
  g.skills.push({ ...g.skills[0] });
  assert.ok(codes(g).some((e) => e.includes('duplicate skill name')));
});

test('lint: detects a stack tag fingerprint cannot emit', () => {
  const g = clone();
  g.skills[0].stack.push('d1'); // real tag in the ecosystem, but not emitted
  assert.ok(codes(g).some((e) => e.includes('is not emitted by fingerprint')));
});

test('lint: detects an orphan capability', () => {
  const g = clone();
  g.capabilities.push({ id: 'ghost', summary: 'nothing covers this' });
  assert.ok(codes(g).some((e) => e.includes('orphan')));
});

test('lint: detects a dangling requires', () => {
  const g = clone();
  g.skills[0].requires = ['does-not-exist'];
  assert.ok(codes(g).some((e) => e.includes('requires unknown skill')));
});

test('lint: detects a cycle in requires', () => {
  const g = clone();
  // Two nodes that do not already require each other, so the only error the
  // cycle check can legitimately report is the cycle itself.
  const a = g.skills.find((s) => s.name === 'add-screen-or-overlay');
  const b = g.skills.find((s) => s.name === 'build-test-verify');
  a.requires = [b.name];
  b.requires = [a.name];
  assert.ok(codes(g).some((e) => e.includes('requires cycle')));
});

test('lint: detects alias-of-alias instead of a chain', () => {
  const g = clone();
  const alias = g.skills.find((s) => s.aliasOf);
  g.skills.find((s) => s.name === alias.aliasOf).aliasOf = alias.name;
  assert.ok(codes(g).some((e) => e.includes('alias-of-alias')));
});

test('lint: detects a variant outside the parent stack', () => {
  const g = clone();
  const skill = g.skills.find((s) => s.variants);
  skill.variants[0].stack.push('python');
  assert.ok(codes(g).some((e) => e.includes('not in the parent node')));
});

test('lint: detects sibling members sharing an identical stack', () => {
  const g = clone();
  const group = g.siblingGroups[0];
  const [first, second] = group.members.map((m) => g.skills.find((s) => s.name === m));
  second.stack = [...first.stack];
  assert.ok(codes(g).some((e) => e.includes('must be discriminated by stack')));
});

test('lint: detects an invalid source role once, not twice', () => {
  const g = clone();
  g.skills[0].sources[0].role = 'primary';
  const found = codes(g).filter((e) => e.includes('invalid role'));
  assert.equal(found.length, 1);
  assert.ok(!codes(g).some((e) => e.includes('canonical source')));
});

test('lint: an alias is not required to carry a canonical source', async () => {
  // milestone-commit is fully retired and delegates to slice-commit. Requiring a
  // canonical source would force a fake entry onto a node that exists to point
  // elsewhere; that was a real lint finding and the rule was wrong, not the data.
  const { ok, errors } = await loadRegistry();
  assert.equal(ok, true, errors.join('\n'));
});

test('lint: reports a missing file rather than throwing', async () => {
  const { ok, errors } = await loadRegistry('/definitely/not/a/registry.json');
  assert.equal(ok, false);
  assert.match(errors[0], /unreadable|invalid JSON/);
});