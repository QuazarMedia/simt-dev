// The CI gate, as a file a repo owns.
//
// `simt check` is the whole gate: projection drift, an unreadable rule, an
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
// `simt check` is red in this repository by design: AGENTS.md here is written by
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
import { LOCAL_BIN, LOCAL_BIN_DIR, assetNameExpr, localInstall, platformLines, releaseBase } from '../distribute/release.mjs';
import { installCommands as nodeInstallCommands } from '../ecosystem/node-runner.mjs';

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
# run \`node scripts/ci.mjs --yes\`. Editing this file by hand works until the next template
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
 * is the release a reader recognises. The two actions this repository's own workflows
 * run are updated by Dependabot's `github-actions` ecosystem, which rewrites the pair
 * together, so those pins need no maintenance here.
 *
 * The major version moves by review, not by updater. `checkout` stayed on v4 while v7
 * carried breaking changes a gate should not absorb by re-running Dependabot; it moved
 * to v7.0.1 when the v7 line had run green in this repository's own workflows (the
 * checkout steps of the v7 Dependabot run all succeeded — only the template-drift
 * tests failed, which is the pin doing its job). `setup-node` stays on v4: no run has
 * yet proven a newer major here, and moving it is the same one reviewed line.
 * `setup-bun` is in the consumer template and nowhere else, so its line moves when a
 * consumer hits the reason to move it; the commit pin is the whole point, because a
 * floating `@v2` on a third-party action runs whatever its author pushed that morning.
 */
export const ACTIONS = {
  checkout: { repo: 'actions/checkout', commit: '3d3c42e5aac5ba805825da76410c181273ba90b1', release: 'v7.0.1' },
  setupNode: { repo: 'actions/setup-node', commit: '49933ea5288caeca8642d1e84afbd3f7d6820020', release: 'v4.4.0' },
  setupBun: { repo: 'oven-sh/setup-bun', commit: '0c5077e51419868618aeaa5fe8019c62421857d6', release: 'v2.2.0' },
};

/**
 * The bun version a repository that declares none gets.
 *
 * `latest` is not a version: a generated workflow that names it changes what CI runs
 * without a commit, and the failure it produces is a mystery on a Tuesday. This is the
 * release this template was rendered and tested against — the line under `bun-version:`
 * in a generated workflow, not a claim about bun's best version. It is bumped by
 * changing this one constant (and the release it names) when a consumer has a reason to
 * move, exactly like a pin in `ACTIONS`; `BUN_FALLBACK_VERSION` is exported so the test
 * asserts against this value instead of restating a second copy of the number. A
 * repository's own `packageManager` pin always wins over it.
 */
export const BUN_FALLBACK_VERSION = '1.4.4';

/**
 * The steps that provision the package manager the install step will use.
 *
 * `npm` ships with Node and needs none. pnpm and yarn come from corepack, which ships
 * with Node; bun is a runtime of its own and needs its setup action. Without these the
 * install step fails on the runner with "command not found", and the failure looks like
 * the repository's own.
 *
 * @param {object|null} nodeInstall the manager record from `installCommands`
 * @param {string|null} nodeManager
 * @param {string|null} declared the version from `packageManager`, when it names this manager
 * @returns {string[]} step lines, or an empty list
 */
