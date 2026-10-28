// The policies an agent-time hook enforces, in one table.
//
// One table and four harnesses. The renderers in ./render.mjs map a harness's own
// payload onto the facts named here and a decision back onto that harness's own JSON,
// so a policy is written once and cannot be enforced in one harness and forgotten in
// another — which is the failure the four vendor documents make easy: they agree on
// nothing, not the config path, not the shape, not the name of the tool that runs a
// shell command (Bash, Shell, run_command), not the key holding the command, not the
// JSON the hook answers with. Every one of those differences lives in the renderer
// beside the vendor page it was read from; the table only knows facts.
//
// The facts are deliberately few: the shell command an agent is about to run, and the
// path it is about to write. A payload the renderer cannot recognise yields no facts,
// and no fact is not a violation — guessing from a shape we did not read would block
// real work in a harness whose payload changed under us.
//
// The messages are the bytes an author reads while being stopped, so each one names
// the rule, the record that settled it, and the override that lifts it. An override
// nobody is told about is a policy the author learns to route around instead of one
// they can ask about.

import { CLI } from '../name.mjs';
import { HOOKS_DIR, HOOKS_PATH_KEY } from '../hooks/shim.mjs';

/**
 * The events an agent-time hook can answer, normalised across harnesses.
 *
 * `pre-tool-use` is a decision: a payload in, a deny or nothing out, and exit 2 means
 * block. `prompt-submit` is a delivery: the same payload shape in, context out, and it
 * never denies anything — a hook that could stop a person's prompt would be a hook whose
 * own bug is a person who cannot type (R29). `post-tool-use` recalls a lesson as one
 * paragraph when a tool call fails with a signature matching `docs/lessons/*.md` (R33).
 */
export const EVENTS = ['pre-tool-use', 'prompt-submit', 'post-tool-use'];

/** The environment variable that lifts named policies for one session. */
export const ALLOW_ENV = 'SIMT_ALLOW';

/**
 * The environment variable that names the session a claim was filed under and the
 * session an edit is asked for (R54).
 *
 * One name in both places on purpose: a denial is only explainable if the session the
 * hook protected is the same name `simt lease` recorded, and two spellings would drift
 * into a refusal nobody can reconcile with a claim that exists.
 */
export const SESSION_ENV = 'SIMT_SESSION';

/**
 * One row per policy.
 *
 * `inspects` names the fact the matcher is handed, and `match` the condition. A command
 * row carries two matchers because the facts come in two states: `match` reads the
 * normalised command - the shell tokenised, wrappers unwrapped, each git invocation
 * reduced to subcommand and options (ADR-104) - and `regex` is the fallback that runs
 * when the command cannot be tokenised at all, so a parse failure never weakens a
 * policy. Facts that were never normalised - a test that hands `decide` a bare command
 * string - also take the fallback, which is why it stays in the table rather than
 * beside the tokenizer. The `generated` row has no matcher because what it asks — does
 * this file hold bytes this tool generates — is answered by reading the file, not by
 * the text of a payload.
 *
 * Order matters where two policies match one command: `git push --force` is both a
 * push and a rewrite, so both are reported and both have to be lifted before it runs.
 */
