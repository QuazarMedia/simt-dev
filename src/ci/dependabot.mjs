// Dependency updates, as a file a repo owns.
//
// The gap this closes is real and dated: no repository in the estate had a
// Dependabot config, and plan 1 named it as still missing after the CI gate
// landed. A repo with no Dependabot config does not get security patches as
// pull requests - it finds out from an advisory.
//
// Two decisions are load-bearing, and both come from what this file IS rather
// than from taste.
//
//   - It is a WHOLE FILE, not a region. ADR-025 ruled that a baseline is a
//     marker-managed region, and that ruling is right for a file whose grammar
//     has a place to put one. This file has no such place: `updates:` is a YAML
//     list, and two lists cannot be concatenated. There is no region shape that
//     means "these entries are mine and those are yours", so there is nothing to
//     merge and nothing to preserve - which is not an accident to work around but
//     the reason the ownership question has to be answered differently rather
//     than the same.
//
//   - So it inherits ADR-023's ownership rule wholesale: written once, never
//     rewritten, their file from the first commit. A repo that wants a different
//     cadence, a private registry or an `ignore` rule edits it, and the edit
//     stays. simt-dev's own repository is the ADR-024 exception and is refreshed
//     by `simt-dev ci`.
//
// The content is detection-driven, which is the ADR-013 shape: the ecosystems
// listed are the ones this tree actually has a manifest for. Writing an `npm`
// entry into a repo with no `package.json` looks configured and configures
// nothing - Dependabot finds no manifest and silently opens no pull request,
// which is the failure mode a generated file is supposed to make impossible.
//
// `github-actions` is the one unconditional entry, and it is unconditional
// because of what this package ships: simt-dev writes a workflow into every
// repo it adopts (ADR-023), so every repo that adopted it has Actions to
// watch. A repo with no workflow has no Actions, and is not an entry here.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { fingerprint } from '../resolve/fingerprint.mjs';
import { isOwnRepo, WORKFLOWS_DIR } from './workflow.mjs';

/** The one file this module writes. */
export const DEPENDABOT_FILE = '.github/dependabot.yml';

/**
 * fact -> the `package-ecosystem` value Dependabot documents for it.
 *
 * The fact names are already in the fingerprint vocabulary and already carry
 * evidence, so this table adds no new observation vocabulary: it says which
 * Dependabot value watches which observable manifest. Facts absent from this
 * table are not ecosystems Dependabot updates, and adding one is a new ruling
 * about the estate rather than a code detail.
 *
 * Several facts map to one value on purpose. `has-pyproject` and
 * `has-requirements` are two ways of declaring python dependencies and
 * Dependabot reads both under `pip`; emitting two `pip` entries would be a
 * duplicate the config rejects or silently collapses, and the reader would have
 * no way to tell which one won.
 *
 * A `stack` tag is used where no fact exists and one is needed. npm is the
 * clearest case: `node` is a stack tag in `fingerprint.mjs` and `typescript` is
 * a dependency name, so a repo's package manager is either of those and adding
 * `has-node-manifest` would be a third name for one observation - the exact
 * duplication that table's own header rules out. Every other entry below is a
 * real `has-*` fact, which is why npm reads differently from its neighbours.
 *
 * `has-build-system` is deliberately NOT mapped: Makefile, CMakeLists and
 * meson.build are build files, not dependency manifests, and Dependabot has no
 * ecosystem that reads them. Mapping it to `maven` would be a lie of exactly the
 * kind the detection-driven ruling exists to prevent.
 */
const ECOSYSTEMS = [
  { stack: 'node', value: 'npm', manifest: 'package.json' },
  { stack: 'typescript', value: 'npm', manifest: 'package.json' },
  { fact: 'has-pyproject', value: 'pip', manifest: 'pyproject.toml' },
  { fact: 'has-requirements', value: 'pip', manifest: 'requirements.txt' },
  { fact: 'has-go-mod', value: 'gomod', manifest: 'go.mod' },
  { fact: 'has-cargo-toml', value: 'cargo', manifest: 'Cargo.toml' },
  { fact: 'has-gemfile', value: 'bundler', manifest: 'Gemfile' },
  { fact: 'has-composer', value: 'composer', manifest: 'composer.json' },
  { fact: 'has-maven-pom', value: 'maven', manifest: 'pom.xml' },
  { fact: 'has-dockerfile', value: 'docker', manifest: 'Dockerfile' },
  { fact: 'has-compose', value: 'docker-compose', manifest: 'compose file' },
  { fact: 'has-terraform', value: 'terraform', manifest: '*.tf' },
];

/**
 * The ecosystems this tree has a manifest for, in a stable order.
 *
 * The order is the table's, not detection's: `fingerprint` returns arrays built
 * from sets and file listings, and a config whose entry order changed with
 * readdir order could not be diffed. Determinism is a feature here - a pull
 * request that adds a manifest must show one added entry, not a reshuffle.
 *
 * @param {Iterable<string>} facts emitted `has-*` facts
 * @param {Iterable<string>} [stack] emitted stack tags
 * @returns {{value: string, manifest: string}[]}
 */
export function ecosystems(facts, stack = []) {
  const seenFacts = new Set(facts);
  const seenStack = new Set(stack);
  const out = [];
  for (const row of ECOSYSTEMS) {
    const found = row.fact ? seenFacts.has(row.fact) : seenStack.has(row.stack);
    if (!found || out.some((e) => e.value === row.value)) continue;
    out.push({ value: row.value, manifest: row.manifest });
  }
  return out;
}

