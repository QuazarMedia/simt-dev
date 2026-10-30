// The one Node runner resolver every consumer reads (review 0003 Q31).
//
// Before this, four tables answered "how does this repo run a script" and
// disagreed: the card printed `npm run`, the dispatcher spawned `npm run`,
// the manifest remedies named `npm run`, and CI installed with `npm ci` — in a
// repository whose lockfile and `packageManager` said pnpm. A pnpm adoption
// then failed on its first pull request, and a docs-only or Go repo got
// remedies proposing npm gates it could never run.
//
// One data table, one resolver, every consumer. The table is records, not
// code, so the Q70 ecosystem work can adopt it without a second answer: a
// future `ecosystems/<id>.json` row carries the same fields and this resolver
// stays the shape of the lookup.
//
// Precedence is committed evidence first. A lockfile on disk names the manager
// the repo actually installs with; `packageManager` names the one it declares.
// Where the two disagree `checkToolchain` already reports `mismatched`, and the
// runner follows the lockfile — the install step must restore the tree CI
// checks out, not the field. With no lockfile the declared field wins over the
// npm default, so a fresh `pnpm init` names pnpm before its first install.

export const NODE_MANAGERS = [
  {
    id: 'pnpm',
    lockfiles: ['pnpm-lock.yaml'],
    fact: 'has-pnpm-lock',
    run: 'pnpm',
    install: 'pnpm install --frozen-lockfile',
    installFallback: 'pnpm install',
    addDev: 'pnpm add -D',
    silent: true,
    setupNode: true,
  },
  {
    id: 'yarn',
    lockfiles: ['yarn.lock'],
    fact: 'has-yarn-lock',
    run: 'yarn',
    install: 'yarn install --frozen-lockfile',
    installFallback: 'yarn install',
    addDev: 'yarn add -D',
    silent: true,
    setupNode: true,
  },
  {
    id: 'bun',
    lockfiles: ['bun.lock', 'bun.lockb'],
    fact: 'has-bun-lock',
    run: 'bun',
    install: 'bun install --frozen-lockfile',
    installFallback: 'bun install',
    addDev: 'bun add -d',
    silent: false,
    setupNode: false,
  },
  {
    id: 'npm',
    lockfiles: ['package-lock.json'],
    fact: 'has-package-lock',
    run: 'npm',
    install: 'npm ci',
    installFallback: 'npm install',
    addDev: 'npm i -D',
    silent: true,
    setupNode: true,
  },
];

const BY_ID = new Map(NODE_MANAGERS.map((row) => [row.id, row]));
const BY_LOCKFILE = new Map();
for (const row of NODE_MANAGERS) {
  for (const file of row.lockfiles) BY_LOCKFILE.set(file, row);
}
const BY_FACT = new Map(NODE_MANAGERS.map((row) => [row.fact, row]));

/** The npm row. Exported so callers never spell a default twice. */
export function npmManager() {
  return BY_ID.get('npm');
}

/**
 * Name the manager a `packageManager` field declares, or null.
 *
 * `packageManager` is `manager@version`; only the manager names the runner.
 * Unknown managers and non-strings are null, never a guess.
 */
export function managerFromPackageField(value) {
  if (typeof value !== 'string') return null;
  const id = value.split('@')[0].trim();
  return BY_ID.has(id) ? id : null;
}

/**
 * Resolve the one Node runner for a repository.
 *
 * @param {{facts?: string[]|Set<string>, lockfiles?: string[], packageManager?: string|null}} input
 * @returns {object} the NODE_MANAGERS row that owns this repo
 */
export function resolveNodeRunner({ facts = [], lockfiles = [], packageManager = null } = {}) {
  const present = facts instanceof Set ? facts : new Set(facts);
  for (const row of NODE_MANAGERS) {
    if (present.has(row.fact)) return row;
    for (const file of row.lockfiles) {
      if (lockfiles.includes(file)) return row;
    }
  }
  const declared = managerFromPackageField(packageManager);
  if (declared) return BY_ID.get(declared);
  return npmManager();
}

/** Whether this runner id spells gates as `<run> run <script>`. */
export function isNodeRunner(runner) {
  return BY_ID.has(runner);
}

/** The command that runs one script: `pnpm run lint`, `bun run lint`. */
export function runScript(manager, script) {
  const id = typeof manager === 'string' ? manager : manager?.id ?? 'npm';
  const run = BY_ID.get(id)?.run ?? 'npm';
  return `${run} run ${script}`;
}

/** The argv the dispatcher spawns for one script gate. */
export function runScriptArgv(manager, script) {
  const id = typeof manager === 'string' ? manager : manager?.id ?? 'npm';
  const row = BY_ID.get(id) ?? npmManager();
  if (row.silent) return [row.run, 'run', '--silent', script];
  return [row.run, 'run', script];
}

/** Install step for CI: the frozen command plus its fallback. */
export function installCommands(manager) {
  const row = typeof manager === 'string' ? (BY_ID.get(manager) ?? npmManager()) : (manager ?? npmManager());
  return { install: row.install, fallback: row.installFallback, setupNode: row.setupNode };
}

/** Look up a manager record by lockfile name, fact, or id. */
export function lookupNodeManager({ lockfile = null, fact = null, id = null } = {}) {
  if (id && BY_ID.has(id)) return BY_ID.get(id);
  if (lockfile && BY_LOCKFILE.has(lockfile)) return BY_LOCKFILE.get(lockfile);
  if (fact && BY_FACT.has(fact)) return BY_FACT.get(fact);
  return null;
}
