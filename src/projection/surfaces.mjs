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
//      (one repository's `CLAUDE.md` is byte-identical to its `AGENTS.md`), and
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
//      derived from `rules/mdc/*.mdc` and `simt check` compares each against
//      that same derivation, they are not duplication, they are a build output.
//      The difference from that duplicate is that nobody can hand-edit one
//      and have it survive a sync.
//
//   3. AN ALWAYS-ON RULE EMITS NO SCOPING FRONTMATTER. Claude Code's `paths:` key
//      has a documented parser defect — quoted values and YAML sequences
//      silently fail to lazy-load (anthropics/claude-code#13905, #17204,
//      #19377), and the documented examples are not valid YAML. Every rule
//      shipped here is always-on, so the key would buy nothing and cost a
//      silent-failure surface. Absence of frontmatter is documented to load
//      eagerly, which is exactly what is wanted. (S50 ruled on this: a rule
//      that carries a scope is emitted ONLY for surfaces whose scoping key is
//      documented and parsed correctly, and Claude is not one of them, which
//      is why `canScope` below excludes it rather than trusting `documentedKeys`
//      to carry the reason.)
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
 * `readsAgentsMd` is a vendor fact, in three values rather than two:
 *   - `all`   every reader this row names loads AGENTS.md
 *   - `some`  some of them do, and `readsAgentsMdNote` says which
 *   - `none`  none does, so the row is the only channel its readers have
 *
 * It is not `readsPrimary`, which asks a different question: that one is about
 * whether a per-rule file would duplicate text the region already carries, and it is
 * only meaningful while folding is on. This one is about the FILE, and it is what
 * decides whether a new harness needs a row at all - a harness that reads AGENTS.md
 * is supported by the standard surface, whatever else it reads.
 *
 * `configDirs` are the directories whose presence implies the harness is in use.
 * Detection reads them and claims nothing else: a directory a harness may create for
 * other reasons is a presence, not a proof, and the command says "present", never
 * "installed".
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
      'OpenCode v2, and AGENTS.md is also read natively by Codex, Cursor, Windsurf, Zed, Amp, Jules, Copilot CLI and the DeepSeek harness; Claude Code falls back to it, Antigravity and Gemini CLI accept GEMINI.md as an equal name',
    primary: 'AGENTS.md',
    kind: 'region',
    // OpenCode v2 documents no per-rule directory. It reads AGENTS.md only — every
    // file from the workspace up to the project root, combined — and it does not fall
    // back to CLAUDE.md. So `foldRules`: this surface carries every rule inside the
    // one generated region, and the other rows are how a rule reaches an editor that
    // cannot read AGENTS.md. Writing .opencode/rules/*.md would be a guess, and a
    // guessed path is the failure this table exists to prevent.
    rule: null,
    foldRules: true,
    readsAgentsMd: 'all',
    configDirs: ['.opencode'],
    skills: '.agents/skills',
    documentedSkillsPaths: ['.opencode/skills', '.claude/skills', '.agents/skills'],
    // Codex concatenates AGENTS.md from the root down and stops at
    // project_doc_max_bytes. The default is 32 KiB. A region that ends past it is
    // never read, and nothing else in check notices. Other readers of this file
    // publish no such limit.
    readLimits: [
      {
        reader: 'Codex',
        bytes: 32768,
        verified: 'Codex project_doc_max_bytes defaults to 32 KiB',
      },
    ],
    verified:
      'OpenCode v2 instructions and skills docs (opencode.ai/v2/docs, read 2026-10-14) — AGENTS.md only, combined from the workspace up to the project root; CLAUDE.md is not a fallback; skills at .opencode/skills/, .claude/skills/ and .agents/skills/<name>/SKILL.md, with the model shown name and description',
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
    readsAgentsMd: 'all',
    configDirs: ['.cursor'],
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
    // Filled into a substitution only when every selected surface names the same
    // value. One body is written for all of them, so a Cursor name must not land
    // in a file Claude Code also reads.
    substitutions: { askTool: 'Use the interactive `AskQuestion` tool' },
    ruleFrontmatter: (rule) => [
      `description: ${rule.description ?? `Canonical ${rule.id} rule managed by simt-dev`}`,
      // `globs` only appears when the rule declares a scope. Cursor attaches a rule
      // with no globs on the strength of `alwaysApply` alone, so emitting either
      // unquoted patterns on an eager rule or no globs at all on a scoped one is
      // asking for the wrong loading behaviour.
      ...(rule.scope ? [`globs: ${rule.scope.map((g) => `"${g}"`).join(', ')}`] : []),
      `alwaysApply: ${rule.alwaysApply ? 'true' : 'false'}`,
    ],
    verified:
      'Cursor project rules (.cursor/rules/*.mdc, description + alwaysApply + globs); alwaysApply: false with globs is "auto-attached when a matching file is in context", and the docs warn that alwaysApply: false with no description is manual @-mention only',
    note: 'The only surface that reads `.mdc`. Every other row here is a plain `.md` or a symlink.',
  },
  {
    id: 'claude',
    label: 'Claude Code rules',
    readers: 'Claude Code',
    primary: null,
    kind: 'file',
    rule: '.claude/rules/{name}.md',
    // `some`, not `none`. It reads AGENTS.md - the same docs say CLAUDE.md is used only
    // when no AGENTS.md exists - but only on that condition, so a repository that has a
    // hand-written CLAUDE.md is read by neither. That is why this row still needs its
    // own channel and a pointer: the fallback is not a channel, it is the absence of
    // one, and a reader who relied on it would be relying on the reader deleting a
    // file they wrote.
    readsAgentsMd: 'some',
    readsAgentsMdNote:
      'CLAUDE.md is read first; AGENTS.md is read only when there is no CLAUDE.md, which is why the pointer exists',
    configDirs: ['.claude'],
    // Intentionally no `paths:`. See decision 3 in the header.
    documentedKeys: ['paths', 'description'],
    ruleFrontmatter: () => [],
    // The claude-md pointer makes CLAUDE.md a symlink to AGENTS.md (ADR-021 ruling 1),
    // and Claude reads CLAUDE.md in preference to AGENTS.md. So the folded region
    // arrives through the pointer and a rule file alongside it is the same text twice.
    readsPrimary: true,
    substitutions: { askTool: 'Use the interactive `AskUserQuestion` tool' },
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
    readsAgentsMd: 'all',
    configDirs: ['.agents'],
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
      // `trigger: glob` carries the patterns, and they are quoted because YAML reads a
      // value starting with `*` as an alias anchor — the Antigravity docs require it, and
      // an invalid frontmatter block is discarded with no message at all.
      `trigger: ${rule.scope ? 'glob' : rule.alwaysApply ? 'always_on' : 'model_decision'}`,
      ...(rule.scope ? [`globs: ${rule.scope.map((g) => `"${g}"`).join(', ')}`] : []),
      `description: ${rule.description ?? `Canonical ${rule.id} rule managed by simt-dev`}`,
    ],
    verified:
      'Google Antigravity docs, "Rules" — .agents/rules/*.md, YAML frontmatter with trigger: always_on | model_decision | glob | manual; missing or invalid frontmatter silently discards the rule; trigger: glob takes comma-separated globs, which the docs require to be quoted so YAML does not read a leading * as an alias anchor; a 24 KB per-file limit and a 20,000-token budget for always_on rules, with automatic demotion to pointers past it',
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
    // Copilot is why the column is three values and not two. Its CLI reads AGENTS.md
    // and its editor and code review do not, so the row both needs its own channel and
    // cannot be described as "reads AGENTS.md" without a reader reading that claim as
    // "this repo is covered for Copilot", which for two of its three readers it is not.
    readsAgentsMd: 'some',
    readsAgentsMdNote:
      'Copilot CLI reads AGENTS.md; the editor, code review and the cloud agent do not',
    configDirs: ['.github'],
    documentedKeys: ['applyTo', 'excludeAgent'],
    ruleFrontmatter: (rule) => [`applyTo: ${rule.scope ? `"${rule.scope.join(',')}"` : '"**"'}`],
    verified:
      'GitHub docs, "Adding repository custom instructions" — .github/instructions/NAME.instructions.md with applyTo globs; `applyTo: "**"` is the documented example, and a comma-separated pattern list is how more than one is named',
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
      'Google Antigravity docs, "Rules": workspace rules are AGENTS.md or GEMINI.md in the root or any subdirectory; Copilot CLI also discovers GEMINI.md. ' +
      'Gemini CLI, read today: its own docs (core memory index, and the configuration reference) say the memory service loads GEMINI.md hierarchically from the working directory up to the project root and the home directory and also into subdirectories, and that `context.fileName` in settings.json "accepts either a single string or an array of strings" naming the context file(s) to load, default undefined',
    note:
      'Covers Gemini CLI and gives Antigravity a second, equally-native name for the same file. ' +
      'A repository can also point Gemini CLI at AGENTS.md itself with `context.fileName: ["AGENTS.md"]` and need no pointer at all, ' +
      'which is the reason there is no separate Gemini CLI row here: this pointer and a native row would be two ways to hand one reader the same rule.',
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
 * Whether this surface can load a rule only when a matching file is in play.
 *
 * Three do, and each for its own documented key: Cursor patterns with `globs` under
 * `alwaysApply: false`, Copilot with `applyTo`, and Antigravity with `trigger: glob`
 * plus `globs`. Claude Code does not — its `paths:` key has a documented parser
 * defect in which quoted values and YAML sequences silently fail to lazy-load — and
 * opencode cannot, because it has no per-rule file channel at all.
 *
 * The question is asked per surface rather than per key because the answer decides
 * whether a scoped profile may leave the region: a profile written only as a scoped
 * file would be absent from a reader that cannot scope it, and a rule nobody loads is
 * worse than a rule that loads eagerly (ADR-071).
 */