const POLICIES = [
  {
    id: 'push',
    adr: 'ADR-001',
    event: 'pre-tool-use',
    inspects: 'command',
    match: (facts) => facts.shell.facts.some((f) => f.kind === 'git' && (f.sub === 'push' || f.sub === 'send-pack')),
    regex: /(?:^|[\s;&|(])git\s+push(?:\s|$)/,
    message: `Push needs explicit approval (ADR-001); ask the user.`,
  },
  {
    id: 'rewrite',
    adr: 'ADR-017',
    event: 'pre-tool-use',
    inspects: 'command',
    match: (facts) =>
      facts.shell.facts.some((f) => {
        if (f.kind !== 'git') return false;
        if (f.opts.has('--no-verify')) return true;
        if (f.sub === 'commit' && (f.opts.has('--amend') || f.opts.has('n'))) return true; // -n is --no-verify
        if (f.sub === 'reset' && f.opts.has('--hard')) return true;
        if (f.sub === 'rebase') return true;
        if (f.sub === 'pull' && f.opts.has('--rebase')) return true; // pull --rebase rebases
        return (
          (f.sub === 'push' || f.sub === 'send-pack') &&
          (f.opts.has('--force') || f.opts.has('f') || f.refspecs.some((r) => r.startsWith('+')))
        );
      }),
    regex:
      /--no-verify|git\s+commit\b[^;&|]*\s--amend|git\s+reset\s+--hard|git\s+rebase\b|git\s+push\b[^;&|]*(?:--force\b|\s-f\b)/,
    message:
      `Never amend, rebase, reset --hard, force-push or --no-verify unless asked; ` +
      `each is the escape that turns the declared gates into a suggestion (ADR-017).`,
  },
  {
    id: 'hooks-disable',
    adr: 'ADR-104',
    event: 'pre-tool-use',
    inspects: 'command',
    // No regex fallback: before ADR-104 this policy did not exist, so a command that
    // cannot be tokenised is judged exactly as it was judged before this row was written.
    regex: null,
    match: (facts) => {
      const dir = (a) => a.replace(/^\.\/+/, '').replace(/\/+$/, '');
      const key = HOOKS_PATH_KEY.toLowerCase(); // config keys are case-insensitive in git
      return facts.shell.facts.some((f) => {
        if (f.kind === 'git') {
          if (f.globals.c.some((s) => s.toLowerCase().startsWith(`${key}=`))) return true;
          if (f.sub === 'config' && f.refspecs.some((r) => r.toLowerCase() === key || r.toLowerCase().startsWith(`${key}.`))) return true;
          return false;
        }
        if (f.kind === 'rm') return f.args.some((a) => dir(a) === HOOKS_DIR || dir(a).startsWith(`${HOOKS_DIR}/`));
        return false;
      });
    },
    message:
      `That removes or reroutes the git hooks this repository's gates run in, so the gates would stop ` +
      `running without anyone saying so; if it is deliberate, run \`${CLI} hooks install --yes\` afterwards (ADR-104).`,
  },
  {
    id: 'generated',
    adr: 'ADR-036',
    event: 'pre-tool-use',
    inspects: 'write',
    match: null,
    message:
      `That file carries bytes this tool generates, so an edit there is overwritten on the next ` +
      `write; edit the source the region comes from, then run \`${CLI} sync --yes\` (ADR-036).`,
  },
  {
    id: 'lease',
    adr: 'ADR-101',
    event: 'pre-tool-use',
    inspects: 'lease',
    match: null,
    message: `That path is leased by another session (ADR-101); wait for its TTL or ask the holder to release it.`,
    // The only row whose message is not a constant: what the blocked session needs to
    // hear — which path, whose, until when — is read from the claim file at decision
    // time, and a static row cannot carry a timestamp it has never seen.
    detail: (facts, env) => {
      if (facts.leaseError) return `${facts.leaseError}; fix or remove it so the claims are readable`;
      const mine = env[SESSION_ENV] ?? '';
      const held = (facts.writes ?? [])
        .filter((w) => w.lease && w.lease.session !== mine)
        .map((w) => `${w.path} held by ${w.lease.session} until ${new Date(w.lease.expiresAt).toISOString()}`);
      return held.length > 0 ? `held: ${held.join('; ')}` : '';
    },
  },
];

/** The policy ids, in table order: the vocabulary an override is checked against. */
export const POLICY_IDS = POLICIES.map((p) => p.id);

/** The rows for one event, so a renderer and the table cannot disagree about events. */
export function policiesFor(event) {
  return POLICIES.filter((p) => p.event === event);
}
