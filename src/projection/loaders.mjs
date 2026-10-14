// What each harness actually reads at session start — one row per reader, with the
// document every claim came from.
//
// `surfaces.mjs` answers "where do we WRITE a rule". That is half of a reader, and the
// half that is convenient: writing a file needs a path and nothing else. Reading one
// needs more. Claude Code concatenates every `CLAUDE.md` from the filesystem root down
// and expands `@path` imports four hops deep. Codex walks project root to cwd, takes at
// most one file per directory, and *stops adding files* once the merged chain reaches
// `project_doc_max_bytes` — so a repository can be inside the limit on every single file
// and past it as a chain. Antigravity scans `.agents/rules/` flat and ignores nested
// files. Three of those facts change what a byte count means, and none of them is in
// the surface table, which is why R06 had to be blocked on this one.
//
// WHAT THIS TABLE IS NOT. It is not a second opinion about any harness, and it does not
// re-verify `surfaces.mjs`: a path that appears here and there is one fact written twice
// because two consumers read it, not because either was guessed. `verified` is on every
// row and cites the page the row was read from, because a loader row with no provenance
// is worse than no row: it would be a number in a report that nobody can check, and
// context cost is exactly the number people will not check twice.
//
// FOUR DECISIONS, each with a cost.
//
//   1. A ROW IS A READER, NOT A PRODUCT. `claude` is Claude Code's loader; Codex and
//      opencode are separate rows even though all three read `AGENTS.md`, because they
//      disagree about what to do with a second one of anything. Keying by product would
//      force those disagreements into a field called "notes".
//
//   2. `atStart` IS A BOOLEAN, NOT A RANK. A file either is loaded before the first
//      message or it is not. `cursor` is the case that makes the alternative untenable:
//      a `.mdc` with `alwaysApply: false` costs nothing until a matching file is in
//      context, and a meter that counted it would report a cost the reader does not pay.
//      Ordering the always-on files among themselves is `order`, and it is a sentence
//      because that is what the vendor docs are.
//
//   3. A CAP IS NAMED WITH ITS SCOPE. Codex's 32 KiB applies to the *merged chain* and
//      Antigravity's 24,000 B applies to *one rule file* — a difference that decides
//      whether a finding belongs to a file or to a repository, so `cap.scope` is a
//      required field rather than a comment. A reader that publishes no cap has
//      `cap: null`, which means "checked, none found", not "not checked".
//
//   4. UNDOCUMENTED IS ITS OWN ANSWER. Copilot has no documented hooks file, and Gemini
//      CLI's own configuration reference 404s today. Those cells are `null` with a
//      `note` saying what was looked for. An empty string would read as "no hooks" and
//      an invented path would read as a fact.

/**
 * One row per reader. Ordered by how widely the reader is deployed, so a truncated
 * report loses the rows nobody could have acted on.
 *
 * `start` entries, each one a file the reader may load:
 *
 *   scope       `project` (in the repository) or `user` (in the reader's home)
 *   path        the path, relative to the repository root; `dir` entries carry the
 *               directory instead and are enumerated by `tree`
 *   tree        `single`  the named path only
 *               `chain`   root to cwd; `chainMerge: 'first'` keeps one file per
 *                         directory, `chainMerge: 'all'` keeps every candidate
 *               `flat`    immediate children of `dir` only
 *               `nested`  recursive under `dir`
 *   atStart     loaded before the first message; `false` costs nothing until a
 *               matching file or a mention pulls it in
 *   absent      the entry is skipped when any of these paths exists at the root —
 *               the documented precondition, evaluated where the vendor documents it
 *   why         one line naming the document the entry came from
 *
 * `order` is concatenation order as the vendor states it, in words.
 */
