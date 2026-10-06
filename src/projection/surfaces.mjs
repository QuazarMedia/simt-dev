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
    id: 'agents',
    label: 'AGENTS.md (the de facto standard)',
    readers: 'Codex, opencode, Claude Code (as fallback), Cursor, Copilot CLI, Antigravity, DeepSeek harness',
    primary: 'AGENTS.md',
    kind: 'region',
    // No `rule` path: this surface is the primary document, not a per-rule
    // directory, and the region lives inside it once.
    rule: null,
    verified: 'agents.md convention, read across the vendor docs listed on each row below',
    note:
      'Every other surface is either a second copy of this one or a per-rule file derived from the same canonical rule.',
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
 * This is a list, not a rule. "Support every known IDE" cannot be satisfied by
 * always writing everything — a repo that deliberately uses one tool should not
 * acquire three rule directories and two symlinks it will never read. It also
 * cannot be satisfied by writing nothing, which is what happens today.
 *
 * So the default is the union of what was verified against a vendor document, and
 * a repo narrows it by declaring `"surfaces"` in simt-dev.json. The manifest is
 * the choice; this is the answer when there has not been one. Declaring an empty
 * list is a real choice and means AGENTS.md only.
 */
export const DEFAULT_SURFACES = SURFACES.filter((s) => s.id !== 'agents').map((s) => s.id);

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
