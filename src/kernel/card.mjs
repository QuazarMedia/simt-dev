// The command card: the exact commands for THIS repository, at the top of the
// projected region (plan 0003 R10).
//
// The card holds the bytes a reader cannot infer. "Run the tests" is useless advice in a
// repository whose test command is `./gradlew :app:testDebugUnitTest`; the runner, the
// wrapper and the task name are facts about this repository, and none of them are in the
// rules, which are the same in every repository. So the card is derived rather than
// written: from the manifest's declared gates, the repository's own `package.json`
// scripts, and the marker files that name its ecosystem.
//
// It reads committed evidence ONLY. It must never consult PATH or `node_modules`, because
// the projected region is required to be byte-identical on two machines (plan 0003 P4,
// R13) and a card that named whichever linter happened to be installed would differ
// between a laptop and CI for no reason a diff could explain. Runnability is a property
// of the machine; a command is a property of the repository.
//
// The focused-test entries are TEMPLATES. `{file}`, `{pkg}`, `{Test}` and `{class}` are
// placeholders the reader fills from the file they are editing, and the label names the
// path kind so a template is never mistaken for a command that can be pasted as-is.
// Refining which test a given `{file}` maps to is R24's job, not R10's.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ECOSYSTEMS } from '../projection/manifest.mjs';

/**
 * The card's ceiling in bytes (plan 0003 R10). Over it, the least valuable lines are
 * dropped rather than the ceiling raised: the point of the card is the bytes a reader
 * most needs, and an unbounded card is a second copy of the rules.
 */
export const CARD_LIMIT_BYTES = 600;

/**
 * The verbs the card carries, in the order a reader meets them. The plan names exactly
 * these five. A `build` command exists only where a repository declares one, so the order
 * is a priority as well as a sequence: the most universally true verb comes first.
 *
 * Exported because a second reader has to agree with it: a rule may declare `card:<verb>`
 * as the evidence that makes its line redundant (R09), and a copy of this list living in
 * the filter would let the card name a verb the filter called unknown.
 */
export const CARD_VERBS = ['build', 'test', 'lint', 'format', 'typecheck'];

const VERBS = CARD_VERBS;

/**
 * The order verbs are dropped in when the card is over its ceiling: the verb whose loss a
 * reader misses least goes first. `test` is absent on purpose — a card that dropped the
 * test command would have dropped the one command it exists to carry.
 */
const DROP_ORDER = ['format', 'typecheck', 'lint', 'build'];

/**
 * Build commands for ecosystems whose build entrypoint is not a package script. Keyed by
 * a marker fact or stack tag, whichever the ecosystem is identified by. `npm` is handled
 * before this table, because a Node repository states its own build script and stating it
 * again here would be a second answer to the same question.
 */
const BUILDS = [
  { fact: 'has-cargo-toml', command: 'cargo build' },
  { fact: 'has-go-mod', command: 'go build ./...' },
  { fact: 'has-nuget', command: 'dotnet build' },
  { fact: 'has-swift-package', command: 'swift build' },
  { fact: 'has-mix', command: 'mix compile' },
  { stack: 'gradle', command: './gradlew build' },
];

/**
 * One focused-test template per path kind. Entries are ordered, and the FIRST match wins,
 * so a repository that carries more than one marker gets the more specific template:
 * `has-uv-lock` before `has-pyproject`, `has-android-manifest` before the plain `gradle`
 * tag, `has-deno-config` before the Node fallback. A duplicate template for the same path
 * kind would be two answers, and the second is the wrong one.
 */
