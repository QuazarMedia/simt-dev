// Registry loader and validator for graph/skills.graph.json.
//
// The registry is hand-authored, so it needs a machine check that it still
// describes reality. Hand-authoring 38 nodes across 6 repos is exactly the kind
// of bookkeeping that rots silently: a skill gets renamed, a reference file is
// deleted, a stack tag is invented that the detector cannot emit. `graph lint`
// is what keeps the registry trustworthy, and therefore what keeps resolution
// trustworthy - an unverified registry would make every selection it produces
// untrustworthy.
//
// Sizing rule: a skill's `bytes` is SKILL.md plus every reference file beneath it.
// Measured, never asserted. `.cursor/skills`, `.claude/skills` and `.agents/skills`
// are frequently symlink pairs, so the same body is reachable by two paths; sources
// are measured once per declared source and never double-counted.

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { KNOWN_TAGS } from '../resolve/fingerprint.mjs';
import { matchesGlob, syntheticPathFor, tokenize } from '../resolve/resolve.mjs';
import { PACKAGE_ROOT, resolveWorkspace, WORKSPACE_REMEDY } from '../workspace.mjs';

/**
 * The registry is workspace data (ADR-061): it describes which skill bodies a particular
 * workspace holds, where they are, how big they are, and which tags separate the variants.
 * It therefore lives in a MEMBER of the workspace, not in the workspace root - the root is
 * the directory that CONTAINS the member repositories, and it holds no `graph/` of its own.
 * An explicitly named path always wins over everything below.
 */
function defaultRegistryPath() {
  return join(PACKAGE_ROOT, 'graph', 'skills.graph.json');
}

/**
 * The registry to read when the reader names none, in order (ADR-061 ruling 3):
 *
 * 1. The package root, when it holds one. In this checkout that is how the tool finds its
 *    own registry; in an installed package `graph` is not in the published `files`, so it
 *    never does, and the reader falls through to 2 instead of being handed this workspace's
 *    catalogue.
 * 2. A member of the resolved workspace, when exactly one holds one: a tool installed from
 *    node_modules or a formula resolves its workspace by configuration, and the member that
 *    holds the registry is usually the tool's own checkout. More than one holding it is
 *    ambiguity and the reader must pick; none is an honest absence, reported with the
 *    workspace that was looked in.
 *
 * Every step is file existence plus the configured workspace, so the answer can be
 * explained to whoever asks (determinism). `errors` empty means a path was found.
 *
 * @returns {Promise<{where: string|null, errors: string[], workspace: {root: string|null, source: string, detail: string}|null}>}
 */
async function defaultRegistry(flags) {
  const own = defaultRegistryPath();
  if (existsSync(own)) return { where: own, errors: [], workspace: null };

  const ws = await workspace(flags);
  const info = { root: ws.root, source: ws.source, detail: ws.detail };
  const absent = `no skill registry at ${own}; create one there, or name it explicitly`;
  if (ws.error) {
    return { where: own, errors: [`${ws.detail}: ${ws.error}`, absent], workspace: info };
  }
  if (ws.root === null) {
    return { where: own, errors: [absent], workspace: info };
  }
  if (!existsSync(ws.root)) {
    return {
      where: own,
      errors: [`no skill registry: the configured workspace ${ws.root} (${ws.detail}) does not exist`],
      workspace: info,
    };
  }

  const members = [];
  let entries;
  try {
    entries = await readdir(ws.root, { withFileTypes: true });
  } catch {
    entries = null;
  }
  for (const entry of entries ?? []) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    if (existsSync(join(ws.root, entry.name, 'graph', 'skills.graph.json'))) members.push(entry.name);
  }

  if (members.length === 1) {
    return { where: join(ws.root, members[0], 'graph', 'skills.graph.json'), errors: [], workspace: info };
  }
  if (members.length > 1) {
    return {
      where: null,
      errors: [
        `ambiguous registry: ${members.length} members of workspace ${ws.root} each hold ` +
          `graph/skills.graph.json (${members.join(', ')}); name one explicitly`,
      ],
      workspace: info,
    };
  }
  return {
    where: own,
    errors: [
      `no skill registry in workspace ${ws.root} (${ws.detail}); create one in a member, or name it explicitly`,
    ],
    workspace: info,
  };
}

