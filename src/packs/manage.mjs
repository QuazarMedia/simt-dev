// Pack management (plan 0003 R45): new, lint, publish, and the bench summary.
//
// A pack is vendored bytes (ADR-065): the adopting repository carries them under
// `.simt/packs/<name>/` and pins a digest in its manifest, and nothing in the
// projection or the gate reads outside the repository. What this module adds is the
// author side of that same arrangement: a pack as a versioned artefact with a
// declared source (npm or git), a lint that validates the shape, a publish that
// puts an npm-sourced pack where its source names, and a bench summary that states
// the pack's measured ΔR.
//
// The fetch ADR-065 left as a later ruling stays left. Publishing makes the bytes
// obtainable; vendoring makes the region reproducible from what the reader has. A
// published pack reaches an adopting repository the same way every other byte does:
// copied in and pinned by digest, never fetched at render time.

import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { commitJournal, journaledWriteFile } from '../journal.mjs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { PACK_DIR, packDigest, packNameProblem } from '../packs.mjs';
import { readManifest } from '../projection/manifest.mjs';
import { CLI, MANIFEST_FILE } from '../name.mjs';

const exec = promisify(execFile);

/** The file that makes a directory a pack: identity, version and source. */
export const PACK_JSON = 'pack.json';

/**
 * The file that makes a pack measured: the bench outcome it was measured at, in
 * the estate's own vocabulary (`dR`, resolved counts per arm). Covered by the pack
 * digest like every other file, so a summary measured at other bytes is a stale
 * summary, not this pack's.
 */
export const BENCH_JSON = 'bench.json';

/** A version is three numbers. The release tooling reads the same shape. */
const SEMVER = /^\d+\.\d+\.\d+$/;

/** npm package names, lowercased, with an optional @scope — the registry's rule. */
const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** A git source names a repo over https, with an optional ref after #. */
const GIT_SOURCE = /^git\+https:\/\/[^\s/]+(\/[^\s]*)?(#[^\s]+)?$/;

/**
 * @returns {string|null} why the source cannot name a pack's origin, or null.
 *
 * Two forms, and only two, because the source is a promise about where the bytes
 * can be obtained: `npm:<package>[@<version>]` for the registry, and
 * `git+https://…[#ref]` for a repository. Anything else is a string nobody can act
 * on, and lint refuses to bless it.
 */
export function describeSourceProblem(source) {
  if (typeof source !== 'string' || source.length === 0) return 'a pack source names where the bytes come from: `npm:<package>` or `git+https://…`';
  if (source.startsWith('npm:')) {
    const rest = source.slice('npm:'.length);
    const at = rest.lastIndexOf('@');
    const name = at > 0 ? rest.slice(0, at) : rest;
    const version = at > 0 ? rest.slice(at + 1) : null;
    if (!NPM_NAME.test(name)) return `\`${source}\` is not a usable npm package name`;
    if (version !== null && !SEMVER.test(version)) {
      return `\`${source}\` pins \`${version}\`, which is not x.y.z`;
    }
    return null;
  }
  if (GIT_SOURCE.test(source)) return null;
  return `\`${source}\` names neither an npm package (\`npm:<package>\`) nor a git repository (\`git+https://…\`)`;
}

/**
 * The registry package an npm source names, or null when the source is not an
 * npm one. The split is on the LAST `@`, and only when what follows is a
 * version: a leading `@` is the scope (`@scope/pkg`), not a version pin, and
 * splitting on it the naive way names the empty string - which `npm view`
 * would then ask the registry about.
 *
 * Callers validate the source first (`describeSourceProblem`, then `lintPack`):
 * this answers "which package", not "is this a source".
 */
export function npmPackageOf(source) {
  if (typeof source !== 'string' || !source.startsWith('npm:')) return null;
  const rest = source.slice('npm:'.length);
  const at = rest.lastIndexOf('@');
  if (at <= 0) return rest;
  return SEMVER.test(rest.slice(at + 1)) ? rest.slice(0, at) : rest;
}

/** @returns {string|null} why the version is not usable, or null. */
export function describeVersionProblem(version) {
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    return `version \`${version ?? '(missing)'}\` is not x.y.z`;
  }
  return null;
}