const FOCUSED = [
  { kind: 'Android', when: (s, f) => f.has('has-android-manifest'), template: () => './gradlew :{module}:testDebugUnitTest --tests {class}' },
  { kind: 'JVM', when: (s) => s.has('gradle'), template: () => './gradlew test --tests {class}' },
  { kind: 'Maven', when: (s, f) => f.has('has-maven-pom'), template: () => './mvnw test -Dtest={class}' },
  { kind: 'Go package', when: (s, f) => f.has('has-go-mod'), template: () => 'go test ./{pkg} -run {Test}' },
  { kind: 'Rust', when: (s, f) => f.has('has-cargo-toml'), template: () => 'cargo test {name}' },
  { kind: 'Python', when: (s, f) => f.has('has-uv-lock'), template: () => 'uv run -m pytest {file}::{test}' },
  { kind: 'Python', when: (s, f) => f.has('has-pyproject') || f.has('has-requirements'), template: () => 'pytest {file}::{test}' },
  { kind: '.NET', when: (s, f) => f.has('has-nuget'), template: () => 'dotnet test --filter {test}' },
  { kind: 'Swift', when: (s, f) => f.has('has-swift-package'), template: () => 'swift test --filter {test}' },
  { kind: 'Deno', when: (s, f) => f.has('has-deno-config'), template: () => 'deno test {file}' },
  { kind: 'Ruby', when: (s, f) => f.has('has-gemfile'), template: () => 'bundle exec rspec {file}' },
  { kind: 'Dart', when: (s, f) => f.has('has-pubspec'), template: () => 'dart test {file}' },
  { kind: 'Elixir', when: (s, f) => f.has('has-mix'), template: () => 'mix test {file}' },
  {
    kind: 'Node',
    when: (s) => s.has('node'),
    // The repo's own runner decides the shape. A repository whose test script is vitest
    // or jest takes a file argument through the script; one with no such script gets the
    // built-in runner, which is the only answer that needs nothing installed to already
    // be true. `npm test -- <file>` is the ADR-010 shape (never `npx`).
    template: (s, f, scripts) => {
      const test = scripts?.test ?? '';
      return /vitest|jest/.test(test) ? 'npm test -- {file}' : 'node --test {file}';
    },
  },
];

/**
 * Verbs for ecosystems the gate table does not seed, used by the card alone.
 *
 * Python is the case, and it is not an oversight that the tool seeds no Python gate: the
 * runner genuinely varies (uv, poetry, tox, nox, a project wrapper), so a seeded gate would
 * be wrong in the repositories it guessed about. The card can still name the one command a
 * repository has proved: a committed `uv.lock` means uv, and the uv profile is explicit
 * that `uv run -m pytest` is correct and `uv run pytest` is not — the console entrypoint
 * can miss the `uv` import path and run a different copy of the package than the one under
 * test. Without a lockfile the card names the plain runner, which is what the python
 * profile assumes when it says "no `pytest.skip`".
 */
const CARD_FALLBACKS = [
  { when: (s, f) => f.has('has-uv-lock'), commands: { test: 'uv run -m pytest' } },
  { when: (s, f) => f.has('has-pyproject') || f.has('has-requirements'), commands: { test: 'pytest' } },
];

/** A non-empty string, or null. Guards JSON that is present but not a command. */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** The repository's own `package.json` scripts, or an empty map. */
async function readScripts(root) {
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    return pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
  } catch {
    // No package.json is a normal shape (a Python or Go repository), and an unreadable one
    // is reported by the manifest path. Either way the card has no scripts to draw on.
    return {};
  }
}

/**
 * The command for one verb, or null when this repository proves none.
 *
 * Precedence is deliberate and mirrors the manifest's own. A declared `gates.commands`
 * entry is the repository naming its own program and wins over anything inferred; a
 * `package.json` script is the repository's declared entrypoint (`npm run <verb>`); and
 * the ecosystem table is the canonical command for a marker that is present but whose
 * repository has declared nothing. The last is the same table the tool seeds gates from,
 * so the card and the gate list cannot name two different commands for one repository.
 */
