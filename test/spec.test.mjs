// The spec is the registry (review 0003 Q60).
//
// Four copies of the command list had already disagreed when the review found them:
// README lacked `bench critic`, `ci` and `plugin`; help named seven `--reader` values
// where the binary knew eight. A list nothing checks drifts, so the check is this file:
// the spec and the dispatch map must name the same paths, in both directions, and a
// default must point at a path that exists.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { GROUP_DEFAULTS, SPEC, SPEC_PATHS } from '../src/commands/spec.mjs';
import { COMMANDS, GROUPS, IMPLEMENTED } from '../src/commands/index.mjs';
import { BOOL_FLAGS, REPEATABLE_FLAGS, VALUE_FLAGS } from '../src/argv.mjs';

test('spec: the registry and the spec name the same commands, both directions', () => {
  assert.deepEqual(SPEC_PATHS, Object.keys(IMPLEMENTED).sort());
  assert.equal(new Set(SPEC_PATHS).size, SPEC.length, 'a path is declared twice');
});

test('spec: every path has a loader that resolves to a handler', async () => {
  // The registry holds loaders, not handlers: a value that is not callable, or that
  // resolves to a module without the export it names, is a command that fails at the
  // moment a reader runs it - and only then (review 0003 Q64).
  for (const [path, load] of Object.entries(IMPLEMENTED)) {
    assert.equal(typeof load, 'function', `${path} is not a loader`);
    assert.equal(typeof (await load()), 'function', `${path} does not load a handler`);
  }
});

test('spec: the registry imports no command module at load time', () => {
  // A static import of one command module pulls its whole graph on every invocation,
  // which is what made `status --line` 36.5 ms slower than the one file it reads.
  // `spec` and `help` are exempt because dispatch needs both before it can route.
  const source = readFileSync(new URL('../src/commands/index.mjs', import.meta.url), 'utf8');
  const staticImports = [...source.matchAll(/^import[^;]*?from '(\.\/[^']+)';/gm)].map((m) => m[1]);
  assert.deepEqual(
    staticImports.filter((spec) => spec !== './spec.mjs' && spec !== './help.mjs'),
    [],
    'a command module is imported statically again',
  );
});

test('spec: every group default is a real subcommand of the group it names', () => {
  for (const [group, sub] of GROUP_DEFAULTS) {
    assert.ok(SPEC_PATHS.includes(`${group} ${sub}`), `${group} defaults to ${sub}, which is not a path`);
  }
  for (const row of SPEC) {
    if (row.defaultFor === undefined) continue;
    assert.equal(row.path.split(' ')[0], row.defaultFor, `${row.path} declares a default for ${row.defaultFor}`);
  }
});

test('spec: dispatch reads the same defaults the spec declares', () => {
  assert.deepEqual([...GROUPS], [...GROUP_DEFAULTS]);
});

test('spec: every declared flag is one the parser accepts', () => {
  const known = new Set([...BOOL_FLAGS, ...VALUE_FLAGS, ...REPEATABLE_FLAGS].map((n) => n.replace(/-([a-z])/g, (_, c) => c.toUpperCase())));
  for (const row of SPEC) {
    for (const flag of row.flags ?? []) {
      const camel = flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      assert.ok(known.has(camel), `${row.path} declares --${flag}, which the parser does not accept`);
    }
  }
});

test('spec: a command declares every flag its own module reads', () => {
  // One module can serve several paths, so the unit is the module: every flag a module
  // reads must be declared by some path that uses it. The converse is not true - a
  // command may hand its flags to a facts function that reads keys the module text
  // never names - and asserting it failed for exactly that reason (review 0003 Q62).
  const registry = readFileSync(new URL('../src/commands/index.mjs', import.meta.url), 'utf8');
  const body = registry.slice(registry.indexOf('export const IMPLEMENTED = {'));
  const moduleOf = new Map(
    [...body.matchAll(/^  '?([a-z][a-z-]*(?: [a-z-]+)?)'?: [\s\S]*?await import\('\.\/([^']+)'\)/gm)].map((m) => [m[1], m[2]]),
  );
  const GLOBAL = new Set(['root', 'json', 'pretty', 'help', 'version', 'maxBytes']);
  const byPath = new Map(SPEC.map((row) => [row.path, new Set(row.flags ?? [])]));
  const byModule = new Map();
  for (const [path, file] of moduleOf) byModule.set(file, [...(byModule.get(file) ?? []), path]);

  for (const [file, paths] of byModule) {
    const source = readFileSync(new URL(`../src/commands/${file}`, import.meta.url), 'utf8');
    const read = new Set(
      [...source.matchAll(/\bflags\.([a-zA-Z][\w]*)/g)]
        .map((m) => m[1])
        .filter((n) => !GLOBAL.has(n))
        .map((n) => n.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)),
    );
    const declared = new Set(paths.flatMap((path) => [...byPath.get(path)]));
    // Subset, not equality: a path may declare a flag this module reads through a
    // parameter indirection, and the failure that matters is a flag read and declared
    // nowhere - it is silently accepted and ignored (review 0003 Q62).
    // A path may declare a flag this file never names: `skills brief` passes its flags
    // to skillsBriefFacts, which reads `args.task`. The rule that holds is the one
    // below - nothing a module reads may go undeclared - not its converse.
    for (const flag of read) assert.ok(declared.has(flag), `${file} reads --${flag}, and no path declares it`);
  }
});
test('spec: a summary is one phrase, not a placeholder', () => {
  for (const row of SPEC) {
    assert.ok(row.summary.length > 10 && row.summary.length <= 95, `${row.path}: ${row.summary.length} chars`);
    assert.doesNotMatch(row.summary, /\.$/, `${row.path} ends with a period`);
  }
});