export const LOADERS = [
  {
    id: 'opencode',
    label: 'OpenCode v2',
    readers: 'OpenCode v2',
    surface: 'opencode',
    start: [
      {
        scope: 'project',
        path: 'AGENTS.md',
        tree: 'chain',
        atStart: true,
        why: 'OpenCode v2 instructions docs: every AGENTS.md from the workspace directory up to the project root is loaded and combined; V2 recognizes AGENTS.md only and does not fall back to CLAUDE.md',
      },
      {
        scope: 'user',
        path: '~/.config/opencode/AGENTS.md',
        tree: 'single',
        atStart: true,
        why: 'OpenCode v2 instructions docs: the global file is loaded first, before the project chain',
      },
      {
        scope: 'project',
        path: '.claude/skills/{name}/SKILL.md',
        tree: 'nested',
        dir: '.claude/skills',
        suffix: '/SKILL.md',
        atStart: true,
        metadata: true,
        why: 'OpenCode v2 skills docs: .claude/skills is a project compatibility source, registered before .agents/skills',
      },
      {
        scope: 'project',
        path: '.agents/skills/{name}/SKILL.md',
        tree: 'nested',
        dir: '.agents/skills',
        suffix: '/SKILL.md',
        atStart: true,
        // Frontmatter only, which is why the entry carries `metadata: true`: a skill's
        // body is opened when a reader decides it is relevant, and billing the body to
        // the session-start cost is the error this makes impossible to repeat.
        metadata: true,
        why: 'OpenCode v2 skills docs: .agents/skills is a project compatibility source; the model is shown the id, name and description, not the body',
      },
      {
        scope: 'project',
        path: '.opencode/skills/{name}/SKILL.md',
        tree: 'nested',
        dir: '.opencode/skills',
        suffix: '/SKILL.md',
        atStart: true,
        metadata: true,
        why: 'OpenCode v2 skills docs: .opencode/skills is the project source and outranks .agents/skills and .claude/skills for the same id',
      },
    ],
    alsoReads: [
      {
        what: 'AGENTS.md below the workspace',
        atStart: false,
        why: 'OpenCode v2 instructions docs: instruction files below the workspace load when the agent reads or lists that area, not at session start',
      },
      {
        what: 'opencode.json `instructions` array',
        atStart: false,
        why: 'OpenCode v2 instructions docs: the config schema accepts an instructions array, but V2 does not resolve its files, globs or URLs',
      },
    ],
    order: 'global ~/.config/opencode/AGENTS.md, then project AGENTS.md files from the workspace directory up to the project root (nearest first); files are combined, not overridden',
    cap: null,
    capNote:
      'no byte cap published for AGENTS.md; V2 accepts an instructions array and does not load it, so there is no fetch timeout to apply',
    imports: {
      syntax: null,
      depth: 0,
      why: 'OpenCode v2 instructions docs: an AGENTS.md reference to another file is not an include; V2 loads AGENTS.md files by discovery, not by @path expansion',
    },
    nested: 'cumulative up to the project root at session start; files below the workspace load when that area is read',
    skills: ['.agents/skills', '.opencode/skills', '.claude/skills'],
    hooks: {
      path: '.opencode/plugins/',
      verified:
        'OpenCode v2 plugins docs: direct .ts and .js files and immediate plugin packages are loaded from every discovered .opencode/plugins/ directory, and the plugins array in opencode.json(c)',
    },
    mcp: {
      path: 'opencode.json',
      key: 'mcp.servers',
      verified:
        'OpenCode v2 MCP servers docs: servers are named under mcp.servers; V2 does not place server names directly under mcp',
    },
    verified:
      'OpenCode v2 instructions, skills, plugins and MCP docs (opencode.ai/v2/docs, read 2026-10-14) — V2 loads AGENTS.md only, combining the global file with every project AGENTS.md from the workspace up to the project root; CLAUDE.md is not a fallback; the instructions array is accepted and not loaded; skills advertise name and description from .opencode/skills, .claude/skills and .agents/skills',
    note: 'This row is OpenCode v2. V1 read CLAUDE.md when AGENTS.md was absent and loaded the instructions array; V2 does neither, so a meter that still did would bill bytes this reader does not pay.',
  },
  {
    id: 'claude',
    label: 'Claude Code',
    readers: 'Claude Code',
    surface: 'claude',
    start: [
      {
        scope: 'project',
        path: 'CLAUDE.md',
        tree: 'chain',
        atStart: true,
        why: 'Claude Code memory docs: CLAUDE.md and CLAUDE.local.md are discovered from the working directory and every directory above it, and all discovered files are concatenated',
      },
      {
        scope: 'project',
        path: 'CLAUDE.local.md',
        tree: 'chain',
        atStart: true,
        why: 'Claude Code memory docs: CLAUDE.local.md is loaded at each level, after CLAUDE.md from that level',
      },
      {
        scope: 'project',
        path: 'AGENTS.md',
        tree: 'chain',
        atStart: true,
        absent: ['CLAUDE.md', 'CLAUDE.local.md'],
        why: 'Claude Code memory docs: AGENTS.md is read directly, but only when there is no CLAUDE.md or CLAUDE.local.md in the working directory or above it',
      },
      {
        scope: 'project',
        path: '.claude/rules/{name}.md',
        tree: 'nested',
        dir: '.claude/rules',
        suffix: '.md',
        atStart: true,
        why: 'Claude Code memory docs: project rules under .claude/rules/ are discovered recursively and loaded at session start when unscoped',
      },
      {
        scope: 'user',
        path: '~/.claude/rules/*.md',
        tree: 'flat',
        dir: '.claude/rules',
        atStart: true,
        why: 'Claude Code memory docs: user-level rules in ~/.claude/rules/ load before project rules',
      },
      {
        scope: 'project',
        path: '.claude/skills/{name}/SKILL.md',
        tree: 'nested',
        dir: '.claude/skills',
        suffix: '/SKILL.md',
        atStart: true,
        metadata: true,
        why: 'Claude Code memory docs: skills are discovered under .claude/skills',
      },
    ],
    alsoReads: [
      {
        what: 'MEMORY.md (auto memory)',
        atStart: true,
        why: 'Claude Code memory docs: auto memory loads the first 200 lines or 25 KB, whichever comes first',
      },
    ],
    order: 'filesystem root down to the working directory, CLAUDE.md before CLAUDE.local.md at each level',
    cap: {
      bytes: 4 * 1024 * 1024,
      scope: 'file',
      config: 'none — a fixed limit',
      why: 'Claude Code memory docs: "Claude Code loads a CLAUDE.md file of up to 4 MiB in full and skips a larger file"',
    },
    imports: {
      syntax: '@path',
      depth: 4,
      why: 'Claude Code memory docs: `@path/to/import` is expanded at launch, resolved relative to the importing file, to a maximum depth of four hops; parsing skips code spans and fenced blocks, `@` inside backticks is literal, quoted paths are not imported, and an import outside the working directory prompts for approval',
    },
    nested: 'on demand — a subdirectory CLAUDE.md loads when Claude reads, writes or edits a file in that directory',
    skills: ['.claude/skills'],
    hooks: {
      path: '.claude/settings.json',
      verified:
        'Claude Code hooks docs, hook locations: project settings at .claude/settings.json and .claude/settings.local.json, user settings at ~/.claude/settings.json',
    },
    mcp: {
      path: '.mcp.json',
      key: null,
      verified:
        'Claude Code MCP docs: project-scoped servers live in .mcp.json in the project root; local and user scope live in ~/.claude.json',
    },
    verified:
      'Claude Code memory docs (docs.claude.com/en/docs/claude-code/memory, read 2026-10-14) — CLAUDE.md and CLAUDE.local.md are concatenated from every directory above the working directory, subdirectory files load on demand, `@path` imports expand to four hops, a CLAUDE.md larger than 4 MiB is skipped, and AGENTS.md is read only when no CLAUDE.md exists above the working directory',
    note:
      'The AGENTS.md row carries an `absent` condition because the vendor documents it as one. A repository holding both files is read by Claude Code for the CLAUDE.md alone, which is why the pointer surface exists.',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    readers: 'Codex CLI, Codex IDE extension',
    surface: null,
    start: [
      {
        scope: 'project',
        path: 'AGENTS.override.md',
        tree: 'chain',
        atStart: true,
        why: 'Codex AGENTS.md docs: each directory from the project root to the working directory is checked for AGENTS.override.md first, then AGENTS.md, then the configured fallback filenames, and at most one file per directory is used',
      },
      {
        scope: 'project',
        path: 'AGENTS.md',
        tree: 'chain',
        atStart: true,
        why: 'Codex AGENTS.md docs: AGENTS.md is the second precedence in the same per-directory search',
      },
      {
        scope: 'user',
        path: '~/.codex/AGENTS.override.md',
        tree: 'single',
        atStart: true,
        why: 'Codex AGENTS.md docs: the global file is AGENTS.override.md if non-empty, otherwise AGENTS.md; CODEX_HOME overrides the home directory',
      },
      {
        scope: 'user',
        path: '~/.codex/AGENTS.md',
        tree: 'single',
        atStart: true,
        why: 'Codex AGENTS.md docs: AGENTS.md is the global fallback when AGENTS.override.md is empty or absent',
      },
    ],
    alsoReads: [
      {
        what: 'project_doc_fallback_filenames',
        atStart: true,
        why: 'Codex config reference: an array of additional filenames checked per directory after AGENTS.override.md and AGENTS.md',
      },
      {
        what: 'model_instructions_file',
        atStart: true,
        why: 'Codex config reference: a file that replaces AGENTS.md as the project instructions source',
      },
    ],
    order: 'project root down to the working directory, merged in that order and joined with blank lines',
    cap: {
      bytes: 32768,
      scope: 'chain',
      config: 'project_doc_max_bytes',
      why: 'Codex AGENTS.md docs: empty files are skipped and Codex stops adding files once the combined size reaches project_doc_max_bytes, which defaults to 32 KiB',
    },
    imports: {
      syntax: null,
      depth: 0,
      why: 'no import syntax documented for AGENTS.md; a reference to another file is an instruction to the model, not an include',
    },
    nested: 'cumulative — every directory from the project root to the working directory is merged, and the cap applies to the merge',
    skills: [],
    skillsNote: 'no skill directory is documented for Codex, so the cell is empty rather than borrowed from another reader',
    hooks: {
      path: '.codex/hooks.json',
      verified:
        'Codex hooks docs: <repo>/.codex/hooks.json or ~/.codex/hooks.json, or inline [hooks] tables in config.toml',
    },
    mcp: {
      path: '.codex/config.toml',
      key: 'mcp_servers',
      verified: 'Codex MCP docs: MCP configuration is stored in config.toml, ~/.codex/config.toml by default',
    },
    verified:
      'Codex AGENTS.md documentation and configuration reference (developers.openai.com/codex, read 2026-10-14) — the project scope walks from the project root to the working directory, taking at most one file per directory in the order AGENTS.override.md, AGENTS.md, project_doc_fallback_filenames; the merge runs root to cwd and stops adding files at project_doc_max_bytes, 32 KiB by default',
    note:
      'This is the row that made the table worth building: `cap.scope` is `chain`, so a repository can be inside 32 KiB in every file and still lose the tail of its deepest instruction file to the merge.',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    readers: 'Cursor',
    surface: 'cursor',
    start: [
      {
        scope: 'project',
        path: '.cursor/rules/{name}.mdc',
        tree: 'nested',
        dir: '.cursor/rules',
        suffix: '.mdc',
        // Only the always-apply rows. A `.mdc` with `alwaysApply: false` loads on a
        // matching file or a description match, which is a turn, not a session-start
        // cost — and Cursor publishes no byte cap, so the file's size is not the thing
        // being limited.
        frontmatter: { alwaysApply: 'true' },
        atStart: true,
        why: 'Cursor rules docs: alwaysApply: true alone means the rule is always included; alwaysApply: false attaches on a matching file, on a description match, or only on an @-mention',
      },
      {
        scope: 'project',
        path: 'AGENTS.md',
        tree: 'chain',
        atStart: true,
        why: 'Cursor rules docs: AGENTS.md is supported in the project root and in subdirectories, combined with parent files, with the more specific one winning',
      },
    ],
    alsoReads: [
      {
        what: '.cursor/rules/*.mdc with alwaysApply: false',
        atStart: false,
        why: 'Cursor rules docs: globs auto-attach on a matching file, a description lets the model decide, and a rule with neither loads only on an @-mention',
      },
      {
        what: 'team and user rules',
        atStart: true,
        why: 'Cursor rules docs: precedence is Team Rules, then Project Rules, then User Rules; the latter two are configured in the app, not in a file this tool can project',
      },
    ],
    order: 'team rules, then project rules, then user rules',
    cap: null,
    capNote:
      'no byte cap published; the docs recommend keeping rules under 500 lines, which is guidance and not a limit the reader enforces',
    imports: {
      syntax: null,
      depth: 0,
      why: 'Cursor rules docs: an @file in a rule body is not inlined — "the file\'s contents are not inlined into the prompt"',
    },
    nested: 'cumulative — nested AGENTS.md files are combined with their parents and the more specific one wins; .cursor/rules/ may hold folders',
    skills: [],
    skillsNote: 'no project skill directory is documented for Cursor',
    hooks: {
      path: '.cursor/hooks.json',
      verified: 'Cursor agent hooks docs: <project-root>/.cursor/hooks.json and ~/.cursor/hooks.json',
    },
    mcp: {
      path: '.cursor/mcp.json',
      key: null,
      verified: 'Cursor MCP docs: "Create .cursor/mcp.json in your project"',
    },
    verified:
      'Cursor rules documentation (cursor.com/docs/context/rules, read 2026-10-14) — only .cursor/rules/*.mdc is read, a plain .md there is ignored; alwaysApply decides whether a rule costs bytes at start; @file references in a rule body are not inlined; AGENTS.md is read in the project root and in subdirectories, combined with parents',
    note: 'A rule with alwaysApply: false is listed under alsoReads rather than start, because it costs nothing until something matches.',
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    readers: 'Antigravity IDE, Antigravity CLI',
    surface: 'antigravity',
    start: [
      {
        scope: 'project',
        path: '.agents/rules/{name}.md',
        tree: 'flat',
        dir: '.agents/rules',
        suffix: '.md',
        // `trigger: always_on` is the value that costs bytes before the first message.
        // `model_decision` injects a path and a description only, and `glob` waits for
        // a matching file — all three are real files in the same directory, and only
        // one of them is start cost.
        frontmatter: { trigger: 'always_on' },
        atStart: true,
        why: 'Antigravity rules docs: trigger is one of always_on, model_decision, glob, manual; model_decision injects only the path and description',
      },
      {
        scope: 'project',
        path: 'AGENTS.md',
        tree: 'chain',
        atStart: true,
        why: 'Antigravity rules docs: AGENTS.md, GEMINI.md and .agents/AGENTS.md in the root or any subdirectory are always-on workspace rules, and they take no frontmatter',
      },
      {
        scope: 'user',
        path: '~/.gemini/config/rules/*.md',
        tree: 'flat',
        dir: '.gemini/config/rules',
        atStart: true,
        why: 'Antigravity rules docs: global modular rules at ~/.gemini/config/rules/*.md, alongside ~/.gemini/AGENTS.md and ~/.gemini/config/AGENTS.md',
      },
    ],
    alsoReads: [
      {
        what: '.agents/rules/*.md with trigger: model_decision',
        atStart: false,
        why: 'Antigravity rules docs: progressive disclosure — the path and description are injected and the body is opened on demand',
      },
      {
        what: '.agents/rules/*.md in nested directories',
        atStart: false,
        why: 'Antigravity rules docs: .agents/rules/ is scanned flat — nested files are ignored unless registered in .agents/rules.json',
      },
    ],
    order: 'rules are cumulative across the global, workspace and directory scopes; directory scope is resolved by walking up from the edited file to the workspace root',
    cap: {
      bytes: 24000,
      scope: 'file',
      config: 'none — a fixed limit',
      why: 'Antigravity rules docs: a rule file is truncated at 24,000 bytes, counted after @[label](path) includes are expanded',
    },
    alsoCaps: [
      {
        bytes: 20000,
        scope: 'tokens',
        appliesTo: 'global plus always_on rules combined',
        why: 'Antigravity rules docs: past a 20,000-token budget the largest rules are demoted to a pointer line, "- <path>: <description>"',
      },
    ],
    imports: {
      syntax: '@[label](path)',
      depth: 0,
      why: 'Antigravity rules docs: @[label](path) inlines the file before the size limits are checked, with its frontmatter stripped; a bare @filename only rewrites to a canonical absolute path',
    },
    nested: 'cumulative — a rule applies to its directory and every subdirectory; the .agents/rules/ scan itself is flat',
    skills: [],
    skillsNote: 'no skill directory is documented for Antigravity',
    hooks: {
      path: '.agents/hooks.json',
      verified: 'Antigravity hooks docs: workspace level .agents/hooks.json, global ~/.gemini/config/hooks.json',
    },
    mcp: {
      path: '.agents/mcp_config.json',
      key: null,
      verified: 'Antigravity MCP docs: "Configured in your workspace under .agents/mcp_config.json"',
    },
    verified:
      'Google Antigravity rules documentation (antigravity.google/docs/rules/, read 2026-10-14) — rules are cumulative across global, workspace and directory scope; .agents/rules/*.md requires frontmatter with trigger, and an invalid block silently discards the rule; the directory is scanned flat and nested files are ignored unless registered in .agents/rules.json; each rule file is truncated at 24,000 bytes after includes are expanded, and global plus always_on rules share a 20,000-token budget past which the largest are demoted to pointers',
    note:
      'The flat scan is the fact that made the meter wrong before this table existed: a recursive walk of .agents/rules/ counts bytes for files Antigravity never reads.',
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    readers: 'Copilot CLI, Copilot chat, Copilot code review, Copilot cloud agent',
    surface: 'copilot',
    start: [
      {
        scope: 'project',
        path: '.github/copilot-instructions.md',
        tree: 'single',
        atStart: true,
        why: 'GitHub Copilot docs, adding repository instructions: .github/copilot-instructions.md applies to every request in the repository',
      },
      {
        scope: 'project',
        path: '.github/instructions/**/*.instructions.md',
        tree: 'nested',
        dir: '.github/instructions',
        suffix: '.instructions.md',
        frontmatter: { applyTo: '**' },
        atStart: true,
        why: 'GitHub Copilot docs: a path-specific file is applied when a file matching applyTo is in context, and applyTo: "**" matches every file at session start',
      },
      {
        scope: 'project',
        path: 'AGENTS.md',
        tree: 'chain',
        atStart: true,
        why: 'GitHub Copilot docs, agent instructions: one or more AGENTS.md anywhere in the repository, the nearest to the file in play wins, or a single CLAUDE.md or GEMINI.md at the root',
      },
    ],
    alsoReads: [
      {
        what: '.github/instructions/**/*.instructions.md',
        atStart: false,
        why: 'GitHub Copilot docs: applyTo globs select the files, and excludeAgent keeps the file away from code review or the cloud agent',
      },
    ],
    order: 'personal instructions, then repository instructions, then organization instructions',
    cap: null,
    capNote: 'no byte cap published for Copilot instructions',
    imports: {
      syntax: null,
      depth: 0,
      why: 'no import syntax documented for Copilot instruction files',
    },
    nested: 'nearest wins — AGENTS.md files anywhere in the repository are candidates and the nearest one to the file in play is used; .github/instructions/ may hold subdirectories',
    skills: [],
    skillsNote: 'no project skill directory is documented for Copilot',
    hooks: null,
    hooksNote: 'no hooks file is documented for Copilot in any first-party page checked on 2026-10-14',
    mcp: {
      path: '.vscode/mcp.json',
      key: null,
      verified:
        'GitHub Copilot MCP docs: the VS Code extension reads .vscode/mcp.json; Copilot CLI reads .mcp.json, .github/mcp.json or ~/.copilot/mcp-config.json; a repository-level configuration entered on github.com is not a file at all',
    },
    verified:
      'GitHub Copilot documentation (docs.github.com/en/copilot, read 2026-10-14) — repository-wide instructions live at .github/copilot-instructions.md; path-specific instructions live at .github/instructions/**/NAME.instructions.md with applyTo globs and an optional excludeAgent; agent instructions are one or more AGENTS.md anywhere in the repository, nearest wins, or a single root CLAUDE.md or GEMINI.md; no byte cap is published',
    note:
      'Which Copilot reader consumes these differs — the cloud agent and code review are documented as reading repository and path-specific instructions — so the row is one reader with a split, the same split `surfaces.mjs` records on the copilot row.',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek harness',
    readers: 'DeepSeek harness',
    // No projection surface. It reads AGENTS.md, so the standard region is its channel
    // (ADR-067). This row exists because its chain is not Codex's: both AGENTS.md and
    // CLAUDE.md load unless their trimmed bytes match, and the budget drops the broader
    // file before it truncates the most specific one.
    surface: null,
    chainMerge: 'all',
    dedupe: 'trim',
    start: [
      {
        scope: 'project',
        path: 'AGENTS.md',
        tree: 'chain',
        atStart: true,
        why: 'DeepSeek harness agent-instructions docs: AGENTS.md is the first base candidate in each directory from the project root down to the session working directory',
      },
      {
        scope: 'project',
        path: 'CLAUDE.md',
        tree: 'chain',
        atStart: true,
        why: 'DeepSeek harness agent-instructions docs: CLAUDE.md is the second base candidate and loads beside AGENTS.md unless the two are identical after trimming',
      },
      {
        scope: 'project',
        path: 'AGENTS.local.md',
        tree: 'chain',
        atStart: true,
        why: 'DeepSeek harness agent-instructions docs: AGENTS.local.md is a local overlay loaded after the base candidates in the same directory',
      },
      {
        scope: 'project',
        path: 'CLAUDE.local.md',
        tree: 'chain',
        atStart: true,
        why: 'DeepSeek harness agent-instructions docs: CLAUDE.local.md is the second local overlay, under the same per-directory trim dedup',
      },
      {
        scope: 'user',
        path: '~/.dsh/AGENTS.md',
        tree: 'single',
        atStart: true,
        why: 'DeepSeek harness agent-instructions docs: the user-global file is $DSH_HOME/AGENTS.md, defaulting to ~/.dsh/AGENTS.md',
      },
      {
        scope: 'user',
        path: '~/.agents/AGENTS.md',
        tree: 'single',
        atStart: true,
        why: 'DeepSeek harness agent-instructions docs: the shared agents root is $DSH_AGENTS_HOME or ~/.agents, and a copy that matches the harness-home file collapses behind it',
      },
    ],
    alsoReads: [
      {
        what: 'AGENTS.md below the session working directory',
        atStart: false,
        why: 'DeepSeek harness agent-instructions docs: a successful read, write or edit that reaches a deeper directory loads that directory\'s instruction file on the next request; shell navigation does not',
      },
    ],
    order:
      'user-global ~/.dsh/AGENTS.md, then ~/.agents/AGENTS.md, then every project candidate from the project root down to the working directory, broad to specific; within one directory, base files then local overlays',
    cap: {
      bytes: 65536,
      scope: 'chain',
      config: 'maxBytes',
      drop: 'broader',
      why: 'DeepSeek harness agent-instructions docs: dsh-base sets maxBytes to 65536, and rendering drops whole broader files before truncating the most specific one',
    },
    alsoCaps: [
      {
        bytes: 1048576,
        scope: 'file',
        appliesTo: 'one source file before rendering',
        config: 'maxSourceBytes',
        why: 'DeepSeek harness agent-instructions docs: maxSourceBytes defaults to 1048576, and a larger source file is ignored rather than truncated into the chain',
      },
    ],
    imports: {
      syntax: null,
      depth: 0,
      why: 'DeepSeek harness agent-instructions docs: @path imports are not interpreted; a reference inside an instruction file is not an include',
    },
    nested:
      'on touch — the baseline is the root-to-cwd chain; a deeper AGENTS.md loads after a successful read, write or edit in that directory, not because the shell changed directory',
    skills: [],
    skillsNote:
      'the agent-instructions package does not document a project skill directory; shared agent configuration lives at ~/.agents, which is user scope and is not measured here',
    hooks: null,
    hooksNote:
      'DeepSeek harness hooks docs: the Claude Code and Codex bridges take an explicit configPath, and project-local hooks.json discovery is still marked TODO, so no repository path is loaded by default',
    mcp: {
      path: null,
      key: '@deepseek-ai/dsh-mcp-client',
      verified:
        'DeepSeek harness MCP docs: a server is a profile plugin row (@deepseek-ai/dsh-mcp-client), not a project file this tool can project',
    },
    verified:
      'DeepSeek harness agent-instructions package (deepseek-ai/deepseek-harness packages/context/agent-instructions/README.md, read 2026-10-14) — the baseline loads ~/.dsh/AGENTS.md, ~/.agents/AGENTS.md, then AGENTS.md and CLAUDE.md plus the local overlays from the project root down to the working directory; trimmed duplicates in one directory collapse; dsh-base caps the rendered baseline at 65536 bytes and ignores a source file over 1048576 bytes',
    note:
      'A drifted CLAUDE.md beside AGENTS.md is loaded in full. A symlink or a byte-identical copy is not. That is why this reader does not share Codex\'s one-file-per-directory rule.',
  },
];

