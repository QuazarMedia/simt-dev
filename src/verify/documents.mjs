// Document validators and generation contracts (W25).
//
// A documentation repository has quality controls that are not unit tests: a format check, a
// link check, a rubric, a reviewer, a model's judgement. Each is useful and none of them is
// interchangeable, so this module keeps them apart instead of summing them into a score:
//
//   * A rubric matrix routes a document to the rubrics declared for its most specific pattern.
//     A less specific mapping does not also apply, an explicitly unmapped document says so
//     with a reason, and two equally specific mappings are an error rather than a guess.
//   * Deterministic checks, human review and model judgement are separate bases. A human
//     requirement is not satisfied by a model, and two model judges from the same provider are
//     not independent however different their model names are.
//   * Semantic evidence is pinned to the rubric, the prompt and the input it was produced
//     under. Change any of them and the evidence is stale, not merely older.
//   * A claim is not proved by a link being reachable or by a domain being authoritative. It is
//     proved by an excerpt that states it.
//   * A generation contract pins the template, the required sections, the source scope and the
//     representations, and a generated document is checked against all four.
//
// The module is pure: no filesystem, no clock, no network. A link check's result arrives as a
// record; this module decides what that record is worth.

export const DOCUMENTS_SCHEMA_VERSION = 1;
export const GENERATION_SCHEMA_VERSION = 1;

/** The three bases an assessment can rest on, weakest separation first. */
export const CHECK_KINDS = Object.freeze(['deterministic', 'human-review', 'model-judgement']);

const isText = (value) => typeof value === 'string' && value.length > 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** How specific a mapping pattern is: literal segments first, then length. */
function specificity(pattern) {
  const segments = String(pattern).split('/').filter((segment) => segment.length > 0);
  const literal = segments.filter((segment) => !segment.includes('*')).length;
  return literal * 1000 + segments.length;
}

function glob(pattern) {
  const source = String(pattern)
    .split('/')
    .map((segment) => {
      if (segment === '**') return '.*';
      return segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    })
    .join('/');
  return new RegExp(`^${source}$`);
}

/**
 * Route one document to exactly the rubrics its most specific mapping declares.
 *
 * @param {{document: string, matrix?: object[], rubrics?: string[]}} input
 */
export function selectRubrics({ document, matrix = [], rubrics = [] } = {}) {
  const path = isText(document) ? document : '';
  const catalogue = new Set((Array.isArray(rubrics) ? rubrics : []).filter(isText));
  const matches = (Array.isArray(matrix) ? matrix : [])
    .filter((mapping) => isObject(mapping) && isText(mapping.match?.pattern) && glob(mapping.match.pattern).test(path))
    .map((mapping) => ({ mapping, rank: specificity(mapping.match.pattern) }));
  const problems = [];

  if (matches.length === 0) {
    return { document: path, mapping: null, rubrics: [], excluded: [], unmapped: true, reason: 'no-mapping', problems };
  }

  const top = Math.max(...matches.map((entry) => entry.rank));
  const winners = matches.filter((entry) => entry.rank === top);
  if (winners.length > 1) {
    problems.push({
      code: 'ambiguous-mapping',
      detail: `${path} matches ${winners.map((entry) => entry.mapping.id ?? entry.mapping.match.pattern).join(', ')} equally specifically`,
      remedy: 'make one pattern more specific, or name the rubrics on a single mapping',
    });
    return { document: path, mapping: null, rubrics: [], excluded: [], unmapped: false, reason: null, problems };
  }

  const mapping = winners[0].mapping;
  const declared = (Array.isArray(mapping.rubrics) ? mapping.rubrics : []).filter(isText);
  const excludes = (Array.isArray(mapping.excludeRubrics) ? mapping.excludeRubrics : []).filter(isText);
  const unknown = declared.filter((rubric) => catalogue.size > 0 && !catalogue.has(rubric));
  for (const rubric of unknown) {
    problems.push({ code: 'unknown-rubric', detail: `${rubric} is not in the rubric catalogue`, remedy: `declare ${rubric}, or fix the mapping that names it` });
  }

  const chosen = declared.filter((rubric) => !excludes.includes(rubric)).sort();
  const unmapped = chosen.length === 0;
  return {
    document: path,
    mapping: mapping.id ?? mapping.match.pattern,
    rubrics: chosen,
    excluded: excludes.filter((rubric) => declared.includes(rubric)).sort().map((rubric) => ({ rubric, reason: 'excluded-by-mapping' })),
    unmapped,
    reason: unmapped ? 'explicitly-unmapped' : null,
    problems,
  };
}

