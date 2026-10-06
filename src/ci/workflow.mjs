// The CI gate, as a file a repo owns.
//
// `simt-dev check` is the whole gate: projection drift, an unreadable rule, an
// unrunnable gate, a stale manifest. The pre-commit hook runs it locally, which
// stops one person committing a broken region and stops nobody else - a hook is a
// developer's machine, and every review is somebody else's. So the same command
// ships as a workflow that runs the gate where a pull request is actually merged.
//
// Two decisions that are easy to get wrong and are load-bearing:
//
//   - The BYTES are copied, not referenced. A GitHub `uses:` line would make this
//     one file owned by a repository the adopting team cannot read, cannot edit and
//     cannot diff, changing under them whenever that repo moves. A copied file is
//     reviewable in the PR that adopts it, which is the only review that happens.
//
//   - It is written ONCE and never rewritten. From that point it is the repo's
//     file: their extra jobs, their triggers, their matrix. Overwriting it would
//     delete work this tool has no way to know about, which is the same defect as
//     replacing a hand-written `.mdc` body. A template improvement therefore does
//     not reach an adopted repo on its own - stated in ADR-023 rather than
//     discovered later.
//
// The directory decides whether it applies at all: a repo with no
// `.github/workflows` is not a GitHub Actions repo, and silently creating that
// directory starts running CI on someone's pull requests they did not ask for.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { PACKAGE_NAME, renderLocator } from '../locate.mjs';

/** Directory whose presence means this repo runs GitHub Actions. */
export const WORKFLOWS_DIR = '.github/workflows';

/** The one file this module writes. */
export const WORKFLOW_FILE = `${WORKFLOWS_DIR}/simt-dev-check.yml`;

/**
 * The workflow, as bytes.
 *
 * @returns {string} YAML, LF-terminated
 */
export function renderWorkflow() {
  const locator = renderLocator('check --root "$ROOT"', {
    remedy: `REMEDY run: npm i -D ${PACKAGE_NAME}   (the gate runs from the pinned dependency)`,
  });
  return `# Written by simt-dev when this repo was adopted. Yours from here: simt-dev
# creates this file once and never rewrites it, so your own jobs and triggers stay
# yours.
#
# It runs one command, \`simt-dev check\` - the same gate the pre-commit hook runs,
# in the place a pull request is actually merged. A hook guards one developer's
# machine; this guards the merge.
#
# If simt-dev cannot be found the job FAILS instead of passing. A green tick from a
# check that never ran is the one outcome worse than a red one.
name: simt-dev check

on:
  pull_request:
  push:
    branches:
      - main
      - master

# Read-only is enough to check a repo, and a gate job does not need to write to it.
permissions:
  contents: read

concurrency:
  group: simt-dev-\${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    name: simt-dev check
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          # The floor in this package's \`engines.node\`. A gate that cannot start on
          # the version it declares support for is not a gate.
          node-version: '20'
      - name: install dependencies
        # \`npm ci\` needs a lockfile; a repo without one is still gated, not skipped.
        run: npm ci || npm install
      - name: simt-dev check
        run: |
          set -eu
          ROOT="\${GITHUB_WORKSPACE}"
${locator.split('\n').map((l) => (l === '' ? '' : `          ${l}`)).join('\n')}
`;
}

/**
 * Whether this repo already runs GitHub Actions, and whether the gate file is there.
 *
 * @param {string} root repo root
 * @returns {Promise<{file:string, path:string, action:'create'|'unchanged'|'skip',
 *                    exists:boolean, bytes:number, workflows:boolean, reason:string|null}>}
 */
export async function planWorkflow(root) {
  const path = join(root, WORKFLOW_FILE);
  let exists = false;
  let bytes = 0;
  try {
    const text = await readFile(path, 'utf8');
    exists = true;
    bytes = Buffer.byteLength(text);
  } catch {
    exists = false;
  }

  // An unreadable path is not an absent one. ENOENT is absence; anything else means
  // the file is there and this tool cannot see it, and reporting that as "create"
  // would hand the writer an EACCES at the worst moment.
  let workflows = false;
  try {
    workflows = (await stat(join(root, WORKFLOWS_DIR))).isDirectory();
  } catch {
    workflows = false;
  }

  if (exists) {
    return { file: WORKFLOW_FILE, path, action: 'unchanged', exists, bytes, workflows, reason: null };
  }
  return {
    file: WORKFLOW_FILE,
    path,
    action: workflows ? 'create' : 'skip',
    exists,
    bytes,
    workflows,
    reason: workflows ? null : `no ${WORKFLOWS_DIR} directory, so this repo does not run GitHub Actions yet`,
  };
}