/**
 * Where sibling repos live. Sources are declared as `repo/path`, so resolving one
 * needs a directory that CONTAINS repositories.
 *
 * This used to be `resolve(HERE, '..', '..', '..')`, which is correct in the checkout
 * and wrong in `node_modules`, where it lands inside the scope directory and every
 * source resolves to a path that cannot exist. It is now configuration - flag,
 * environment, user config file, then a sibling heuristic that must verify - and a
 * failure to resolve is a WARNING, not 38 `ENOENT` lines (ADR-014).
 *
 * Resolved once per process and memoised, because every caller needs the same answer
 * and the answer cannot change while the process runs.
 */
let workspacePromise = null;
export function workspace(flags = {}) {
  if (!workspacePromise) workspacePromise = resolveWorkspace(flags);
  return workspacePromise;
}

const VALID_ROLES = new Set(['canonical', 'variant', 'stub', 'duplicate', 'deprecated']);

/**
 * Load and verify the registry.
 *
 * `verified: false` means the structural checks passed but disk verification was SKIPPED
 * because no workspace was available. That is a warning, not an error: the catalogue is
 * still perfectly readable, and its byte counts simply could not be checked against
 * files. Treating an absent workspace as a registry failure is the same mistake as
 * printing 38 `ENOENT` lines - it converts "not configured" into "broken" (ADR-014).
 *
 * @returns {Promise<{ok: boolean, registry: object|null, errors: string[], warnings: string[],
 *                    verified: boolean, workspace: {root: string|null, source: string, detail: string}>}
 */
export async function loadRegistry(path = null, flags = {}) {
  // An explicitly named path wins over the default (ADR-061). When none is given,
  // `defaultRegistry` looks in the package root and then in the workspace's members; its
  // errors are facts about ABSENCE - no registry here, or more than one and the reader must
  // pick - and are reported as such. A named path that is missing is a different fact: the
  // reader pointed at a file that is not there, and it names that path.
  let where = path;
  let resolveErrors = null;
  let resolvedWorkspace = null;
  if (path === null) {
    const found = await defaultRegistry(flags);
    where = found.where;
    resolveErrors = found.errors;
    resolvedWorkspace = found.workspace;
  }

  if (resolveErrors !== null && resolveErrors.length > 0) {
    return {
      ok: false,
      registry: null,
      path: where,
      errors: resolveErrors,
      warnings: [],
      verified: false,
      workspace: resolvedWorkspace ?? { root: null, source: 'none', detail: 'not resolved' },
    };
  }

  let registry;
  try {
    registry = JSON.parse(await readFile(where, 'utf8'));
  } catch (error) {
    const message =
      path === null && error.code === 'ENOENT'
        ? `no skill registry at ${where}; create one there, or name it explicitly`
        : `${where}: unreadable or invalid JSON (${error.message})`;
    return {
      ok: false,
      registry: null,
      path: where,
      errors: [message],
      warnings: [],
      verified: false,
      workspace: { root: null, source: 'none', detail: 'not resolved' },
    };
  }

  const errors = [];
  const warnings = [];
  const lint = lintRegistry(registry);

  for (const error of lint.sync) errors.push(error);
  for (const warning of lint.warnings) warnings.push(warning);

  const ws = await workspace(flags);

  if (ws.error) {
    // A config file that exists and does not parse is a real mistake, and it is the
    // author's to fix - so this one IS an error. An absent config is not.
    errors.push(`${ws.detail}: ${ws.error}`);
  } else if (ws.root === null) {
    warnings.push(
      `skill sources are not available: no workspace configured, so byte counts were not verified`,
    );
    warnings.push(WORKSPACE_REMEDY);
  } else if (!existsSync(ws.root)) {
    // A workspace that was CONFIGURED but is not there is a different fact from one
    // that was never configured: the reader named a directory that has moved. Naming
    // it is useful; turning it into 38 ENOENT lines is not, and it is the same
    // mistake as above with an extra cause (ADR-014).
    warnings.push(
      `skill sources were not verified: the configured workspace ${ws.root} (from ${ws.detail}) does not exist`,
    );
  } else if (!holdsAnyRepo(registry, ws.root)) {
    // Exists, but holds none of the directories the registry names. Either the
    // reader pointed at the wrong directory or the repos are not cloned there. Both
    // are one fact with one remedy, and neither is 38 ENOENT lines.
    const named = [...new Set((registry.skills ?? []).flatMap((s) => (s.sources ?? []).map((x) => x.repo)))].sort();
    warnings.push(
      `skill sources were not verified: ${ws.root} (from ${ws.detail}) contains none of the ` +
        `repositories the registry names (${named.slice(0, 4).join(', ')}${named.length > 4 ? ', …' : ''})`,
    );
  } else {
    // Disk verification is async: a registry that no longer matches the repos is
    // worse than one that is merely malformed, because it still resolves.
    const disk = await lintSourcesOnDisk(registry, ws.root);
    errors.push(...disk.errors);
    warnings.push(...disk.warnings);
  }

  const verified =
    ws.error === null && ws.root !== null && existsSync(ws.root) && holdsAnyRepo(registry, ws.root);

  return {
    ok: errors.length === 0,
    registry,
    path: where,
    errors,
    warnings,
    verified,
    workspace: { root: ws.root, source: ws.source, detail: ws.detail },
  };
}

