// Minimal argv parser. Zero dependencies is a hard requirement (ADR: principle 5):
// a DX tool that needs an install step is a DX tool that fails on a fresh machine.
//
// Supported forms:
//   --flag              boolean
//   --key value         string
//   --key=value         string
//   --no-flag           sets flag false
//   --                  everything after is positional
// Anything unrecognised is an error, not a silent ignore: a typo'd gate name
// that is ignored is worse than a typo'd gate name that fails.

import { EXIT } from './output/index.mjs';

// `--quiet`, `--semantic` and `--mermaid` were here and were read by nothing (review
// 0001 filed it; it survived every change to this file since). Each was a plan's
// intention rather than a feature: `--semantic` was to be an explicitly non-canonical
// escape hatch, `--mermaid` belonged to a `skills graph` command that was never built,
// and `--quiet` was to shorten `help`. The plans keep those records; the parser does not
// need to keep a promise no code makes.
//
// An accepted flag that changes nothing is worse than an absent one. `--nonsense` exits
// 2 and tells the reader the flag does not exist; `--quiet` exits 0 and tells them
// nothing happened, which is indistinguishable from the output being quiet on purpose.
// Removing them makes `test/help.test.mjs`'s "every flag is described" assertion able to
// mean something, which it could not while three accepted flags had no description.

export const BOOL_FLAGS = new Set([
  // hooks install|status: write or report each harness's own hooks file instead of the
  // git hooks. It is a flag rather than a second command because the plan, the report
  // and the journal entry are the same run, and `agent-hooks install` is its alias.
  'agent',
  // bench ablate: compare across harness, model and experiment groups. The command
  // read `flags.crossGroup` while the parser accepted no such flag, so the override
  // existed only in the error message that told the reader to pass it
  'cross-group',
  'json',
  'all',
  'baselines',
  'dry-run',
  'yes',
  'check',
  'plan',
  'help',
  'version',
  // JSON output: indent it. Off by default because a pipe is not a person, and the
  // bytes an agent pays for indentation are bytes it never reads.
  'pretty',
  'accept-conflicts',
  'backup',
  // init: opt out of the agent files and the agent-hooks in one flag. The parser's
  // `no-` convention spells the flag as a negation of the positive `agents`, so the
  // positive name is what belongs here and `init` reads `flags.agents === false` -
  // the user-facing flag stays `--no-agents`. They are the two halves of the same
  // decision - which harnesses the adoption speaks to - and the standalone agents /
  // agent-hooks install commands remain for a repo that wants them later. Off by
  // default because the adoption writes them by default.
  'agents',
  'list',
  // tokens: measure every repository under the root, not just the one.
  // names this flag `--workspace`, and that name has been a VALUE flag since plan
  // 0002 - it is where the skill sources live. One flag with two meanings is the
  // silent-ignore defect this file's header refuses, so the meter's switch is named
  // for what it selects.
  'repos',
  // harness detect: also report the directories in the user's home. Off by default
  // because the home directory belongs to the reader rather than the repository, and a
  // command whose output changes because something was installed elsewhere is one a
  // reader stops trusting.
  'user',
  // harness loaders: print the vendor facts (order, caps, imports, hooks and MCP
  // config) without measuring a repository. The measurement is the other mode; this is
  // the one that answers "what does this reader do", which does not depend on the repo.
  'table',
  // sync: name every line the inferability filter dropped and the evidence behind it
  //. Off by default because a count is enough to act on; the per-line
  // detail is what an author needs, and a reader is not an author.
  'explain',
  // check: the lock must match. Off by default because a repository that has not
  // written one yet is not drift, and a gate that failed for the absence would be
  // red on every repository this package already adopted.
  'frozen',
  // compare: show the estate learning block even when no ledger run, hook denial or
  // no-value section would have surfaced it. The changelog documented the flag before
  // the parser accepted it, so the one reader who followed it got a usage warning.
  'learn',
  // map: report gold-file recall@10 instead of rendering the ranking. Off by
  // default because the ranking is the answer a task asked for, and the recall
  // figure needs the hidden benchmark patches.
  'recall',
  // tests: also list files that only changed in the same commits as a test.
  // Off by default because a shared commit is not a test.
  'cochange',
  // gate: read the working-tree diff instead of the paths named after the command.
  // Off by default because a path is the change the caller named, and the diff
  // is a different question.
  'changed',
  // tests: `--run` asks the gate's question — the tests a change reaches — under the
  // name that already means tests, so a reader does not have to learn a second verb.
  'run',
  // local doctor: allow non-loopback model URLs. Off by default because nothing leaves
  // the machine unless explicitly overridden (ADR-075).
  'allow-remote',
  // index / map / brief: opt into local vector embeddings configured under local.embed
  //. Off by default unless recall@10 gains at least 10 points.
  'embed',
  // distill: regenerate a proposal that is already cached. Off by default because
  // the cache is the point - the same source at the same budget is the same answer,
  // and re-reading it is cheaper than re-deriving it.
  'refresh',
  // pack lint: reject a pack whose bench summary is missing or unmeasured.
  // Off by default because a scaffold is born unmeasured - `pack new` writes a
  // bench.json marked unmeasured, and a lint that failed it on arrival would make
  // every new pack red before its author wrote the rule.
  'require-measured',
  // bench mine: restore the old "reflect exactly this history" semantics by
  // deleting task files the current history does not reproduce. Off by default
  // because mining is append-only.
  'replace',
  // distill: propose the summary from the configured local chat model instead of
  // the deterministic outline. Off by default: no model in the default path (P1),
  // and a model that is not asked for should not be opened against (ADR-090).
  'local',
  // doctor: apply the remedies flagged safe (local, idempotent, journaled) and
  // list the rest. Off by default because a repair, however safe, is still a
  // write, and a command whose name is a diagnosis should not write by default.
  'fix',
  // status: print the one-line gate summary from the last check. Off by
  // default because the only mode this command has is the line; bare `status`
  // is a usage error naming it, the way `plan` without a subcommand is.
  'line',
  // every writer: print the plan as unified diffs. Off by default because a
  // plan report is the compact answer and the diff is the verbose one; --diff
  // never changes what the run writes or its exit code, only what it shows.
  'diff',
  // plan archive: close a document with rows still open. The refusal is the default
  // because an archived unfinished plan stops being counted as work.
  'force',
]);

