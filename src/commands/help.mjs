import { emit, fail, jsonFailMode } from '../output/index.mjs';
import { parse, rawJsonFlag } from '../argv.mjs';
import { CLI, MANIFEST_FILE, STATE_DIR } from '../name.mjs';
import { SESSION_ENV } from '../agenthooks/policy.mjs';
import { DEFAULT_DIRECTORIES, DEFAULT_TEMPLATE } from '../plan/template.mjs';

const COMMANDS = `${CLI} init [path]            adopt or scaffold a repo into the ecosystem
                           (dry-run unless --yes; conflicts block without
                           --accept-conflicts; in place unless --backup;
                           never commits or pushes)
${CLI} doctor [--fix]        classify a repo and check config health (with --fix:
                           apply the remedies flagged safe and list the rest;
                           dry-run unless --yes)
${CLI} status --line         one line from the last check, for prompts and tmux
                           (as of the last check; STALE after new commits)
${CLI} check                  the gate: projection drift, manifest validity, policy
${CLI} sync [--yes]           regenerate the projection (idempotent)
                           (prints the plan and exits 1 on drift without --yes,
                           so it also works as a check)
${CLI} upgrade                move every consumer to this simt-dev SHA, as one set
                           (dry-run unless --yes; moves a pin only - it never
                           adopts or repairs a repo; never commits or pushes)

${CLI} brief "<task>"         one packet for a task: the kind, the commands, the
                           likely files, the tests and the decisions that govern
                           them, inside --budget bytes (default 2048; 0 is
                           unlimited). Says how many items it cut; --explain
                           says why each was kept or dropped

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
${CLI} skills compile [<name>] compile a skill to Agent Skills standard, flag bodies
                           over 5000 tokens with a split plan, and report per-skill
                           trigger recall and precision from R02 transcripts

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
${CLI} agent-hook <event>      the entry point a harness calls: pre-tool-use decides,
                            prompt-submit delivers the packet as prompt context
                           (reads one JSON payload on stdin and answers in that
                            harness's dialect; exit 2 blocks; needs --harness)
${CLI} agent-hooks install     write this repo's policies into the harnesses that
                            read a hooks file (--harness <id> writes one, not all)
                           (dry-run unless --yes; merges into the file, keeps every
                            key it does not own; Codex needs the hook trusted)
${CLI} agent-hooks status      what each harness will run, and what is not trusted yet
${CLI} plugin <claude|gemini|cursor|opencode>  generate a harness package from the same tables
                           (dry-run unless --yes; writes a self-contained runtime, the
                           hooks and MCP registration, and for cursor the kernel rules;
                           the skill registry is workspace data and is not shipped)
${CLI} completions <shell>    print a bash, zsh or fish completion script
                           (generated from the command registry, so every command
                           completes; deterministic bytes; stdout only - redirect
                           or source it)
${CLI} plan status             count tracker rows
                           (${MANIFEST_FILE} key plans when set, otherwise
                           the ${DEFAULT_TEMPLATE} template:
                           ${DEFAULT_DIRECTORIES.join(' and ')})
${CLI} plan next [<id>]        one ready slice's section, or the one named; ~1 KB
${CLI} plan done <id> [<sha>]  mark one row; dry-run unless --yes
${CLI} slice start <id>     give a slice its own worktree and branch, preload the
                           brief, and mark the row started (dry-run unless
                           --yes; the worktree is ${STATE_DIR}/local/worktrees/<id>
                           on branch slice/<id>, the brief ${STATE_DIR}/local/briefs/<id>.md
                           beside it; --session <id> leases the slice)
${CLI} slice finish <id>    run the pre-commit gates, commit what is staged with a
                           Conventional subject from the row's title, then record
                           the SHA and the --test command on the row (dry-run
                           unless --yes; --type picks the type, default feat;
                           refuses unless HEAD is the slice branch; gates the
                           ledger already proves for this tree are not re-run)
${CLI} slice abandon <id>   remove the worktree, delete the branch, and return
                           the row to ready (dry-run unless --yes; refuses from
                           inside the worktree)
${CLI} lease [<paths>...]    claim files for one session and a TTL, or list the
                           claims (dry-run unless --yes; the session is --session
                           <id> or ${SESSION_ENV}; a pre-edit hook refuses an edit
                           to a path another session holds — ADR-101;
                           release and renew end and extend your own claims)
${CLI} graph lint              check the skill registry against the skills on disk
                           (byte counts, dangling edges, unresolvable variants)
${CLI} ci                     simt-dev's own .github files: create or refresh them
                           (dry-run unless --yes; refreshes the templates' own copies
                            and no repository else's)
${CLI} ignore [--yes]         render the one .simtignore list into .cursorignore,
                           .aiderignore, .geminiignore and Claude's
                           permissions.deny Read(...) entries (dry-run unless
                           --yes; --diff prints the plan as unified diffs; the
                           Claude settings file is merged, never replaced)
${CLI} compare                org-wide matrix across every sibling repo
                           (read-only; exits non-zero on defects, not on
                           repos that have not adopted yet)
${CLI} index                   rebuild the local file index from git blob hashes
${CLI} why [path]            what governs a file: a decision whose Affects line names
                           it, a rule whose scope matches it, a skill, a gate
                           or a lesson. With no path, the Affects tokens this
                           tree cannot resolve (UNRESOLVED-AFFECTS)
${CLI} tests [path]          the tests that exercise a file: an import, the conventional
                           source beside the test, or a coverage record that
                           names both (--cochange adds files that only share
                           commits, and only those)
${CLI} gate [path...]        the tests a change reaches, and only those
                           (--changed reads the diff instead of the paths)
${CLI} impact <file|symbol>  who a change reaches: importers, their tests,
                           what governs it, and a contract another repository references
${CLI} map [--task "<text>"] [--level outline|names|signatures]
                           the files this task is most likely to touch, within
                           --budget bytes (default 2048; 0 is unlimited). outline
                           is paths, names adds exports, signatures adds the line.
                           --recall reports gold-file recall@10 on mined tasks
${CLI} pr-body [--base <ref>]  a pull request body: the evidence block for this tree,
                           the decision records the diff touches, the gate
                           state from the last check, and the residual risk
                           in ADR-008 vocabulary (read-only; the exit code
                           never carries the verdict)
${CLI} evidence                the runs recorded against the tree on disk
${CLI} evidence check <file>   a commit message that claims a run this tree does not
                           have: a warning, or a block when gates.evidence is "block"
${CLI} lessons list            deterministic lesson candidates in .simt/local/lessons.jsonl
                           and promoted lessons in docs/lessons/*.md
${CLI} lessons review [<id>]   promote a lesson candidate to docs/lessons/NNNN-<slug>.md
                           (dry-run unless --yes; writes Appendix A frontmatter)
${CLI} explain <CODE>        what a check finding means: the decision behind it, how
                           to fix it, and a concrete trigger (DRIFT, UNMANAGED,
                           PACK-DIGEST-MISMATCH, ...; case-insensitive)
${CLI} decide [<title>]        scaffold an ADR with the next free number, a Status: line,
                           a rulings skeleton, and structured simt-affects +
                           simt-supersedes frontmatter (dry-run unless --yes;
                           --check lints ADRs for prose-only partial supersessions)
${CLI} undo                  restore the last journaled set of writes, but only
                           when every file in it is untouched since (dry-run
                           unless --yes; a touched file refuses the whole undo
                           and nothing is restored)
${CLI} local doctor            probe configured local model endpoints (chat and embed)
                           (reads local in ${MANIFEST_FILE}; opens no socket when
                           unset; refuses non-loopback URLs without --allow-remote)
${CLI} distill <skill|doc>     a budgeted proposal summary of a skill body or doc,
                           every claim citing the source line range it rests on
                           (writes .simt/local/distilled/<digest>.md; a proposal a
                           human merges - never projected or committed;
                           deterministic outline by default; --local proposes
                           from the configured chat model instead; the cache is
                           keyed by source digest and budget, --refresh regenerates)
${CLI} review [--local]        an ADR-008 verdict skeleton for the staged diff,
                           the brief listing everything that governs it (R25)
                           (deterministic without --local: the brief and its
                           governing ids only; --local proposes from the
                           configured chat model and writes
                           .simt/local/reviews/<digest>.md — a proposal a human
                           reads, verified against the verdict vocabulary and
                           the brief's ids; advisory always, never a gate)
${CLI} shared plan            what a workspace's repeated rules cost to carry
                           once: the shared set, its bytes, and every path that would be written
                           (read-only; touches nothing, not even your home directory)
${CLI} shared install [--yes] carry those rules once per reader, at user level,
                           and declare the delta in each repo's manifest (dry-run unless
                           --yes; copies land in files the vendors' own docs name, and a reader
                           with no such file gets the block printed to paste; ${CLI} doctor
                           reports a copy that is missing or stale)
${CLI} tokens [--repos]       what a reader loads at session start, in bytes
                           (read-only; exits 0 whatever it finds, because a
                           measurement is not a verdict; --repos measures every
                           repository under the root and what repeats an earlier)
${CLI} harness detect         which harnesses this repo (and, with --user, you)
                           are set up for, and which have a rule channel here
                           (presence only: a directory or an MCP config file
                           found is not a claim about what its owner reads;
                           exits 0 whatever it finds)
${CLI} harness loaders        what each reader loads at session start, in bytes,
                            and what its size cap drops
                            (--table prints the vendor facts without measuring;
                            --reader <id> narrows it; every claim cites its source)
${CLI} bench mine [--yes]     mine verified benchmark tasks from git history
                            (dry-run unless --yes; validates RED and GOLD twice in
                            a temp worktree and stores test patches in the vault)
${CLI} bench run [--yes]      run benchmark tasks across arms in isolated one-commit exports
                            (dry-run unless --yes; grades against vault test patches
                            and declared gates; --regrade <run> verifies stored runs)
${CLI} bench report           statistical report across benchmark arms (R, Q, C, CPI, cache)
                            (read-only; paired bootstrap 95% CIs; --compare <a> <b>
                            prints deltas with McNemar and Wilcoxon p-values)
${CLI} bench ablate [--yes]    leave-one-out ablation across core, profile and process sections
                            (dry-run unless --yes; 10-task canary with escalation,
                            value-per-KB ranking and deletion candidates)
${CLI} bench probes [--yes]    12 synthetic rule-compliance probes with deterministic graders
                            (dry-run unless --yes; grades git state, transcript and ledger,
                            and reports compliance per arm)
${CLI} bench variants [--yes]  evaluate simt-variants rule slots on the canary suite and lock
                            winning variants in simt-dev.lock.json (dry-run unless --yes;
                            re-opens when model or harness changes)
${CLI} bench critic          precision and recall of the local critic over a labelled
                            set of historical diffs (.simt/local/critic-labels.jsonl;
                            overrides --labels; labels are human-written verdicts
                            under ADR-008; the critic is advisory until precision
                            reaches 0.8 on 30 labelled diffs)
${CLI} pack new <name> --source <spec>
                           scaffold a versioned pack: pack.json, an unmeasured
                           bench.json, and one stack rule (dry-run unless --yes;
                           refuses a directory that already exists)
${CLI} pack lint [dir]        validate a pack: identity, source, rules, and the
                           bench summary (--require-measured rejects a pack with
                           no measured ΔR; a pack vendored under .simt/packs/ is
                           also checked against the manifest's pin)
${CLI} pack publish [dir] [--yes]
                           publish an npm-sourced pack to the registry
                           (dry-run unless --yes; skips a version already live;
                           a git-sourced pack names the tag-and-push instead)
${CLI} mcp                    the read-only surface as MCP tools over stdio
                           (--list prints it without reading stdin; init, sync,
                           upgrade and the installers stay CLI-only by design)`;

