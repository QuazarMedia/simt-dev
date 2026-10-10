// `tsconfig.base.json`: the strictness floor every TypeScript repo in the estate agrees on.
//
// This is ADR-026's mechanism — a config whose grammar has no comments is a whole file the
// repo owns from the first commit — pointed at the file ADR-025 ruled out by name. Two
// consequences shape everything here, and both are easy to get wrong:
//
//   1. A base file is a FLOOR, not a policy. `extends` lets a child override any key, so a
//      base can only repair a repo that is *missing* a flag. It can never repair one that
//      spells a flag differently — the child wins and the base is inert for that key. Every
//      key below is therefore one the estate already agrees on, and the one place the estate
//      disagrees is a check instead (see `checkTsconfig`).
//   2. The bytes cannot explain themselves. JSON has no comments, so this file ships with no
//      header saying who wrote it or what a reader must do next, which is normally the one
//      thing a shipped file owes its reader. `init` prints the `extends` line it requires
//      and `check` reports a repo that has not adopted it, so the obligation is met by the
//      tool's output rather than the file's.
//
// The whole file is owned by `init` alone. It is not in `src/ci/` and not in
// `src/projection/baselines.mjs` because it is neither a `.github` file that `simt-dev ci`
// refreshes nor a marker region: `simt-dev check` reports its absence and never its contents.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { fingerprint } from './resolve/fingerprint.mjs';
import { CLI } from './name.mjs';

export const TSCONFIG_BASE_FILE = 'tsconfig.base.json';
export const TSCONFIG_FILE = 'tsconfig.json';

/**
 * The strictness floor.
 *
 * Every key here is already set, and set the same way, by every `tsconfig.json` in the
 * estate that could afford it. `simt-goto` is the outlier and it is not one on purpose: it
 * is missing the seven flags below that the three social repos share, which is the gap
 * plan section 3.1 row 5 named. Nothing in this object is a value anybody has argued about;
 * it is the intersection of what four repositories independently wrote.
 *
 * Absent, and each for a reason that would be invisible to the next reader:
 *
 *   - `noEmit`. node.md:36 wants it for "any project that bundles elsewhere", and it would
 *     be harmless to inherit here because a child can set `false`. It is left out because a
 *     base that hands `noEmit` to a repo nobody looked at is a build that stops emitting,
 *     and the two repositories that bundle elsewhere did not ask for it. A floor nobody
 *     opted into is not a floor.
 *   - `moduleResolution`. All four repositories set it; three write `Bundler` and one writes
 *     `bundler`. Shipping either would change nothing, because the child overrides the base
 *     and the disagreement is precisely that the child sets it. `check` reports the spelling
 *     instead.
 *   - `target`, `lib`, `module`. Genuinely per-repo: `lib` is DOM+DOM.Iterable in two
 *     repositories and DOM+WebWorker in the other two, and a base that chose would silence
 *     one of them. These describe the platform, not the estate.
 *   - `include`, `exclude`, `paths`, `types`, `jsx`. What a project is made of.
 */
export const STRICTNESS_FLOOR = {
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noImplicitOverride: true,
  useUnknownInCatchVariables: true,
  noFallthroughCasesInSwitch: true,
  noImplicitReturns: true,
  isolatedModules: true,
  verbatimModuleSyntax: true,
  allowJs: false,
  resolveJsonModule: true,
  skipLibCheck: true,
};

/**
 * `moduleResolution` as TypeScript documents it.
 *
 * The parser is case-insensitive, which is the whole reason the estate has drifted: both
 * `bundler` and `Bundler` work, so nothing ever told anybody the other one did not. node.md:38
 * asks for it "spelled consistently across every repo in the workspace", and consistency
 * with an external document is the only spelling that can be checked in one repo at a time
 * — consistency with the other repositories would need a workspace, and `check` runs in a
 * repo on its own.
 */
export const DOCUMENTED_RESOLUTIONS = new Set([
  'classic',
  'node',
  'node10',
  'node16',
  'nodenext',
  'bundler',
]);

/**
 * The base file, as bytes.
 *
 * Key order is the order of `STRICTNESS_FLOOR` and not alphabetical, because the object
 * literal is the readable form and reordering it here would mean the file and the reason
 * disagree. `JSON.stringify` preserves insertion order, so the two cannot drift.
 *
 * @returns {string} JSON, LF-terminated
 */
export function renderTsconfigBase() {
  return `${JSON.stringify({ compilerOptions: STRICTNESS_FLOOR }, null, 2)}\n`;
}

/**
 * Parse a file that TypeScript allows to carry comments.
 *
 * `tsconfig.json` is JSONC: tsc strips comments before reading it, so a repo with a comment
 * at the top of its tsconfig is normal and not a mistake. A plain `JSON.parse` would throw,
 * and a gate that throws on a file it did not write is worse than a gate that says nothing
 * — the reader would see a stack trace where the answer was one line. Every failure here
 * returns a value rather than throwing, so a malformed tsconfig is reported as unreadable
 * and nothing else claims to know what is in it.
 *
 * Written as a scanner rather than a regex for one reason: `//` and `/*` occur inside
 * strings, and the commonest string in a tsconfig-adjacent file is a URL. A regex would
 * delete `https://` and then report a parse error on a file that is perfectly valid.
 *
 * @param {string} text
 * @returns {{value: object|null, error: string|null}}
 */
