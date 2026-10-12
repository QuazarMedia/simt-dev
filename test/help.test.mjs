import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { COMMANDS } from '../src/commands/index.mjs';
import { parse } from '../src/argv.mjs';
import { BOOL_FLAGS, REPEATABLE_FLAGS, VALUE_FLAGS } from '../src/argv.mjs';

const exec = promisify(execFile);
const BIN = new URL('../bin/simt-dev.mjs', import.meta.url).pathname;

async function help() {
  const { stdout } = await exec('node', [BIN, '--help'], { maxBuffer: 8 << 20 });
  return stdout;
}

/**
 * Every command the binary dispatches must be nameable from `--help`.
 *
 * The defect this exists for: `graph lint`, `hooks status` and `hooks run` all worked,
 * all exited 0, and none of them appeared anywhere in `--help`. The cause was
 * structural rather than careless — the dispatch table was an object literal inside
 * `dispatch()`, so no test could enumerate it and the help text was a hand-written
 * string that only a human compared to the source by eye.
 *
 * `--help` is how an agent chooses a command. It is the one consumer with no way to
 * discover a missing entry except by guessing, so an omission there is a capability
 * that exists but cannot be reached.
 */
test('every dispatchable command is documented in --help', async () => {
  const text = await help();
  const missing = COMMANDS.filter((path) => !text.includes(`${'simt'} ${path}`));
  assert.deepEqual(missing, [], `undocumented commands: ${missing.join(', ')}`);
});

/**
 * And the other direction: a command name in `--help` that the binary will not run is
 * the worse of the two errors. It is a promise the dispatcher does not keep, and a
 * reader who follows it gets a usage error instead of a result.
 */
test('--help documents nothing the binary will not run', async () => {
  const text = await help();
  const { CLI } = await import('../src/name.mjs');
  // Every `simt <words>` at the start of a help line is a claimed command path.
  const claimed = [...text.matchAll(new RegExp(`^${CLI} ([a-z-]+(?: [a-z-]+)?)`, 'gm'))].map(
    (m) => m[1],
  );
  const bogus = [];
  for (const path of new Set(claimed)) {
    if (path === 'init [path]' || path.includes('[') || path.includes('<')) continue;
    // A claim that resolves must actually dispatch. Probed rather than compared
    // against the table, because the table is the thing under suspicion.
    const { code } = await exec('node', [BIN, path, '--help'], { maxBuffer: 8 << 20 }).then(
      () => ({ code: 0 }),
      (error) => ({ code: error.code ?? 1 }),
    );
    if (code !== 0) bogus.push(`${path} (exit ${code})`);
  }
  assert.deepEqual(bogus, [], `--help advertises commands that do not run: ${bogus.join(', ')}`);
});

test('a command path whose group is unknown is a usage error, not a silent default', async () => {
  // `commandPath` returns null for `skills nonsense`, so it cannot fall through to the
  // group's default and print an index the caller did not ask for.
  await assert.rejects(
    () => exec('node', [BIN, 'skills', 'nonsense'], { maxBuffer: 8 << 20 }),
    (error) => {
      assert.equal(error.code, 2, 'an unknown subcommand must be a usage exit');
      assert.match(`${error.stdout}${error.stderr}`, /unknown command/i);
      return true;
    },
  );
});

// --- flags --------------------------------------------------------------------

/**
 * `--skill` is documented as repeatable and was not.
 *
 * `flags.skill = value` meant `--skill a --skill b` resolved to `b`, with `a` dropped
 * silently — no error, no warning, and a brief missing a skill the caller had named by
 * hand. For a tool whose stated design rule is that the answer is a function of what was
 * asked, a flag that discards half its input is a correctness bug, not a papercut.
 */
test('--skill accumulates instead of overwriting', () => {
  const { value } = parse(['skills', 'brief', '--skill', 'a', '--skill', 'b']);
  assert.deepEqual(value.flags.skill, ['a', 'b']);
});

test('--skill still accepts the comma-separated form it always accepted', async () => {
  // A superset, not a replacement: `--skill a,b` parsed before this change and must
  // parse identically now, or the fix traded one broken spelling for another.
  const { listFlag } = await import('../src/commands/skills.mjs');
  const comma = parse(['--skill', 'a,b']).value.flags.skill;
  const repeated = parse(['--skill', 'a', '--skill', 'b']).value.flags.skill;
  const mixed = parse(['--skill', 'a', '--skill', 'b,c']).value.flags.skill;
  assert.deepEqual(listFlag(comma), ['a', 'b']);
  assert.deepEqual(listFlag(repeated), ['a', 'b']);
  assert.deepEqual(listFlag(mixed), ['a', 'b', 'c']);
});

test('an absent repeatable flag is an empty list, not a stringified undefined', async () => {
  const { listFlag } = await import('../src/commands/skills.mjs');
  assert.deepEqual(listFlag(undefined), []);
  assert.deepEqual(listFlag([]), []);
});

test('no flag is in more than one of the three flag tables', () => {
  // They are consulted in order and a name in two of them resolves by position rather
  // than by declaration, so an overlap is a silent behavioural change rather than a
  // parse error.
  const overlap = (a, b) => [...a].filter((x) => b.has(x));
  assert.deepEqual(overlap(BOOL_FLAGS, VALUE_FLAGS), []);
  assert.deepEqual(overlap(BOOL_FLAGS, REPEATABLE_FLAGS), []);
  // A repeatable flag is a value flag; being in both is the design, not an accident.
  for (const name of REPEATABLE_FLAGS) assert.ok(VALUE_FLAGS.has(name), `${name} is not a value flag`);
});

test('every flag the parser accepts is described in --help', async () => {
  // The mirror of the command test, for the same reason. `--help` documents the flags
  // a caller will reach for; a flag that works but is undescribed is a flag nobody
  // types, and a described flag that does not parse is a promise the CLI breaks.
  const text = await help();
  const undocumented = [...VALUE_FLAGS, ...BOOL_FLAGS, ...REPEATABLE_FLAGS]
    .filter((name) => !text.includes(`--${name}`))
    .sort();
  assert.deepEqual(undocumented, [], `undocumented flags: ${undocumented.join(', ')}`);
});