// Which editor a repo's rules are projected into, and why.
//
// simt-dev used to write exactly two things into a consumer repo: a region in
// `AGENTS.md`, and `.cursor/rules/*.mdc`. That is support for two IDEs, one of
// which is the only reader of the `.mdc` extension. A Claude Code user, a Copilot
// user and an Antigravity user in an adopted repo received `AGENTS.md` — the core
// and stack rules — and **none** of the three always-on process rules, because
// those lived only in a directory only Cursor reads. "Supported" was true of the
// file format and false of the estate.
//
// This module is the named surface: each row is one editor, the path its rules
// take, the frontmatter keys it understands, and the document the row was checked
// against. Nothing here is inferred from the ecosystem; a surface is a fact about
// a vendor, and it was read, not guessed.
//
// FOUR DECISIONS, each with a cost.
//
//   1. A POINTER IS NOT A COPY. `CLAUDE.md` and `GEMINI.md` are symlinks to
//      `AGENTS.md`. A copy is the corpus's one true content duplicate
//      (bunnyland-server's `CLAUDE.md` is byte-identical to its `AGENTS.md`), and
//      the DeepSeek harness explicitly rejects loading both in one directory
//      because "repositories in transition commonly duplicate guidance" — and
//      *its* dedup is content-based, so a symlink collapses to one while a
//      drifted copy loads in full beside its twin. Both vendors document the
//      symlink. POSIX-only symlinks are already in scope under ADR-012.
//
//   2. THE PER-RULE SURFACES ARE GENERATED FILES, NOT SYMLINKS, because symlink
//      support is documented for only one of them. Claude Code states that
//      `.claude/rules/` supports symlinks. Nothing states that for
//      `.agents/rules/` or `.github/instructions/`, and a symlink into a
//      directory whose reader's symlink behaviour is unverified is a guess with a
//      mode bit. So those get machine-written copies — and because every byte is
//      derived from `rules/mdc/*.mdc` and `simt-dev check` compares each against
//      that same derivation, they are not duplication, they are a build output.
//      The difference from bunnyland's duplicate is that nobody can hand-edit one
//      and have it survive a sync.
//
//   3. AN ALWAYS-ON RULE EMITS NO SCOPING FRONTMATTER. Claude Code's `paths:` key
//      has a documented parser defect — quoted values and YAML sequences
//      silently fail to lazy-load (anthropics/claude-code#13905, #17204,
//      #19377), and the documented examples are not valid YAML. Every rule
//      shipped here is always-on, so the key would buy nothing and cost a
//      silent-failure surface. Absence of frontmatter is documented to load
//      eagerly, which is exactly what is wanted.
//
//   4. `verified` IS THE POINT OF THE TABLE. A row whose `verified` is null was
//      not checked against a vendor document, and the row says so where a reader
//      can see it. A surface list that silently grew a guessed row would put an
//      unverified assumption into every repo that adopted it, which is the exact
//      failure this table exists to prevent.

/**
 * Surfaces, in the order the writer emits them.
 *
 * `kind`:
 *   - `region`  a generated region inside a file the repo may also write by hand
 *   - `file`    a wholly generated file; hand-written body text is retired
 *   - `pointer` a symlink to the primary target; carries no content of its own
 *
 * `ruleFrontmatter` returns the keys that editor reads BEFORE any rule text. A
 * surface that needs none returns '' and the projected file starts at the body.
 */