/**
 * Does this directory hold any of the repositories the registry names?
 *
 * Existence is not enough. Pointing `--workspace` at the wrong directory - a home
 * folder, an empty tmpdir, the wrong checkout - produces 38 ENOENTs that read as a
 * broken registry rather than a wrong pointer, which is exactly backwards.
 */
function holdsAnyRepo(registry, root) {
  const named = new Set(
    (registry.skills ?? []).flatMap((s) => (s.sources ?? []).map((x) => x.repo)).filter(Boolean),
  );
  for (const repo of named) {
    if (existsSync(join(root, repo))) return true;
  }
  return false;
}

/** Pure structural checks. No filesystem access. */
export function lintRegistry(registry) {
  const errors = [];
  const warnings = [];
  const err = (message) => errors.push(message);
  const warn = (message) => warnings.push(message);

  const capabilities = new Map((registry.capabilities ?? []).map((c) => [c.id, c]));
  const skills = registry.skills ?? [];
  const index = new Map();
  const threshold = registry.deferredThreshold ?? 20000;

  // --- shape -----------------------------------------------------------------
  if (!Array.isArray(registry.capabilities) || capabilities.size === 0) {
    err('capabilities: missing or empty');
  }
  if (!Array.isArray(registry.skills) || skills.length === 0) {
    err('skills: missing or empty');
    return { sync: errors, warnings, index };
  }
  for (const c of registry.capabilities) {
    if (!c.id || !c.summary) err(`capability ${c.id ?? '<no id>'}: needs id and summary`);
  }

  // --- duplicate names -------------------------------------------------------
  for (const skill of skills) {
    if (index.has(skill.name)) {
      err(`duplicate skill name: ${skill.name}`);
    } else {
      index.set(skill.name, skill);
    }
  }

  // --- per-skill checks ------------------------------------------------------
  for (const skill of skills) {
    const at = skill.name ?? '<unnamed>';

    if (!skill.summary) err(`${at}: missing summary`);
    if (!Array.isArray(skill.capabilities) || skill.capabilities.length === 0) {
      err(`${at}: needs at least one capability`);
    }
    for (const cap of skill.capabilities ?? []) {
      if (!capabilities.has(cap)) err(`${at}: unknown capability "${cap}"`);
    }
    if (!Array.isArray(skill.stack) || skill.stack.length === 0) {
      err(`${at}: needs a stack array (an empty one can never be selected)`);
    }
    if (!Array.isArray(skill.paths)) warn(`${at}: no paths, so it can only be found by keyword or capability`);
    if (!Array.isArray(skill.keywords) || skill.keywords.length === 0) {
      err(`${at}: needs keywords, otherwise it is unreachable from a task description`);
    }

    checkStack(at, skill.stack, err);
    checkGlobs(at, skill.paths, err);
    checkKeywords(at, skill.keywords, err);

    // `deferred` is derived. A hand-edited `deferred: false` on a 384 KB skill
    // would let the whole Cloudflare reference land in a context window, which is
    // the exact failure this tool exists to prevent.
    const shouldDefer = skill.bytes > threshold;
    if (shouldDefer && skill.deferred !== true) {
      err(`${at}: ${skill.bytes} bytes exceeds deferredThreshold ${threshold} but deferred is not true`);
    }
    if (!shouldDefer && skill.deferred === true) {
      warn(`${at}: deferred is true but ${skill.bytes} bytes is under the threshold ${threshold}`);
    }

    checkRequires(at, skill, index, err);
    checkAlias(at, skill, index, err);
    checkVariants(at, skill, index, err);
    checkSources(at, skill, err, warn);
  }

  // --- capability coverage ---------------------------------------------------
  const covered = new Set(skills.flatMap((s) => s.capabilities ?? []));
  for (const cap of capabilities.keys()) {
    if (!covered.has(cap)) err(`capability "${cap}" has no covering skill (orphan)`);
  }
  for (const cap of covered) {
    if (!capabilities.has(cap)) err(`capability "${cap}" is referenced but not declared`);
  }

  // --- sibling groups --------------------------------------------------------
  const groups = registry.siblingGroups ?? [];
  const groupNames = new Set();
  for (const group of groups) {
    if (groupNames.has(group.name)) err(`duplicate siblingGroup "${group.name}"`);
    groupNames.add(group.name);
    if (!capabilities.has(group.capability)) {
      err(`siblingGroup "${group.name}": unknown capability "${group.capability}"`);
    }
    if (group.discriminator !== 'stack') {
      err(`siblingGroup "${group.name}": discriminator must be "stack" (only stack is deterministic)`);
    }
    const memberStacks = new Set();
    for (const member of group.members ?? []) {
      const skill = index.get(member);
      if (!skill) {
        err(`siblingGroup "${group.name}": unknown member "${member}"`);
        continue;
      }
      if (skill.variantOf !== group.name) {
        err(`siblingGroup "${group.name}": member "${member}" does not declare variantOf "${group.name}"`);
      }
      memberStacks.add(skill.stack.join(','));
    }
    // Siblings that resolve identically defeat the purpose of having siblings.
    if (memberStacks.size < (group.members ?? []).length && (group.members ?? []).length > 1) {
      err(`siblingGroup "${group.name}": members must be discriminated by stack, but two share an identical stack`);
    }
  }
  for (const skill of skills) {
    if (skill.variantOf && !groupNames.has(skill.variantOf)) {
      err(`${skill.name}: variantOf "${skill.variantOf}" has no siblingGroup entry`);
    }
  }

  return { sync: errors, warnings, index };
}

