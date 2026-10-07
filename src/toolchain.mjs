// What the repository pins, and whether those pins agree with each other.
//
// rules/stacks/node.md already makes four claims about this and enforces none of them:
// one `packageManager` field matching the committed lockfile, a floor in `engines.node`,
// a `.nvmrc` that agrees with both, and `engines` stated at all. This module is the
// gate for those claims, so the file is read but never written: the values are the
// repository's decisions and a version is not this tool's to pick.
//
// The one thing deliberately not checked is whether one repository's node major matches
// another's. The plan called three `.nvmrc` files "disagreeing", and reading them showed
// they agree with their own `engines` perfectly; what differs is a per-repository choice
// that each one has a reason for. A check that reported that would be a check with no
// remedy, and a gate whose finding cannot be acted on is the failure AGENTS.md exists to
// prevent.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { fingerprint } from './resolve/fingerprint.mjs';
import { readJsonc } from './tsconfig.mjs';

export const LOCKFILES = [
  { file: 'package-lock.json', manager: 'npm' },
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'bun.lock', manager: 'bun' },
  { file: 'bun.lockb', manager: 'bun' },
];

const PKG_FILE = 'package.json';
const NVMRC_FILE = '.nvmrc';

/**
 * The comparators this tool will evaluate, and nothing else.
 *
 * A range it does not understand produces no finding rather than an approximate one: a
 * wrong contradiction names two values that may well be fine, and a reader who cannot tell
 * which of our readings was the guess stops trusting the ones we got right. Anything not
 * listed here is deliberately silent.
 *
 * @returns {null | {min: number[], max: number[]|null, minExclusive: boolean}}
 */
function comparator(text) {
  const operator = /^(>=|<=|>|<|\^|~|=)?\s*(\S+)$/.exec(text.trim());
  const sign = operator[1] ?? '';
  const version = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(operator[2].replace(/^[v=]+/, ''));
  if (!version) return null;
  const parts = [Number(version[1]), Number(version[2] ?? 0), Number(version[3] ?? 0)];
  const major = parts[0];
  const minor = parts[1];
  const nextMinor = { min: parts, minExclusive: false, max: [major, minor + 1, 0], maxExclusive: true };
  const unbounded = { max: null, maxExclusive: false };

  if (sign === '>=') return { min: parts, minExclusive: false, ...unbounded };
  if (sign === '>') return { min: parts, minExclusive: true, ...unbounded };
  if (sign === '<=') return { min: null, minExclusive: false, max: parts, maxExclusive: false };
  if (sign === '<') return { min: null, minExclusive: false, max: parts, maxExclusive: true };
  if (sign === '^') {
    const ceiling = major === 0 ? (minor === 0 ? [0, 0, parts[2] + 1] : [0, minor + 1, 0]) : [major + 1, 0, 0];
    return { min: parts, minExclusive: false, max: ceiling, maxExclusive: true };
  }
  if (sign === '~') return nextMinor;
  // A bare `22` means every 22, as npm reads it, and `22.1` every 22.1. Reading either as
  // one exact version would report a matching pin as a contradiction.
  if (version[3] !== undefined) return { min: parts, minExclusive: false, max: parts, maxExclusive: false };
  if (version[2] !== undefined) return nextMinor;
  return { min: parts, minExclusive: false, max: [major + 1, 0, 0], maxExclusive: true };
}

/** @returns {null | number[]} `null` when the range uses something this tool does not evaluate. */
export function allows(range, version) {
  const target = typeof version === 'string' ? version.trim().replace(/^[v=]+/, '') : version;
  if (!/^\d+(\.\d+)*$/.test(String(target))) return null;
  const wanted = String(target).split('.').map(Number);
  const padded = [wanted[0], wanted[1] ?? 0, wanted[2] ?? 0];
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

  // An `||` satisfies if any branch does; every branch must be readable or the answer is
  // unknown rather than "no".
  const branches = String(range).split('||');
  const read = branches.map((branch) => branch.trim().split(/\s+/).map(comparator));
  if (read.some((terms) => terms.some((term) => term === null))) return null;

  return read.some((terms) =>
    terms.every((term) => {
      if (term.min !== null) {
        const cmp = compare(padded, term.min);
        if (cmp < 0 || (cmp === 0 && term.minExclusive)) return false;
      }
      if (term.max === null) return true;
      const cmp = compare(padded, term.max);
      return cmp < 0 || (cmp === 0 && !term.maxExclusive);
    })
  );
}