/** Whether two judges could have reached their conclusions independently. */
function independentPair(a, b) {
  if (isText(a.reviewer) && a.reviewer === b.reviewer) return { independent: false, reason: 'same-reviewer' };
  if (isText(a.provider) && a.provider === b.provider) {
    // A different model name from the same provider is a different model, not a second
    // opinion: the same corpus, the same policy and the same failure modes produced it.
    return { independent: false, reason: 'same-provider' };
  }
  if (isText(a.attestation?.digest) && a.attestation?.digest === b.attestation?.digest) return { independent: false, reason: 'shared-attestation' };
  return { independent: true, reason: 'independent' };
}

/**
 * Evaluate required judgements against the judges actually recorded.
 *
 * @param {{required?: object[], judges?: object[]}} input
 */
export function evaluateJudges({ required = [], judges = [] } = {}) {
  const pool = (Array.isArray(judges) ? judges : []).filter((judge) => isObject(judge) && isText(judge.id));
  const satisfied = [];
  const unavailable = [];

  for (const requirement of Array.isArray(required) ? required : []) {
    if (!isObject(requirement) || !isText(requirement.id)) continue;
    const ofKind = pool.filter((judge) => judge.kind === requirement.kind);
    if (ofKind.length === 0) {
      const modelsOnly = requirement.kind === 'human-review' && pool.some((judge) => judge.kind === 'model-judgement');
      unavailable.push({
        requirement: requirement.id,
        reason: modelsOnly ? 'model-judgement-is-not-human-review' : 'no-judge',
      });
      continue;
    }
    const attested = ofKind.filter((judge) => isText(judge.attestation?.digest));
    if (attested.length === 0) {
      unavailable.push({ requirement: requirement.id, reason: 'unattested-judge' });
      continue;
    }
    if (requirement.needsIndependence === true) {
      const pairs = [];
      for (let i = 0; i < attested.length; i += 1) {
        for (let j = i + 1; j < attested.length; j += 1) pairs.push({ a: attested[i].id, b: attested[j].id, ...independentPair(attested[i], attested[j]) });
      }
      if (!pairs.some((pair) => pair.independent)) {
        unavailable.push({ requirement: requirement.id, reason: pairs.length === 0 ? 'no-judge' : 'insufficient-independent-judges' });
        continue;
      }
      satisfied.push({ requirement: requirement.id, judges: attested.map((judge) => judge.id), pairs });
      continue;
    }
    satisfied.push({ requirement: requirement.id, judges: attested.map((judge) => judge.id), pairs: [] });
  }

  return { satisfied, unavailable };
}

/**
 * Invalidate semantic evidence whose rubric, prompt or input has changed.
 *
 * Deterministic evidence has no prompt: a prompt change cannot make a format check wrong. A
 * rubric change can, because the rubric is what the check was built to satisfy.
 *
 * @param {object[]} evidence
 * @param {{rubricDigest?: string, promptDigest?: string, inputDigest?: string}} current
 */