/**
 * The header.
 *
 * @param {boolean} own whether this is simt-dev's own repository
 * @returns {string}
 */
function header(own) {
  if (own) {
    return `# Written by simt-dev, and refreshed by it. This repository is simt-dev's
# own, so this file is a copy of the template rather than a repository's own: a diff
# here means the TEMPLATE changed, not that somebody hand-edited their updates.
# Anywhere else this file is written once by \`simt-dev init\` and never touched again.
#
# To change which ecosystems are watched, change \`src/ci/dependabot.mjs\` in the same
# commit and run \`simt-dev ci --yes\`. Editing this file by hand works until the
# next template change overwrites it.
#
# The entries below are the ecosystems this repository has a manifest for. A repo
# that adds a manifest does not get an entry from this tool: \`simt-dev ci\` is the
# only writer here, so an entry is added deliberately rather than as a side effect.
`;
  }
  return `# Written by simt-dev when this repo was adopted. Yours from here: simt-dev
# creates this file once and never rewrites it, so your own cadence, ignore rules
# and groups stay yours.
#
# Each entry is a package manager this repo actually has a manifest for, so every
# one of them opens pull requests. Adding a manifest does not add an entry - the
# file is yours now, and the entry is a line you write on purpose.
#
# To add one: copy any block below, set \`package-ecosystem\` to your package manager,
# point \`directory\` at the folder holding the manifest, and leave the schedule at
# weekly unless you have a reason not to.
`;
}

/** One `updates:` entry. `directory` is "/" for everything: a monorepo's packages
 *  live under the root, and Dependabot searches the directory it is given plus its
 *  subdirectories only when told to with a glob, which is the repo's decision to
 *  make rather than this tool's. */
function entry({ value }) {
  return `  - package-ecosystem: "${value}"
    directory: "/"
    schedule:
      interval: "weekly"`;
}

/**
 * The config, as bytes.
 *
 * @param {Iterable<string>} facts emitted `has-*` facts for the target repo
 * @param {{stack?: Iterable<string>, own?: boolean}} [options]
 * @returns {string} YAML, LF-terminated
 */
export function renderDependabot(facts, { stack = [], own = false } = {}) {
  const found = ecosystems(facts, stack);
  const entries = [entry({ value: 'github-actions' }), ...found.map(entry)];
  return `${header(own)}version: 2
updates:
${entries.join('\n')}
`;
}

/**
 * What this repo's dependabot file should be, and what should happen to it.
 *
 * Mirrors `planWorkflow` deliberately: two files, one ownership rule, one place
 * that knows it. A reader of `src/commands/ci.mjs` should not have to work out
 * which of these two files behaves differently.
 *
 * @param {string} root repo root
 * @returns {Promise<{file:string, path:string, action:'create'|'refresh'|'unchanged'|'skip',
 *                    own:boolean, exists:boolean, bytes:number, current:boolean,
 *                    workflows:boolean, ecosystems:string[], reason:string|null}>}
 */
export async function planDependabot(root) {
  const path = join(root, DEPENDABOT_FILE);
  const own = isOwnRepo(root);
  let text = null;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    text = null;
  }
  const exists = text !== null;
  const bytes = exists ? Buffer.byteLength(text) : 0;

  // ENOENT is absence; anything else is a file this tool cannot read, and calling
  // that "create" hands the writer an EACCES instead of saying what is wrong.
  let workflows = false;
  try {
    workflows = (await stat(join(root, WORKFLOWS_DIR))).isDirectory();
  } catch {
    workflows = false;
  }

  // Detection runs even when the file exists, because the refresh comparison needs
  // the bytes this repo would get today. Skipping it would make `refresh` mean
  // "the file differs" instead of "the file differs from what this repo should get",
  // and those are different questions when a manifest appeared since.
  const { facts, stack } = await fingerprint(root);
  const watched = ecosystems(facts, stack).map((e) => e.value);
  // Carried on the plan so the writer renders from the same observation this
  // comparison used. Re-detecting at write time would make `ci` and `check`
  // disagree whenever a manifest appeared between the two calls, and the file
  // would be written from facts nobody ever saw in the plan.
  const detection = { facts, stack };

  if (exists) {
    // Both sides of the comparison, for the same reason as the workflow plan: a reader
    // told the file differs can be shown how, and re-rendering for a diff would let
    // the two answers disagree.
    const desired = renderDependabot(facts, { stack, own: true });
    const current = own ? text === desired : true;
    return {
      file: DEPENDABOT_FILE,
      path,
      action: current ? 'unchanged' : 'refresh',
      own,
      exists,
      bytes,
      current,
      source: { text, desired },
      workflows,
      ecosystems: watched,
      ...detection,
      reason: current ? null : `this repository is simt-dev's own, and the dependabot template has changed since this copy was written`,
    };
  }
  return {
    file: DEPENDABOT_FILE,
    path,
    action: workflows || own ? 'create' : 'skip',
    own,
    exists,
    bytes,
    current: false,
    workflows,
    ecosystems: watched,
    ...detection,
    reason:
      workflows || own
        ? null
        : `no ${WORKFLOWS_DIR} directory, so this repo does not run GitHub Actions yet`,
  };
}