/**
 * A declared keyword has to be sayable.
 *
 * The existing check on this field is `needs keywords`, which is satisfied by a list of
 * words no task can produce. A keyword is only reachable if the tokenizer keeps at least
 * one of its words, so that is what this asks - the same question `checkGlobs` asks of a
 * path, and for the same reason: 13 of 232 unique keywords were unreachable and nothing
 * said so. Multi-word keywords are reachable as phrases, so only a keyword whose words
 * are ALL dropped fails here.
 */
function checkKeywords(at, keywords, err) {
  for (const keyword of keywords ?? []) {
    if (tokenize(keyword).length === 0) {
      err(`${at}: keyword "${keyword}" cannot be reached: the tokenizer keeps no word in it`);
    }
  }
}

/**
 * A declared glob has to match a path built from itself.
 *
 * The other per-skill checks ask whether a value is present and well-formed. This one
 * asks whether it does anything, which is the only question the resolver actually
 * cares about: a glob that matches no path can never select its skill, and it costs
 * nothing to declare, so only a check that compiles it catches one. 13 of 65 registry
 * globs matched nothing until this existed (S02).
 */
function checkGlobs(at, paths, err) {
  for (const glob of paths ?? []) {
    const candidates = syntheticPathFor(glob);
    if (candidates.length === 0) {
      err(`${at}: path glob "${glob}" expands to no path at all`);
      continue;
    }
    const missed = candidates.filter((p) => !matchesGlob(p, glob));
    if (missed.length > 0) {
      err(`${at}: path glob "${glob}" does not match ${missed.join(', ')}`);
    }
  }
}