function resolveVerb(verb, { manifest, facts, stack, scripts }) {
  const declared = text(manifest?.gates?.commands?.[verb]);
  if (declared) return declared;

  // The script a verb maps to. `format` is a staged gate rather than a script gate, so its
  // two conventional script names are tried directly — `format:check` first, because that
  // is the one a hook and CI run, which is what the card is reporting.
  const scriptNames = verb === 'format' ? ['format:check', 'format'] : [verb];
  for (const name of scriptNames) {
    if (text(scripts?.[name])) return `npm run ${name}`;
  }

  if (verb === 'build') {
    if (text(scripts?.build)) return 'npm run build';
    for (const row of BUILDS) {
      if (row.fact && facts.has(row.fact)) return row.command;
      if (row.stack && stack.has(row.stack)) return row.command;
    }
    return null;
  }

  for (const eco of ECOSYSTEMS) {
    if (!facts.has(eco.fact)) continue;
    const command = text(eco.commands?.[verb]);
    if (command) return command;
  }
  for (const row of CARD_FALLBACKS) {
    if (!row.when(stack, facts, scripts)) continue;
    const command = text(row.commands?.[verb]);
    if (command) return command;
  }
  return null;
}

/** The text a set of lines renders to. Kept beside `commandCard` so both agree. */
function renderCard(lines) {
  const body = lines.map((l) => `- ${l.label}: \`${l.command}\``).join('\n');
  return `Commands for this repository:\n\n${body}`;
}

function renderBytes(lines) {
  return lines.length === 0 ? 0 : Buffer.byteLength(renderCard(lines));
}

/**
 * The index of the next line to drop, or -1 when nothing may be dropped.
 *
 * Verbs drop in `DROP_ORDER`. Focused templates drop only after every verb, from the last
 * first, because a focused template is the plan's headline content and a repository with
 * several is the one case where dropping one still leaves the reader a template.
 */
function pickDroppable(lines) {
  for (const verb of DROP_ORDER) {
    const at = lines.findIndex((l) => l.verb === verb);
    if (at !== -1) return at;
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].verb === 'focused') return i;
  }
  return -1;
}

/**
 * Build the card for one repository.
 *
 * @param {{root: string, manifest?: object, stack?: string[], facts?: string[]}} input
 * @returns {Promise<{text: string, bytes: number, lines: {label: string, command: string,
 *   verb: string}[], dropped: string[]}>}
 */
export async function commandCard({ root, manifest = null, stack = [], facts = [] }) {
  const factSet = new Set(facts);
  const stackSet = new Set(stack);
  const scripts = await readScripts(root);

  const lines = [];
  for (const verb of VERBS) {
    const command = resolveVerb(verb, { manifest, facts: factSet, stack: stackSet, scripts });
    if (command) lines.push({ label: verb, command, verb });
  }
  for (const entry of FOCUSED) {
    if (!entry.when(stackSet, factSet, scripts)) continue;
    // One template per path kind: `has-uv-lock` and `has-pyproject` both match a uv repo,
    // and two Python lines would be two answers with the second one wrong.
    if (lines.some((l) => l.kind === entry.kind)) continue;
    lines.push({
      label: `focused test (${entry.kind})`,
      command: entry.template(stackSet, factSet, scripts),
      kind: entry.kind,
      verb: 'focused',
    });
  }

  // Fit under the ceiling by dropping whole lines, least valuable first. Nothing is cut
  // silently: `dropped` names every line removed so the caller can say so, because a card
  // that quietly lost a command is a card a reader cannot tell is incomplete.
  const dropped = [];
  let kept = lines.slice();
  while (renderBytes(kept) > CARD_LIMIT_BYTES) {
    const victim = pickDroppable(kept);
    if (victim === -1) break;
    dropped.push(kept[victim].label);
    kept = kept.filter((_, i) => i !== victim);
  }

  const text = kept.length > 0 ? renderCard(kept) : '';
  return { text, bytes: Buffer.byteLength(text), lines: kept, dropped };
}
