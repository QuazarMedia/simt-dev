// The environment the suite is allowed to assume about itself.
//
// Two failures in this repository's history were the same failure twice: the tool
// resolved a workspace, or found a body, only because the test happened to be run
// from inside the estate. Both passed locally and failed on a runner that had only
// this checkout. A test suite that can only pass in the author's directory is not
// evidence about the tool, and AGENTS.md says so directly.
//
// So the suite builds what it needs. `git` always carries an identity, and the
// skill bodies live in a synthetic workspace generated from the registry rather
// than copied out of sibling repositories.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REGISTRY_PATH, loadRegistry } from '../src/graph/load.mjs';
import { CLI, MANIFEST_FILE } from '../src/name.mjs';

/**
 * A RegExp matching literal text, with `{cli}` the command and `{manifest}` the manifest
 * filename.
 *
 * The tests assert on what this build prints, so hardcoding the command in them means
 * the same rename that touches `src/` has to touch every assertion - and an assertion
 * left behind is a test that passes for the wrong reason. Escaping happens AFTER the
 * substitution, so a call site can be written like the sentence it matches and still
 * mean it literally. `/remedy: simt ci --yes/` never matched literally; the `.` was a
 * wildcard that happened not to matter, which is the kind of thing that matters the
 * day the text after it changes.
 *
 * The two tokens exist because they are not the same name: the manifest file was renamed
 * away from the project name and the command was not, so a single token would have to
 * pick one of the two spellings and be wrong about the other.
 *
 * @param {string} text
 * @returns {RegExp}
 */