export const SURFACES = [
  {
    // THE STANDARD SURFACE. One repo, one editor, one file — unless the agent or the
    // repo's owner names another. This row exists because "write a file for every IDE
    // we know" is not support: it gives a repo that lives in opencode three rule
    // directories and two symlinks it will never open, and it means every rule change
    // lands in four places instead of one. ADR-020 wrote all four; ADR-021 writes one
    // and asks.
    id: 'opencode',
    label: 'opencode (AGENTS.md + .agents/skills)',
    readers:
      'opencode, and AGENTS.md is also read natively by Codex, Cursor, Windsurf, Zed, Amp, Jules, Copilot CLI and the DeepSeek harness; Claude Code falls back to it, Antigravity and Gemini CLI accept GEMINI.md as an equal name',
    primary: 'AGENTS.md',
    kind: 'region',
    // opencode documents NO per-rule directory: it reads AGENTS.md (walking up to the
    // git worktree), CLAUDE.md only as a fallback, and .opencode/AGENTS.md in
    // addition. So `foldRules` — this surface carries every rule inside the one
    // generated region, and the other rows are how a rule reaches an editor that
    // cannot read AGENTS.md. Writing .opencode/rules/*.md would be a guess, and a
    // guessed path is the failure this table exists to prevent.
    rule: null,
    foldRules: true,
    skills: '.agents/skills',
    documentedSkillsPaths: ['.opencode/skills', '.claude/skills', '.agents/skills'],
    verified:
      'opencode docs, "Rules" and "Agent Skills" (read 2026-10-07) — AGENTS.md walked up from cwd to the git worktree; CLAUDE.md used only if no AGENTS.md exists; .opencode/AGENTS.md additionally; skills at .opencode/skills/, .claude/skills/ and .agents/skills/<name>/SKILL.md; skill frontmatter recognises only name, description, license, compatibility, metadata',
    note:
      '.agents/skills is one of the three skill locations opencode documents, so the same directory serves the standard surface without a symlink.',
  },
  {
    id: 'cursor',
    label: 'Cursor rules',
    readers: 'Cursor',
    primary: null,
    kind: 'file',
    rule: '.cursor/rules/{name}.mdc',
    // `documentedKeys` is the set the vendor's own docs name for this surface, and
    // `ruleFrontmatter` must emit nothing outside it. A key invented here would be
    // inert at best; on Antigravity an unrecognised value silently discards the
    // rule. The guard lives in test/shipped.test.mjs, and this row is its evidence.
    documentedKeys: ['description', 'alwaysApply', 'globs'],
    // ADR-021 ruled that "a Cursor reader getting .mdc files does not serve them",
    // because Cursor had no documented channel for AGENTS.md. It does, and has:
    // cursor.com/docs/context/rules calls AGENTS.md "a simple alternative to
    // .cursor/rules" and documents support in the project root and subdirectories.
    // So a folded rule reaches a Cursor reader twice - once inside the region, once
    // in the .mdc - and the second copy is 28 KB of pure repetition across the five
    // repos that select both surfaces.
    //
    // The caveat belongs here rather than in the ADR body, because it is a fact about
    // a product and products move: a Cursor bug report records AGENTS.md NOT being
    // read in worktree agents by default, fixed in 3.9. A reader below that version
    // gets the .mdc copy and a reader above it does not need it.
    readsPrimary: true,
    ruleFrontmatter: (rule) =>
      [
        `description: ${rule.description ?? `Canonical ${rule.id} rule managed by simt-dev`}`,
        `alwaysApply: ${rule.alwaysApply ? 'true' : 'false'}`,
      ],
    verified: 'Cursor project rules (.cursor/rules/*.mdc, description + alwaysApply + globs)',
    note: 'The only surface that reads `.mdc`. Every other row here is a plain `.md` or a symlink.',
  },
  {
    id: 'claude',
    label: 'Claude Code rules',
    readers: 'Claude Code',
    primary: null,
    kind: 'file',
    rule: '.claude/rules/{name}.md',
    // Intentionally no `paths:`. See decision 3 in the header.
    documentedKeys: ['paths', 'description'],
    ruleFrontmatter: () => [],
    // The claude-md pointer makes CLAUDE.md a symlink to AGENTS.md (ADR-021 ruling 1),
    // and Claude reads CLAUDE.md in preference to AGENTS.md. So the folded region
    // arrives through the pointer and a rule file alongside it is the same text twice.
    readsPrimary: true,
    verified: 'Claude Code, "Organize rules with .claude/rules/" — recursive discovery, symlinks supported, no `paths` loads at session start',
    note:
      'CLAUDE.md is a separate pointer surface (see POINTERS). A rule file without frontmatter loads eagerly, which is what an always-on rule wants.',
  },
  {
    id: 'antigravity',
    label: 'Antigravity workspace rules',
    readers: 'Antigravity IDE, Antigravity CLI',
    primary: null,
    kind: 'file',
    rule: '.agents/rules/{name}.md',
    // `trigger` is REQUIRED here and an unrecognised value discards the rule with no
    // message, which is why the value is mapped rather than passed through.
    documentedKeys: ['trigger', 'description', 'globs', 'glob'],
    // The gemini-md pointer's own `verified` cites the same Antigravity docs: "workspace
    // rules are AGENTS.md or GEMINI.md in the root or any subdirectory". Either name
    // reaches the reader, so a .agents/rules file repeats text the region already
    // carries. Both channels are documented as alternatives to each other, which is
    // what makes them duplicates rather than a fallback.
    readsPrimary: true,
    ruleFrontmatter: (rule) => [
      `trigger: ${rule.alwaysApply ? 'always_on' : 'model_decision'}`,
      `description: ${rule.description ?? `Canonical ${rule.id} rule managed by simt-dev`}`,
    ],
    verified: 'Google Antigravity docs, "Rules" — .agents/rules/*.md, YAML frontmatter with trigger: always_on | model_decision | glob | manual; missing or invalid frontmatter silently discards the rule',
    note:
      'This is why frontmatter is mandatory here and why the trigger value is not guessed: an unrecognised trigger means the rule is dropped with no message.',
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot instructions',
    readers: 'GitHub Copilot chat, Copilot CLI, Copilot code review, Copilot cloud agent',
    primary: null,
    kind: 'file',
    rule: '.github/instructions/{name}.instructions.md',
    documentedKeys: ['applyTo', 'excludeAgent'],
    ruleFrontmatter: () => ['applyTo: "**"'],
    verified:
      'GitHub docs, "Adding repository custom instructions" — .github/instructions/NAME.instructions.md with applyTo globs; `applyTo: "**"` is the documented example',
    // NOT marked readsPrimary, and this row is the reason the flag is per-surface
    // rather than global. The reader is split: Copilot CLI reads AGENTS.md, the
    // editor and code review do not. A per-rule file here is not duplication for two
    // of the three, and dropping it would remove the process rules from a chat that
    // had no other channel to them.
    note:
      'Copilot reads AGENTS.md itself through Copilot CLI, but the editor and code review do not; this is the channel they use.',
  },
];