/**
 * @returns {Promise<{manager: string, lockfile: string, declared: string|null,
 *   engines: string|null, nvmrc: string|null}[]>} one entry per lockfile found
 */
export async function readPins(root) {
  // `fingerprint().manifest` is this tool's own manifest, not package.json, so the node
  // stack tag decides whether there is a package.json to read and the file is read here.
  const { stack } = await fingerprint(root);
  if (!stack.includes('node')) return [];
  const text = await readFile(join(root, PKG_FILE), 'utf8').catch(() => null);
  if (text === null) return [];
  const { value: pkg, error } = readJsonc(text);
  if (error !== null) return [];

  const found = [];
  for (const entry of LOCKFILES) {
    if (!(await readFile(join(root, entry.file), 'utf8').then(() => true).catch(() => false))) continue;
    found.push({
      manager: entry.manager,
      lockfile: entry.file,
      declared: typeof pkg.packageManager === 'string' ? pkg.packageManager : null,
      engines: pkg.engines && typeof pkg.engines.node === 'string' ? pkg.engines.node : null,
      nvmrc: await readFile(join(root, NVMRC_FILE), 'utf8').then((t) => t.trim()).catch(() => null),
    });
  }
  return found;
}

/**
 * @returns {Promise<{file: string, status: string, detail: string, remedy: string}[]>}
 */
export async function checkToolchain(root) {
  const pins = await readPins(root);
  const findings = [];
  const report = (file, status, detail, remedy) => findings.push({ file, status, detail, remedy });

  if (pins.length === 0) return findings;

  // Two lockfiles is not a disagreement this tool can resolve by picking one, so it is
  // reported as what it is: the repository does not have a single package manager.
  if (pins.length > 1) {
    report(
      PKG_FILE,
      'mismatched',
      `this repo has ${pins.length} lockfiles (${pins.map((p) => p.lockfile).join(', ')}), so the ` +
        'package manager is whichever one each contributor installed',
      'delete the lockfile for the manager this repo does not use, and commit the other one',
    );
    return findings;
  }

  const [pin] = pins;

  if (pin.declared === null) {
    report(
      PKG_FILE,
      'undeclared',
      `this repo commits ${pin.lockfile} and declares no "packageManager", so the manager is ` +
        'whoever installed it last and corepack is free to pick the other one',
      `npm pkg set packageManager=${pin.manager}@$(npm --version)   (run it here; it fills in the version this machine has)`,
    );
  } else if (pin.declared.split('@')[0] !== pin.manager) {
    report(
      PKG_FILE,
      'mismatched',
      `"packageManager" says ${pin.declared} and this repo commits ${pin.lockfile}, so the field ` +
        'pins a manager whose lockfile is not the one being committed',
      `npm pkg set packageManager=${pin.manager}@$(npm --version)`,
    );
  }

  if (pin.engines === null) {
    // The remedy prefers the version the repository already pins over the one this machine
    // happens to run. Taking the local one is what turns a single missing floor into two
    // findings: a developer on a newer node than the repo's `.nvmrc` would floor above their
    // own pin and be handed a contradiction the moment they acted on it.
    const floor = pin.nvmrc !== null
      ? `   (${NVMRC_FILE} already pins ${pin.nvmrc}; floor to that version, not to this machine's)`
      : '   (run it here; it fills in the version this machine has)';
    report(
      PKG_FILE,
      'unfloored',
      `this repo commits ${pin.lockfile} and declares no "engines": {"node": ...}, so the floor ` +
        'is a comment and the version is whatever CI happens to be running',
      `node --version   (then add "engines": {"node": ">=<that version>"} to package.json)${floor}`,
    );
  }

  // A `.nvmrc` that the declared floor forbids is the one contradiction in this file that
  // has a single obvious answer, because the floor is the promise and the pin is the
  // instance: the pin is the thing that must move.
  if (pin.nvmrc !== null && pin.engines !== null) {
    const satisfies = allows(pin.engines, pin.nvmrc);
    if (satisfies === false) {
      report(
        NVMRC_FILE,
        'contradiction',
        `${NVMRC_FILE} pins ${pin.nvmrc} and "engines": {"node": "${pin.engines}"} does not allow it, ` +
          'so the version a developer gets locally is one the project says it does not support',
        `change ${NVMRC_FILE} to a version that satisfies "${pin.engines}", or raise "engines": {"node": ...} to cover ${pin.nvmrc}`,
      );
    }
  }

  return findings;
}
