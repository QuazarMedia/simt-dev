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
//   - simt-dev's OWN repository is the exception, and the exception has to be the
//     file's own words. Everywhere else the file is a repo's; here it is a copy of
//     the thing it is copied from, and a copy that is allowed to rot stops being a
//     template. A reader who opens this file in this repository and sees a diff has
//     to be able to tell it apart from a hand edit without reading a decision record,
//     which is why the header says so in the file rather than in this comment.
//
// The own copy also RUNS something different, and that is not a variation for taste.
// `simt-dev check` is red in this repository by design: AGENTS.md here is written by
// hand and deliberately never self-adopted (see its own "Why this repository is not
// self-adopted"), so the check reports it as unmanaged forever. A gate that is red on
// the day it lands is the one thing worse than no gate - it teaches the reader to
// ignore it - so the own copy runs what this repository actually declares, which is
// what `.githooks/pre-push` already runs.
//
// The directory decides whether it applies at all: a repo with no
// `.github/workflows` is not a GitHub Actions repo, and silently creating that
// directory starts running CI on someone's pull requests they did not ask for. The
// own repository is exempt from that too, for the same reason it is exempt from
// write-once: it is the only repo whose Actions directory this tool is entitled to
// decide the contents of.

import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { PACKAGE_ROOT } from '../workspace.mjs';
import { PACKAGE_NAME, WORKFLOW_FILE_NAME } from '../name.mjs';
import { renderLocator } from '../locate.mjs';
import { CLI } from '../name.mjs';
import { packageVersion } from '../package-version.mjs';

/** Directory whose presence means this repo runs GitHub Actions. */
export const WORKFLOWS_DIR = '.github/workflows';

/** The one file this module writes. */
export const WORKFLOW_FILE = `${WORKFLOWS_DIR}/${WORKFLOW_FILE_NAME}`;

/**
 * Whether this repo is the one this code is running from.
 *
 * `resolve` and not `realpath`, deliberately: a repo reached through a symlinked
 * path fails to match, and that is the safe direction. It would be written once and
 * never refreshed - the ruling every other repo lives under - where a realpath that
 * matched a symlink would let an alias of this repo rewrite a file nobody thought of
 * as managed.
 *
 * @param {string} root repo root
 * @returns {boolean}
 */
export function isOwnRepo(root) {
  return resolve(root) === PACKAGE_ROOT;
}

/**
 * The header. The only part of the file that says who owns it, and the place the
 * exception has to live: a reader of this file who has only this repository has to be
 * able to tell, from these bytes, that simt-dev rewrites it here and nowhere else.
 *
 * @param {boolean} own whether this is simt-dev's own repository
 * @returns {string}
 */
function header(own) {
  if (own) {
    return `# Written by simt-dev, and refreshed by it. This repository is simt-dev's
# own, so this file is a copy of the template rather than a repository's own: a diff
# here means the GATE changed, not that somebody hand-edited their CI. Anywhere else
# this file is written once by \`${CLI} init\` and never touched again.
#
# To change what the gate does, change \`src/ci/workflow.mjs\` in the same commit and
# run \`${CLI} ci --yes\`. Editing this file by hand works until the next template
# change overwrites it.
#
# The steps below run what this repository declares - its tests and its registry lint,
# the same two \`.githooks/pre-push\` runs - and NOT \`${CLI} check\`. That check is
# red here by design: this AGENTS.md is written by hand and deliberately never
# self-adopted, so the check reports it as unmanaged on every run. A gate that is red
# the day it lands is worse than no gate.
#
# Every step runs from this checkout: this package has zero dependencies, so there is
# nothing to install and no binary to resolve. Nothing here can pass by skipping - a
# step that cannot run fails the job.
`;
  }
  return `# Written by simt-dev when this repo was adopted. Yours from here: ${CLI}
# creates this file once and never rewrites it, so your own jobs and triggers stay
# yours.
#
# It runs one command, \`${CLI} check\` - the same gate the pre-commit hook runs,
# in the place a pull request is actually merged. A hook guards one developer's
# machine; this guards the merge.
#
# If ${CLI} cannot be found the job FAILS instead of passing. A green tick from a
# check that never ran is the one outcome worse than a red one.
`;
}

/**
 * Actions the templates run, pinned to the commit that runs them.
 *
 * A tag is a name that moves. `actions/checkout@v4` resolved to whatever that project
 * published under the name today, so the bytes executing a gate are not the bytes the
 * adopting repository reviewed, and a change to them arrives as a force-push or a
 * compromised token rather than as a diff. The pin is the commit; the comment beside it
 * is the release a reader recognises, and Dependabot's `github-actions` ecosystem
 * rewrites the pair together - which is why the pin needs no maintenance here.
 *
 * The major version is deliberately the one the templates already used rather than the
 * newest available. `checkout` v7 and `setup-node` v7 both carry breaking changes, and
 * a gate whose behaviour changes because somebody re-ran an updater is precisely what
 * pinning exists to prevent. Moving a major is one reviewed line in this table.
 */
