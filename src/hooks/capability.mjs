// What a repository can demonstrably run, as opposed to what its stack suggests.
//
// This exists because the first real adoption declared five gates and could run two.
// The stack table proposes a formatter, a linter and an i18n check for any Node repo;
// simt-social-media has no prettier installed, no `lint` script and no declared command
// for the i18n check. Every one of those gates fails closed by design, so installing the
// dispatcher on that manifest blocks every commit and teaches the team to reach for
// `--no-verify`. The dispatcher was right; the declaration was wrong.
//
// Three kinds of evidence, and they are not interchangeable:
//   - a script that EXISTS in package.json, which is what `npm run <name>` will attempt
//   - a binary INSTALLED in node_modules/.bin, which is what the staged formatter shells
//     out to; a declared dependency with no install is not one
//   - a command the manifest itself declares under `gates.commands`, because "repo
//     specific check" means the repo names the program
//
// Deliberately no inference. A repo with `lint` in its dependencies and no `lint` script
// cannot run a `lint` gate, and this reads the manifest rather than the dependency graph
// so the two can never disagree about what a script does.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Binaries the shared dispatcher shells out to directly, rather than via a script. */
const BIN_DIR = join('node_modules', '.bin');

/**
 * Read what this repo can run.
 *
 * @param {string} root
 * @returns {Promise<{scripts: Record<string,string>, binaries: string[], commands: Record<string,string>, error: string|null}>}
 */
export async function readCapability(root) {
  const capability = { scripts: {}, binaries: [], commands: {}, error: null };

  try {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    capability.scripts = manifest.scripts ?? {};
  } catch (error) {
    // A repo with no manifest is a normal shape — a Python or Gradle repo has no
    // package.json at all — so this is reported, never thrown. The gate filter treats
    // an empty script map as "no npm script gates", which is the truth.
    capability.error = error.code === 'ENOENT' ? null : `package.json: ${error.message}`;
  }

  try {
    capability.binaries = (await readdir(join(root, BIN_DIR))).filter((n) => !n.includes('.'));
  } catch {
    // No node_modules is the same as no installed binaries.
  }

  return capability;
}

/** The declared `gates.commands` map from an existing manifest, if it has one. */
export function declaredCommands(manifest) {
  const commands = manifest?.gates?.commands;
  return commands && typeof commands === 'object' ? commands : {};
}