function checkStack(at, stack, err) {
  for (const tag of stack ?? []) {
    if (!KNOWN_TAGS.has(tag)) {
      // A tag the detector cannot emit matches nothing, forever, with no error at
      // resolution time. This is the check that turns a silent dead entry into a
      // loud one. The vocabulary is stack tags plus emitted facts (ADR-013).
      err(`${at}: tag "${tag}" is not emitted by fingerprint() (known: ${[...KNOWN_TAGS].sort().join(', ')})`);
    }
  }
  for (const duplicate of duplicates(stack)) {
    err(`${at}: duplicate stack tag "${duplicate}"`);
  }
}

function checkRequires(at, skill, index, err) {
  for (const dep of skill.requires ?? []) {
    if (!index.has(dep)) err(`${at}: requires unknown skill "${dep}"`);
    if (dep === skill.name) err(`${at}: requires itself`);
  }
  // Cycle detection over `requires`. Depth is bounded by node count, so an
  // accidental cycle terminates rather than hanging the lint.
  const seen = new Set([skill.name]);
  let frontier = skill.requires ?? [];
  while (frontier.length > 0) {
    const next = [];
    for (const dep of frontier) {
      if (seen.has(dep)) {
        err(`requires cycle: ${[...seen].join(' -> ')} -> ${dep}`);
        return;
      }
      seen.add(dep);
      next.push(...(index.get(dep)?.requires ?? []));
    }
    frontier = next;
  }
}

function checkAlias(at, skill, index, err) {
  if (!skill.aliasOf) return;
  const target = index.get(skill.aliasOf);
  if (!target) {
    err(`${at}: aliasOf unknown skill "${skill.aliasOf}"`);
    return;
  }
  if (target.aliasOf) {
    // A retired name aliasing another retired name is a chain nobody resolves.
    err(`${at}: alias-of-alias, ${at} -> ${target.name} -> ${target.aliasOf}; collapse into one hop`);
  }
  if ((target.requires ?? []).includes(skill.name) || (skill.requires ?? []).includes(target.name)) {
    err(`${at}: alias target ${target.name} and the alias require each other`);
  }
}

function checkVariants(at, skill, index, err) {
  const variants = skill.variants ?? [];
  if (variants.length === 0) return;

  const ids = new Set();
  const parentStack = new Set(skill.stack ?? []);
  for (const variant of variants) {
    if (!variant.id) err(`${at}: a variant is missing its id`);
    if (ids.has(variant.id)) err(`${at}: duplicate variant id "${variant.id}"`);
    ids.add(variant.id);

    checkStack(`${at}#${variant.id}`, variant.stack, err);

    // A variant the parent does not admit could still be selected, because the
    // parent stack is what gates the node.
    for (const tag of variant.stack ?? []) {
      if (!parentStack.has(tag)) {
        err(`${at}#${variant.id}: stack tag "${tag}" is not in the parent node's stack`);
      }
    }
    if (typeof variant.bytes !== 'number') {
      err(`${at}#${variant.id}: missing bytes`);
    } else if (variant.bytes > (skill.bytes ?? 0)) {
      err(`${at}#${variant.id}: bytes ${variant.bytes} exceeds the node total ${skill.bytes}`);
    }
  }
  if (variants.length > 1) {
    const signatures = new Set(variants.map((v) => (v.stack ?? []).join(',')));
    if (signatures.size < variants.length) {
      err(`${at}: variants are not discriminated by stack (two have an identical stack)`);
    }
  }
}