/**
 * The rule files the projection would collect from a pack directory: `rules/*.md`
 * and `rules/stacks/*.md`. The same two reads `loadRules` makes, so a file lint
 * counts is a file the region counts — and one it skips (`.mdc`, anything else)
 * is one the region never sees.
 *
 * @returns {Promise<string[]>} paths relative to the pack directory, sorted.
 */
export async function packRuleFiles(dir) {
  const rules = join(dir, 'rules');
  let names = [];
  try {
    names = (await readdir(rules)).filter((n) => n.endsWith('.md')).sort();
  } catch {
    names = [];
  }
  let stackNames = [];
  try {
    stackNames = (await readdir(join(rules, 'stacks')))
      .filter((n) => n.endsWith('.md'))
      .map((n) => `stacks/${n}`);
  } catch {
    stackNames = [];
  }
  return [...names, ...stackNames].sort().map((n) => `rules/${n}`);
}

/**
 * Read and parse a pack's identity file.
 *
 * @returns {Promise<{pack: object|null, error: string|null}>}
 */
export async function readPack(dir) {
  let text;
  try {
    text = await readFile(join(dir, PACK_JSON), 'utf8');
  } catch {
    return { pack: null, error: `no ${PACK_JSON} in ${dir}: a directory of rules is not a pack until it declares its name, version and source` };
  }
  try {
    return { pack: JSON.parse(text), error: null };
  } catch (error) {
    return { pack: null, error: `${PACK_JSON} in ${dir} is not JSON: ${error.message}` };
  }
}

/**
 * Read and parse a pack's bench summary, without judging it. The summary is the
 * pack stating its measured ΔR; `lint` judges whether the statement holds.
 *
 * @returns {Promise<{bench: object|null, error: string|null}>}
 */
export async function readBench(dir) {
  let text;
  try {
    text = await readFile(join(dir, BENCH_JSON), 'utf8');
  } catch {
    return { bench: null, error: 'missing' };
  }
  try {
    return { bench: JSON.parse(text), error: null };
  } catch (error) {
    return { bench: null, error: `invalid: ${error.message}` };
  }
}

/**
 * The measured ΔR a bench summary states, recomputed from its own arms. A summary
 * whose arithmetic does not close is not a measurement; it is a number with a
 * story, and lint refuses the story.
 */
