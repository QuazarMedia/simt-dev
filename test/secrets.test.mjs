// Plan 0003 R52 — the staged-diff secret scan, and the `builtin` gate kind it
// arrived with (ADR-100).
//
// The acceptance test is the one in the tracker row: a sentinel secret in the
// staged diff is BLOCKED by the dispatcher, with a report that does not contain
// the sentinel. The unit rows around it exist because that one assertion can
// pass for the wrong reason — a scanner that flags everything also blocks the
// sentinel — so the negatives (hex digests, UUIDs, identifiers, placeholders)
// are asserted with the same weight as the positives.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { GATE_KINDS, GATES } from '../src/hooks/gates.mjs';
import { runGates } from '../src/hooks/dispatcher.mjs';
import { ENTROPY_MIN_BITS, entropy, renderFindings, scanStaged, scanText } from '../src/secrets.mjs';
import { git } from './fixture.mjs';

/**
 * Exactly 16 characters after the AKIA prefix: the shape AWS issues.
 *
 * Built from parts, and so is every token sample below: the bytes at runtime
 * are the real shape (the patterns must match them), but no contiguous
 * vendor-shaped token sits in the committed blob — GitHub's push protection
 * reads this file too, and a fixture is not an exception it makes.
 */
const AWS_SENTINEL = ['AKIA', 'SIMTSENTINEL0123'].join('');

const made = [];
after(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

/** One git repository with an initial commit, so `git diff --cached` can answer. */
async function repo(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'simt-secrets-'));
  made.push(root);
  await git(['init', '-q', root]);
  await writeFile(join(root, 'base.txt'), 'benign\n');
  await git(['-C', root, 'add', 'base.txt']);
  await git(['-C', root, 'commit', '-qm', 'initial']);
  for (const [path, body] of Object.entries(files)) {
    await writeFile(join(root, path), body);
    await git(['-C', root, 'add', path]);
  }
  return root;
}

// --- patterns ----------------------------------------------------------------

test('every vendor shape the library names is caught', () => {
  const cases = [
    ['aws-access-key-id', `const k = "${AWS_SENTINEL}";`],
    ['private-key-block', '-----BEGIN OPENSSH PRIVATE KEY-----'],
    ['github-token', `curl -H "Authorization: token ${['ghp', 'a1B2'.repeat(9)].join('_')}"`],
    ['slack-token', `export HOOK=${['xoxb', '01234567890', 'abcdefghijklmnop'].join('-')}`],
    ['stripe-live-key', `const s = "${['sk_live', '9f8e7d6c5b4a3f2e1d0c9b8a'].join('_')}";`],
    ['google-api-key', `const g = "${['AIza', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r'].join('')}";`],
    ['openai-style-key', `client.key = "${['sk', 'proj'.repeat(5) + 'XYZ1234567890'].join('-')}";`],
    [
      'jwt',
      `auth=${['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g'].join('.')}`,
    ],
  ];
  for (const [kind, line] of cases) {
      const found = scanText(line);
      assert.ok(
        found.some((f) => f.kind === kind),
        `${kind} not caught in: ${line.slice(0, 60)} (got ${JSON.stringify(found)})`,
      );
    }
});

test('assigned secrets are caught through quotes, and placeholders are not secrets', () => {
  assert.equal(scanText('password = "hunter2hunter2hunter2"')[0]?.kind, 'assigned-secret');
  assert.deepEqual(scanText('password = "changeme-example"'), [], 'a documented placeholder');
  assert.deepEqual(scanText('api_key = "<your-key-here>"'), [], 'an angle-bracket placeholder');
  assert.deepEqual(scanText('secret: "xxxxxxxxxxxxxxxxxxxx"'), [], 'obvious filler');
});

// --- review 0003 Q24: precision and recall ------------------------------------

test('a prefixed key name is a secret name: DB_PASSWORD, aws_secret_access_key', () => {
  assert.equal(scanText('DB_PASSWORD = "hunter2hunter2hunter2"')[0]?.kind, 'assigned-secret');
  assert.equal(scanText('aws_secret_access_key=wJalrXUtnFEMI9K7MDENG/ubRVIx0oD5m')[0]?.kind, 'assigned-secret');
});

test('an unquoted .env and YAML value is caught, a short one is not', () => {
  assert.equal(scanText('SESSION_TOKEN=9f8e7d6c5b4a3f2e1d0c')[0]?.kind, 'assigned-secret');
  assert.deepEqual(scanText('token: none'), [], 'a four-letter value is not a secret');
  assert.deepEqual(scanText('password = undefined'), [], 'a code sentinel is not a secret');
});

