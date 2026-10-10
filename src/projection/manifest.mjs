// simt-dev.json - the one manifest per repo.
//
// One file answers every question the tool needs: what this repo is, what it is
// allowed to declare, which gates it runs, and which simt-dev produced its rules.
//
// This is where two rulings land in code:
//   ADR-005 file length is two tiers (400 review trigger, 1000 ceiling) - a default,
//            overridable per repo under limits.fileLines.
//   ADR-006 evidence discipline is central; the NUMERIC bar is declared per repo.
//            So limits.coverage defaults to null. A null is a real, valid answer:
//            the evidence-discipline rules still apply, there is simply no number.
//            Inventing a number here would be worse than declaring none.
//
// Every default this module produces is explained by the ADR that requires it. The
// rationale is not duplicated into the JSON (data must stay data); `simt-dev init`
// prints the reason for each value it writes.

import { readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
// gates.mjs imports nothing, so this direction cannot cycle. It is the gate table
// this file already selects from; duplicating the runnability rules here would be two
// answers to "can this repo run that gate", which is precisely the kind of drift this
// file exists to prevent elsewhere.
import { getGate } from '../hooks/gates.mjs';

// Imported as well as re-exported: a bare `export { X as Y } from` binds nothing here,
// and the manifest name is used a dozen times below in remedy strings that name this
// file by name.
import { MANIFEST_FILE } from '../name.mjs';
export const MANIFEST = MANIFEST_FILE;

/**
 * The one definition of the file's own comment, exported because `upgrade` rewrites
 * the manifest and must not carry a stale copy forward. Two literals for one string
 * is how the old one survived every upgrade.
 *
 * Every value here is read by someone who cannot see simt-dev's own tree, so this
 * names only things true in the repo it lands in. An earlier version pointed at
 * docs/decisions/ and claimed each value cites the ADR that requires it; no value
 * cited one, so it was decoration that misdescribed the file. The provenance that IS
 * real is the recorded SHA under `projection`.
 */
export const MANIFEST_COMMENT = {
  $comment:
    'Written and maintained by simt-dev. Edit by hand only if you intend to take ownership of this file: `simt-dev sync --yes` regenerates the projected rules, and re-running `simt-dev init` refreshes the SHA without weakening a value you set here.',
};

/**
 * Gate names the shared dispatcher knows how to run (step 8). Choosing these from
 * the detected stack rather than asking a human keeps `init` non-interactive.
 */
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
 * Can this repo actually run the gate?
 *
 * A declared gate that cannot run is worse than an absent one. Absent, an author sees
 * nothing and knows nothing is being checked; declared-and-unrunnable, the dispatcher
 * fails closed on every commit and the only exit an author can find is `--no-verify`,
 * which teaches the whole team that the gate is theatre. The dispatcher is right to
 * fail closed — the defect is declaring a gate this repo has no way to run.
 *
 * The check mirrors what the dispatcher actually attempts:
 *   - `script` gates  run `npm run <script>`, so the script must exist
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

  if (gate.kind === 'command') {
    return { runnable: false, why: `no command is declared for it in gates.commands` };
  }
  if (gate.kind === 'script') {
    const script = gate.script ?? gate.name;
    if (capability.scripts?.[script]) return { runnable: true, why: `runs: npm run ${script}` };
    // Saying "no script in package.json" about a repo with no package.json states a
    // fact about a file that does not exist and implies a fix that cannot be taken.
    return {
      runnable: false,
      why: foreign
        ? `this repo runs ${runnerName(capability.runner)}, not npm, so "npm run ${script}" cannot run here`
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
  const fix =
    npmShaped && foreign
      ? `this repo runs ${runnerName(runner)}, not npm; name the program under "gates.commands" in ${MANIFEST} instead of the npm equivalent`
      : gate?.kind === 'staged'
        ? `install ${gate.tools.join(', ')} as a dev dependency`
        : gate?.kind === 'script'
          ? `add a "${gate.script ?? name}" script to package.json`
          : gate?.kind === 'command'
            ? `declare the program under "gates.commands" in ${MANIFEST}`
            : `remove "${name}" from the gates list in ${MANIFEST}`;
  // A re-init never re-adds a gate to a manifest that already has one, so "install the
  // tool and re-run init" would send the reader round the loop and back to where they
  // started. On an existing manifest the declaration is the second half of the fix.
  const second =
    npmShaped && foreign
      ? `, or add "${name}" to gates.preCommit or gates.prePush in ${MANIFEST}`
      : existing
        ? `, then add "${name}" to gates.preCommit or gates.prePush in ${MANIFEST}`
        : `, then re-run: simt-dev init --yes`;
  return `${fix}${second}`;
}

/**
 * Is this runner one where `npm run` is not how a gate is spelled?
 *
 * `undefined` means "the caller did not report a runner", and `npm` means the npm
 * remedy applies. Only a positively identified other ecosystem changes the wording.
 */
function isForeignRunner(runner) {
  return runner != null && runner !== 'npm';
}

/** How a reader would name the runner in a sentence. */
function runnerName(runner) {
  return (
    {
      none: 'no recognised runner',
      gradle: 'Gradle',
      python: 'Python',
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
 * @returns {{gates: {preCommit: string[], prePush: string[]}, dropped: {gate: string, why: string}[]}}
 */
export function planGates(stack = [], capability = null) {
  const proposed = defaultGates(stack);
  if (!capability) return { gates: proposed, dropped: [] };
  const dropped = [];
  const runnable = (list) =>
    list.filter((name) => {
      const gate = getGate(name);
      const verdict = gateRunnable(gate, capability);
      if (!verdict.runnable) {
        dropped.push({ gate: name, why: verdict.why, remedy: gateRemedy(gate, { runner: capability.runner }) });
      }
      return verdict.runnable;
    });
  return { gates: { preCommit: runnable(proposed.preCommit), prePush: runnable(proposed.prePush) }, dropped };
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
export function buildManifest({ root, stack = [], sha, existing = null, capability = null, surfaces = undefined }) {
  const gates = defaultGates(stack);
  const limits = defaultLimits(stack);

  // A re-init must never silently weaken a repo's own declaration: existing
  // limits and gates win over defaults, and only the projection stamp is refreshed.
  const limitsFinal = existing?.limits ? { ...limits, ...existing.limits } : limits;
  const gatesFinal = existing?.gates
    ? { ...gates, ...existing.gates }
    : planGates(stack, capability).gates;

  return {
    ...MANIFEST_COMMENT,
    id: existing?.id ?? defaultId(root),
    stack: existing?.stack?.length ? existing.stack : stack,
    limits: limitsFinal,
    gates: gatesFinal,
    localSkills: existing?.localSkills ?? [],
    // ADR-013: profile ids the repo wants, whether they ship centrally or live
    // in `.simt-dev/profiles/`. Detection already selects the right profiles; this
    // is the declaration a reviewer reads to see the repo's intent stated rather
    // than inferred.
    profiles: existing?.profiles ?? [],
    // ADR-016: per-repo values for the canonical `.mdc` rules' declared
    // substitutions, keyed by rule id. Seeded empty rather than absent so the
    // shape is visible in the file before anything needs it. `__optIn` is not a
    // substitution value: it lists the rules this repo declares it has a problem
    // with, which is something detection cannot infer.
    substitutions: existing?.substitutions ?? {},
    // ADR-020: which editors this repo's rules are projected into. Absent means the
    // global standard applies; an explicit empty list is a real choice meaning
    // AGENTS.md only. Recorded rather than inferred, because "which IDE does this repo
    // support" is a decision a reviewer should be able to read in one line — and
    // because a typo here silently reduces the estate to AGENTS.md, which looks
    // exactly like a working setup.
    surfaces: surfaces ?? existing?.surfaces ?? null,
    projection: { simtDevSha: sha ?? null },
  };
}

/**
 * Declared gates this repo cannot run, as findings.
 *
 * `init` no longer writes them, but a manifest written by an older version still
 * carries them and a hand-edited one can add them back. Leaving that to
 * `hooks status` means the repo is green until someone installs hooks, at which
 * point every commit fails and the first exit anyone finds is `--no-verify`.
 * So the check that guards the generated rules also reports the landmine.
 *
 * @returns {{file: string, status: string, gate: string, detail: string, remedy: string}[]}
 */
export function unrunnableGates(manifest, capability) {
  const declared = [
    ...(manifest?.gates?.preCommit ?? []),
    ...(manifest?.gates?.prePush ?? []),
  ];
  const findings = [];
  const seen = new Set();
  for (const name of declared) {
    if (seen.has(name)) continue;
    seen.add(name);
    const gate = getGate(name);
    const verdict = gateRunnable(gate, capability);
    if (verdict.runnable) continue;
    findings.push({
      file: MANIFEST,
      status: 'unrunnable',
      gate: name,
      detail: `declares gate "${name}", which this repo cannot run: ${verdict.why}`,
      remedy: gateRemedy(gate, { existing: true, runner: capability.runner }),
    });
  }
  return findings;
}

/** ADR-005: 400 is a review trigger, 1000 a hard ceiling. Generated files exempt. */
function defaultLimits() {
  return { coverage: null, fileLines: { warn: 400, error: 1000 } };
}

/** ADR-006: coverage stays null. Set it only if the repo has a real numeric gate. */
function defaultGates(stack) {
  const tags = new Set(stack);
  const gates = { preCommit: [], prePush: [] };

  for (const row of GATES_BY_STACK) {
    if (row.when.some((tag) => tags.has(tag))) {
      gates.preCommit.push(...row.preCommit);
      gates.prePush.push(...row.prePush);
    }
  }
  for (const row of TAG_GATES) {
    if (tags.has(row.tag)) gates.preCommit.push(...row.preCommit);
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

/**
 * A repo id is the directory name. Using it rather than a guessed field keeps
 * `init` working in a directory that is not yet a git repo (step 8 scaffolds
 * those), where no remote name exists to read.
 */
function defaultId(root) {
  // Resolve before taking the basename: `basename('.')` is `''`, so every repo adopted
  // with `--root .` or a bare positional was written as `unnamed-repo`. The id is the
  // one field in the manifest a human reads, and it was wrong for the most natural
  // invocation of the command.
  const name = basename(resolve(root));
  return name === '' || name === '.' ? 'unnamed-repo' : name;
}

/**
 * Is a generated field of this manifest wrong, or has a formatter taken its bytes?
 *
 * Two distinct defects, one shape of answer, because they share a cause: a generated
 * file with no path back to being correct.
 *
 * 1. A STALE GENERATED FIELD. `buildManifest` emits `$comment` and
 *    `projection.simtDevSha`; the repo owns everything else. `upgrade` spreads the
 *    existing manifest and refreshes only the SHA, so a field added to the writer
 *    after a repo was adopted never appears — simt-space had been projecting for
 *    several versions with no `surfaces` key, and nothing said so. Every parse-based
 *    comparison passes, because the file is valid and the values in it are all true.
 *
 * 2. REFORMATTED BYTES. A repo with a prettier hook rewrites the manifest on the
 *    first commit: prettier collapses short arrays onto one line,
 *    `JSON.stringify(m, null, 2)` always expands them. The content is identical, so
 *    the next `init` puts simt-dev's bytes back and the formatter takes them away
 *    again. `upgrade` reported `current` the whole time, which is correct: the pin
 *    was current. The bytes were not.
 *
 * Content the repo chose is never compared. A repo that edited `limits.coverage` on
 * purpose is not being told to revert it.
 *
 * @returns {{file: string, status: string, detail: string, remedy: string}|null}
 */
export async function manifestDrift(root, stack, sha) {
  const { manifest, exists, error } = await readManifest(root);
  if (!exists || error !== null || manifest === null) return null;

  const expected = buildManifest({ root, stack, sha, existing: manifest });
  const stale = [];
  for (const key of Object.keys(expected)) {
    const generated =
      key === '$comment' ||
      (key === 'projection' && JSON.stringify(expected.projection) !== JSON.stringify(manifest.projection ?? null));
    if (generated && JSON.stringify(manifest[key]) !== JSON.stringify(expected[key])) stale.push(key);
  }
  if (stale.length > 0) {
    return {
      file: MANIFEST,
      status: 'stale-generated-field',
      detail: `generated field(s) ${stale.join(', ')} do not match what this simt-dev writes`,
      remedy: `run: simt-dev init --yes   (it refreshes the stamp without touching values this repo set)`,
    };
  }

  // Form is compared by re-serialising the file's OWN parsed content in our shape,
  // not by rebuilding the manifest from defaults. Rebuilding would also report a
  // repo for an optional key it predates (`surfaces`), which is not an error: absent
  // and null both mean "the global standard applies". Comparing content-to-content
  // isolates the one question — does another tool own this file's formatting.
  const onDisk = (await readFile(join(root, MANIFEST), 'utf8')).trim();
  const ours = JSON.stringify(manifest, null, 2).trim();
  if (onDisk === ours) return null;
  return {
    file: MANIFEST,
    status: 'reformatted',
    detail: 'content is what simt-dev would write, but the bytes differ - another formatter owns this file',
    remedy: `add ${MANIFEST} to .prettierignore (a generated file is not prose), then: simt-dev init --yes`,
  };
}

/** @returns {{manifest: object|null, exists: boolean, error: string|null}} */
export async function readManifest(root) {
  const path = join(root, MANIFEST);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { manifest: null, exists: false, error: null };
  }
  try {
    return { manifest: JSON.parse(text), exists: true, error: null };
  } catch (error) {
    return { manifest: null, exists: true, error: `unparseable: ${error.message}` };
  }
}

export async function writeManifest(root, manifest) {
  const path = join(root, MANIFEST);
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}