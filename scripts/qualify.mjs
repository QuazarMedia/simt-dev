#!/usr/bin/env node
// Named qualification stages for the two questions `npm test` is not allowed to ask.
//
// `npm test` is the offline correctness gate. It must pass from a relocated checkout
// with no network, no host Git configuration and no prior build data. The checks that
// need a registry, a Python interpreter or a downloaded Node base are release
// qualification: they run here, in named stages, and a stage that cannot start says so
// with the command and the prerequisite rather than disappearing behind a skip.
//
// Usage: node scripts/qualify.mjs [offline|artifacts|all]

import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const [mode = 'all'] = process.argv.slice(2);
if (!['offline', 'artifacts', 'all'].includes(mode)) {
  process.stderr.write('qualify: expected offline, artifacts or all\n');
  process.exit(2);
}

const CACHE = process.env.SIMT_QUALIFY_CACHE ?? join(tmpdir(), 'simt-dev-qualify-cache');
await mkdir(CACHE, { recursive: true });

/** One stage: the command, why it exists, and what it needs. */
function stage(id, why, command, args, { env = {}, prerequisite = null } = {}) {
  return { id, why, command, args, env, prerequisite };
}

function hostTarget() {
  const os = { darwin: 'darwin', linux: 'linux' }[process.platform];
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
  return os && arch ? `${os}-${arch}` : null;
}

const baseEnv = {
  ...process.env,
  npm_config_cache: join(CACHE, 'npm'),
  npm_config_update_notifier: 'false',
  SIMT_SEA_CACHE: process.env.SIMT_SEA_CACHE ?? join(CACHE, 'sea'),
};

const target = hostTarget();
const offline = [
  stage('offline-suite', 'the correctness suite, with no network and a fixed worker count', 'npm', ['test']),
  stage('registry-lint', 'the skill registry is internally consistent', 'npm', ['run', 'lint']),
  stage('generated-ci', 'the own workflow and dependabot copies match their templates', process.execPath, ['scripts/ci.mjs', '--check']),
  stage('index-benchmark', 'incremental indexing stays inside its declared budget', process.execPath, ['scripts/bench-index.mjs']),
];

const artifacts = [
  stage('wheel-parity', 'the wheel carries the bytes the npm tarball ships', 'npm', ['run', 'verify:wheel'], {
    prerequisite: 'python3 and a registry',
  }),
  ...(target === null
    ? []
    : [
        stage('sea-build', `build the ${target} single-file binary from pinned inputs`, process.execPath, ['scripts/build-sea.mjs', target], {
          prerequisite: 'nodejs.org for the pinned Node base, and an npm registry for postject',
        }),
        stage('sea-acceptance', 'the built binary runs an inert Gradle fixture with no Node on PATH', process.execPath, ['--test', 'test/binary.test.mjs'], {
          env: { SIMT_QUALIFY_SEA: '1' },
          prerequisite: target,
        }),
      ]),
];

const stages = mode === 'offline' ? offline : mode === 'artifacts' ? artifacts : [...offline, ...artifacts];
let failed = 0;
let skipped = 0;

for (const item of stages) {
  process.stdout.write(`\nQUALIFY ${item.id}\n  ${item.why}\n  $ ${item.command} ${item.args.join(' ')}\n`);
  const result = spawnSync(item.command, item.args, {
    stdio: 'inherit',
    env: { ...baseEnv, ...item.env },
  });
  if (result.error) {
    failed += 1;
    process.stderr.write(`\nFAIL ${item.id}: ${result.error.message}\n  prerequisite: ${item.prerequisite ?? 'available locally'}\n`);
    continue;
  }
  if (result.status !== 0) {
    failed += 1;
    process.stderr.write(`\nFAIL ${item.id}: exit ${result.status}\n  prerequisite: ${item.prerequisite ?? 'available locally'}\n`);
    continue;
  }
  process.stdout.write(`PASS ${item.id}\n`);
}

if (target === null && mode !== 'offline') {
  skipped += 1;
  process.stdout.write('\nSKIP sea-build/sea-acceptance: this host is not a release target\n');
}

if (failed > 0) {
  process.stderr.write(`\nqualify: ${failed} stage(s) failed, ${skipped} skipped\n`);
  process.exit(1);
}
process.stdout.write(`\nqualify: all ${stages.length} stage(s) passed${skipped > 0 ? `, ${skipped} skipped` : ''}\n`);
