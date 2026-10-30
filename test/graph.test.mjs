import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { lintRegistry, loadRegistry, workspace } from '../src/graph/load.mjs';
import { SPEC, SPEC_SOURCE } from '../src/graph/spec.mjs';
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

test('lint: detects a path glob that matches nothing (S02)', () => {
  // The check that would have caught the 13 dead globs. Every other lint rule asks
  // whether a value is well-formed; this one asks whether it does anything, which is
  // the only question the resolver has about a glob.
  const g = clone();
  g.skills[0].paths = [...(g.skills[0].paths ?? []), 'src/a?.ts'];
  assert.ok(
    codes(g).some((e) => e.includes('does not match')),
    'a glob that matches nothing it claims must be an error',
  );
});

test('lint: a reachable glob is not reported, including one with ** in it', () => {
  // The other half, because a check that fires on everything is indistinguishable
  // from one that fires on the right thing.
  const g = clone();
  g.skills[0].paths = ['src/**/*.ts', '**/*.kt', 'migrations/**', '**'];
  assert.deepEqual(codes(g), []);
});

test('lint: detects a keyword no task can produce (S03)', () => {
  // The field already had a check and it asked the wrong question: `needs keywords` is
  // satisfied by a list of words the tokenizer throws away. This asks whether one is
  // sayable.
  const g = clone();
  g.skills[0].keywords = [...(g.skills[0].keywords ?? []), 'x'];
  assert.ok(
    codes(g).some((e) => e.includes('cannot be reached')),
    'a keyword the tokenizer keeps no word of must be an error',
  );
});

test('lint: a multi-word keyword is reachable and must not be reported (S03)', () => {
  // The other half. Phrases are matched as phrases now, so the longest keyword in the
  // registry is a legal one, and a check that rejected it would push the fix backwards.
  const g = clone();
  g.skills[0].keywords = ['durable object', 'd1 migrations apply', 'ci', 'r2'];
  assert.deepEqual(codes(g), []);
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

test('lint: a diamond in requires is sharing, not a cycle (Q35)', () => {
  // The breadth-first walk shared one `seen` set across branches and reported
  // a -> {b, c} -> d as `cycle a -> b -> c -> d -> d`. Depth-first with a
  // recursion stack must stay silent here.
  const g = clone();
  const [a, b, c, d] = ['a-diamond', 'b-diamond', 'c-diamond', 'd-diamond'];
  const leaf = (name) => ({
    name,
    summary: 'a probe node',
    capabilities: [g.capabilities[0].id],
    stack: ['node'],
    paths: ['src/probe.ts'],
    keywords: ['probe'],
    bytes: 10,
  });
  g.skills.push(leaf(a), leaf(b), leaf(c), leaf(d));
  const byName = new Map(g.skills.map((s) => [s.name, s]));
  byName.get(a).requires = [b, c];
  byName.get(b).requires = [d];
  byName.get(c).requires = [d];
  assert.deepEqual(
    codes(g).filter((e) => e.includes('requires cycle')),
    [],
    'a diamond must not be reported as a cycle',
  );
});

test('lint: missing capabilities is one shape error, never a crash (Q35)', () => {
  // The shape check recorded the error and then iterated the missing array
  // anyway: `not iterable`. The lint stops after a shape failure now.
  const g = clone();
  delete g.capabilities;
  assert.deepEqual(codes(g), ['capabilities: missing or empty']);
});

test('lint: missing skills is one shape error, never secondary noise (Q35)', () => {
  const g = clone();
  g.skills = [];
  assert.deepEqual(codes(g), ['skills: missing or empty']);
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

test('registry: --registry flag and SIMT_REGISTRY name the file (Q37)', async () => {
  // Outside the estate no registry resolves by default, so the reader must be
  // able to name one. The order is the flag, then the environment, then the
  // default tiers.
  const dir = await mkdtemp(join(tmpdir(), 'simt-reg-'));
  try {
    const reg = join(dir, 'registry.json');
    await writeFile(reg, REGISTRY);
    const flagged = await loadRegistry(null, { registry: reg });
    assert.equal(flagged.ok, true, flagged.errors.join('\n'));
    assert.equal(flagged.path, reg);

    const prev = process.env.SIMT_REGISTRY;
    process.env.SIMT_REGISTRY = reg;
    try {
      const fromEnv = await loadRegistry(null, {});
      assert.equal(fromEnv.ok, true, fromEnv.errors.join('\n'));
      assert.equal(fromEnv.path, reg);

      const other = join(dir, 'other.json');
      await writeFile(other, REGISTRY);
      const flagWins = await loadRegistry(null, { registry: other });
      assert.equal(flagWins.path, other, 'the flag beats the environment');
    } finally {
      if (prev === undefined) delete process.env.SIMT_REGISTRY;
      else process.env.SIMT_REGISTRY = prev;
    }

    const missing = await loadRegistry(null, { registry: join(dir, 'absent.json') });
    assert.equal(missing.ok, false);
    assert.match(missing.errors[0], /absent\.json/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI: the default lint runs no spec pass and stays honest about it (Q35)', async () => {
  // The spec pass used to run without `--spec`: 37 warnings for a pass the
  // payload claimed never ran (`spec: null`).
  const { code, stdout } = await runCli(['graph', 'lint', '--json']);
  assert.equal(code, 0, stdout);
  const payload = JSON.parse(stdout);
  assert.equal(payload.spec, null);
  assert.deepEqual(
    payload.warnings.filter((w) => /conformance pass|SKILL\.md/.test(w)),
    [],
    'no spec-pass warnings without --spec',
  );
});

test('CLI: errors found after the load still fail the JSON contract (Q35)', async () => {
  // `--json` reported `ok: true`, exit 0 with errors present; text said FAIL.
  const dir = await mkdtemp(join(tmpdir(), 'simt-graph-'));
  try {
    const broken = clone();
    broken.skills.push({ ...broken.skills[0] });
    const reg = join(dir, 'registry.json');
    await writeFile(reg, JSON.stringify(broken));
    const { code, stdout } = await runCli(['graph', 'lint', '--json', reg]);
    assert.notEqual(code, 0, 'errors must fail the exit code');
    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.errors.some((e) => e.includes('duplicate skill name')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI: --spec without a verified registry skips loudly instead of warning 37 times (Q35)', async () => {
  const { stdout } = await runCli(['graph', 'lint', '--json', '--spec', SPEC]);
  const payload = JSON.parse(stdout);
  assert.deepEqual(payload.spec, { name: SPEC, source: SPEC_SOURCE, checked: 0 });
  assert.ok(payload.warnings.some((w) => w.includes('spec pass skipped')));
});

const BIN = resolve(ROOT, 'bin', 'simt.mjs');
const exec = promisify(execFile);

async function runCli(args, env = {}) {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args], {
      maxBuffer: 16 << 20,
      env: { ...process.env, NO_COLOR: '1', SIMT_DEV_WORKSPACE: 'off', ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('workspace: different flags resolve different workspaces (Q14)', async () => {
  // The memo used to be first-call-wins for the process lifetime, so a call with
  // `{workspace: ws}` poisoned every later caller. The key is the inputs now.
  const first = await mkdtemp(join(tmpdir(), 'simt-ws-a-'));
  const second = await mkdtemp(join(tmpdir(), 'simt-ws-b-'));
  try {
    const a = await workspace({ workspace: first });
    const b = await workspace({ workspace: second });
    assert.equal(a.root, first);
    assert.equal(b.root, second);
    const again = await workspace({ workspace: first });
    assert.equal(again.root, first, 'same inputs share the one resolution');
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});