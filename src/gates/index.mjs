import { readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { journaledWriteFile } from '../journal.mjs';
import { getGate } from '../hooks/gates.mjs';
import { runScript } from '../ecosystem/node-runner.mjs';
import { ecosystemGateRows } from '../ecosystem/records.mjs';
import { MANIFEST_FILE, MANIFEST_LEGACY } from '../name.mjs';
import { GENERATED_KEYS_OF, KEYS, loadManifest, manifestPath } from '../manifest/schema.mjs';
import { CLI } from '../name.mjs';
import { packageVersion } from '../package-version.mjs';

// The gates a repository declares: what each one runs, and whether it can run at all.
//
// Moved out of projection/manifest.mjs. A gate is a claim about what a commit will run,
// and the manifest is where the claim is written down; keeping the two in one module meant
// a change to the gate table was a change to the manifest writer. `manifest.mjs` still
// re-exports every name here, so a caller imports the surface it always did.

const GATES_BY_STACK = [
  {
    when: ['gradle', 'kotlin', 'connectiq'],
    preCommit: ['format', 'lint', 'i18n-completeness'],
    prePush: ['test'],
  },
  {
    when: ['python'],
    preCommit: ['format', 'lint', 'i18n-completeness'],
    prePush: ['test', 'coverage'],
  },
  {
    when: ['node', 'node-web', 'cloudflare-workers', 'typescript'],
    preCommit: ['format', 'lint'],
    prePush: ['test', 'typecheck'],
  },
];

/** Extra gate implied by a specific tag, applied after the table above. */
const TAG_GATES = [
  { tag: 'connectiq', preCommit: ['memory', 'codegen-drift'] },
  { tag: 'hono', preCommit: ['i18n-completeness'] },
];

/**
 * The ecosystems that produce a fact rather than a stack tag, and what a fresh
 * adoption of one should declare.
 *
 * Read from the ecosystem records (ADR-013: content is data, the engine is code), not
 * written here. A row proposes gates the way `GATES_BY_STACK` does, and the fact it keys
 * on is the same signal a profile's `simt-applies` names, so one marker file reaches
 * both: the region this repo reads and the gates its commits run.
 *
 * `commands` is what a FRESH manifest declares for each proposed gate, and it is written
 * only when the probe in `readCapability` found `tool` where the record says it lives.
 * A declared gate that cannot run blocks every commit, so a command is never declared on
 * the faith of a marker file: the marker says the ecosystem is here, the probe says its
 * program can run (ADR-017). A command the repo already declared wins over the seed.
 *
 * `file` marks a tool that is a file in the repository rather than a binary on PATH: the
 * Maven wrapper, probed the way this tool already probes `gradlew`.
 *
 * The shipped set, read without a root, is what the const-iterating tests pin; a
 * repository's own `.simt/ecosystems/` overrides arrive through the views' `root` argument.
 */
export const ECOSYSTEMS = ecosystemGateRows();

/**
 * Can this repo actually run the gate?
 *
 * A declared gate that cannot run is worse than an absent one. Absent, an author sees
 * nothing and knows nothing is being checked; declared-and-unrunnable, the dispatcher
 * fails closed on every commit and the only exit an author can find is `--no-verify`,
 * which teaches the whole team that the gate is theatre. The dispatcher is right to
 * fail closed — the defect is declaring a gate this repo has no way to run.
 *
 * The check mirrors what the dispatcher actually attempts:
 *   - `script` gates  run `<manager> run <script>`, so the script must exist
 *   - `staged` gates  look for each named tool in `node_modules/.bin`, so it must be
 *     installed, not merely declared as a dependency
 *   - `command` gates run whatever the manifest's `gates.commands` declares, so a
 *     command gate with no declared command is unrunnable by definition
 *
 * @param {object} gate an entry from GATES in src/hooks/gates.mjs
 * @param {{scripts?: Record<string,string>, binaries?: string[], commands?: Record<string,string>}} capability
 */
export function gateRunnable(gate, capability = {}) {
  if (!gate) return { runnable: false, why: 'unknown gate' };
  // Only a KNOWN non-npm runner changes the wording. A capability that does not report
  // its runner (a hand-built one, a caller from an older version) is treated as npm,
  // because claiming a repo has no package.json is a much worse guess than assuming it.
  const foreign = isForeignRunner(capability.runner);

  // A declared command satisfies the gate whatever its kind, because that is the
  // dispatcher's own precedence and the two must never disagree about one manifest.
  const declared = capability.commands?.[gate.name];
  if (declared) {
    return declared.trim() === ''
      ? { runnable: false, why: `gates.commands["${gate.name}"] is empty` }
      : { runnable: true, why: `runs: ${declared}` };
  }

  if (gate.kind === 'builtin') {
    // The one kind with no external requirement: the implementation ships inside
    // the binary that is reading this manifest (ADR-100). Saying otherwise would
    // make `check` report a gate as unrunnable that runs on every commit.
    return { runnable: true, why: 'runs inside the tool itself; nothing to install' };
  }
  if (gate.kind === 'command') {
    return { runnable: false, why: `no command is declared for it in gates.commands` };
  }
  if (gate.kind === 'script') {
    const script = gate.script ?? gate.name;
    // the runnable sentence names the repo's own runner, never a bare npm
    // assumption — the card, the dispatcher and this check read one resolver.
    const spell = runScript(capability.runner ?? 'npm', script);
    if (capability.scripts?.[script]) return { runnable: true, why: `runs: ${spell}` };
    // Saying "no script in package.json" about a repo with no package.json states a
    // fact about a file that does not exist and implies a fix that cannot be taken.
    return {
      runnable: false,
      why: foreign
        ? `this repo runs ${runnerName(capability.runner)}, not npm, so "${spell}" cannot run here`
        : `no "${script}" script in package.json`,
    };
  }
  // staged: a formatter must actually be installed
  for (const tool of gate.tools ?? []) {
    if (!(capability.binaries ?? []).includes(tool)) {
      return {
        runnable: false,
        why: foreign
          ? `${tool} is not installed, and this repo has no node_modules/.bin to install it into`
          : `${tool} is not installed in node_modules/.bin`,
      };
    }
  }
  return { runnable: true, why: `formats staged files with ${(gate.tools ?? []).join(', ')}` };
}

/**
 * What the reader has to do to make a dropped gate runnable.
 *
 * A drop is a decision the tool made on the repo's behalf, so it owes the reader the
 * undo. Every remedy is one of three real choices — install the tool, add the script,
 * or name the command — because "this repo cannot run format" with no next step reads
 * as simt-dev deciding formatting does not matter here.
 *
 * The two npm-shaped remedies only apply where npm is the runner. In a Gradle, Python or
 * Rust repo the honest undo is the `command` gate: the repo names its own program, which
 * is the same escape hatch ConnectIQ memory budgets already use.
 */
function gateRemedy(gate, { existing = false, runner = null } = {}) {
  const name = gate?.name ?? 'the gate';
  const npmShaped = gate?.kind === 'staged' || gate?.kind === 'script';
  const foreign = isForeignRunner(runner);
  // a missing tool in a Node repo names the repo's own installer —
  // `pnpm add -D`, not `npm i -D` — and anything elsewhere keeps the honest
  // undo: name the program under `gates.commands`.
  const addDev = { npm: 'npm i -D', pnpm: 'pnpm add -D', yarn: 'yarn add -D', bun: 'bun add -d' }[runner] ?? null;
  const fix =
    npmShaped && foreign
      ? `this repo runs ${runnerName(runner)}, not npm; name the program under "gates.commands" in ${MANIFEST_FILE} instead of the npm equivalent`
      : gate?.kind === 'staged'
        ? addDev
          ? `install ${gate.tools.join(', ')} as a dev dependency: ${addDev} ${gate.tools.join(' ')}   (the gate runs from the pinned dependency)`
          : `install ${gate.tools.join(', ')} as a dev dependency`
        : gate?.kind === 'script'
          ? `add a "${gate.script ?? name}" script to package.json`
          : gate?.kind === 'command'
            ? `declare the program under "gates.commands" in ${MANIFEST_FILE}`
            : `remove "${name}" from the gates list in ${MANIFEST_FILE}`;
  // A re-init never re-adds a gate to a manifest that already has one, so "install the
  // tool and re-run init" would send the reader round the loop and back to where they
  // started. On an existing manifest the declaration is the second half of the fix.
  const second =
    npmShaped && foreign
      ? `, or add "${name}" to gates.preCommit or gates.prePush in ${MANIFEST_FILE}`
      : existing
        ? `, then add "${name}" to gates.preCommit or gates.prePush in ${MANIFEST_FILE}`
        : `, then re-run: ${CLI} init --yes`;
  return `${fix}${second}`;
}

/**
 * Is this runner one where `npm run` is not how a gate is spelled?
 *
 * `undefined` means "the caller did not report a runner", and every Node manager
 * (`npm`, `pnpm`, `yarn`, `bun`) spells gates as `<manager> run <script>` with
 * scripts living in the same `package.json`. Only a positively identified
 * non-Node runner changes the wording. (pnpm is Node-shaped, not foreign.)
 */
function isForeignRunner(runner) {
  if (runner == null) return false;
  return !['npm', 'pnpm', 'yarn', 'bun'].includes(runner);
}

/** How a reader would name the runner in a sentence. */
function runnerName(runner) {
  return (
    {
      none: 'no recognised runner',
      gradle: 'Gradle',
      python: 'Python',
      npm: 'npm',
      pnpm: 'pnpm',
      yarn: 'yarn',
      bun: 'bun',
      cargo: 'Cargo',
      go: 'Go',
    }[runner] ?? runner
  );
}

/**
 * The stack table, filtered by what this repo can actually run.
 *
 * A declared gate that cannot run is worse than an absent one. Absent, an author sees
 * nothing and knows nothing is being checked; declared-and-unrunnable, the dispatcher
 * fails closed on every commit and the only exit an author can find is `--no-verify`,
 * which teaches the whole team that the gate is theatre. The dispatcher is right to
 * fail closed — the defect is declaring a gate this repo has no way to run.
 *
 * The filter mirrors what the dispatcher actually attempts:
 *   - `script` gates  run `npm run <script>`, so the script must exist
 *   - `staged` gates  look for each named tool in `node_modules/.bin`, so it must be
 *     installed, not merely declared as a dependency
 *   - `command` gates run whatever `gates.commands` declares, so a command gate with
 *     no declared command is unrunnable by definition
 *
 * The seeds are returned alongside the plan because a fresh adoption writes them
 * into `gates.commands` and the reader is owed the line that says so: a command
 * that lands in the manifest without appearing in the plan is a silent write.
 *
 * @returns {{gates: {preCommit: string[], prePush: string[]}, dropped: {gate: string, why: string}[], commands: Record<string,string>}}
 */
export function planGates(stack = [], capability = null, facts = [], root = null) {
  const proposed = defaultGates(stack, facts, root);
  if (!capability) return { gates: proposed, dropped: [], commands: {} };
  const seeds = ecosystemCommands(facts, capability, root);
  // A command the repo already declared wins over a seed: the seed is a default,
  // the declaration is a choice, and a default overwriting a choice is a re-init
  // that edits the repo's mind.
  const effective = { ...capability, commands: { ...seeds, ...capability.commands } };
  const dropped = [];
  const runnable = (list) =>
    list.filter((name) => {
      const gate = getGate(name, effective.commands);
      const verdict = gateRunnable(gate, effective);
      if (!verdict.runnable) {
        dropped.push({ gate: name, why: verdict.why, remedy: gateRemedy(gate, { runner: capability.runner }) });
      }
      return verdict.runnable;
    });
  return {
    gates: { preCommit: runnable(proposed.preCommit), prePush: runnable(proposed.prePush) },
    dropped,
    commands: seeds,
  };
}

/**
 * The canonical `gates.commands` a fresh manifest of this repository should carry.
 *
 * Two probes, and both must pass before a command is declared: the fact says the
 * ecosystem is in the repository, and `capability.tools` says its program can run
 * on this machine. A marker file without a toolchain would otherwise declare a
 * gate that fails closed on every commit — the defect ADR-017 exists to prevent,
 * reached from the ecosystem table rather than the stack table.
 *
 * Pure, so `planGates` and `buildManifest` answer with one implementation.
 */
function ecosystemCommands(facts = [], capability = null, root = null) {
  if (!capability?.tools?.length) return {};
  // A Node runner (npm/pnpm/yarn/bun) already answers "how do I test and format"
  // with its own package.json scripts, and a seed only wins over those scripts when
  // the repo has not declared a command of its own — which is exactly the mixed
  // repos (package.json AND Cargo.toml) where the script is the deliberate answer.
  // Seeding there would replace a choice with a default; the reader's escape hatch
  // is declaring gates.commands by hand, which a seed would lose to anyway. Pure
  // ecosystem repos have runner 'cargo'/'go'/... and seed normally.
  // every Node manager skips seeding — pnpm is not "foreign", it is Node.
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(capability.runner)) return {};
  const present = new Set(facts);
  const commands = {};
  for (const eco of ecosystemGateRows(root)) {
    if (!present.has(eco.fact)) continue;
    if (!capability.tools.includes(eco.tool)) continue;
    for (const [gate, command] of Object.entries(eco.commands)) {
      if (!capability.commands?.[gate]) commands[gate] = command;
    }
  }
  return commands;
}

