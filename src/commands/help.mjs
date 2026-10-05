import { emit } from '../output/index.mjs';
import { parse } from '../argv.mjs';

const COMMANDS = `simt-dev init [path]            adopt or scaffold a repo into the ecosystem
                           (dry-run unless --yes; conflicts block without
                           --accept-conflicts; never commits or pushes)
simt-dev doctor                 classify a repo and check config health
simt-dev check                  the gate: projection drift, manifest validity, policy
simt-dev sync [--check]         regenerate the projection (idempotent)
simt-dev upgrade                move every consumer to this simt-dev SHA, as one set
                           (dry-run unless --yes; moves a pin only - it never
                           adopts or repairs a repo; never commits or pushes)

simt-dev skills index           tier-0 catalog: every skill, one line each
simt-dev skills brief --task    tier-1 pre-assembled brief  <- the common case
simt-dev skills show <name>     tier-2 body (respects --max-bytes)
simt-dev skills why <name>      the signal chain that selected it
simt-dev skills find <query>    search across capability and keyword
simt-dev skills install <name>  pin a skill into the repo as a local override
                           (dry-run unless --yes; a multi-variant skill needs
                           --variant or --from rather than a guess)

simt-dev rules list             the rule catalogue (--root marks what applies to a repo)
simt-dev rules show <id>        one rule body
simt-dev rules why <id|ADR-NNN> the decision that settled it, and whether it is still in force
simt-dev hooks install|status   install the shared dispatcher; report what it would run
simt-dev compare                org-wide matrix across every sibling repo
                           (read-only; exits non-zero on defects, not on
                           repos that have not adopted yet)
simt-dev mcp                    the read-only surface as MCP tools over stdio
                           (--list prints it without reading stdin; init, sync,
                           upgrade and the installers stay CLI-only by design)`;

const FLAGS = `--json                 structured output
--max-bytes <n>         hard ceiling on emitted bytes (0 = unlimited, default 0)
--budget <n>            context budget for skills brief (default 20480)
--plan                  emit a fetch plan instead of inlining skill bodies
--skill <name>          force a skill into the brief (repeatable)
--task "<text>"         the task text used for capability resolution
--paths <globs>         comma-separated path globs used for path resolution
--root <path>           repository root (default: cwd)
--workspace <path>      where the skill sources live; "off" declines it
                        (default: SIMT_DEV_WORKSPACE, then the user config
                        file, then the sibling heuristic if it verifies)
--dry-run               report what would change, change nothing
--yes                   assume yes; required in automation, never prompts
--all                   ignore the budget and resolve everything
--variant <id>          which body of a multi-variant skill to use
--from <repo/path>      install from a declared source by name`;

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
      'usage: simt-dev <command> [args] [flags]',
      '',
      'commands:',
      COMMANDS,
      '',
      'flags:',
      FLAGS,
      '',
      PRINCIPLES,
      '',
      'plans    docs/plans/0002-simt-dev-cli.md',
      'rulings  docs/decisions/README.md',
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