export function canScope(surface) {
  return surface.rule !== null && surface.rule !== undefined && SCOPE_KEYS.has(surface.id);
}

/** Surface ids whose scoping key was read in the vendor's own documentation. */
const SCOPE_KEYS = new Set(['cursor', 'antigravity', 'copilot']);

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
 * Config directories whose presence implies a harness is in use, for the ones this
 * tool has no surface row for.
 *
 * Deliberately a list of DIRECTORY NAMES and nothing else. It carries no claim about
 * what any of these readers loads: the review that proposed the command listed these
 * harnesses as candidates and explicitly did not re-verify each vendor's current
 * documentation, and a row built from that list would ship a `verified` field citing
 * nothing — decoration that misdescribes the artefact, which is the failure this whole
 * repository exists to prevent. A directory here means "a reader may be configured in
 * this repository", never "this harness is installed" and never "its rules are not
 * being loaded".
 *
 * The exception that proves the rule is `.gemini`: R42 read Gemini CLI's
 * configuration docs, so its entry carries readsAgentsMd and a `verified` the same way
 * a surface row does. Everyone else stays a bare name until somebody reads their
 * vendor pages — the bar for facts here is a document, not an ML search snippet, and
 * that bar is what keeps this list honest as harnesses come and go.
 *
 * `.github` is absent even though the Copilot row carries it: `.github` holds workflows
 * and issues, so its presence says nothing about whether Copilot is used, and the
 * Copilot row's own detection is not something this command is for.
 */