/**
 * Pointers: files that must exist and must carry no content.
 *
 * A pointer is the cheapest possible answer to an editor that wants its own
 * filename, and the only one that cannot rot: a stale pointer is a broken symlink
 * that fails loudly, whereas a stale copy is a file full of confidently wrong
 * rules that nobody notices for a release.
 */
export const POINTERS = [
  {
    id: 'claude-md',
    // A pointer belongs to the surface that needs it, never to every repo.
    // ADR-020 wrote both of these unconditionally, which meant that narrowing to
    // one surface under ADR-021 still created a CLAUDE.md nobody asked for — the
    // same over-writing that ruling set out to stop, one file down.
    surface: 'claude',
    path: 'CLAUDE.md',
    to: 'AGENTS.md',
    readers: 'Claude Code',
    verified:
      'Claude Code memory docs: "A symlink also works" — `ln -s AGENTS.md CLAUDE.md`; Claude reads CLAUDE.md by default and AGENTS.md only as a fallback',
    note:
      'Claude Code reads CLAUDE.md and ignores AGENTS.md when both exist. A pointer is what makes one file answer for both without a second copy.',
  },
  {
    id: 'gemini-md',
    surface: 'antigravity',
    path: 'GEMINI.md',
    to: 'AGENTS.md',
    readers: 'Gemini CLI, Antigravity',
    verified:
      'Google Antigravity docs, "Rules": workspace rules are AGENTS.md or GEMINI.md in the root or any subdirectory; Copilot CLI also discovers GEMINI.md',
    note: 'Covers Gemini CLI and gives Antigravity a second, equally-native name for the same file.',
  },
];

/**
 * The global standard: what a repo gets when it has not chosen.
 *
 * ONE surface, not all of them. ADR-020 made the default the union of every
 * verified surface, on the reasoning that writing nothing leaves editors
 * unsupported. It over-corrected: a repo that lives in one editor acquired four
 * rule directories and two symlinks, and every rule change landed four times.
 * "Support every known editor" is satisfied by *knowing how to* write each one and
 * writing the one that was asked for.
 *
 * The standard is opencode, because it is the agent simt-dev is developed against
 * and its paths (`AGENTS.md`, `.agents/skills/`) are the ones this workspace already
 * uses. `AGENTS.md` is the widest-reaching filename in the table: seven of the eight
 * readers listed on that row read it natively, so the default is not a private
 * choice — it is the file most editors already read.
 *
 * A repo narrows or changes it by declaring `"surfaces"` in simt-dev.json, and the
 * agent can be asked for a specific one with `--surfaces`. Declaring an empty list is
 * a real choice and means AGENTS.md with no per-rule files and no pointers.
 */
export const DEFAULT_SURFACES = ['opencode'];

/**
 * True when every selected surface carries its rules inside the primary region
 * rather than in per-rule files.
 *
 * ANY selected surface that folds is enough. Asking "does the whole set fold?" would
 * be wrong the moment a repo adds a second surface: opencode's only channel is
 * AGENTS.md, so a reader in opencode still needs the rules in the region even when a
 * Cursor reader gets them as `.mdc`. Folding and per-rule files therefore coexist,
 * and `ruleTargets` already skips a surface that has no rule path.
 *
 * Asked in exactly two places that must agree: `desiredRegion` folds the bodies in,
 * and `mdcTargets` writes the files. Asking it twice is how ADR-020's fold decision
 * could drift between the writer and the gate, which is the step-6 failure.
 */
export function foldsRules(resolved) {
  return resolved.surfaces.some((s) => s.foldRules === true);
}