/**
 * Build a manifest from a fingerprint. Pure, so the whole default surface is
 * testable without a filesystem.
 *
 * When `capability` is supplied, newly proposed gates the repo cannot run are dropped.
 * Gates the repo ALREADY declared are kept regardless: that is the repo's choice to
 * make, and quietly disarming a gate somebody declared on purpose is a worse surprise
 * than a visible one.
 */
export function unrunnableGates(manifest, capability) {
  const declared = [
    ...(manifest?.gates?.preCommit ?? []),
    ...(manifest?.gates?.prePush ?? []),
  ];
  const findings = [];
  const seen = new Set();
  // `gates.cwd` names a directory a gate runs in, and a name that is not a declared
  // gate is as much a landmine as one that cannot run: the entry is inert, the reader
  // believes the gate runs in the package it names, and nothing anywhere says so. Same
  // shape as the unknown-gate finding in the dispatcher, so both are repaired the same
  // way.
  const cwds = manifest?.gates?.cwd;
  if (cwds && typeof cwds === 'object' && !Array.isArray(cwds)) {
    for (const name of Object.keys(cwds).sort()) {
      if (declared.includes(name)) continue;
      findings.push({
        file: MANIFEST_FILE,
        status: 'unknown-gate-cwd',
        gate: name,
        detail: `gates.cwd names "${name}", which is not declared in gates.preCommit or gates.prePush, so it is never read`,
        remedy: `declare "${name}" in gates.preCommit or gates.prePush, or remove gates.cwd["${name}"]`,
      });
    }
  }
  for (const name of declared) {
    if (seen.has(name)) continue;
    seen.add(name);
    const gate = getGate(name, capability.commands);
    const verdict = gateRunnable(gate, capability);
    if (verdict.runnable) continue;
    findings.push({
      file: MANIFEST_FILE,
      status: 'unrunnable',
      gate: name,
      detail: `declares gate "${name}", which this repo cannot run: ${verdict.why}`,
      remedy: gateRemedy(gate, { existing: true, runner: capability.runner }),
    });
  }
  return findings;
}

