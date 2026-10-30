// `tsconfig.base.json`: the strictness floor a TypeScript repo writes for itself.
//
// ADR-026's mechanism — a config whose grammar has no comments is a whole file the
// repo owns from the first commit — pointed at the file ADR-025 ruled out by name.
// `init` used to create it (review 0003 Q28 stopped that): a floor the tool writes
// into a fresh repo is a file nothing extends, because the repo's own `tsconfig.json`
// is the repo's to write — and a base that nothing points at is a floor with no
// effect, which `check` then reported as drift on every fresh adoption.
//
// What is left here is the reporting side of ADR-026, and it reports exactly the two
// states a base file can be in that no file can fix:
//
//   1. `inert` — the base exists and `tsconfig.json` does not extend it, so the floor
//      is in the repository and not in effect. `extends` lets a child override any key,
//      so a base can only repair a repo that is *missing* a flag; it can never repair
//      one that does not point at it.
//   2. `inconsistent` — `moduleResolution` is spelled the way the parser accepts but
//      the documentation does not. The parser is case-insensitive, which is the whole
//      reason the estate drifted: both spellings work, so nothing ever said so.
//
// Both are non-blocking findings (review 0003 Q28): the base file is repo-owned, and
// a gate that fails a repository over a policy decision is a gate whose remedy is a
// choice, not a command. An existing base file stays exactly as the repo wrote it:
// this tool does not own its bytes, so a repo that edited them is not drift.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { fingerprint } from './resolve/fingerprint.mjs';

export const TSCONFIG_BASE_FILE = 'tsconfig.base.json';
export const TSCONFIG_FILE = 'tsconfig.json';

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
 * What this repo's base file is, and what `init` will do about it.
 *
 * There is no `refresh`, and since review 0003 Q28 there is no `create` either: the
 * file is the repo's to write, and a floor the tool created was one nothing extended.
 * `init`'s whole contribution is now to say so in the plan — a file that appears after
 * the run without being in the plan is a silent write, and "init will not write this"
 * is a plan line, not an absence of one.
 *
 * `unchanged` means the file exists and is left exactly as it is: this tool does not
 * own its bytes (ADR-026), so a repo that edited them is not drift.
 *
 * @param {string} root repo root
 * @returns {Promise<{file:string, path:string, action:'unchanged'|'skip',
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
  // Absent is a skip in every case: init no longer creates the file (review 0003 Q28),
  // so the plan states what it will not write and why, rather than leaving a floor
  // behind that nothing extends.
  return {
    file: TSCONFIG_BASE_FILE,
    path,
    action: 'skip',
    exists,
    bytes: 0,
    current: true,
    typescript,
    reason: typescript
      ? 'init no longer creates the base file; a floor is a policy the repo writes for itself'
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

  // Nothing below reads the base file's contents, and that is deliberate. This tool does not
  // own those bytes (ADR-026), so a repo that edited them is not drift — and a finding that
  // compared them would report somebody's work as an error. Only the question of whether
  // `tsconfig.json` points at the base is this tool's to ask. A missing base file raises
  // no finding at all (review 0003 Q28): writing one is the repo's decision, and a gate
  // whose remedy is a policy choice is a gate nothing can satisfy.
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