export const LOADER_IDS = LOADERS.map((l) => l.id);

/** Loader row `id` or null. */
export function loader(id) {
  return LOADERS.find((l) => l.id === id) ?? null;
}

/**
 * The cap that applies to one row, or null — with `alsoCaps` folded in.
 *
 * Callers ask for "the limits this reader enforces", not for the shape of the cell. A
 * cap stated as prose in `capNote` and enforced in code somewhere else is the drift this
 * table was built to stop, so the enumeration is one function both the meter and the
 * report call.
 */
export function caps(row) {
  const out = [];
  if (row.cap) {
    out.push({
      bytes: row.cap.bytes,
      scope: row.cap.scope,
      config: row.cap.config ?? null,
      // Named from the scope rather than written per row, because the two answer
      // different questions and a reader who saw only one of them would misattribute
      // the finding: a chain cap fails on the repository, a file cap fails on the file.
      appliesTo: row.cap.scope === 'chain' ? 'the merged chain' : 'a single file',
      drop: row.cap.drop ?? null,
      why: row.cap.why,
    });
  }
  for (const extra of row.alsoCaps ?? []) {
    out.push({
      bytes: extra.bytes,
      scope: extra.scope,
      config: extra.config ?? null,
      appliesTo: extra.appliesTo,
      why: extra.why,
    });
  }
  return out;
}