export const ACTIONS = {
  checkout: { repo: 'actions/checkout', commit: '11d5960a326750d5838078e36cf38b85af677262', release: 'v4.4.0' },
  setupNode: { repo: 'actions/setup-node', commit: '49933ea5288caeca8642d1e84afbd3f7d6820020', release: 'v4.4.0' },
};

/**
 * One `- uses:` line, pinned.
 *
 * @param {keyof typeof ACTIONS} action
 * @returns {string}
 */
function uses(action) {
  const { repo, commit, release } = ACTIONS[action];
  return `      - uses: ${repo}@${commit} # ${release}`;
}

/** This repository's own gate runs `npm test`, and two of those tests read
 *  history. A consumer's gate does not, so its checkout stays shallow. */
function checkoutFull() {
  return `${uses('checkout')}
        with:
          # \`bench mine\` counts commits, and the Affects snapshot reads
          # 4c27514. A depth-1 checkout fails both, and both run in \`npm test\`.
          fetch-depth: 0`;
}

/** The YAML every copy shares, so the two cannot drift on triggers, permissions or
 *  concurrency. Only `name`, the runner and `steps` vary, and only because they have
 *  to. The own gate also varies the platforms and the Node versions, because this
 *  package is the one whose floor and whose ADR-012 claim have to hold on more than
 *  the minimum. */
function skeleton(name, steps, { matrix = null } = {}) {
  const axes = matrix
    ? Object.entries(matrix)
        .map(([axis, values]) => `        ${axis}: [${values.map((v) => `'${v}'`).join(', ')}]`)
        .join('\n')
    : '';
  const strategy = axes === '' ? '' : `    strategy:\n      fail-fast: false\n      matrix:\n${axes}\n`;
  // The runner and the matrix have to be read together: naming the platforms in the
  // matrix and leaving `runs-on` on one literal is how a job ends up running six times
  // on the one runner. One of the two is derived from the other rather than written
  // twice, so a matrix that grows an axis cannot be half-honoured.
  // `${{ matrix.os }}` is a template-literal hazard - `${` opens an interpolation - so
  // it is written escaped, the same way the `concurrency` line below spells its own two.
  const runner = matrix?.os ? '\${{ matrix.os }}' : 'ubuntu-latest';
  const job = matrix?.node ? '\${{ matrix.os }} node \${{ matrix.node }}' : name;
  return `name: ${name}

# Pull requests only, and that is a decision rather than a default.
#
# A gate that runs on every push re-runs itself for every commit that pushes a
# branch forward, including the ones nobody asked it about, and its verdict has to
# be cleared before the next one lands. \`pull_request\` asks one question — may this
# merge — and answers it once. \`main\` here is the branch protection list, not a
# trigger: the gate that has to pass is the one the pull request runs, and the one
# on \`main\` is whatever CI the repository already has there.
on:
  pull_request:

# Read-only is enough to check a repo, and a gate job does not need to write to it.
permissions:
  contents: read

concurrency:
  group: simt-dev-\${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    name: ${job}
    runs-on: ${runner}
${strategy}    timeout-minutes: 5
    steps:
${steps}`;
}

/** The minimum Node `engines.node` allows, without the range operator. Both
 *  templates pin setup-node to it, read from package.json so the two cannot name
 *  a version the package says it does not run on. */
export function nodeFloor() {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const range = pkg.engines?.node;
  const version = typeof range === 'string' ? />=\s*(\d+\.\d+\.\d+)/.exec(range) : null;
  if (!version) throw new Error(`engines.node must be a >=x.y.z floor, got ${JSON.stringify(range)}`);
  return version[1];
}

/** The floor in this package's `engines.node`. A gate that cannot start on the
 *  version it declares support for is not a gate. The comment ships in the file,
 *  because the reader deciding whether to bump that version has only the file.
 *  The own gate passes the matrix expression; every other copy passes the floor. */
function setupNode(version) {
  return `${uses('setupNode')}
        with:
          # The floor in this package's \`engines.node\`. A gate that cannot start on
          # the version it declares support for is not a gate.
          node-version: '${version}'`;
}

/** Indent a rendered shell block so it sits inside a YAML block scalar. Blank lines
 *  stay blank: a line of trailing whitespace inside a scalar is a diff nobody meant. */
function indent(text, spaces) {
  return text
    .split('\n')
    .map((l) => (l === '' ? '' : `${' '.repeat(spaces)}${l}`))
    .join('\n');
}

/**
 * The workflow, as bytes.
 *
 * Two renderings, and the argument is which repository this one is for. `own` is the
 * copy that lives in simt-dev's own repository; it is refreshed rather than left alone,
 * and it runs this repository's own gate rather than the adopting repository's.
 *
 * @param {{own?: boolean}} [options]
 * @returns {string} YAML, LF-terminated
 */
