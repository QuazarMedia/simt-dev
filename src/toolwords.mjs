// The `simt-` names this tool owns, and the records that argue about the prefix itself.
//
// Two readers need to tell this tool's own vocabulary from a repository in the estate
// these records were written about: the decision reader, which redacts the second kind
// and names it, and the guard on shipped text, which refuses to ship it. Both answered
// the question with a shape — `simt-` followed by anything but `dev` — and the shape is
// false about the tool's own names, which the corpus prints. `rules why ADR-073` reported
// that the ruling surveyed `simt-priority` as a repository, and printed the same word as
// `a repository: hard | command | convention | style` where the record says
// `simt-priority: hard | command | convention | style`: a reader with the tool and not
// the estate got a sentence with no subject, from the command whose whole job is to
// explain a citation.
//
// The words are derived from the modules that own them (ADR-022) rather than listed
// here, because a second list is a list that drifts and then forgives. Both readers read
// this one, and a name added to a frontmatter vocabulary reaches both without an edit.
import { KNOWN_KEYS } from './projection/mdc.mjs';
import { PROFILE_KEYS } from './projection/rules.mjs';
import { INFERABLE_MARKER } from './kernel/inferability.mjs';
import { CHECK_MARKER } from './kernel/checks.mjs';
import { VARIANTS_MARKER } from './kernel/variants.mjs';
import { LESSON_KEYS } from './memory/lessons.mjs';
import { DECISION_KEYS } from './memory/decide.mjs';
import { PROMPT_WORDS } from './mcp/prompts.mjs';

/**
 * `simt-` names that belong to this tool and never to a repository.
 *
 * The three markers and the four suffixed names are not frontmatter: they are names this
 * tool writes into files it adopts a repository into — the package, the gate file it puts
 * in `.github`, the hooks directory it points `core.hooksPath` at, and the two prompts it
 * serves over MCP, derived from the module that owns them. `simt-dev` itself is here for
 * the same reason the estate pattern exempts it, and stating it once here is what stops
 * the two readers from disagreeing about the tool's own name.
 */
export const TOOL_WORDS = new Set([
  ...KNOWN_KEYS,
  ...PROFILE_KEYS,
  ...LESSON_KEYS,
  ...DECISION_KEYS,
  ...PROMPT_WORDS,
  INFERABLE_MARKER,
  CHECK_MARKER,
  VARIANTS_MARKER,
  'simt-dev',
  'simt-dev-check',
  'simt-hooks',
]);

/**
 * Records whose subject is the prefix itself, so the prefixed names in them are the
 * argument rather than a citation.
 *
 * Each entry is a file and a reason, never a repository. That distinction is the whole
 * point: an exemption says "this document discusses the namespace", which is a fact
 * about this tool and carries nothing about whoever uses it. A vocabulary cannot settle
 * these two — a hypothetical key in an argument and a repository name are the same shape
 * — so the file is exempted where the word cannot be.
 *
 * The guard fails on a stale entry: each one must still be tripping the rule, so an
 * exemption that stops being needed is removed rather than kept as a precedent.
 */
export const PREFIX_ARGUING = new Map([
  [
    'ADR-022-a-key-simt-dev-reads-is-prefixed.md',
    'is the record arguing for the prefix, using hypothetical keys as examples',
  ],
  [
    'ADR-026-a-config-without-a-region-is-a-file-the-repo-owns.md',
    'names one prefixed key to record Dependabot rejecting it',
  ],
  [
    'ADR-080-the-tools-own-names-are-not-repositories-and-neither-reader-decides-by-shape.md',
    'quotes the prefixed names it measured, which are its evidence rather than a citation',
  ],
  [
    'ADR-081-a-tracker-is-read-through-the-repositorys-template.md',
    'names the plan overlay file the next record withdraws, and that filename has the shape of a repository',
  ],
]);
