import { emit } from '../output/index.mjs';
import { parse } from '../argv.mjs';
import { CLI } from '../name.mjs';

const COMMANDS = `${CLI} init [path]            adopt or scaffold a repo into the ecosystem
                           (dry-run unless --yes; conflicts block without
                           --accept-conflicts; in place unless --backup;
                           never commits or pushes)
${CLI} doctor                 classify a repo and check config health
${CLI} check                  the gate: projection drift, manifest validity, policy
${CLI} sync [--yes]           regenerate the projection (idempotent)
                           (prints the plan and exits 1 on drift without --yes,
                           so it also works as a check)
${CLI} upgrade                move every consumer to this simt-dev SHA, as one set
                           (dry-run unless --yes; moves a pin only - it never
                           adopts or repairs a repo; never commits or pushes)

${CLI} skills index           tier-0 catalog: every skill, one line each
${CLI} skills brief --task    tier-1 pre-assembled brief  <- the common case
${CLI} skills show <name>     tier-2 body (respects --max-bytes)
${CLI} skills why <name>      the signal chain that selected it
${CLI} skills find <query>    search across capability and keyword
${CLI} skills eval [corpus]   measure the resolver against a gold corpus
                           (reports precision and recall; exits non-zero on
                            regression; without an argument, the corpus in this
                            checkout)
${CLI} skills install <name>  pin a skill into the repo as a local override
                           (dry-run unless --yes; a multi-variant skill needs
                           --variant or --from rather than a guess)

${CLI} rules list             the rule catalogue (--root marks what applies to a repo)
${CLI} rules show <id>        one rule body
${CLI} rules why <id|ADR-NNN> the decision that settled it, and whether it is still in force
                           (--all prints every ruling, not the first two)
${CLI} hooks install [--yes]   install the shared dispatcher; report what it would run
                           (dry-run unless --yes; refuses to take over routing git
                            already uses, and --yes is that consent)
${CLI} hooks status            what each git event routes to, and whether it is wired
${CLI} hooks run <event>       run one event's gates now, as git would
                           (pre-commit, pre-push, post-merge, ...)
${CLI} graph lint              check the skill registry against the skills on disk
                           (byte counts, dangling edges, unresolvable variants)
${CLI} ci                     simt-dev's own .github files: create or refresh them
                           (dry-run unless --yes; refreshes the templates' own copies
                            and no repository else's)
${CLI} compare                org-wide matrix across every sibling repo
                           (read-only; exits non-zero on defects, not on
                           repos that have not adopted yet)
${CLI} tokens [--repos]       what a reader loads at session start, in bytes
                           (read-only; exits 0 whatever it finds, because a
                           measurement is not a verdict; --repos measures every
                           repository under the root and what repeats an earlier)
${CLI} harness detect         which harnesses this repo (and, with --user, you)
                           are set up for, and which have a rule channel here
                           (presence only: a directory found is not a claim about
                           what its owner reads; exits 0 whatever it finds)
${CLI} harness loaders        what each reader loads at session start, in bytes,
                            and what its size cap drops
                            (--table prints the vendor facts without measuring;
                            --reader <id> narrows it; every claim cites its source)
${CLI} mcp                    the read-only surface as MCP tools over stdio
                           (--list prints it without reading stdin; init, sync,
                           upgrade and the installers stay CLI-only by design)`;

const FLAGS = `--json                 structured output (compact; one document, one line)
--pretty                indent --json for a human
--max-bytes <n>         hard ceiling on emitted bytes (0 = unlimited, default 0)
--budget <n>            context budget for skills brief (default 20480)
--plan                  emit a fetch plan instead of inlining skill bodies
--skill <name>          force a skill into the brief (repeatable)
--task "<text>"         the task text used for capability resolution
--paths <globs>         comma-separated path globs used for path resolution
--root <path>           repository root (default: cwd)
--surfaces <ids>        comma-separated editors to write rule files for;
                         "" means AGENTS.md only (default: every surface,
                         or the "surfaces" list in simt-dev.json)
--workspace <path>      where the skill sources live; "off" declines it
                        (default: SIMT_DEV_WORKSPACE, then the user config
                        file, then the sibling heuristic if it verifies)
--dry-run               report what would change, change nothing
--yes                   assume yes; required in automation, never prompts
--check                 report drift and write nothing (sync, ci)
--all                   ignore a cap: every ruling of a record, or the skills budget
--variant <id>          which body of a multi-variant skill to use
--from <repo/path>      install from a declared source by name
--list                  print the MCP tool surface without reading stdin (mcp)
--accept-conflicts      init: adopt rules that collide with hand-written ones
--backup                init: tag the pre-adoption commit and branch onto
                        simt-dev/adopt before writing (the undo path)
--spec <name>           graph lint: also check every skill against a named
                        specification (one exists: agentskills)
--user                  harness detect: also report the directories in your home
--repos                 tokens: measure every repository under the root, not
                        just the one, and report what repeats an earlier one
--session <path>        tokens: split a local Claude Code or Codex transcript
                        into rules, file reads and tool output
--reader <id>           harness loaders: report one reader (opencode, claude, codex,
                         cursor, antigravity, copilot, deepseek)
--table                 harness loaders: print order, caps, imports, skill dirs and
                         the hook and MCP config files, without measuring a repo
--at <path>             harness loaders: measure as if the agent were working in
                         this directory (default: the root; readers that merge the
                         project root down to the working directory cost more here)
--help                  this text
--version               the version, and the SHA it was built from`;

const PRINCIPLES = `design rules:
  deterministic       same repo + same task = same answer, forever
  explainable         skills why prints the signal chain for any selection;
                      rules why prints the decision behind any rule
  zero dependencies   a DX tool that needs an install step fails on a fresh machine
  bounded output      one fact per line, fixed field order, explicit TRUNCATED lines`;

export async function help(argv) {
  const { ok, value } = parse(argv);
  if (!ok) return value.code;
  const { flags } = value;
  if (flags.version) {
    emit((await version()).trim());
    return 0;
  }
  emit(
    [
      'simt-dev - shared agent rules, skills and gates for a repo ecosystem',
      '',
      `usage: ${CLI} <command> [args] [flags]`,
      '',
      'commands:',
      COMMANDS,
      '',
      'flags:',
      FLAGS,
      '',
      PRINCIPLES,
      '',
      // The plans ship inside the installed package but have no command that surfaces
      // them, so naming the path would again be advice the reader cannot take. They
      // are an implementation record; the rulings are the part a reader can act on.
      `rulings  ${CLI} rules list   the decisions behind the rules you just read`,
    ].join('\n'),
    { maxBytes: flags.maxBytes ?? 0 },
  );
  return 0;
}

async function version() {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(await readFile(join(root, '..', 'package.json'), 'utf8'));
  return `simt-dev ${pkg.version}\n`;
}
