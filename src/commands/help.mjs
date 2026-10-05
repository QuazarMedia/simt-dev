import { emit } from '../output/index.mjs';
import { parse } from '../argv.mjs';

const COMMANDS = `simt init [path]            adopt or scaffold a repo into the ecosystem
simt doctor                 classify a repo and check config health
simt check                  the gate: projection drift, manifest validity, policy
simt sync [--check]         regenerate the projection (idempotent)
simt upgrade                bump consumers to this simt-dev SHA

simt skills index           tier-0 catalog: every skill, one line each
simt skills brief --task    tier-1 pre-assembled brief  <- the common case
simt skills show <name>     tier-2 body (respects --max-bytes)
simt skills why <name>      the signal chain that selected it
simt skills find <query>    search across capability and keyword
simt skills install <name>  pin a skill into the repo as a local override

simt rules list|show|why    rules with provenance back to the ADR that settled them
simt hooks install|status   shared hook dispatcher and this repo's gates
simt compare                org-wide matrix across every sibling repo
simt mcp                    expose the same surface as MCP tools`;

const FLAGS = `--json                 structured output
--max-bytes <n>         hard ceiling on emitted bytes (0 = unlimited, default 0)
--budget <n>            context budget for skills brief (default 20480)
--plan                  emit a fetch plan instead of inlining skill bodies
--skill <name>          force a skill into the brief (repeatable)
--task "<text>"         the task text used for capability resolution
--paths <globs>         comma-separated path globs used for path resolution
--root <path>           repository root (default: cwd)
--dry-run               report what would change, change nothing
--yes                   assume yes; required in automation, never prompts
--all                   ignore the budget and resolve everything`;

const PRINCIPLES = `design rules:
  deterministic       same repo + same task = same answer, forever
  explainable         simt skills why prints the signal chain for any selection
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
      'simt-dev - developer and agent tooling for the SIMT ecosystem',
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
