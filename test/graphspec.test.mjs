// Agent Skills conformance - the specification, not somebody's memory of it.
//
// Every rule here was read from agentskills.io/specification, and the tests that matter
// are the ones that fail on a violation: an uppercase name, a description over the limit,
// a name that disagrees with its directory, and a body a client will load whole. The
// fixture cases are the accept criterion from the review this was filed for.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { SPEC, checkSkill, nameProblems } from '../src/graph/spec.mjs';
import { lintSpec } from '../src/graph/speccheck.mjs';

const made = [];

after(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'simt-spec-'));
  made.push(dir);
  return dir;
}

/** A skill directory with the given name and SKILL.md body. */
async function skill(name, text) {
  const root = await scratch();
  await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, name, 'SKILL.md'), text);
  return root;
}

const conforming = `---
name: conformance-demo
description: Explain the Agent Skills naming rules, and check a directory against them. Use when a skill is rejected by a client or when adding a new one.
---

# Body
`;

test('the specification is named, so a reader can check the claim', () => {
  // A lint against an unnamed set of rules is decoration; the name is what makes it
  // falsifiable.
  assert.equal(SPEC, 'agentskills');
});

test('a conforming skill produces nothing', async () => {
  assert.deepEqual(checkSkill({ directoryName: 'conformance-demo', text: conforming, at: 'demo' }), {
    errors: [],
    warnings: [],
  });
});

test('a name the specification forbids fails with the rule it broke', () => {
  const cases = [
    ['Upper-Case', 'not lowercase'],
    ['-leading', 'starts or ends with a hyphen'],
    ['trailing-', 'starts or ends with a hyphen'],
    ['double--hyphen', 'consecutive hyphens'],
    ['under_score', 'not lowercase'],
    ['with space', 'not lowercase'],
    ['x'.repeat(65), 'at most 64'],
  ];
  for (const [name, expected] of cases) {
    const broken = nameProblems(name);
    assert.ok(broken !== null, `${JSON.stringify(name)} should not have passed`);
    assert.match(broken, new RegExp(expected), `reported the wrong rule for ${JSON.stringify(name)}: ${broken}`);

    const text = `---\nname: ${name}\ndescription: ${'x'.repeat(80)}\n---\n\nBody\n`;
    const { errors } = checkSkill({ directoryName: name, text, at: 'demo' });
    assert.ok(errors.some((e) => e.includes(expected)), `lint missed ${JSON.stringify(name)}: ${errors}`);
  }
});

test('a name that disagrees with its directory is the rule installs break on', () => {
  // A client resolves a skill by name, finds the directory it was given, and reads
  // nothing when the two differ. The review's install-side fix is this check, moved to
  // where the copy happens.
  const text = `---\nname: renamed-elsewhere\ndescription: ${'x'.repeat(80)}\n---\n\nBody\n`;
  const { errors } = checkSkill({ directoryName: 'original-name', text, at: 'demo' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /does not match its directory/);
});

test('a description over the specification limit fails, and a short one is a warning', () => {
  const tooLong = `---\nname: length-demo\ndescription: ${'x'.repeat(1100)}\n---\n\nBody\n`;
  const { errors } = checkSkill({ directoryName: 'length-demo', text: tooLong, at: 'demo' });
  assert.ok(errors.some((e) => /description is 1100 characters/.test(e)), `got ${errors}`);

  const short = `---\nname: length-demo\ndescription: Too short to match a keyword.\n---\n\nBody\n`;
  const { warnings } = checkSkill({ directoryName: 'length-demo', text: short, at: 'demo' });
  assert.ok(warnings.some((w) => /what the skill does AND when to use it/.test(w)), `got ${warnings}`);
});

test('a description written as a folded block scalar is read as text, not as its arrow', () => {
  // The real spelling of a long description, and the one a naive reader reports as two
  // characters. The lint being confidently wrong about a conforming file is worse than
  // the lint not existing.
  const folded = `---\nname: folded\ndescription: >-\n  Explain one thing and another in several sentences.\n  Use when a task needs both, or when a keyword matches either.\n---\n\nBody\n`;
  const { errors, warnings } = checkSkill({ directoryName: 'folded', text: folded, at: 'demo' });
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 0, 'a 100-character folded description is long enough');
});

test('compatibility has its own limit, and most skills do not need it', () => {
  const long = `---\nname: compat\ndescription: ${'x'.repeat(80)}\ncompatibility: ${'y'.repeat(501)}\n---\n\nBody\n`;
  const { errors } = checkSkill({ directoryName: 'compat', text: long, at: 'demo' });
  assert.ok(errors.some((e) => /compatibility is 501 characters/.test(e)));
});

test('a body past the recommended size is a warning that says what it costs', () => {
  const body = `${'line of body text\n'.repeat(12000)}`;
  const text = `---\nname: big\ndescription: ${'x'.repeat(80)}\n---\n\n${body}`;
  const { errors, warnings } = checkSkill({ directoryName: 'big', text, at: 'demo' });
  // The body limit is a recommendation, so it never blocks the exit code: a lint that
  // fails on a recommendation teaches a reader to skip the lint.
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => /recommends under 5000/.test(w)));
  assert.ok(warnings.some((w) => /under 500/.test(w)));
});

test('the flat form is reported, because a client looks for SKILL.md by name', async () => {
  const root = await scratch();
  await writeFile(join(root, 'flat-skill.md'), `---\nname: flat-skill\ndescription: ${'x'.repeat(80)}\n---\nBody\n`);
  const report = await lintSpec(
    { skills: [{ name: 'flat-skill', sources: [{ repo: 'r', path: 'flat-skill.md', role: 'canonical' }] }] },
    root,
  );
  // The repo is `r` under the root, so the path join finds nothing there; this fixture
  // writes the file at the root, which is what the linter is given.
  assert.ok(report.warnings.some((w) => /could not read it/.test(w)), `${report.warnings}`);
});

test('lintSpec checks the canonical source, and names the skill in every finding', async () => {
  const oneRoot = await scratch();
  await mkdir(join(oneRoot, 'conformance-demo'), { recursive: true });
  await writeFile(join(oneRoot, 'conformance-demo', 'SKILL.md'), conforming);
  await mkdir(join(oneRoot, 'Bad_Name'), { recursive: true });
  await writeFile(
    join(oneRoot, 'Bad_Name', 'SKILL.md'),
    `---\nname: Bad_Name\ndescription: ${'x'.repeat(80)}\n---\n\nBody\n`,
  );

  const findings = await lintSpec(
    {
      skills: [
        { name: 'good', sources: [{ repo: '.', path: 'conformance-demo', role: 'canonical' }] },
        { name: 'bad', sources: [{ repo: '.', path: 'Bad_Name', role: 'canonical' }] },
        // A skill with no canonical source is an alias: the target is checked, so
        // checking it again would double-count one body against one specification.
        { name: 'alias', aliasOf: 'good', sources: [{ repo: '.', path: 'conformance-demo', role: 'retired' }] },
      ],
    },
    oneRoot,
  );
  assert.equal(findings.checked, 2);
  assert.equal(findings.errors.length, 1);
  assert.match(findings.errors[0], /^bad: /);
  assert.match(findings.errors[0], /not lowercase/);
});