export function cmd(text) {
  const spelled = text.replaceAll('{manifest}', MANIFEST_FILE).replaceAll('{cli}', CLI);
  return new RegExp(spelled.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

const exec = promisify(execFile);

/**
 * git with an identity, always.
 *
 * A runner has no `user.email`, so a bare `git commit` dies with "Author identity
 * unknown" and takes the test that wanted a commit with it. Passing `-c` on the
 * command line rather than setting it in a config file means the suite cannot
 * change the developer's own git configuration, and cannot be changed by it
 * either. `commit.gpgsign` is disabled for the same reason: a developer with
 * signing configured locally must not be the only person whose tests pass.
 */
const IDENTITY = [
  '-c', 'user.email=tests@simt.invalid',
  '-c', 'user.name=simt-dev tests',
  '-c', 'commit.gpgsign=false',
  '-c', 'tag.gpgsign=false',
];

/** Run git with the identity above. Accepts the same options as execFile. */
export function git(args, options = {}) {
  return exec('git', [...IDENTITY, ...args], { maxBuffer: 32 << 20, ...options });
}

/**
 * The two repos a variant-bearing skill is resolved against, and the stack each
 * one signals.
 *
 * `node-web` comes from a vite config file, not from package.json, which is why
 * `react` alone is not enough to select the `web` variant. Both profiles are named
 * here rather than derived: the registry records where each body lives and how
 * many bytes it is, and says nothing about the repo that holds it. This is the
 * scenario being staged, so it is stated rather than inferred.
 */
const REPO_PROFILES = {
  // Any repo the registry names that is not listed here is staged neutral: a name
  // and a lockfile, no stack dependencies. That is enough for the commands under
  // test, because no variant-bearing skill declares a source outside the two
  // profiles below, so nothing has to be selected by signal from anywhere else.
  'simt-social': {
    profile: 'web',
    files: {
      'package.json': `${JSON.stringify(
        {
          name: 'simt-social',
          dependencies: { react: '^19.0.0', 'react-router': '^7.0.0' },
          devDependencies: { vite: '^6.0.0', typescript: '^5.6.0' },
        },
        null,
        2,
      )}\n`,
      'vite.config.ts': 'export default {};\n',
    },
  },
  'simt-social-api': {
    profile: 'api',
    files: {
      'package.json': `${JSON.stringify(
        {
          name: 'simt-social-api',
          dependencies: { hono: '^4.0.0' },
          devDependencies: { typescript: '^5.6.0', wrangler: '^3.0.0' },
        },
        null,
        2,
      )}\n`,
    },
  },
};

/**
 * Skills whose body is more than one file.
 *
 * A declared source is a size, not a layout: `measureSkill` sums the directory, so
 * a single padded `SKILL.md` satisfies the identity check for every skill. Only the
 * splits a test actually asserts on are declared here. Ten of the estate's skills
 * ship a `references/` directory that this fixture does not reproduce, and that is
 * deliberate - the fixture stages bytes that satisfy the registry, not a copy of
 * somebody else's documentation.
 */
const FILE_SPLITS = {
  'add-country-galaxy': ['SKILL.md', 'checklist.md'],
};

/** Any repo the registry names that carries no profile of its own. */
function neutralRepo(name) {
  return {
    profile: 'neutral',
    files: {
      'package.json': `${JSON.stringify({ name, dependencies: {}, devDependencies: {} }, null, 2)}\n`,
      'package-lock.json': `${JSON.stringify({ name, lockfileVersion: 3, requires: true, packages: {} }, null, 2)}\n`,
    },
  };
}

/** A plausible frontmatter block, so the body parses as the thing it claims to be. */
function head(name, summary) {
  return `---\nname: ${name}\ndescription: ${summary}\n---\n\n# ${name}\n\nBody staged by the test fixture.\n`;
}

/**
 * A body of exactly `bytes` bytes.
 *
 * Byte size is the whole of a source's identity (`locateSource` compares
 * `measureSkill` against the declared number), so a fixture body that is nearly
 * right is a fixture body that is wrong: the command under test would report
 * "exists but is not the declared body" and the test would be asserting on a
 * refusal it never asked for.
 */
function padded(prefix, bytes, label) {
  const have = Buffer.byteLength(prefix);
  if (have > bytes) {
    throw new Error(`fixture cannot stage ${label}: its head is ${have} bytes but only ${bytes} are declared`);
  }
  const line = '<!-- staged by test/fixture.mjs -->\n';
  const size = Buffer.byteLength(line);
  let out = prefix;
  let need = bytes - have;
  while (need >= size) {
    out += line;
    need -= size;
  }
  if (need > 0) out += `${'-'.repeat(need - 1)}\n`;
  return out;
}

/** Split a declared size across a file list, giving the last file the remainder. */
function stagedFiles(skill, source) {
  const split = FILE_SPLITS[skill.name] ?? ['SKILL.md'];
  const label = `${source.repo}/${source.path}`;
  const bodies = split.map((file) => head(skill.name, skill.summary ?? ''));
  // Every file but the last gets its head only; the last one absorbs the padding,
  // which keeps each file legal markdown while the directory totals the declared
  // size exactly.
  const last = bodies.length - 1;
  let used = 0;
  for (let i = 0; i < bodies.length; i += 1) {
    if (i === last) bodies[i] = padded(bodies[i], source.bytes - used, label);
    else used += Buffer.byteLength(bodies[i]);
  }
  return Object.fromEntries(split.map((file, i) => [file, bodies[i]]));
}

/**
 * Build a workspace holding every source the registry declares.
 *
 * Sources are generated from `graph/skills.graph.json` rather than hardcoded, so a
 * source added to the registry is staged here without a second edit, and a declared
 * size that changes cannot silently leave the fixture staging the old one.
 *
 * @returns {Promise<{root: string, repos: Record<string, {profile: string}>}>}
 */
export async function skillWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'simt-workspace-'));
  const { registry } = await loadRegistry(REGISTRY_PATH);

  for (const name of new Set(registry.skills.flatMap((s) => (s.sources ?? []).map((src) => src.repo)))) {
    const spec = REPO_PROFILES[name] ?? neutralRepo(name);
    const dir = join(root, name);
    for (const [file, body] of Object.entries(spec.files)) {
      const path = join(dir, file);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, body);
    }
    await git(['init', '-q'], { cwd: dir });
  }

  for (const skill of registry.skills) {
    for (const source of skill.sources ?? []) {
      if (typeof source.bytes !== 'number') continue;
      const dir = join(root, source.repo, source.path);
      await mkdir(dir, { recursive: true });
      for (const [file, body] of Object.entries(stagedFiles(skill, source))) {
        await writeFile(join(dir, file), body);
      }
    }
  }

  const repos = Object.fromEntries(
    [...new Set(registry.skills.flatMap((s) => (s.sources ?? []).map((src) => src.repo)))].map((name) => [
      name,
      { profile: (REPO_PROFILES[name] ?? neutralRepo(name)).profile },
    ]),
  );
  return { root, repos };
}

/**
 * The env that points the tool at a staged workspace.
 *
 * `--workspace` outranks this, and `'off'` disables it, so a test that needs no
 * workspace says so explicitly rather than inheriting whatever the developer has.
 */
export function workspaceEnv(root) {
  return { SIMT_DEV_WORKSPACE: root };
}