function checkSources(at, skill, err, warn) {
  const sources = skill.sources ?? [];
  if (sources.length === 0) {
    // The registry is a description of reality; a skill with no source is a
    // claim with nothing behind it.
    err(`${at}: no sources; every skill must point at the file it came from`);
    return;
  }
  // Validate the shape of every source before interpreting any of them, so a
  // typo produces one actionable error instead of a second confusing complaint.
  let shapeOk = true;
  for (const source of sources) {
    if (!VALID_ROLES.has(source.role)) {
      err(`${at}: source ${source.repo}/${source.path} has invalid role "${source.role}" (expected one of ${[...VALID_ROLES].join(', ')})`);
      shapeOk = false;
    }
    if (!source.repo || !source.path) {
      err(`${at}: a source is missing repo or path`);
      shapeOk = false;
    }
    if (typeof source.bytes !== 'number') {
      err(`${at}: source ${source.repo}/${source.path} is missing bytes`);
      shapeOk = false;
    }
  }
  if (!shapeOk) return;
  // Reject unknown roles before counting them, so a typo produces one actionable
  // error instead of a second confusing complaint about the canonical count.
  const roleNames = sources.map((s) => s.role).filter((r) => VALID_ROLES.has(r));
  if (roleNames.length !== sources.length) return;

  const canonical = sources.filter((s) => s.role === 'canonical');
  if (canonical.length > 1) {
    err(`${at}: expected at most 1 canonical source, found ${canonical.length}`);
  }
  // A retired alias has no canonical source of its own: it delegates to its
  // target. Requiring one would force a fake canonical entry onto a node whose
  // whole purpose is to point elsewhere. What it must have instead is at least
  // one source, so the alias is traceable to the file it was retired from.
  if (canonical.length === 0 && !skill.aliasOf) {
    err(`${at}: no canonical source; exactly one is required unless the node is an aliasOf another skill`);
  }
for (const duplicate of duplicates(sources.map((s) => `${s.repo}/${s.path}`))) {
    warn(`${at}: declares the same source path twice (${duplicate})`);
  }
}

/** Compare declared sizes against the filesystem. */
async function lintSourcesOnDisk(registry, workspaceRoot) {
  const errors = [];
  const warnings = [];

  for (const skill of registry.skills ?? []) {
    for (const source of skill.sources ?? []) {
      const at = `${skill.name}: ${source.repo}/${source.path}`;
      if (!source.repo || !source.path) continue;
      const full = join(workspaceRoot, source.repo, source.path);

      let measured;
      try {
        measured = await measureSkill(full);
      } catch (error) {
        errors.push(`${at}: ${error.code ?? error.message} (registry points at a path that does not exist)`);
        continue;
      }
      if (typeof source.bytes === 'number' && source.bytes !== measured.bytes) {
        // The delta is computed here, not in `measureSkill`: that function measures
        // one path and knows nothing about the declaration it is being compared with.
        const delta = measured.bytes - source.bytes;
        errors.push(
          `${at}: declared ${source.bytes} bytes, on disk ${measured.bytes} (${delta > 0 ? '+' : ''}${delta})`,
        );
      }
      if (!source.bytes) warnings.push(`${at}: no declared bytes to compare against`);
    }
  }
  return { errors, warnings };
}

/**
 * SKILL.md plus every file beneath the skill directory.
 * Handles both layouts: a directory containing SKILL.md, and the flat
 * `skills/<name>.md` form one repository still uses (ADR-009 says that will be
 * wrapped, so lint reports it rather than accepting it silently).
 */
export async function measureSkill(full) {
  const info = await stat(full);

  if (info.isFile()) {
    const bytes = (await readFile(full)).byteLength;
    return { bytes, files: 1, flat: true };
  }
  if (!info.isDirectory()) {
    throw Object.assign(new Error(`${full} is neither a file nor a directory`), { code: 'NOT_A_SKILL' });
  }

  let bytes = 0;
  let files = 0;
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      const data = await readFile(child);
      bytes += data.byteLength;
      files += 1;
    }
  };
  await walk(full);

  // Confirm the entry point exists, because a directory of reference files
  // without SKILL.md is not a skill.
  //
  // `flat` means one thing only: this entry has no SKILL.md to read. It is NOT
  // "has a .md file sitting beside SKILL.md" - a `checklist.md` reference in the
  // same directory is a reference, and treating it as a flat layout made install
  // try to readFile() a directory.
  let hasEntry = false;
  try {
    await stat(join(full, 'SKILL.md'));
    hasEntry = true;
  } catch {
    hasEntry = false;
  }
  if (!hasEntry) {
    const md = files === 1 ? '' : '';
    throw Object.assign(new Error(`${full} has no SKILL.md entry point${md}`), { code: 'NO_SKILL_MD' });
  }

  return { bytes, files, flat: false };
}

function duplicates(list) {
  const seen = new Set();
  const dupes = new Set();
  for (const item of list) {
    if (seen.has(item)) dupes.add(item);
    seen.add(item);
  }
  return [...dupes];
}