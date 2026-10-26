// Two prompt templates for the two jobs this server exists for.
//
// A prompt is a message template, not an answer. The server is read-only, so a prompt
// cannot implement anything either: what it CAN do is hand a calling agent a working set
// of instructions that name the tools to call and the order to call them in, which is the
// part a model otherwise has to discover by trial. The text therefore speaks ABOUT the
// tools and never runs them.

/**
 * `simt-brief`: start a task from the pre-assembled packet.
 *
 * The brief tool is the entry point every other surface points at, so the one prompt a
 * client needs before it knows the model is "start there". Required `task` degrades to a
 * visible placeholder rather than an error: a client that ignored the `required` flag at
 * least gets a message that says so instead of a broken stream, and the agent reading it
 * knows to ask before calling anything.
 */
const SIMT_BRIEF = {
  name: 'simt-brief',
  title: 'Work a task from the simt brief',
  description: 'Start a task from the pre-assembled brief packet, and work from what it selected and why.',
  arguments: [
    { name: 'task', description: "the task, in the user's own words", required: true },
  ],
};

/**
 * `simt-slice`: implement one slice of the working plan.
 *
 * `id` is optional and omission is the DEFAULT reading - the next slice whose
 * dependencies are complete is what "implement the next slice" means, and a plan whose
 * numbering a reader does not know yet has no id to give.
 */
const SIMT_SLICE = {
  name: 'simt-slice',
  title: 'Implement a plan slice',
  description: 'Implement the next ready slice of the working plan, or the named one.',
  arguments: [
    { name: 'id', description: 'slice id; omitted means the next ready one', required: false },
  ],
};

export const PROMPTS = [SIMT_BRIEF, SIMT_SLICE];

/**
 * The prompt names as words, exported for the tool-vocabulary derivation in
 * `src/toolwords.mjs`: a name this tool serves over MCP is this tool's own name, and the
 * estate guard that reads that derivation would otherwise read `simt-brief` the way it
 * reads a repository (ADR-080).
 */
export const PROMPT_WORDS = PROMPTS.map((prompt) => prompt.name);

/**
 * The prompt named, or null when there is no such name.
 *
 * `null`, not a throw: the caller decides what a missing prompt is worth (the server
 * answers with the method error a client expects), and `getPrompt` stays a lookup.
 */
export function getPrompt(name, args = {}) {
  const brief = name === SIMT_BRIEF.name;
  const slice = name === SIMT_SLICE.name;
  if (!brief && !slice) return null;

  // Prompts degrade on missing arguments instead of failing: a template with an unfilled
  // variable is still readable, and the agent it reaches is exactly the one that can ask
  // the user what was meant.
  const id = typeof args?.id === 'string' && args.id.length > 0 ? args.id : null;
  const text = brief
    ? briefText(typeof args?.task === 'string' && args.task.trim() !== '' ? args.task : null)
    : sliceText(id);

  return {
    description: brief ? SIMT_BRIEF.description : SIMT_SLICE.description,
    messages: [{ role: 'user', content: { type: 'text', text } }],
  };
}

function briefText(task) {
  const ask = task ?? '(none given - ask the user what to work before calling anything)';
  return `Work the task through this repository's simt tools before touching code.

The task: ${ask}

1. Call the \`brief\` tool with this task. It returns the pre-assembled packet: the kind
   of task, the commands that kind needs, the files the index ranks highest, the tests
   covering them, the decisions governing them and the skills that apply.
2. Work from the packet. Where something you need was cut to fit the budget, the packet
   names the tool that fetches it - call that tool instead of guessing.
3. Make the change, then prove it by running the packet's focused test before anything
   broader.

Report what changed and the evidence, not a summary of the effort.
`;
}

function sliceText(id) {
  const ask = id
    ? `id ${id}`
    : 'the next one whose dependencies are complete';
  const lead = id
    ? `Call the \`plan_next\` tool with id "${id}" for the design and acceptance checks of exactly that slice.`
    : 'Call the `plan_next` tool with no id: it returns the next queued slice whose dependencies are complete, with that slice\'s design section only.';
  return `Implement one slice of this repository's plan, reading it through the simt tools.

The slice: ${ask}

1. ${lead}
2. Read \`simt://kernel\` first: the rules this repository packs for its stack, and the
   ones it defers to \`simt rules show\`. They govern how you work here.
3. Implement in the design's language, writing the regression test its acceptance check
   asks for as you go. A slice is done when its checks hold, not when the code runs.
4. Run the tests the design names, then the full suite - the last both in place and
   from a copy at a path with no siblings, because a suite that only passes at home has
   not passed.
5. Commit locally with a conventional subject and a body that records why, and report
   the sha. Push only on explicit user approval.
`;
}