export const CANDIDATE_DIRS = [
  {
    // The one candidate with verified facts (R42): Gemini CLI's configuration reference
    // was live and read on 2026-10-26, so presence now carries provenance instead of
    // the default "a reader may be configured here". AGENTS.md is loaded only when
    // settings.json `context.fileName` names it - the context file is GEMINI.md
    // otherwise - so the fact is "some", which here means one reader under
    // configuration, and the note says exactly that.
    dir: '.gemini',
    harness: 'Gemini CLI',
    readsAgentsMd: 'some',
    readsAgentsMdNote: 'AGENTS.md is loaded only when settings.json context.fileName names it; the context file is GEMINI.md otherwise',
    verified: 'Gemini CLI configuration docs (geminicli.com/docs/reference/configuration/, read 2026-10-26) — a .gemini directory holds the project settings.json, and the reader loads GEMINI.md unless context.fileName renames it',
  },
  { dir: '.windsurf', harness: 'Windsurf' },
  { dir: '.zed', harness: 'Zed' },
  { dir: '.kiro', harness: 'Kiro' },
  { dir: '.cline', harness: 'Cline' },
  { dir: '.roo', harness: 'Roo Code' },
  { dir: '.junie', harness: 'Junie' },
  { dir: '.aider', harness: 'Aider' },
  { dir: '.continue', harness: 'Continue' },
  { dir: '.amp', harness: 'Amp' },
  { dir: '.goose', harness: 'Goose' },
  // Home directory, seen only with `harness detect --user`. DeepSeek keeps user data
  // under ~/.dsh and reads the repository's AGENTS.md; it has no project config
  // directory and no per-rule file to project (ADR-067).
  {
    dir: '.dsh',
    harness: 'DeepSeek harness',
    readsAgentsMd: 'all',
    verified:
      'DeepSeek harness agent-instructions docs (read 2026-10-14): user data lives at $DSH_HOME or ~/.dsh, and the project chain is AGENTS.md',
  },
];

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
    // Both shapes, because a scoping key is emitted only on the scoped shape: probing
    // the eager one alone would pass a row that drops `globs` on a scoped rule, and the
    // rule would then load on nothing.
    const probes = [
      { id: 'probe', description: 'probe', alwaysApply: true },
      { id: 'probe', description: 'probe', alwaysApply: false, scope: ['src/**'] },
    ];
    for (const rule of probes) {
      for (const line of s.ruleFrontmatter(rule)) {
        const key = String(line).split(':')[0].trim();
        // One report per key, not per probe: the same invented key appears on both
        // shapes, and a gate that prints it twice reads as two defects.
        if (documented.includes(key) || bad.some((b) => b.includes(`key "${key}"`))) continue;
        bad.push(
          `${s.id} emits frontmatter key "${key}"; its vendor documents ${documented.join(', ') || '(nothing)'}`,
        );
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