export function readJsonc(text) {
  let out = '';
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      if (c === '\\') {
        out += c + (text[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      out += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    // A trailing comma is legal in JSONC and illegal in JSON. Dropping it on the way out
    // rather than with a regex over the finished string, because `, }` is also what a
    // string containing a closing brace looks like.
    if (c === '}' || c === ']') {
      let end = out.length - 1;
      while (end >= 0 && /\s/.test(out[end])) end -= 1;
      if (out[end] === ',') out = out.slice(0, end) + out.slice(end + 1);
    }
    out += c;
    i += 1;
  }
  try {
    const value = JSON.parse(out);
    return { value: typeof value === 'object' && value !== null ? value : null, error: null };
  } catch (e) {
    return { value: null, error: e.message };
  }
}

/**
 * What this repo's base file should be, and what should happen to it.
 *
 * There is no `refresh`. ADR-026 gave simt-dev's own `.github` files a refresh path because
 * this repository is the template's only author; a base file has the same argument, and it
 * is deliberately not extended to it. `simt-dev check` in this repository reports the
 * baseline files as unmanaged by design, so a refresh path here would be a way to make this
 * repository's own gate green by rewriting the file it is judging — which is the same
 * mistake as a gate that edits its own expectations.
 *
 * The skip case is detection, not politeness: a repository with no TypeScript has nothing to
 * extend the base, and a `tsconfig.base.json` in a JavaScript repository is a file that
 * claims to be an authority and is read by nothing.
 *
 * @param {string} root repo root
 * @returns {Promise<{file:string, path:string, action:'create'|'unchanged'|'skip',
 *                    exists:boolean, bytes:number, current:boolean, typescript:boolean,
 *                    reason:string|null}>}
 */
export async function planTsconfigBase(root) {
  const path = join(root, TSCONFIG_BASE_FILE);
  let text = null;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    text = null;
  }
  const exists = text !== null;
  const bytes = exists ? Buffer.byteLength(text) : 0;
  const { stack } = await fingerprint(root);
  const typescript = stack.includes('typescript');
  if (exists) {
    return {
      file: TSCONFIG_BASE_FILE,
      path,
      action: 'unchanged',
      exists,
      bytes,
      current: true,
      typescript,
      reason: null,
    };
  }
  return {
    file: TSCONFIG_BASE_FILE,
    path,
    action: typescript ? 'create' : 'skip',
    exists,
    bytes: 0,
    current: false,
    typescript,
    reason: typescript
      ? null
      : 'no TypeScript in this repository, so nothing would extend the base',
  };
}

/**
 * What is wrong with a repository's TypeScript configuration.
 *
 * Two findings, and the split between them is the point of the whole module. A base file
 * repairs a repository that is missing a flag and is structurally unable to repair one that
 * spells a flag differently, so exactly one of these two problems can be handed to a file
 * and the other has to be a check.
 *
 * Returns `[]` rather than throwing on unreadable input, for the reason in `readJsonc`.
 *
 * @param {string} root repo root
 * @returns {Promise<{file:string, status:string, detail:string, remedy:string}[]>}
 */
export async function checkTsconfig(root) {
  const findings = [];

  let baseExists = true;
  try {
    await readFile(join(root, TSCONFIG_BASE_FILE), 'utf8');
  } catch {
    baseExists = false;
  }

  const { stack } = await fingerprint(root);
  const typescript = stack.includes('typescript');
  if (typescript && !baseExists) {
    findings.push({
      file: TSCONFIG_BASE_FILE,
      status: 'absent',
      detail:
        'this repo is TypeScript and has no base file, so every strictness flag is whatever ' +
        'one person happened to write',
      remedy: `${CLI} init --yes`,
    });
  }

  // Nothing below reads the base file's contents, and that is deliberate. This tool does not
  // own those bytes (ADR-026), so a repo that edited them is not drift — and a finding that
  // compared them would report somebody's work as an error. Only the question of whether
  // `tsconfig.json` points at the base is this tool's to ask.
  let own = null;
  try {
    own = readJsonc(await readFile(join(root, TSCONFIG_FILE), 'utf8'));
  } catch {
    own = null;
  }
  if (own === null) return findings;
  if (own.error !== null) {
    // A file that cannot be parsed is a finding about `tsc`, not about simt-dev, and tsc
    // says it better. Staying quiet here is the difference between a gate with an opinion
    // and a gate that guesses.
    return findings;
  }
  const config = own.value;
  if (!config) return findings;

  if (baseExists && config.extends === undefined) {
    findings.push({
      file: TSCONFIG_FILE,
      status: 'inert',
      detail:
        `this repo has a ${TSCONFIG_BASE_FILE} that ${TSCONFIG_FILE} does not extend, so the ` +
        'strictness floor is in the repository and not in effect',
      remedy: `add "extends": "./${TSCONFIG_BASE_FILE}" to ${TSCONFIG_FILE}`,
    });
  }

  const resolution = config.compilerOptions?.moduleResolution;
  if (typeof resolution === 'string' && !DOCUMENTED_RESOLUTIONS.has(resolution)) {
    const canonical = [...DOCUMENTED_RESOLUTIONS].find(
      (r) => r.toLowerCase() === resolution.toLowerCase(),
    );
    if (canonical) {
      findings.push({
        file: TSCONFIG_FILE,
        status: 'inconsistent',
        detail:
          `"moduleResolution": "${resolution}" compiles, which is why it disagrees with the ` +
          `repositories that write "${canonical}" and why nothing has ever said so`,
        remedy: `change it to "${canonical}"`,
      });
    }
  }

  return findings;
}
