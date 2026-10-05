// The matrix a `simt compare` row is built from: one repo's adoption state.
//
// The shape of a row answers one question - "would this repo behave correctly if
// an agent followed it today?" - from the four things that can make it not:
//
//   manifest   is the repo in the ecosystem at all?
//   region     does the committed projection match this simt-dev?
//   hooks      would a commit actually be gated?
//   gates      do the declared gates exist, and can they run?
//
// A repo can be adopted and still wrong (drifted region, missing hooks), which is
// the case a hand audit misses: the repo LOOKS done. That is why these are four
// columns and not one status.
//
// Ordering within a row is fixed. Output design (plan 0002 section 6) requires one
// fact per line in a stable field order so two runs diff cleanly; a row that
// reordered its columns would make every comparison between two runs unreadable.

import { checkTarget } from '../projection/project.mjs';
import { readManifest } from '../projection/manifest.mjs';
import { knownGates } from '../hooks/resolve.mjs';
import { fingerprint } from '../resolve/fingerprint.mjs';
import { readHooksState } from './hooksstate.mjs';

/**
 * @typedef {object} RepoRow
 * @property {string} name        directory name, the thing a human reads
 * @property {string} path
 * @property {'adopted'|'unmanaged'|'broken'} adoption
 * @property {string|null} id     manifest id, when declared
 * @property {string[]} stack
 * @property {string[]} facts
 * @property {string[]} profiles  profile ids that would be selected
 * @property {string|null} pinnedSha
 * @property {string|null} recordedSha
 * @property {'current'|'drift'|'unmanaged'|'absent'|'malformed'} region
 * @property {string|null} regionDetail
 * @property {boolean} hooksRouted   core.hooksPath points at the shared dispatcher
 * @property {boolean} hooksComplete every event installed, executable, not stale
 * @property {string[]} gatesDeclared
 * @property {string[]} gateProblems
 * @property {string[]} problems     everything wrong, one line each
 */

/**
 * Build one row. Never throws: a repo that cannot be read becomes a row with a
 * problem, because a dashboard that drops unreadable repos reports a smaller
 * estate than exists and the reader has no way to know.
 *
 * @param {string} path
 * @param {{expectedSha: string, gates: Set<string>}} context
 * @returns {Promise<RepoRow>}
 */