test('a real secret that contains "example" is still a secret', () => {
  const found = scanText('token = "prod-example-9f8e7d6c5b4a3f2e"');
  assert.ok(found.some((f) => f.kind === 'assigned-secret'), JSON.stringify(found));
});

test('the new vendor shapes are caught: gitlab, npm, encrypted key, url userinfo', () => {
  const cases = [
    ['gitlab-token', `curl -H "PRIVATE-TOKEN: ${['glpat', 'Ab1Cd2Ef3Gh4Ij5Kl6Mn'].join('-')}"`],
    ['npm-token', `${['npm', 'Ab1Cd2Ef3Gh4Ij5Kl6MnOp7Qr8St9UvWx0Yz'].join('_')}`],
    ['private-key-block', '-----BEGIN ENCRYPTED PRIVATE KEY-----'],
    ['url-userinfo', 'url = "https://deploy:9f8e7d6c5b4a3f2e@hooks.example.com/repos"'],
  ];
  for (const [kind, line] of cases) {
    const found = scanText(line);
    assert.ok(
      found.some((f) => f.kind === kind),
      `${kind} not caught in: ${line.slice(0, 60)} (got ${JSON.stringify(found)})`,
    );
  }
});

test('a subresource-integrity hash is high-entropy bytes that are not a secret', () => {
  const sri = `sha512-${'aB3dE6gH9jK2mN5pQ8rS1tU4vW7yZ0bC4dE5fG6hI8j'}`;
  assert.deepEqual(scanText(`"integrity": "${sri}"`), [], 'an SRI digest in a lockfile line');
  assert.deepEqual(scanText(`integrity="sha256-${'Ab3dE6gH9jK2mN5pQ8rS1tU4vW7yZ0bC4dE5fG6hI8j'}"`), [], 'a sha256 SRI digest');
});

// --- entropy -----------------------------------------------------------------

test('entropy flags a high-entropy blob and nothing that merely looks busy', () => {
  const secret = 'aX7Qm2Zp9Lb4Tn6Vc8Rw1Ys5Df0Gh3JkLpO0';
  const hit = scanText(`const blob = "${secret}";`).find((f) => f.kind === 'high-entropy');
  assert.ok(hit, 'a 36-char base64 token must be reported');
  assert.ok(hit.entropy >= ENTROPY_MIN_BITS, `entropy ${hit.entropy} below the threshold`);

  // The negatives decide whether the threshold is usable rather than merely
  // strict: each of these appears in every commit this tool will ever gate.
  assert.deepEqual(scanText(`"${'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'}"`), [], 'a sha256 hex digest is not a secret');
  assert.deepEqual(scanText('"123e4567-e89b-12d3-a456-426614174000"'), [], 'a UUID is not a secret');
  assert.deepEqual(
    scanText('const someVeryLongIdentifierNameThatGoesOnAndOnForever = 1;'),
    [],
    'a long identifier is not a secret',
  );
});

test('entropy is what its name says', () => {
  assert.ok(entropy('aaaaaaaaaaaaaaaa') < 1, 'one repeated char has no entropy');
  assert.ok(entropy('aX7Qm2Zp9Lb4Tn6Vc8Rw1Ys5Df0Gh3JkLpO0') > ENTROPY_MIN_BITS);
  // The detector's whole discrimination, stated as numbers: hex tops out near
  // 4.0 over sixteen symbols, which is why the threshold sits above it.
  assert.ok(entropy('e3b0c44298fc1c149afbf4c8996fb92') < ENTROPY_MIN_BITS);
});

// --- redaction ---------------------------------------------------------------

test('a finding never carries more than a four-character prefix', () => {
  const line = `const k = "${AWS_SENTINEL}";`;
  const found = scanText(line);
  assert.ok(found.length > 0);
  for (const f of found) {
    assert.match(f.preview, /^.{1,4}…$/);
    assert.equal(f.preview.includes(AWS_SENTINEL.slice(4)), false, 'the body leaked into the preview');
  }
  const report = renderFindings([{ file: 'a.js', line: 1, ...found[0] }]);
  assert.equal(report.includes(AWS_SENTINEL.slice(4)), false, 'the report leaked the sentinel');
  assert.match(report, /a\.js:1\s+aws-access-key-id/);
});

// --- the staged diff ---------------------------------------------------------