function bootstrapSteps(nodeInstall, nodeManager, declared) {
  if (nodeInstall?.bootstrap === 'corepack') {
    return [
      '      - name: enable the declared package manager',
      '        run: |',
      indent(
        `set -eu
command -v corepack >/dev/null 2>&1 || { echo "REMEDY use a Node image that ships corepack, or install ${nodeManager ?? 'the manager'} before this step" >&2; exit 1; }
corepack enable${declared === null ? '' : `\ncorepack prepare ${nodeManager}@${declared} --activate`}`,
        10,
      ),
    ];
  }
  if (nodeInstall?.bootstrap === 'setup-bun') {
    return [
      '      - name: install bun',
      '        # bun is its own runtime and is not on the runner image.',
      uses('setupBun'),
      '        with:',
      `          bun-version: ${declared ?? BUN_FALLBACK_VERSION}`,
    ];
  }
  return [];
}

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
function skeleton(name, steps, { matrix = null, timeoutMinutes = 5, gateMain = false } = {}) {
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
  // Two trigger blocks, because the two copies answer different questions. An
  // adopting repository merges through pull requests, which is where its gate runs.
  // This repository merges locally, so a merge never opens a pull request: without a
  // push trigger the commit that lands on `main` is the one no gate ever ran on
  //. Each block ships only in the copy whose claim it states.
  const trigger = gateMain
    ? `# Pull requests ask whether a change may merge; a push to \`main\` asks whether
# what already merged is sound. This repository merges locally, so a merge never
# opens a pull request — without the second trigger the commit that lands on
# \`main\` is the one no gate ran on.
on:
  pull_request:
  push:
    branches: [main]
`
    : `# Pull requests only, and that is a decision rather than a default.
#
# A gate that runs on every push re-runs itself for every commit that pushes a
# branch forward, including the ones nobody asked it about, and its verdict has to
# be cleared before the next one lands. \`pull_request\` asks one question — may this
# merge — and answers it once. \`main\` here is the branch protection list, not a
# trigger: the gate that has to pass is the one the pull request runs, and the one
# on \`main\` is whatever CI the repository already has there.
on:
  pull_request:
`;
  return `name: ${name}

${trigger}
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
${strategy}    timeout-minutes: ${timeoutMinutes}
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
export function renderWorkflow({ own = false, npm = true, manager = null, version, packageManager = null, gates = null } = {}) {
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
        '        run: npm run lint',
        '      - name: the gate copy in this repo is current',
        // The drift this exception exists to prevent, checked where it would be caught.
        // Without it a template change lands with the copy still describing the old
        // gate, and the next person to read the diff cannot tell which one is right.
        //
        // `--check`, and not the bare command: `ci` previews by default and exits 0,
        // so this step used to print the drift it exists to catch and pass anyway.
        '        run: node scripts/ci.mjs --check',
      ].join('\n'),
      // ADR-012 says CI verifies on macOS and Linux. Until this matrix existed that
      // sentence was false in the one repository that could have made it true, and no
      // check read it - the package declares `os` for npm to enforce, and nothing here
      // ever ran a test on a second platform.
      // The slowest leg (macOS, full suite plus the registry lint) ran 4 min 28 s
      // against a 5-minute timeout, so the timeout that was meant to bound a hang
      // was about to fail a passing run instead. 15 leaves the hang bounded and the
      // run alone; sharding the slowest leg is a later change, not this one.
      //
      // `gateMain` because this repository merges locally: `pull_request` alone left
      // the one commit that reached `main` ungated.
      { matrix: { os: ['ubuntu-latest', 'macos-latest'], node: [floor, '24', '26'] }, timeoutMinutes: 15, gateMain: true },
    )}\n`;
  }

  const v = version ?? packageVersion();
  // the install step names the repo's own manager. `manager` wins over the
  // legacy `npm` boolean so old callers keep their bytes; a Node repo installs
  // with its lockfile's frozen command, anything else takes the release binary.
  // The resolver row also decides setup-node (bun ships its own runtime).
  const nodeManager = manager ?? (npm ? 'npm' : null);
  const nodeInstall = nodeManager ? nodeInstallCommands(nodeManager) : null;
  // The install step is the whole of S35's consumer CI: a repository with npm pins
  // simt-dev as a devDependency and `npm ci` restores it; one without (Gradle,
  // Connect IQ) has no node_modules to pin in, so CI downloads the release binary
  // into the repository - the same pinned bytes the machine remedy names, verified
  // against the checksum published beside it. The two must agree, or the gate
  // passes in one place and cannot start in the other.
  //
  // The binary branch needs no setup-node at all: the SEA runs without a Node on
  // PATH (ADR-098), and installing one to run a file that does not need it would be
  // the toolchain this channel exists to remove, present in the one place it was not.
  //
  // The platform is derived in the shell (platformLines) and not from a
  // `${{ runner.* }}` expression: an expression substituted into `$( … )` is a
  // command substitution trying to execute "Linux", which set -eu refuses - the
  // install would fail on every run in the one repository kind this channel is for.
  // The declared pin, when the repo has one. `packageManager: "pnpm@9.1.0+sha512…"` names
  // the exact manager this repo used; carrying it into the bootstrap keeps the runner on
  // that version instead of whichever one corepack or the setup action defaults to.
  const declared = (() => {
    if (packageManager === null || nodeManager === null) return null;
    const prefix = `${nodeManager}@`;
    if (!String(packageManager).startsWith(prefix)) return null;
    return String(packageManager).slice(prefix.length).split('+')[0];
  })();
  const bootstrap = bootstrapSteps(nodeInstall, nodeManager, declared);
  const install = nodeInstall
    ? [
        '      - name: install dependencies',
        '        # A lockfile present means the frozen install, and a stale lock fails the job.',
        '        # `|| install` used to run an unlocked install instead, so a green run could',
        '        # prove nothing about the committed lockfile (review 0005 PR17). Without a',
        '        # lockfile there is nothing to freeze, and such a repo is gated, not skipped.',
        '        run: |',
        indent(
          `if ${nodeInstall.lockfiles.map((f) => `[ -f ${f} ]`).join(' || ')}; then\n${nodeInstall.install}\nelse\n${nodeInstall.fallback}\nfi`,
          10,
        ),
      ]
    : [
        '      - name: install the pinned gate binary',
        '        # No node_modules to pin in, so the release binary into the repository:',
        '        # the same bytes the machine remedy names, checked against the',
        '        # checksum published beside it before anything runs them.',
        '        run: |',
        indent(
          `set -eu
${platformLines().join('\n')}
asset="${assetNameExpr(v)}"
base="${releaseBase(v)}"
curl -fsSL "$base/$asset" -o "$asset"
expected=$(curl -fsSL "$base/$asset.sha256" | awk '{print $1}')
actual=$(openssl sha256 "$asset" | grep -oE '[0-9a-f]{64}')
if [ "$expected" != "$actual" ]; then
  echo "checksum mismatch for $asset: the release asset does not match its published sha256" >&2
  exit 1
fi
mkdir -p ${LOCAL_BIN_DIR}
mv "$asset" ${LOCAL_BIN}
chmod +x ${LOCAL_BIN}`, 10),
      ];
  const addDev = { npm: `npm i -D ${PACKAGE_NAME}`, pnpm: `pnpm add -D ${PACKAGE_NAME}`, yarn: `yarn add -D ${PACKAGE_NAME}`, bun: `bun add -d ${PACKAGE_NAME}` }[nodeManager] ?? null;
  const remedy = nodeInstall && addDev
    ? `REMEDY run: ${addDev}   (the gate runs from the pinned dependency)`
    : `REMEDY run: ${localInstall(v)}   (the gate runs from the release binary in .simt/bin)`;
  const locator = renderLocator('check --root "$ROOT"', { remedy });
  // The declared gates, run by the dispatcher a push runs. Without this the workflow
  // proved the projection was current and nothing about the tests the repository
  // declared, so a green pull request said less than its checks implied (review 0005
  // PR17). Only `pre-push` is run here: the pre-commit gate reads the staged set, and a
  // CI checkout has nothing staged — its lint runs through the same command in the
  // pre-push list when the repository declares it there.
  const declaredGates = gates?.prePush ?? [];
  const gateStep = declaredGates.length === 0
    ? []
    : [
        '      - name: the declared pre-push gates',
        `        # ${declaredGates.join(', ')}: run by the same dispatcher a push runs, so a green`,
        '        # run here and a green push cannot disagree about what was checked. stdin is',
        '        # closed so the dispatcher cannot wait for a ref list CI never gave it.',
        '        run: |',
        indent(
          `set -eu\nROOT="\${GITHUB_WORKSPACE}"\n${renderLocator('hooks run pre-push --root "$ROOT" </dev/null', { remedy })}`,
          10,
        ),
      ];
  return `${header(false)}${skeleton(
    `${CLI} check`,
    [
      uses('checkout'),
      // The binary branch has no setup-node: see the install step above.
      // bun ships its own runtime, so only managers that need Node get it.
      ...(nodeInstall && nodeInstall.setupNode ? [setupNode(nodeFloor())] : []),
      ...bootstrap,
      ...install,
      `      - name: ${CLI} check`,
      '        run: |',
      indent(`set -eu\nROOT="\${GITHUB_WORKSPACE}"\n${locator}`, 10),
      ...gateStep,
    ].join('\n'),
  )}\n`;
}