export function renderWorkflow({ own = false, npm = true, version } = {}) {
  if (own) {
    const floor = nodeFloor();
    return `${header(true)}${skeleton(
      'simt-dev own gate',
      [
        checkoutFull(),
        setupNode('${{ matrix.node }}'),
        // The two checks `.githooks/pre-push` runs, named here rather than discovered,
        // because a reader of this file has to be able to answer "what stops a merge"
        // without opening a shell script in another directory.
        '      - name: tests',
        '        run: npm test',
        '      - name: skill registry lint',
        '        run: node bin/simt.mjs graph lint',
        '      - name: the gate copy in this repo is current',
        // The drift this exception exists to prevent, checked where it would be caught.
        // Without it a template change lands with the copy still describing the old
        // gate, and the next person to read the diff cannot tell which one is right.
        //
        // `--check`, and not the bare command: `ci` previews by default and exits 0,
        // so this step used to print the drift it exists to catch and pass anyway.
        '        run: node bin/simt.mjs ci --check',
      ].join('\n'),
      // ADR-012 says CI verifies on macOS and Linux. Until this matrix existed that
      // sentence was false in the one repository that could have made it true, and no
      // check read it - the package declares `os` for npm to enforce, and nothing here
      // ever ran a test on a second platform.
      { matrix: { os: ['ubuntu-latest', 'macos-latest'], node: [floor, '24', '26'] } },
    )}\n`;
  }

  const v = version ?? packageVersion();
  // The install step is the whole of S35's consumer CI: a repository with npm pins
  // simt-dev as a devDependency and `npm ci` restores it; one without (Gradle,
  // Connect IQ) has no node_modules to pin in, so CI installs the same pinned global
  // binary the machine remedy names. The two must agree, or the gate passes in one
  // place and cannot start in the other.
  const install = npm
    ? [
        '      - name: install dependencies',
        '        # `npm ci` needs a lockfile; a repo without one is still gated, not skipped.',
        '        run: npm ci || npm install',
      ]
    : [
        '      - name: install the pinned gate binary',
        '        # No node_modules to pin in, so a pinned global install: the same bytes',
        '        # the machine remedy names, so the gate cannot pass locally and fail here.',
        `        run: npm i -g ${PACKAGE_NAME}@${v}`,
      ];
  const remedy = npm
    ? `REMEDY run: npm i -D ${PACKAGE_NAME}   (the gate runs from the pinned dependency)`
    : `REMEDY run: npm i -g ${PACKAGE_NAME}@${v}   (the gate runs from a pinned global install)`;
  const locator = renderLocator('check --root "$ROOT"', { remedy });
  return `${header(false)}${skeleton(
    `${CLI} check`,
    [
      uses('checkout'),
      setupNode(nodeFloor()),
      ...install,
      `      - name: ${CLI} check`,
      '        run: |',
      indent(`set -eu\nROOT="\${GITHUB_WORKSPACE}"\n${locator}`, 10),
    ].join('\n'),
  )}\n`;
}

/**
 * What this repo's gate file should be, and what should happen to it.
 *
 * The one place that knows about the write-once rule, so `init`, `check` and `ci`
 * cannot disagree about which repo owns its file.
 *
 * @param {string} root repo root
 * @returns {Promise<{file:string, path:string, action:'create'|'refresh'|'unchanged'|'skip',
 *                    own:boolean, exists:boolean, bytes:number, current:boolean,
 *                    workflows:boolean, reason:string|null}>}
 */
export async function planWorkflow(root) {
  const path = join(root, WORKFLOW_FILE);
  const own = isOwnRepo(root);
  let text = null;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    text = null;
  }
  const exists = text !== null;
  const bytes = exists ? Buffer.byteLength(text) : 0;

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
    // Content is only ever compared in simt-dev's own repository. Everywhere else
    // that comparison is the thing ADR-023 ruled out: a repo's file is the repo's
    // file, and the only question is whether one is there.
    const desired = renderWorkflow({ own: true });
    const current = own ? text === desired : true;
    return {
      file: WORKFLOW_FILE,
      path,
      action: current ? 'unchanged' : 'refresh',
      own,
      exists,
      bytes,
      current,
      // Both sides, so a reader told the file differs can be shown how. Rendering a
      // second time for a diff would risk a second answer, and the two call sites
      // must not be able to disagree about what "refresh" means.
      source: { text, desired },
      workflows,
      reason: current ? null : `this repository is simt-dev's own, and the gate template has changed since this copy was written`,
    };
  }
  return {
    file: WORKFLOW_FILE,
    path,
    // The own repository creates the directory. It is the one repo whose Actions
    // surface this tool is entitled to populate, and the rule that stopped it from
    // inventing CI on somebody's pull requests does not apply to CI on its own.
    action: workflows || own ? 'create' : 'skip',
    own,
    exists,
    bytes,
    current: false,
    workflows,
    reason:
      workflows || own
        ? null
        : `no ${WORKFLOWS_DIR} directory, so this repo does not run GitHub Actions yet`,
  };
}