function statedDelta(bench) {
  const withArm = bench.arms.with;
  const withoutArm = bench.arms.without;
  return withArm.resolved / withArm.total - withoutArm.resolved / withoutArm.total;
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * @returns {object|null} the first thing wrong with the summary, or null.
 *
 * Shape first, then measurement: a summary that is not an object, or names the
 * wrong pack, cannot be this pack's no matter what it claims. The digest binds
 * the claim to the bytes — last, because it is the one that changes every time
 * the pack does.
 */
function describeBenchProblem(bench, { name, version, digest }) {
  if (bench === null || typeof bench !== 'object' || Array.isArray(bench)) {
    return { status: 'pack-bench-invalid', detail: `${BENCH_JSON} is not an object` };
  }
  if (bench.schemaVersion !== 1) {
    return { status: 'pack-bench-invalid', detail: `${BENCH_JSON} has schemaVersion ${JSON.stringify(bench.schemaVersion ?? null)}, expected 1` };
  }
  if (bench.pack !== name || bench.version !== version) {
    return {
      status: 'pack-bench-invalid',
      detail: `${BENCH_JSON} names pack \`${bench.pack ?? '(missing)'}\` at \`${bench.version ?? '(missing)'}\`, but the pack is \`${name}\` at \`${version}\``,
    };
  }
  if (typeof bench.measured !== 'boolean') {
    return { status: 'pack-bench-invalid', detail: `${BENCH_JSON} has no \`measured\` boolean` };
  }
  if (bench.measured !== true) return { status: 'pack-bench-unmeasured', unmeasured: true };
  if (typeof bench.digest !== 'string' || !/^[0-9a-f]{40}$/.test(bench.digest)) {
    return { status: 'pack-bench-invalid', detail: `${BENCH_JSON} has no 40-hex digest of the bytes it was measured at` };
  }
  if (!isCount(bench.tasks) || bench.tasks <= 0) {
    return { status: 'pack-bench-invalid', detail: `${BENCH_JSON} names no positive task count` };
  }
  const arms = bench.arms;
  if (arms === null || typeof arms !== 'object' || Array.isArray(arms)) {
    return { status: 'pack-bench-invalid', detail: `${BENCH_JSON} names no \`with\` and \`without\` arms` };
  }
  for (const arm of ['with', 'without']) {
    const counts = arms?.[arm];
    if (counts === null || typeof counts !== 'object') {
      return { status: 'pack-bench-invalid', detail: `${BENCH_JSON} names no \`${arm}\` arm with resolved and total counts` };
    }
    if (!isCount(counts.resolved) || !isCount(counts.total) || counts.total <= 0 || counts.resolved > counts.total) {
      return { status: 'pack-bench-invalid', detail: `${BENCH_JSON} arm \`${arm}\` has impossible counts (resolved ${counts.resolved} of ${counts.total})` };
    }
  }
  if (Object.keys(arms).some((k) => k !== 'with' && k !== 'without')) {
    return { status: 'pack-bench-invalid', detail: `${BENCH_JSON} arms name more than \`with\` and \`without\`: the summary is one comparison, not a report` };
  }
  if (typeof bench.dR !== 'number' || !Number.isFinite(bench.dR)) {
    return { status: 'pack-bench-invalid', detail: `${BENCH_JSON} states no finite dR` };
  }
  // Two decimal places of rounding, not a different number: a dR that did not come
  // from these arms is a claim the arms do not support.
  if (Math.abs(bench.dR - statedDelta(bench)) > 0.005) {
    return {
      status: 'pack-bench-invalid',
      detail: `${BENCH_JSON} states dR ${bench.dR}, but its arms resolve to ${statedDelta(bench).toFixed(4)}`,
    };
  }
  if (typeof bench.run !== 'string' || bench.run.length === 0 || typeof bench.measuredAt !== 'string' || bench.measuredAt.length === 0) {
    return { status: 'pack-bench-invalid', detail: `${BENCH_JSON} names no run and no date: a measurement nobody can reproduce is a rumour` };
  }
  if (bench.digest !== digest) {
    return {
      status: 'pack-bench-stale',
      detail: `${BENCH_JSON} was measured at ${bench.digest}, but the pack now digests to ${digest}: measure again or it states another pack's ΔR`,
    };
  }
  return null;
}

/**
 * Validate a pack directory: identity, source, layout, rules, and — when asked —
 * its measured ΔR.
 *
 * Content defects in individual rule files are the gate's findings when a
 * repository adopts the pack, not lint's: lint validates the pack, and the one
 * structural property that makes a markdown file a rule rather than a stray page
 * is the `simt-id` the projection selects on. The registry check is lint's
 * because a registry inside a pack is read by nothing anywhere (ADR-061), so no
 * gate would ever name it.
 *
 * @param {string} dir the pack directory
 * @param {{requireMeasured?: boolean, declared?: {version?: string, digest?: string}|null}} [opts]
 *   `declared` is the adopting manifest's entry for this pack, when there is one:
 *   lint then also checks the two promises a declaration makes.
 * @returns {Promise<{pack: {name: string, version: string, source: string, digest: string}|null, ok: boolean, findings: {file: string, status: string, detail: string, remedy: string}[]}>}
 */
export async function lintPack(dir, { requireMeasured = false, declared = null } = {}) {
  const findings = [];
  const fail = (file, status, detail, remedy) => findings.push({ file, status, detail, remedy });

  const { pack, error } = await readPack(dir);
  if (pack === null) {
    fail(PACK_JSON, 'pack-json-invalid', error, `write one with: ${CLI} pack new <name> --source <npm:<pkg>|git+https://…>`);
    return { pack: null, ok: false, findings };
  }

  const nameProblem = packNameProblem(pack.name);
  if (nameProblem !== null) {
    fail(PACK_JSON, 'pack-name-invalid', nameProblem, 'rename the pack to a usable directory name');
  }
  const name = typeof pack.name === 'string' ? pack.name : null;
  if (name !== null && name !== basename(dir)) {
    fail(
      PACK_JSON,
      'pack-name-mismatch',
      `the pack is named \`${name}\` but lives in \`${basename(dir)}\`: a name is a directory name, so vendoring this would rename it`,
      `rename the directory to \`${name}\`, or the pack to \`${basename(dir)}\``,
    );
  }

  const versionProblem = describeVersionProblem(pack.version);
  if (versionProblem !== null) {
    fail(PACK_JSON, 'pack-version-invalid', versionProblem, 'version the pack x.y.z, the way the registry versions the tool');
  }

  const sourceProblem = describeSourceProblem(pack.source);
  if (sourceProblem !== null) {
    fail(PACK_JSON, 'pack-source-invalid', sourceProblem, 'declare where the bytes come from: `npm:<package>` or `git+https://…`');
  }

  const rules = await packRuleFiles(dir);
  if (rules.length === 0) {
    fail(join('rules'), 'pack-no-rules', 'the pack carries no rule files: a name with no policy is not a pack', 'add a rule under `rules/`, or a stack profile under `rules/stacks/`');
  }
  for (const rel of rules) {
    let text;
    try {
      text = await readFile(join(dir, rel), 'utf8');
    } catch {
      fail(rel, 'pack-rule-unreadable', 'the file cannot be read', 'restore it or remove it from the pack');
      continue;
    }
    const frontmatter = /^---\n([\s\S]*?)\n---\n?/.exec(text);
    // Multiline: the id sits on its own line inside the frontmatter block, and
    // without `m` the anchors hold the whole block instead of the line.
    const id = frontmatter === null ? null : /^simt-id:\s*(.+?)\s*$/m.exec(frontmatter[1])?.[1] ?? null;
    if (id === null) {
      fail(rel, 'pack-rule-without-id', 'the rule has no `simt-id`: without one nothing selects it and nothing explains it', 'give the rule a `simt-id` in its frontmatter');
    }
  }

  let registry = false;
  try {
    registry = (await stat(join(dir, 'graph', 'skills.graph.json'))).isFile();
  } catch {
    registry = false;
  }
  if (registry) {
    fail(
      join('graph', 'skills.graph.json'),
      'pack-carries-registry',
      'a pack that carries a skill registry reopens ADR-061 by accident: the registry is workspace data, and a second source for it needs its own ruling',
      'remove the registry from the pack; the workspace that owns it names it instead',
    );
  }

  const digest = await packDigest(dir);
  // The summary binds to the measured bytes, which are everything but the summary
  // itself: recording a digest inside the file the digest covers would make the
  // recorded digest wrong the moment it is written. The manifest pin above covers
  // every byte; this one covers every byte the measurement was taken at.
  const measuredDigest = await packDigest(dir, { exclude: [BENCH_JSON] });
  const { bench, error: benchError } = await readBench(dir);
  if (bench === null) {
    if (benchError !== 'missing') {
      fail(BENCH_JSON, 'pack-bench-invalid', `${BENCH_JSON} ${benchError}`, `repair it, or delete it and re-measure`);
    } else if (requireMeasured) {
      fail(BENCH_JSON, 'pack-bench-missing', `the pack states no measured ΔR: nothing records what this rule set is worth`, `measure it and record the summary in ${BENCH_JSON}`);
    }
  } else {
    const problem = describeBenchProblem(bench, { name, version: pack.version, digest: measuredDigest });
    if (problem !== null) {
      if (problem.status === 'pack-bench-unmeasured') {
        if (requireMeasured) {
          fail(
            BENCH_JSON,
            'pack-bench-unmeasured',
            `${BENCH_JSON} is marked unmeasured: the pack states no measured ΔR`,
            `measure the pack and record the summary, or drop --require-measured`,
          );
        }
      } else {
        fail(
          BENCH_JSON,
          problem.status,
          problem.detail,
          problem.status === 'pack-bench-stale'
            ? `measure the pack again at these bytes, then record the new digest`
            : `repair ${BENCH_JSON}: it must name this pack at this version, with arms that close to its dR`,
        );
      }
    }
  }

  if (declared !== null && name !== null) {
    if (typeof declared.version === 'string' && declared.version !== pack.version) {
      fail(
        MANIFEST_FILE,
        'pack-version-drift',
        `the manifest declares pack \`${name}\` at \`${declared.version}\`, but the vendored pack is \`${pack.version}\``,
        `adopt the new version (update the declaration and the digest), or vendor back the declared one`,
      );
    }
    if (typeof declared.digest === 'string' && declared.digest !== digest) {
      fail(
        MANIFEST_FILE,
        'pack-digest-drift',
        `the manifest pins pack \`${name}\` to \`${declared.digest}\`, but the vendored bytes digest to \`${digest}\``,
        `restore the pinned bytes with: git checkout -- ${PACK_DIR}/${name}  (or record \`${digest}\` as its digest, then: ${CLI} sync --yes)`,
      );
    }
  }

  const ok = findings.length === 0;
  return {
    pack: name === null ? null : { name, version: pack.version, source: pack.source, digest },
    ok,
    findings,
  };
}

/**
 * The files `pack new` writes, as relative paths and text. Returned rather than
 * written so the dry run prints the same plan the write performs.
 */
export function scaffoldPack({ name, source }) {
  const title = name
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
  const files = [
    {
      path: PACK_JSON,
      text: `${JSON.stringify({ name, version: '0.1.0', source }, null, 2)}\n`,
    },
    {
      path: BENCH_JSON,
      text: `${JSON.stringify(
        {
          schemaVersion: 1,
          pack: name,
          version: '0.1.0',
          measured: false,
          digest: null,
          tasks: 0,
          arms: {
            without: { resolved: 0, total: 0 },
            with: { resolved: 0, total: 0 },
          },
          dR: 0,
          run: '',
          measuredAt: '',
        },
        null,
        2,
      )}\n`,
    },
    {
      path: `rules/stacks/${name}.md`,
      text: `---\nsimt-id: ${name}\nsimt-title: ${title} rules\nsimt-applies: []\n---\n\n# ${title}\n\nTODO: write the shared rule this pack carries. A pack with no rule of its own is\n a name with no policy; replace this file with the real one before publishing.\n`,
    },
  ];
  if (source.startsWith('npm:')) {
    files.push({
      path: 'package.json',
      text: `${JSON.stringify({ name: npmPackageOf(source), version: '0.1.0', files: ['rules/**', PACK_JSON, BENCH_JSON] }, null, 2)}\n`,
    });
  }
  return files;
}

/**
 * Publish a pack to its source.
 *
 * An npm-sourced pack is published with `npm publish`, skipped when the version
 * is already live, and refused when the directory fails lint: publishing bytes
 * lint would not bless is how a bad pack becomes everybody's problem. A
 * git-sourced pack is published by its own repository — tagging and pushing a
 * checkout this tool does not own is not something it can do by hand — so the
 * command names the manual step instead of pretending.
 *
 * @returns {Promise<{pack: object|null, ok: boolean, published: boolean, skipped: boolean, planned: string[], findings: object[]}>}
 */
export async function publishPack(dir, { apply = false } = {}) {
  const findings = [];
  const fail = (file, status, detail, remedy) => findings.push({ file, status, detail, remedy });

  const { pack, error } = await readPack(dir);
  if (pack === null) {
    fail(PACK_JSON, 'pack-json-invalid', error, `write one with: ${CLI} pack new <name> --source <npm:<pkg>|git+https://…>`);
    return { pack: null, ok: false, published: false, skipped: false, planned: [], findings };
  }

  const linted = await lintPack(dir, {});
  if (!linted.ok) {
    fail(
      PACK_JSON,
      'pack-invalid',
      `the pack fails lint, so publishing it would spread the failure: ${linted.findings[0].detail}`,
      `repair it first: ${CLI} pack lint ${dir}`,
    );
    return { pack: linted.pack, ok: false, published: false, skipped: false, planned: [], findings };
  }

  if (!pack.source.startsWith('npm:')) {
    fail(
      PACK_JSON,
      'pack-publish-manual',
      `pack \`${pack.name}\` is git-sourced, and its bytes are published by tagging and pushing the repository that owns them — not by this tool, which sees only the vendored copy`,
      `in the pack's own repository: git tag v${pack.version} && git push origin v${pack.version}, then vendor the bytes here`,
    );
    return { pack: linted.pack, ok: false, published: false, skipped: false, planned: [], findings };
  }

  const pkg = npmPackageOf(pack.source);
  let pkgFile;
  try {
    pkgFile = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  } catch {
    pkgFile = null;
  }
  if (pkgFile === null || pkgFile.name !== pkg || pkgFile.version !== pack.version) {
    fail(
      'package.json',
      'pack-package-mismatch',
      `\`npm publish\` reads package.json, which must name \`${pkg}\` at \`${pack.version}\``,
      `\`pack new\` writes that file for an npm source; repair it by hand if the pack outgrew the scaffold`,
    );
    return { pack: linted.pack, ok: false, published: false, skipped: false, planned: [], findings };
  }

  // Idempotent, the way the release twin is: a version that is already live is
  // skipped rather than republished, so a re-run after an interruption continues
  // where it stopped.
  let live = null;
  try {
    const { stdout } = await exec('npm', ['view', `${pkg}@${pack.version}`, 'version'], { cwd: dir });
    live = stdout.trim() === pack.version;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fail('npm', 'pack-npm-missing', 'npm is not on PATH, and publishing to the registry needs it', 'install npm, or publish by hand: npm publish');
      return { pack: linted.pack, ok: false, published: false, skipped: false, planned: [], findings };
    }
    live = /E404|404/.test(`${error?.stderr ?? ''}${error?.message ?? ''}`) ? false : null;
    if (live === null) {
      fail('npm', 'pack-npm-unreachable', `the registry could not be read: ${`${error?.stderr ?? error?.message ?? error}`.trim().split('\n')[0]}`, 'check the network and the registry, then run again');
      return { pack: linted.pack, ok: false, published: false, skipped: false, planned: [], findings };
    }
  }
  if (live === true) {
    return { pack: linted.pack, ok: true, published: false, skipped: true, planned: [], findings };
  }

  const planned = [`npm publish  (in ${dir})`];
  if (!apply) {
    return { pack: linted.pack, ok: true, published: false, skipped: false, planned, findings };
  }
  try {
    await exec('npm', ['publish'], { cwd: dir });
  } catch (error) {
    fail('npm', 'pack-publish-failed', `npm publish failed: ${`${error?.stderr ?? error?.message ?? error}`.trim().split('\n')[0]}`, 'repair the registry error and run again');
    return { pack: linted.pack, ok: false, published: false, skipped: false, planned, findings };
  }
  return { pack: linted.pack, ok: true, published: true, skipped: false, planned, findings };
}

/**
 * Write scaffold files into a directory that must not already exist.
 *
 * `root` is the repository the journal set belongs to — usually the scaffold's
 * own parent, so `undo` runs where the files live. Recorded (R49) because a
 * scaffold is repo files like any other write.
 */
export async function writeScaffold(dir, files, root = dirname(dir)) {
  try {
    await stat(dir);
    throw new Error(
      `refusing to scaffold into ${dir}: the directory already exists, and a scaffold that overwrote it would destroy work`,
    );
  } catch (error) {
    if (error?.message?.startsWith('refusing to scaffold')) throw error;
  }
  const journal = [];
  for (const file of files) {
    const abs = join(dir, file.path);
    await mkdir(dirname(abs), { recursive: true });
    await journaledWriteFile(root, journal, abs, file.text);
  }
  await commitJournal(root, 'pack new', journal);
}