test('scanStaged reports the added line with its file and line number', async () => {
  const root = await repo();
  await writeFile(
    join(root, 'app.js'),
    `const a = 1;\nconst k = "${AWS_SENTINEL}";\nconst b = 2;\n`,
  );
  await git(['-C', root, 'add', 'app.js']);

  const { findings, lines, error } = await scanStaged(root);
  assert.equal(error, null);
  assert.equal(lines, 3, 'all three lines are added');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'app.js');
  assert.equal(findings[0].line, 2);
  assert.equal(findings[0].kind, 'aws-access-key-id');
});

test('scanStaged judges the staged diff, not the tree: an untouched line is not a finding', async () => {
  // The line below is a secret that already exists in history. This commit
  // touches a different line, so the secret is not among the bytes being
  // recorded — and blocking for it would be a gate that can never be satisfied.
  const root = await repo();
  await writeFile(join(root, 'old.js'), `const k = "${AWS_SENTINEL}";\nconst keep = 1;\n`);
  await git(['-C', root, 'add', 'old.js']);
  await git(['-C', root, 'commit', '-qm', 'past']);

  await writeFile(join(root, 'old.js'), `const k = "${AWS_SENTINEL}";\nconst keep = 2;\n`);
  await git(['-C', root, 'add', 'old.js']);

  const { findings, lines, error } = await scanStaged(root);
  assert.equal(error, null);
  assert.equal(lines, 1, 'only the changed line is in the diff');
  assert.deepEqual(findings, [], 'the unmodified secret line was not staged by this commit');
});

test('a diff git cannot read reports an error instead of a clean scan', async () => {
  const nowhere = join(tmpdir(), `simt-secrets-missing-${process.pid}`);
  const { findings, error } = await scanStaged(nowhere);
  assert.equal(findings.length, 0);
  assert.ok(error, 'git could not answer and the scan must say so');
});

test('repository diff configuration cannot route the scan around', async () => {
  // `diff.external` sends the diff to a program that prints nothing, `-diff` in
  // `.gitattributes` tells git the file is binary so it prints no text at all, and
  // `diff.mnemonicPrefix` renames the header prefixes the attribution reads. All are
  // settings a repository can carry, and with the first two the scan used to report a
  // clean stage for a staged key (review 0003 Q02). The scan must read the staged bytes
  // with its own flags, whatever the repository asked git for.
  const root = await repo();
  await git(['-C', root, 'config', 'diff.external', '/usr/bin/true']);
  // A boolean: when set, `--cached` diffs are headed `c/… i/…` instead of `a/… b/…`.
  await git(['-C', root, 'config', 'diff.mnemonicPrefix', 'true']);
  await writeFile(join(root, '.gitattributes'), '*.env -diff\n');
  await writeFile(join(root, 'key.env'), `aws_key=${AWS_SENTINEL}\n`);
  await git(['-C', root, 'add', '.gitattributes', 'key.env']);

  const { findings, lines, error } = await scanStaged(root);
  assert.equal(error, null, error);
  assert.ok(lines > 0, 'the staged diff was empty: the configuration won');
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.equal(findings[0].file, 'key.env');
  assert.equal(findings[0].kind, 'aws-access-key-id');
});

test('a lockfile is skipped by default: a dependency bump carries its own high-entropy bytes', async () => {
  const root = await repo();
  await writeFile(join(root, 'package-lock.json'), `"integrity": "sha512-${'aB3dE6gH9jK2mN5pQ8rS1tU4vW7yZ0bC4dE5fG6hI8j'}";\n`);
  await git(['-C', root, 'add', 'package-lock.json']);

  const { findings, lines, error } = await scanStaged(root);
  assert.equal(error, null);
  assert.ok(lines > 0, 'the lockfile line was staged');
  assert.deepEqual(findings, [], JSON.stringify(findings));
});

test('gates.secretScan.ignore skips the named paths and only those', async () => {
  const root = await repo();
  await mkdir(join(root, 'vendor'), { recursive: true });
  await writeFile(join(root, 'vendor/lib.js'), `const k = "${AWS_SENTINEL}";\n`);
  await writeFile(join(root, 'app.js'), `const k = "${AWS_SENTINEL}";\n`);
  await git(['-C', root, 'add', 'vendor/lib.js', 'app.js']);

  const ignored = await scanStaged(root, { ignore: ['vendor/**'] });
  assert.equal(ignored.error, null);
  assert.equal(ignored.findings.length, 1, JSON.stringify(ignored.findings));
  assert.equal(ignored.findings[0].file, 'app.js', 'the un-ignored file is still scanned');

  const none = await scanStaged(root, { ignore: ['**'] });
  assert.deepEqual(none.findings, [], 'a glob that matches everything skips everything');
});