/**
 * The same gating sequence, for a provider that is not GitHub Actions.
 *
 * A workflow file is one provider's syntax around three facts: the toolchain, the
 * install and the gate. A repository on GitLab, Buildkite or a self-hosted runner needs
 * the facts and not the YAML, so `--ci external` prints these and writes nothing. The
 * values come from the same records the workflow is rendered from, so the two channels
 * cannot drift into installing with different commands.
 */
export function ciContract({ npm = true, manager = null, version, gates = null } = {}) {
  const nodeManager = manager ?? (npm ? 'npm' : null);
  if (nodeManager === null) {
    const v = version ?? packageVersion();
    return {
      channel: 'binary',
      node: null,
      manager: null,
      bootstrap: null,
      lockfiles: [],
      // No asset name here: it is built from shell variables the workflow's own
      // `platformLines` defines, and printing `-$os-$arch` as advice told a provider to
      // run a filename no shell would produce.
      install: `fetch this platform's release asset and its .sha256 from ${releaseBase(v)}, verify the checksum, then run ${LOCAL_BIN}`,
      gate: `${CLI} check`,
      ...(gates?.prePush?.length ? { declaredGates: `${CLI} hooks run pre-push --root "$ROOT"` } : {}),
    };
  }
  const inst = nodeInstallCommands(nodeManager);
  return {
    channel: 'node',
    node: nodeFloor(),
    manager: nodeManager,
    bootstrap: inst.bootstrap,
    install: inst.install,
    withoutLockfile: inst.fallback,
    lockfiles: inst.lockfiles,
    gate: `${CLI} check`,
    ...(gates?.prePush?.length ? { declaredGates: `${CLI} hooks run pre-push --root "$ROOT"` } : {}),
  };
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