export async function buildRow(path, context) {
  const name = path.split('/').filter(Boolean).pop() ?? path;
  const problems = [];

  const [manifest, fp, hooks, region] = await Promise.all([
    readManifest(path),
    fingerprint(path),
    readHooksState(path),
    checkTarget(path),
  ]);

  const row = {
    name,
    path,
    adoption: 'unmanaged',
    id: manifest.manifest?.id ?? null,
    stack: fp.stack ?? [],
    declaredStack: manifest.manifest?.stack ?? [],
    facts: fp.facts ?? [],
    profiles: [],
    pinnedSha: manifest.manifest?.projection?.simtDevSha ?? null,
    recordedSha: region.recordedSha ?? null,
    region: region.status,
    regionDetail: region.detail ?? null,
    hooksRouted: hooks.routed,
    hooksComplete: hooks.complete,
    gatesDeclared: declaredGates(manifest.manifest),
    gateProblems: [],
    problems,
  };

  if (manifest.error) {
    problems.push(`simt-dev.json ${manifest.error}`);
  }

  // --- manifest ------------------------------------------------------------
  // An absent manifest is not a defect; it is the pre-adoption state, which is
  // the normal condition of most repos on day one of a migration. It is counted
  // and reported, never called a problem.
  if (!manifest.exists) {
    row.adoption = 'unmanaged';
  } else if (manifest.error) {
    row.adoption = 'broken';
  } else {
    row.adoption = 'adopted';
  }

  // --- region --------------------------------------------------------------
  // Only meaningful for an adopted repo. An unmanaged repo has no manifest, so
  // its `absent` region is a consequence of not having adopted, not a second
  // independent defect - reporting both would double-count one root cause.
  if (row.adoption === 'adopted') {
    if (region.status === 'drift') {
      // A drift has two causes with different fixes, and the SHA says which. When
      // the recorded SHA matches this simt-dev, the region was hand-edited and
      // `simt sync` is right; when it does not, the repo is simply behind and the
      // same command is also right - but the message must not claim a version
      // mismatch when the versions are identical, because that sends the reader
      // looking for a pin that is already correct.
      const sameSha = region.recordedSha === context.expectedSha;
      problems.push(
        sameSha
          ? 'the generated region was hand-edited; restore it with: simt sync'
          : `projection is ${region.recordedSha ?? '(no sha)'} but this simt-dev is ${context.expectedSha}; run: simt sync`,
      );
    } else if (region.status === 'malformed') {
      problems.push(`generated region is malformed: ${region.detail}; run: simt sync`);
    } else if (region.status === 'unmanaged') {
      problems.push('adopted but AGENTS.md has no generated region; run: simt sync');
    } else if (region.status === 'absent') {
      problems.push('adopted but AGENTS.md does not exist; run: simt sync');
    } else if (region.status === 'current' && row.pinnedSha && row.pinnedSha !== context.expectedSha) {
      // The region matches this simt-dev but the manifest pins an older one. The
      // next sync would stamp the newer SHA silently, so the pin is the thing
      // that is stale - and it is the value `simt upgrade` reads.
      problems.push(
        `manifest pins simt-dev ${row.pinnedSha}, this is ${context.expectedSha}; run: simt upgrade`,
      );
    }
  }

  // --- declared stack vs detected stack ------------------------------------
  // `simt-dev.json` records what the repo claims to be; fingerprint records what
  // the files prove. Selection uses detection, so a stale claim does not change
  // which profile is projected - but it DOES mean the manifest misdescribes the
  // repo, and a reader of the manifest would be misled. Reported rather than
  // silently reconciled: picking a winner would hide the edit that caused it.
  //
  // An empty declared stack counts as a disagreement when detection found
  // something. That is not pedantry: `init` writes the detected stack, so an empty
  // one means either the repo was adopted before the markers existed or someone
  // emptied it by hand, and in both cases the manifest is wrong.
  if (row.adoption === 'adopted') {
    const declared = new Set(row.declaredStack);
    const detected = new Set(row.stack);
    const extra = row.declaredStack.filter((t) => !detected.has(t));
    const missing = row.stack.filter((t) => !declared.has(t));
    if (extra.length > 0 || missing.length > 0) {
      const parts = [];
      if (extra.length > 0) parts.push(`declares ${extra.join(', ')} but no marker proves it`);
      if (missing.length > 0) parts.push(`detected ${missing.join(', ')} but the manifest omits it`);
      problems.push(`manifest stack disagrees with detection: ${parts.join('; ')}`);
    }
  }

  // --- hooks ---------------------------------------------------------------
  if (row.adoption === 'adopted') {
    if (!hooks.routed) {
      problems.push(
        hooks.current === null
          ? 'no core.hooksPath; commits are ungated. run: simt hooks install'
          : `core.hooksPath is "${hooks.current}", not the shared dispatcher; run: simt hooks install`,
      );
    } else if (!hooks.complete) {
      for (const h of hooks.problems) problems.push(`hooks: ${h}`);
    }
  }

  // --- gates ---------------------------------------------------------------
  // A declared gate the dispatcher does not know is a hard failure at commit
  // time (step 8 fails closed), so it is a defect here. A command-kind gate with
  // no command declared is the same failure one step later.
  if (row.adoption === 'adopted') {
    const commands = manifest.manifest?.gates?.commands ?? {};
    const invoked = new Set([...row.gatesDeclared, ...Object.keys(commands)]);
    const unknown = [...invoked].filter((g) => !context.gates.has(g)).sort();
    const uncommanded = [...invoked].filter(
      (g) => context.gates.has(g) && context.gateKinds?.get(g) === 'command' && !commands[g],
    );
    const neverRun = Object.keys(commands)
      .filter((c) => !row.gatesDeclared.includes(c))
      .sort();

    row.gateProblems = [
      ...unknown.map((g) => `gate "${g}" is not a known gate`),
      ...uncommanded.map((g) => `gate "${g}" is a command gate with no declared command`),
      ...neverRun.map((c) => `declared command "${c}" is in no gate list`),
    ];
    problems.push(...row.gateProblems);
  }

  return row;
}

function declaredGates(manifest) {
  if (!manifest) return [];
  return [...(manifest.gates?.preCommit ?? []), ...(manifest.gates?.prePush ?? [])];
}

/**
 * The headline facts about an estate, aggregated over rows.
 *
 * Counts, not verdicts. A single summary line an agent can read before deciding
 * whether it needs the table - and the numbers that make a migration legible
 * ("12 of 16 repos still unmanaged") in a way a per-repo list cannot.
 */
export function summarise(rows, extra = {}) {
  const count = (pred) => rows.filter(pred).length;
  const shas = new Map();
  for (const r of rows) {
    const sha = r.pinnedSha ?? '(none)';
    shas.set(sha, (shas.get(sha) ?? 0) + 1);
  }
  return {
    repos: rows.length,
    adopted: count((r) => r.adoption === 'adopted'),
    unmanaged: count((r) => r.adoption === 'unmanaged'),
    broken: count((r) => r.adoption === 'broken'),
    drifted: count((r) => r.region === 'drift'),
    current: count((r) => r.region === 'current'),
    noRegion: count((r) => r.region === 'unmanaged' || r.region === 'absent'),
    malformed: count((r) => r.region === 'malformed'),
    hooksRouted: count((r) => r.hooksRouted),
    withProblems: count((r) => r.problems.length > 0),
    shas: [...shas.entries()].sort((a, b) => (a[0] === '(none)' ? 1 : b[0] === '(none)' ? -1 : b[1] - a[1])),
    ...extra,
  };
}

export { knownGates };