export function invalidateSemantic(evidence = [], { rubricDigest = null, promptDigest = null, inputDigest = null } = {}) {
  return (Array.isArray(evidence) ? evidence : [])
    .filter((item) => isObject(item) && isText(item.id))
    .map((item) => {
      const basis = isText(item.basis) ? item.basis : 'model';
      if (isText(rubricDigest) && item.rubricDigest !== rubricDigest) return { id: item.id, basis, stale: true, reason: 'rubric-changed' };
      if (basis !== 'deterministic' && isText(promptDigest) && item.promptDigest !== promptDigest) return { id: item.id, basis, stale: true, reason: 'prompt-changed' };
      if (basis !== 'deterministic' && isText(inputDigest) && item.inputDigest !== inputDigest) return { id: item.id, basis, stale: true, reason: 'input-changed' };
      return { id: item.id, basis, stale: false, reason: null };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Whether a source actually supports a claim.
 *
 * Reachability and an authoritative domain are properties of a publisher, not of a statement.
 * Support needs an excerpt, and the excerpt has to state the claim.
 *
 * @param {{claim: object, sources?: object[]}} input
 */
export function assessClaimSupport({ claim = {}, sources = [] } = {}) {
  const wanted = claim.value === undefined || claim.value === null ? null : String(claim.value);
  const statement = isText(claim.statement) ? claim.statement.normalize('NFKC').toLowerCase() : null;
  const examined = [];
  const reasons = [];

  for (const source of Array.isArray(sources) ? sources : []) {
    if (!isObject(source) || !isText(source.id)) continue;
    if (!isText(source.quote)) {
      examined.push({ id: source.id, used: false, reason: 'no-excerpt' });
      continue;
    }
    const quote = source.quote.normalize('NFKC').toLowerCase();
    if (wanted !== null && !quote.includes(wanted.toLowerCase())) {
      examined.push({ id: source.id, used: false, reason: 'quote-does-not-state-claim' });
      continue;
    }
    if (wanted === null && statement !== null && !quote.includes(statement)) {
      examined.push({ id: source.id, used: false, reason: 'quote-does-not-state-claim' });
      continue;
    }
    examined.push({ id: source.id, used: true, reason: 'excerpt-states-the-claim' });
  }

  const supported = examined.some((entry) => entry.used);
  if (!supported) {
    const consulted = (Array.isArray(sources) ? sources : []).filter(isObject);
    if (consulted.some((source) => source.reachable === true)) reasons.push('a reachable link is not evidence of the statement');
    if (consulted.some((source) => source.authoritative === true)) reasons.push('an authoritative domain names a publisher, not a statement');
    if (examined.length === 0) reasons.push('no source was examined');
  }

  return { supported, sources: examined.sort((a, b) => a.id.localeCompare(b.id)), reasons };
}

const problem = (code, detail, remedy) => ({ code, detail, remedy });

/**
 * Check a generated document against its generation contract.
 *
 * @param {object} output
 * @param {object} contract
 */
export function checkGeneration(output = {}, contract = {}) {
  const problems = [];
  const pinned = isObject(contract.template) ? contract.template : null;
  if (pinned === null || !isText(pinned.id) || !isText(pinned.digest)) {
    problems.push(problem('no-template', 'the contract names no template with a digest', 'pin the template id and the digest of the bytes it produced'));
  } else {
    if (output.template?.id !== pinned.id) {
      problems.push(problem('template', `the output came from ${JSON.stringify(output.template?.id ?? null)}, the contract pins ${pinned.id}`, `generate from ${pinned.id}`));
    } else if (output.template?.digest !== pinned.digest) {
      problems.push(problem('template-drift', 'the template digest has changed since the contract was written', 're-review the template, then re-pin the contract and regenerate'));
    }
  }

  const present = new Set((Array.isArray(output.sections) ? output.sections : []).map((section) => section?.heading).filter(isText));
  for (const heading of (Array.isArray(contract.sections) ? contract.sections : []).filter(isText)) {
    if (!present.has(heading)) problems.push(problem('missing-section', `${heading} is required by the contract and absent from the output`, `add the ${heading} section, or change the contract`));
  }

  const scope = (Array.isArray(contract.sourceScope) ? contract.sourceScope : []).filter(isText).map(glob);
  for (const source of (Array.isArray(output.sources) ? output.sources : []).filter(isText)) {
    if (scope.length > 0 && !scope.some((pattern) => pattern.test(source))) {
      problems.push(problem('source-out-of-scope', `${source} is outside the contract's source scope`, 'generate from the declared scope, or widen the scope deliberately'));
    }
  }

  const allowed = new Set((Array.isArray(contract.representations) ? contract.representations : []).filter(isText));
  if (allowed.size > 0 && !allowed.has(output.representation)) {
    problems.push(problem('representation', `${JSON.stringify(output.representation ?? null)} is not a declared representation`, `produce one of ${[...allowed].join(', ')}`));
  }

  return { version: GENERATION_SCHEMA_VERSION, ok: problems.length === 0, problems };
}