/**
 * Surfaces whose reader already loads the primary document, so a per-rule file for
 * them repeats text the region already carries.
 *
 * Only meaningful when folding is on: with no folding there is no region to duplicate.
 * That condition is why this is not a property of the surface alone, and why the
 * callers ask both questions rather than this function answering both.
 *
 * Per-surface rather than global, because Copilot is the counter-example: its CLI reads
 * AGENTS.md and its editor and code review do not, so a per-rule file there is the only
 * channel two of its three readers have.
 */
export function readsPrimary(resolved) {
  return foldsRules(resolved) && resolved.surfaces.some((s) => s.readsPrimary === true);
}

export const SURFACE_IDS = SURFACES.map((s) => s.id);

/**
 * Frontmatter keys a surface emits that its own vendor does not document.
 *
 * Returns one message per offender. Lives here rather than in a test so that the
 * shipped-content gate and the surface table cannot drift apart: the gate asks this
 * question, and so can anyone who wants to add a row.
 *
 * Two failure modes it must catch, both silent at the far end. A key an editor does
 * not read is inert — the rule loads with its scoping ignored. A *value* an editor
 * does not recognise is worse: Antigravity's documented behaviour for an
 * unrecognised `trigger` is to discard the rule with no message, so the repo looks
 * configured and is not.
 */
export function undocumentedKeys(surfaceRows = SURFACES) {
  const bad = [];
  for (const s of surfaceRows) {
    if (!s.ruleFrontmatter) continue;
    const documented = Array.isArray(s.documentedKeys) ? s.documentedKeys : [];
    for (const line of s.ruleFrontmatter({ id: 'probe', description: 'probe', alwaysApply: true })) {
      const key = String(line).split(':')[0].trim();
      if (!documented.includes(key)) {
        bad.push(`${s.id} emits frontmatter key "${key}"; its vendor documents ${documented.join(', ') || '(nothing)'}`);
      }
    }
  }
  return bad;
}

/** Surface `id` or null. */
export function surface(id) {
  return SURFACES.find((s) => s.id === id) ?? null;
}

/** The absolute-ish path a rule takes on a surface, given the rule's bare name. */
/** Assemble YAML frontmatter lines into a block. Lives here because this is the
 *  lowest module that owns frontmatter: surfaces.mjs imports nothing, so both
 *  the `.mdc` renderer and the per-surface projector can share one implementation
 *  without either importing the other. Two copies of these four lines is the
 *  "third copy of the same logic is a defect" case with a third-copy count of two. */
export function frontmatterBlock(lines) {
  if (lines.length === 0) return '';
  return ['---', ...lines, '---'].join('\n');
}

export function rulePath(surfaceId, name) {
  const s = surface(surfaceId);
  if (!s || !s.rule) return null;
  return s.rule.replace('{name}', name);
}

/**
 * Which surfaces this repo projects to, and why it chose them.
 *
 * Precedence is flag, then manifest, then the global standard. Reported as
 * `source` because an invisible configuration is a configuration nobody can
 * debug — the same ruling as ADR-014 for the workspace.
 *
 * An unknown id is reported rather than skipped: a typo in `"surfaces"` would
 * otherwise silently reduce the estate to AGENTS.md, and a repo that believes it
 * is covered by Copilot instructions would not be.
 */
export function resolveSurfaces(manifest, flags = {}) {
  const problems = [];
  let ids = null;
  let source = 'default';

  if (typeof flags.surfaces === 'string') {
    ids = flags.surfaces.split(',').map((s) => s.trim()).filter(Boolean);
    source = 'flag';
  } else if (manifest && Array.isArray(manifest.surfaces)) {
    ids = manifest.surfaces.filter((s) => typeof s === 'string');
    source = 'manifest';
  } else {
    ids = [...DEFAULT_SURFACES];
  }

  const seen = new Set();
  const chosen = [];
  for (const id of ids) {
    if (!surface(id)) {
      problems.push(`unknown surface "${id}"; known: ${SURFACE_IDS.join(', ')}`);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    chosen.push(surface(id));
  }
  return { surfaces: chosen, ids: chosen.map((s) => s.id), source, problems };
}

/** One line a reader can check: what this repo gets, and why.
 *
 * `width` exists because the two renderers disagree — `init` pads its header to 12
 * columns and `sync` to 8 — and a value column that does not line up with the
 * lines above it reads as a different kind of thing, which is exactly the kind of
 * small wrongness that makes people stop reading output carefully. */
export function surfacesLine(result, width = 12) {
  const where = result.source === 'default' ? 'global standard' : result.source;
  const ids = result.ids.length === 0 ? '(AGENTS.md only)' : result.ids.join(', ');
  return `${'surfaces'.padEnd(width)}${ids}  (${where})`;
}