export const VALUE_FLAGS = new Set([
  'budget',
  // bench critic: the labelled set of historical diffs to score.
  // A path, not a switch, because the labels themselves come from a human under
  // ADR-008 — the tool never annotates for them.
  'labels',
  'max-bytes',
  'paths',
  'skill',
  'task',
  // plan next: stay inside one tier, or one wave, or both. A value, not a switch,
  // because the answer to "which tier" is the whole question.
  'tier',
  'lane',
  // plan next: a subsystem with a file set of its own, so two lanes can run at once.
  'wave',
  'workspace',
  'root',
  // skills/graph: which registry to read. A value rather than a boolean because
  // "a registry" without a path would have to guess, and the guess is the
  // defect a guess would reintroduce.
  'registry',
  // compare: how many repository rows to build at once.
  // A count, not a switch, because "parallel" without a cap is the burst this
  // flag exists to prevent.
  'concurrency',
  // skills install: which body of a multi-variant skill, and which source when the
  // bytes alone do not identify one.
  'variant',
  'from',
  'surfaces',
  // graph lint: which specification to check the skills against. A value rather than a
  // boolean because "lint against the spec" would not say WHICH spec, and a lint that
  // silently applied an unnamed set of rules is the decoration this repository exists
  // to refuse. One is on offer today, so the command rejects any other by name.
  'spec',
  // harness loaders: which reader to report. A value rather than a boolean because
  // "--loader" would not say WHICH loader, and a report that silently applied to all
  // of them would be decoration that misdescribes the artefact.
  'reader',
  // harness loaders: measure as if the agent were standing here. The chain rows walk
  // the project root down to the working directory, so this is what makes them mean
  // anything beyond the root document.
  'at',
  // tokens: split a local Claude Code or Codex session transcript into rules, file
  // reads and tool output. Local paths only (ADR-075).
  'session',
  // bench run / report: arms, harness adapter, model id, repetition count, regrade target and arm comparison.
  'arm',
  'harness',
  'model',
  'reps',
  'regrade',
  'compare',
  // plan done: the test command that proves the slice.
  'test',
  'state',
  // slice finish: the Conventional Commits type for the commit it makes. A value,
  // not a boolean, because a row title cannot say whether the slice was a feat, a
  // fix or a chore, and deriving it from the words would be a guess no reader of
  // the message could argue with.
  'type',
  // lease: how long the claim lasts, in seconds. A value, because "a lease is short"
  // is not a number any reader can act on, and an expiry nobody chose is an expiry
  // nobody can plan around.
  // lessons capture: how long a captured candidate stays eligible. A value, because a
  // default would be a deadline nobody chose.
  'expires',
  'ttl',
  // map: outline (paths), names (exported symbols) or signatures (the line).
  // A boolean would not say which of the three the caller wanted.
  'level',
  // decide: structured supersession spec (ADR-NNN or ADR-NNN:<ruling>[:<kind>], repeatable).
  'supersedes',
  // pack new: where the pack's bytes come from. Required, because a pack without
  // a source is bytes nobody can obtain again - and a source nobody can act on
  // is refused by lint rather than blessed.
  'source',
  // plugin: where the generated package lands. A value rather than a boolean because
  // "generate a package" with no destination would have to guess, and a guess about where
  // a directory tree goes is the one failure that leaves files behind.
  'out',
  // pr-body: the ref the body diffs against. A value, because the fork point is a
  // name only the author's branch knows, and the default (origin/main, then main)
  // is a guess the report states out loud rather than a question it asks.
  'base',
  // slice start: the id for a prompt slice, overriding the slug derived from the
  // prompt text. A value, because the derived slug is a guess a reader may want to
  // pin, and a flag without a value would not say what to name the slice.
  'id',
]);