/** ADR-005: 400 is a review trigger, 1000 a hard ceiling. Generated files exempt. */
function defaultGates(stack, facts = [], root = null) {
  // Tags and facts are one signal set for gate purposes: a row in `GATES_BY_STACK`
  // keys on a tag, a row in `ECOSYSTEMS` on a fact, and the two never name each
  // other's vocabulary (facts are `has-*`, tags are not), so one union cannot
  // cross-match.
  const signals = new Set([...stack, ...facts]);
  const gates = { preCommit: [], prePush: [] };

  for (const row of GATES_BY_STACK) {
    if (row.when.some((tag) => signals.has(tag))) {
      gates.preCommit.push(...row.preCommit);
      gates.prePush.push(...row.prePush);
    }
  }
  for (const row of ecosystemGateRows(root)) {
    if (signals.has(row.fact)) {
      // A row proposes what it has: the Maven row has no preCommit gates, so a
      // missing key is "none", not a defect. Spreading undefined throws.
      gates.preCommit.push(...(row.preCommit ?? []));
      gates.prePush.push(...(row.prePush ?? []));
    }
  }
  for (const row of TAG_GATES) {
    if (signals.has(row.tag)) gates.preCommit.push(...row.preCommit);
  }

  // A repo with no recognised stack still gets a gate list, because a gate that
  // runs nothing is indistinguishable from a gate that was never installed.
  if (gates.preCommit.length === 0) gates.preCommit.push('format', 'lint');
  if (gates.prePush.length === 0) gates.prePush.push('test');

  return { preCommit: dedupe(gates.preCommit), prePush: dedupe(gates.prePush) };
}

function dedupe(list) {
  return [...new Set(list)];
}

export { defaultGates, dedupe };