const FLAGS = `--json                 structured output (compact; one document, one line)
--pretty                indent --json for a human
--max-bytes <n>         hard ceiling on emitted bytes (0 = unlimited, default 0)
--budget <n>            context budget for a brief (default 2048)
                        (skills brief keeps its own default of 20480)
--plan                  emit a fetch plan instead of inlining skill bodies
--skill <name>          force a skill into the brief (repeatable)
--task "<text>"         the task text used for capability resolution
--paths <globs>         comma-separated path globs used for path resolution
--root <path>           repository root (default: cwd)
--base <ref>           pr-body: the ref the body diffs against
                        (default: origin/main, then main; falls back to the
                        worktree diff against HEAD when neither exists)
--out <path>            plugin: where the generated package lands (required)
--surfaces <ids>        comma-separated editors to write rule files for;
                         "" means AGENTS.md only (default: every surface,
                         or the "surfaces" list in simt-dev.json)
--workspace <path>      where the skill sources live; "off" declines it
                        (default: SIMT_DEV_WORKSPACE, then the user config
                        file, then the sibling heuristic if it verifies)
--dry-run               report what would change, change nothing
--yes                   assume yes; required in automation, never prompts
--check                 report drift and write nothing (sync, ci)
--diff                  print the plan as unified diffs (every writer;
                        changes nothing about what the run writes)
--line                  status: print the one-line gate summary from the last
                        check (the only mode status has)
--fix                   doctor: apply the remedies flagged safe (local,
                        idempotent, journaled); list the rest (dry-run
                        unless --yes)
--frozen                check: the lock must match this projection; an output
                        change no input change explains fails the gate
--explain               sync: name each line dropped as already inferable, with
                        the fact behind it; brief: name every item and why it
                        was kept or cut, with its section's value
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
--arm <spec>            bench run: arm to evaluate (bare, current, kernel, brief,
                         or name=path/to/arm.json; repeatable)
--harness <id>          bench run: adapter to invoke (claude, codex, gemini, opencode,
                         cursor, aider, gold, noop; default: gold);
                         agent-hook: which dialect to answer in (claude, cursor,
                         codex, antigravity)
--model <id>            bench run: model identifier recorded and passed to the adapter
--reps <n>              bench run: repetitions per task and arm (default: 3)
--regrade <run>         bench run: re-grade a stored run from its archived agent patch
--compare <a> <b>       bench report: compare two arms with deltas and p-values
--test <cmd>            plan done / slice finish: the test command that closes the row
--state <name>          plan done: target state (default: Complete)
--type <name>           slice finish: the Conventional Commits type (default: feat)
--ttl <seconds>         lease: how long a claim lasts (default: 3600)
--level <name>          map: detail level (outline, names, signatures)
--supersedes <spec>     decide: superseded ADR or ruling (ADR-NNN or ADR-NNN:<ruling>[:<kind>]; repeatable)
--source <spec>         pack new: where the pack's bytes come from
                         (npm:<package> or git+https://…; required)
--require-measured      pack lint: reject a pack with no measured ΔR
                         (a bench.json marked unmeasured, or missing)
--allow-remote          local doctor / distill / review: allow non-loopback model
                         URLs (refused by default)
--embed                 index / map / brief: compute or query optional local vector embeddings
                        (off by default unless recall@10 gains at least 10 points)
--labels <path>         bench critic: the labelled set of historical diffs to score
                        (default .simt/critic-labels.jsonl; one human-written
                        {sha, verdict} pair per line)
--refresh               distill / review: regenerate a proposal that is already cached
--local                 distill / review: propose the answer from the configured
                         local chat model (local.chat); off by default, which
                         uses the deterministic path instead
--help                  this text
--version               the version, and the SHA it was built from`;

const PRINCIPLES = `design rules:
  deterministic       same repo + same task = same answer, forever
  explainable         skills why prints the signal chain for any selection;
                      rules why prints the decision behind any rule
  zero dependencies   a DX tool that needs an install step fails on a fresh machine
  bounded output      one fact per line, fixed field order, explicit TRUNCATED lines`;

export async function help(argv) {
  const parsed = parse(argv);
  if (!parsed.ok) {
    jsonFailMode(rawJsonFlag(argv));
    return fail(parsed.error.message, parsed.error.code);
  }
  const { flags } = parsed.value;
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
  const { describeVersion } = await import('../package-version.mjs');
  return `${describeVersion()}\n`;
}
