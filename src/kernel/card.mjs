// The command card: the exact commands for THIS repository, at the top of the
// projected region.
//
// The card holds the bytes a reader cannot infer. "Run the tests" is useless advice in a
// repository whose test command is `./gradlew :app:testDebugUnitTest`; the runner, the
// wrapper and the task name are facts about this repository, and none of them are in the
// rules, which are the same in every repository. So the card is derived rather than
// written: from the manifest's declared gates, the repository's own `package.json`
// scripts, and the marker files that name its ecosystem.
//
// It reads committed evidence ONLY. It must never consult PATH or `node_modules`, because
// the projected region is required to be byte-identical on two machines
// and a card that named whichever linter happened to be installed would differ
// between a laptop and CI for no reason a diff could explain. Runnability is a property
// of the machine; a command is a property of the repository.
//
// The focused-test entries are TEMPLATES. `{file}`, `{pkg}`, `{Test}` and `{class}` are
// placeholders the reader fills from the file they are editing, and the label names the
// path kind so a template is never mistaken for a command that can be pasted as-is.
// Refining which test a given `{file}` maps to is the job, not the.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cardBuilds, cardFocused, cardFallbacks, ecosystemGateRows, evalTemplate, matches } from '../ecosystem/records.mjs';
import { resolveNodeRunner, runScript } from '../ecosystem/node-runner.mjs';

/**
 * The card's ceiling in bytes. Over it, the least valuable lines are
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
 * as the evidence that makes its line redundant , and a copy of this list living in
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
 * Build commands for ecosystems whose build entrypoint is not a package script. The rows are
 * the records' `card.build` facet, in first-match-wins order; `npm` is handled before this
 * table, because a Node repository states its own build script and stating it again here
 * would be a second answer to the same question.
 */
function buildRows(root) {
  return cardBuilds(root);
}

/**
 * One focused-test template per path kind. The rows are the records' `card.focused` facet,
 * in first-match-wins order: a repository that carries more than one marker gets the more
 * specific template — `has-uv-lock` before `has-pyproject`, `has-android-manifest` before
 * the plain `gradle` tag, `has-deno-config` before the Node fallback. A duplicate template
 * for the same path kind would be two answers, and the second is the wrong one.
 *
 * The Node row is the one whose shape depends on the repo's own runner: a repository whose
 * test script is vitest or jest takes a file argument through the script; one with no such
 * script gets the built-in runner, which is the only answer that needs nothing installed to
 * already be true. `<manager> test -- <file>` is the ADR-010 shape (never `npx`) — that
 * choice is the template's `dynamic` form in the record, resolved by `evalTemplate`.
 */
function focusedRows(root) {
  return cardFocused(root);
}

/**
 * Verbs for ecosystems the gate table does not seed, used by the card alone. The rows are
 * the records' `card.fallback` facet.
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
function fallbackRows(root) {
  return cardFallbacks(root);
}

/** A non-empty string, or null. Guards JSON that is present but not a command. */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** The repository's own `package.json` scripts, plus the manager that runs them. */
async function readScripts(root) {
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
    // the runner is committed evidence (lockfile, then `packageManager`),
    // never an assumption of npm — the card, the gates and CI read one answer.
    const lockfiles = [];
    for (const file of ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'package-lock.json']) {
      try {
        await readFile(join(root, file), 'utf8');
        lockfiles.push(file);
      } catch {
        // Absent is the normal case; only present files name the runner.
      }
    }
    const runner = resolveNodeRunner({
      facts: [],
      lockfiles,
      packageManager: typeof pkg.packageManager === 'string' ? pkg.packageManager : null,
    });
    return { scripts, runner };
  } catch {
    // No package.json is a normal shape (a Python or Go repository), and an unreadable one
    // is reported by the manifest path. Either way the card has no scripts to draw on.
    return { scripts: {}, runner: null };
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
function resolveVerb(verb, { manifest, facts, stack, scripts, runner, root }) {
  const declared = text(manifest?.gates?.commands?.[verb]);
  if (declared) return declared;

  // The script a verb maps to. `format` is a staged gate rather than a script gate, so its
  // two conventional script names are tried directly — `format:check` first, because that
  // is the one a hook and CI run, which is what the card is reporting.
  const scriptNames = verb === 'format' ? ['format:check', 'format'] : [verb];
  for (const name of scriptNames) {
    if (text(scripts?.[name])) return runScript(runner?.id ?? 'npm', name);
  }

  if (verb === 'build') {
    if (text(scripts?.build)) return runScript(runner?.id ?? 'npm', 'build');
    for (const row of buildRows(root)) {
      if (matches(row.condition, { facts, stack })) return row.command;
    }
    return null;
  }

  for (const eco of ecosystemGateRows(root)) {
    if (!facts.has(eco.fact)) continue;
    const command = text(eco.commands?.[verb]);
    if (command) return command;
  }
  for (const row of fallbackRows(root)) {
    if (!matches(row.condition, { facts, stack })) continue;
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
  const { scripts, runner } = await readScripts(root);
  // the lockfile facts name the runner even when `readScripts` saw no
  // lockfile (a fixture with a bare package.json keeps npm; a pnpm checkout
  // resolves pnpm from its fact). Facts win inside the resolver already.
  const { resolveNodeRunner: resolveRunner } = await import('../ecosystem/node-runner.mjs');
  const effective = runner ?? resolveRunner({ facts: factSet });

  const lines = [];
  for (const verb of VERBS) {
    const command = resolveVerb(verb, { manifest, facts: factSet, stack: stackSet, scripts, runner: effective, root });
    if (command) lines.push({ label: verb, command, verb });
  }
  for (const entry of focusedRows(root)) {
    if (!matches(entry.condition, { facts: factSet, stack: stackSet })) continue;
    // One template per path kind: `has-uv-lock` and `has-pyproject` both match a uv repo,
    // and two Python lines would be two answers with the second one wrong.
    if (lines.some((l) => l.kind === entry.kind)) continue;
    lines.push({
      label: `focused test (${entry.kind})`,
      command: evalTemplate(entry.template, { scripts, runner: effective }),
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
