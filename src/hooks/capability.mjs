// What a repository can demonstrably run, as opposed to what its stack suggests.
//
// This exists because the first real adoption declared five gates and could run two.
// The stack table proposes a formatter, a linter and an i18n check for any Node repo;
// a repository with no prettier installed, no `lint` script and no declared command
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

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { manifestPath } from '../projection/manifest.mjs';

/** Binaries the shared dispatcher shells out to directly, rather than via a script. */
const BIN_DIR = join('node_modules', '.bin');

/**
 * Non-npm runners, and the file that proves one is in use.
 *
 * Only enough to answer "is `npm run <script>` even a sentence this repo can finish?".
 * The concrete Gradle task names are deliberately NOT listed: guessing them would print
 * a remedy that is wrong in exactly the repos where it is printed, which is the failure
 * this whole module exists to remove.
 */
const RUNNER_MARKERS = {
  gradle: 'gradlew',
  python: 'pyproject.toml',
  bun: 'bun.lockb',
  cargo: 'Cargo.toml',
  go: 'go.mod',
};

/**
 * Does this path exist as a FILE?
 *
 * `readdir` was the obvious call here and it silently answers "no" for every file —
 * `ENOTDIR` — which would have left every Gradle, Cargo, Go and Bun repo classified as
 * having no runner at all. A wrong answer from an evidence reader is worse than none,
 * because the caller cannot tell the difference.
 */
async function fileExists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    // Anything unreadable is not evidence either way, and treating it as absent keeps a
    // gate out rather than declaring one this repo cannot prove.
    return false;
  }
}

/**
 * Read what this repo can run.
 *
 * @param {string} root
 * @returns {Promise<{scripts: Record<string,string>, binaries: string[], commands: Record<string,string>, runner: string, error: string|null}>}
 */
export async function readCapability(root) {
  const capability = { scripts: {}, binaries: [], commands: {}, runner: null, error: null };

  try {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    capability.scripts = manifest.scripts ?? {};
    capability.runner = 'npm';
  } catch (error) {
    // A repo with no manifest is a normal shape — a Python or Gradle repo has no
    // package.json at all — so this is reported, never thrown. The gate filter treats
    // an empty script map as "no npm script gates", which is the truth.
    capability.error = error.code === 'ENOENT' ? null : `package.json: ${error.message}`;
  }

  // `runner` records whether `npm run` is even the language a gate would be written in.
  // Without it, a dropped `test` gate on a Gradle repo is explained as a missing
  // package.json script — a fix the reader cannot make, in a file that will never exist
  // in that repo. A remedy naming an action the reader cannot take is a second problem
  // stacked on the first, so the runner decides which remedy is even applicable.
  //
  // `'none'` is a real answer, distinct from "not reported": a caller that builds a
  // capability by hand may leave `runner` unset, and treating that as "no package.json"
  // would make an npm repo's remedy claim a file it has.
  if (capability.runner === null) {
    capability.runner = 'none';
    for (const [tag, marker] of Object.entries(RUNNER_MARKERS)) {
      if (await fileExists(join(root, marker))) {
        capability.runner = tag;
        break;
      }
    }
  }

  try {
    capability.binaries = (await readdir(join(root, BIN_DIR))).filter((n) => !n.includes('.'));
  } catch {
    // No node_modules is the same as no installed binaries.
  }

  // `gates.commands` lives in simt-dev.json, NOT package.json, so it has to be read
  // here or a command gate looks undeclared to `check` while the dispatcher runs it
  // successfully — the gate and the checker disagreeing about the same manifest.
  //
  // This is the one capability source that is a declaration rather than an observation,
  // and that asymmetry is the point: a command gate is the repo naming its own program,
  // so the only evidence that can prove it is the declaration itself. A repo with no
  // manifest simply has no declared commands.
  try {
    const manifest = JSON.parse(await readFile(await manifestPath(root), 'utf8'));
    capability.commands = declaredCommands(manifest);
  } catch {
    capability.commands = {};
  }

  return capability;
}

/** The declared `gates.commands` map from an existing manifest, if it has one. */
export function declaredCommands(manifest) {
  const commands = manifest?.gates?.commands;
  return commands && typeof commands === 'object' ? commands : {};
}