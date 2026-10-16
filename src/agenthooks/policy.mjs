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

/** The events an agent-time hook can answer, normalised across harnesses. */
export const EVENTS = ['pre-tool-use'];

/** The environment variable that lifts named policies for one session. */
export const ALLOW_ENV = 'SIMT_ALLOW';

/**
 * One row per policy.
 *
 * `inspects` names the fact the matcher is handed, and `match` the condition. The
 * `generated` row has no matcher because what it asks — does this file hold bytes this
 * tool generates — is answered by reading the file, not by the text of a payload.
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
    match: /(?:^|[\s;&|(])git\s+push(?:\s|$)/,
    message: `Push needs explicit approval (ADR-001); ask the user.`,
  },
  {
    id: 'rewrite',
    adr: 'ADR-017',
    event: 'pre-tool-use',
    inspects: 'command',
    match:
      /--no-verify|git\s+commit\b[^;&|]*\s--amend|git\s+reset\s+--hard|git\s+rebase\b|git\s+push\b[^;&|]*(?:--force\b|\s-f\b)/,
    message:
      `Never amend, rebase, reset --hard, force-push or --no-verify unless asked; ` +
      `each is the escape that turns the declared gates into a suggestion (ADR-017).`,
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
];

/** The policy ids, in table order: the vocabulary an override is checked against. */
export const POLICY_IDS = POLICIES.map((p) => p.id);

/** The rows for one event, so a renderer and the table cannot disagree about events. */
export function policiesFor(event) {
  return POLICIES.filter((p) => p.event === event);
}