/**
 * Flags that accumulate rather than overwrite.
 *
 * `--skill` was documented as "(repeatable)" and was not: `flags.skill = value` meant
 * `--skill a --skill b` resolved to `b`, with `a` silently dropped. No error, no
 * warning, and a brief that quietly lacked a skill the caller named — which is the one
 * failure mode a tool whose job is to be explainable cannot have (ADR-009, "the answer
 * is a function of what was asked").
 *
 * Comma separation still works, because the consumer splits on commas either way. This
 * is a superset of the old behaviour, not a replacement: `--skill a,b` parsed before it
 * parses now.
 */
export const REPEATABLE_FLAGS = new Set(['skill', 'arm', 'compare', 'supersedes']);

/**
 * Whether a raw argv asks for JSON, read before parsing succeeds.
 *
 * A parse failure is still a result the caller may need as JSON , but the
 * parsed flags do not exist yet — so the dispatcher reads the spelling straight
 * off argv. Only the exact `--json` spelling counts, and nothing past `--` does:
 * a positional that happens to read `--json` is a path, not a flag.
 */
export function rawJsonFlag(argv) {
  for (const arg of argv) {
    if (arg === '--') break;
    if (arg === '--json') return true;
    if (arg === '--no-json') return false;
  }
  return false;
}

/**
 * @param {string[]} argv raw arguments, excluding node and the script path
 * @returns {{ok: true, value: object} | {ok: false, error: {message: string, code: number}}}
 *
 * A failure is data, never output: reporting it is the caller's job, because only
 * the caller knows whether `--json` was asked for . Nothing here prints.
 */
export function parse(argv) {
  const flags = {};
  const positional = [];
  let passthrough = false;
  // `--` is consumed as a separator, but its presence is a fact a command may need:
  // `slice start -- "<text>"` reads the prompt as everything after the marker, and a
  // positional that merely happens to sit there is a different command. Carried as a
  // flag so it reaches the command the way every other parsed fact does.
  let dashdash = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (passthrough || !arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    if (arg === '--') {
      passthrough = true;
      dashdash = true;
      continue;
    }

    const eq = arg.indexOf('=');
    const raw = (eq === -1 ? arg : arg.slice(0, eq)).slice(2);
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);

    if (raw.startsWith('no-')) {
      const positive = raw.slice(3);
      if (!BOOL_FLAGS.has(positive)) {
        return { ok: false, error: usage(`unknown flag --${raw}`) };
      }
      flags[camel(positive)] = false;
      continue;
    }
    if (BOOL_FLAGS.has(raw)) {
      if (inlineValue !== undefined) {
        return { ok: false, error: usage(`--${raw} takes no value`) };
      }
      flags[camel(raw)] = true;
      continue;
    }
    if (VALUE_FLAGS.has(raw)) {
      const value = inlineValue ?? argv[i + 1];
      if (value === undefined || (inlineValue === undefined && value.startsWith('--'))) {
        return { ok: false, error: usage(`--${raw} requires a value`) };
      }
      if (inlineValue === undefined) i += 1;
      if (raw === 'budget' || raw === 'max-bytes') {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0) {
          return { ok: false, error: usage(`--${raw} must be a non-negative integer, received ${value}`) };
        }
        flags[camel(raw)] = n;
      } else if (raw === 'reps') {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
          return { ok: false, error: usage(`--reps must be a positive integer, received ${value}`) };
        }
        flags.reps = n;
      } else {
        const key = camel(raw);
        if (REPEATABLE_FLAGS.has(raw)) {
          flags[key] = [...(Array.isArray(flags[key]) ? flags[key] : []), value];
        } else if (flags[key] !== undefined) {
          // `--root a --root b` kept `b`, so half of what the caller asked for vanished
          // with no error and no way to tell which half. Only a flag declared repeatable
          // accumulates; a second value for any other is a usage error.
          return {
            ok: false,
            error: usage(
              `--${raw} was given twice; it takes one value (repeatable: ${[...REPEATABLE_FLAGS]
                .map((name) => `--${name}`)
                .join(', ')})`,
            ),
          };
        } else {
          flags[key] = value;
        }
      }
      continue;
    }
    return { ok: false, error: usage(`unknown flag --${raw}`) };
  }

  if (dashdash) flags.dashdash = true;
  return { ok: true, value: { flags, positional } };
}

export function parsePathList(value) {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `--max-bytes` -> `maxBytes`. Callers use camelCase; users type kebab-case. */
function camel(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function usage(message) {
  return { message, code: EXIT.USAGE };
}