test('a simt:allow-secret marker on the line exempts that line only', async () => {
  const root = await repo();
  await writeFile(
    join(root, 'app.js'),
    `const k = "${AWS_SENTINEL}"; // simt:allow-secret\nconst j = "${AWS_SENTINEL}";\n`,
  );
  await git(['-C', root, 'add', 'app.js']);

  const { findings, error } = await scanStaged(root);
  assert.equal(error, null);
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.equal(findings[0].line, 2, 'the unmarked line is still a finding');
});

// --- the gate (the acceptance test) ------------------------------------------

test('the secret-scan gate blocks the sentinel, and the report does not contain it', async () => {
  const root = await repo();
  await writeFile(join(root, 'app.js'), `const a = 1;\nconst k = "${AWS_SENTINEL}";\n`);
  await git(['-C', root, 'add', 'app.js']);

  const manifest = { gates: { preCommit: ['secret-scan'], prePush: [] } };
  const result = await runGates('pre-commit', { root, manifest });

  assert.equal(result.failed, true, JSON.stringify(result));
  const gate = result.gates.find((g) => g.name === 'secret-scan');
  assert.equal(gate.status, 'failed');
  assert.match(gate.detail, /probable secret/);
  assert.match(gate.remedy, /git restore --staged/);
  assert.match(gate.output, /app\.js:2/, 'the finding names file and line');
  assert.equal(gate.output.includes(AWS_SENTINEL), false, 'the report contains the sentinel');
  assert.equal(gate.output.includes(AWS_SENTINEL.slice(4)), false, 'the report contains the sentinel body');
  assert.equal(gate.adr, 'ADR-100');
});

test('the secret-scan gate passes a clean stage and a stage with nothing in it', async () => {
  const manifest = { gates: { preCommit: ['secret-scan'], prePush: [] } };

  const clean = await repo();
  await writeFile(join(clean, 'app.js'), 'export const ok = 1;\n');
  await git(['-C', clean, 'add', 'app.js']);
  const cleanResult = await runGates('pre-commit', { root: clean, manifest });
  assert.equal(cleanResult.failed, false, JSON.stringify(cleanResult));
  assert.match(cleanResult.gates[0].detail, /no secret found/);

  const empty = await repo();
  const emptyResult = await runGates('pre-commit', { root: empty, manifest });
  assert.equal(emptyResult.failed, false, JSON.stringify(emptyResult));
  assert.match(emptyResult.gates[0].detail, /nothing staged/);
});

test('the gate is a declared gate like any other: known, kinded, and ADR-cited', () => {
  const gate = GATES['secret-scan'];
  assert.ok(gate, 'the gate exists');
  assert.equal(gate.kind, 'builtin');
  assert.ok(GATE_KINDS.has('builtin'), 'the kind is in the declared kind set');
  assert.match(gate.adr, /^ADR-\d{3}$/);
  assert.ok(gate.why.length > 20);
});

test('a declared command still overrides the built-in, as it does for every kind', async () => {
  // The dispatcher's precedence is unchanged by the new kind (ADR-100 ruling 1):
  // `gates.commands` wins, so a repository can replace the scan with its own
  // program without the new kind quietly becoming a special case.
  const root = await repo();
  await writeFile(join(root, 'app.js'), `const k = "${AWS_SENTINEL}";\n`);
  await git(['-C', root, 'add', 'app.js']);

  const manifest = {
    gates: { preCommit: ['secret-scan'], prePush: [], commands: { 'secret-scan': 'echo override && exit 0' } },
  };
  const result = await runGates('pre-commit', { root, manifest });
  assert.equal(result.failed, false, JSON.stringify(result));
  assert.match(result.gates[0].detail, /echo override/);
});

test('gates.secretScan.ignore reaches the built-in through the dispatcher', async () => {
  const root = await repo();
  await mkdir(join(root, 'vendor'), { recursive: true });
  await writeFile(join(root, 'vendor/lib.js'), `const k = "${AWS_SENTINEL}";\n`);
  await git(['-C', root, 'add', 'vendor/lib.js']);

  const manifest = {
    gates: { preCommit: ['secret-scan'], prePush: [], secretScan: { ignore: ['vendor/**'] } },
  };
  const result = await runGates('pre-commit', { root, manifest });
  assert.equal(result.failed, false, JSON.stringify(result));
  assert.match(result.gates[0].detail, /no secret found/);
});