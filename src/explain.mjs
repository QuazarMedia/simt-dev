// The finding-code table behind `simt explain <CODE>` (plan 0003 R46).
//
// Every status `simt check` can emit, one row each: what the reader is looking
// at, which decision settled that it is a finding (the `why` an agent needs
// before it "fixes" something that is working as designed), how to fix it, and
// a concrete trigger. The acceptance is coverage, not prose: `test/explain.test.mjs`
// scans the check pipeline for `status:` literals and fails when one has no row
// here, so a new finding that ships without documentation is a red gate.
//
// Keys are the canonical lowercase codes. `check` prints them uppercased; the
// command folds case before lookup, so DRIFT and drift are the same question.

/**
 * @typedef {{what: string, why: string, fix: string, example: string}} CodeRow
 * @type {Record<string, CodeRow>}
 */
export const EXPLAIN_CODES = {
  absent: {
    what: 'The file the gate reads does not exist: no AGENTS.md at the repository root, so there is no region to compare.',
    why: 'ADR-025: the region is the baseline in a file the repository owns. Absence is the pre-adoption state — there is nothing to verify against yet, which is why the gate reports it instead of passing a repository it never inspected.',
    fix: 'Run: simt sync --yes to adopt the repository and write the region.',
    example: 'A fresh clone before `simt init`: `check` reports ABSENT AGENTS.md.',
  },
  'beyond-read-limit': {
    what: 'The generated region ends past a reader\u2019s documented read limit, so that reader stops mid-region and never sees the rules below the cut.',
    why: 'ADR-020: rules are projected per surface, and each surface declares what its reader actually loads. A region longer than the limit is a rule the reader was promised and cannot see.',
    fix: 'Set projection.place to "top" in simt.json and run: simt sync --yes, or raise the reader\u2019s project_doc_max_bytes.',
    example: 'A 40 KB region with a Cursor-side 20 KB read: BEYOND-READ-LIMIT names the reader, the limit and the overrun in bytes.',
  },
  budget: {
    what: 'The always-on projection carries more bytes than this repository agreed to carry in budget.bytes — and nothing was cut.',
    why: 'ADR-072: the budget is a number the repository declares, and the gate reports the overrun without enforcing it by deletion. Nothing is cut in full mode, so a reader told only "over budget" must not go looking for a removed rule.',
    fix: 'Raise budget.bytes if the projection is meant to be this size, switch mode to kernel to defer convention and style rules, or narrow the rules that carry it.',
    example: 'budget.bytes 12000 with a 18400-byte projection: BUDGET names the bytes and the ceiling.',
  },
  'budget-cut': {
    what: 'The projection was cut to fit budget.bytes: kernel mode packed least-valuable-first and named every cut rule under "Deferred rules".',
    why: 'ADR-083: the cut is the tool doing what the repository was told — a repository that declared a budget asked for exactly this. Failing the gate for it would fail the tool for obeying.',
    fix: 'No fix needed: this is reported, not failed. Read the Deferred rules section (simt rules show <id> restores any cut rule), or raise budget.bytes.',
    example: 'A kernel-mode repo 3 KB over budget: BUDGET-CUT lists the deferred rule ids.',
  },
  'check-unbuilt': {
    what: 'A selected rule declares a checker this tool does not know, so the gate has no direction to enforce and refuses to pretend otherwise.',
    why: 'ADR-088: declared checkers are compiled from rule prose, and a name that resolves to nothing is not a check — it is a sentence shaped like one. Reported, never blocking: a warning, and a checker with no direction to enforce, is not a red gate.',
    fix: 'Correct the checker name in the rule, or implement it; until then the gate reports and does not fail.',
    example: 'A rule naming `max-paragraphs` when no such checker exists.',
  },
  current: {
    what: 'Not a defect: the file on disk is byte-for-byte what the tool would write. This is the gate\u2019s passing state for that file.',
    why: 'ADR-036: a check that finds no drift exits 0, and the per-file CURRENT lines are the receipt — the answer to "which files did the gate actually look at".',
    fix: 'No fix needed. If every file is current, the gate is green.',
    example: 'AGENTS.md after `simt sync --yes`: CURRENT, with no remedy line.',
  },
  drift: {
    what: 'The file on disk differs from what the tool would write: someone edited the generated region, or the rules changed underneath it.',
    why: 'ADR-036: a bare sync is a check that prints the plan, and a check that finds drift exits non-zero. The region is generated text; hand edits to it are overwritten by the next sync, so the gate fails rather than silently blessing them.',
    fix: 'Run: simt sync --yes to regenerate, or move the hand edit outside the region markers.',
    example: 'A hand-added paragraph inside the simt region of AGENTS.md.',
  },
  'file-lines': {
    what: 'A file exceeds the 1000-line hard ceiling: it fails the gate.',
    why: 'ADR-005: 400 lines is a review trigger, 1000 is a hard ceiling, and generated files are exempt. The ceiling is a default a repository can narrow, never a number an agent negotiates at write time.',
    fix: 'Split the file, or narrow the ceiling deliberately in the rule that declares it — not by editing the generated line.',
    example: 'A 1240-line module with no exemption: FILE-LINES names the file and the count.',
  },
  'file-lines-warn': {
    what: 'A file passed the 400-line review trigger but is under the ceiling: reported, and the gate stays green.',
    why: 'ADR-005: the trigger exists to start a review, not to fail a gate. A warning that failed would turn every growing file into a red repository months before the ceiling mattered.',
    fix: 'No fix needed unless the growth continues: review the file, split it early, or ignore the warning.',
    example: 'A 460-line file: FILE-LINES-WARN, no remedy, exit still 0.',
  },
  'forbid-regex': {
    what: 'A rule forbids a pattern and the pattern occurs: the file contains text the repository\u2019s own rules refuse.',
    why: 'ADR-088: declared checkers read the rule source, not the folded region, so a line that left the prompt is still the line that runs. The rule is the decision; this finding is its enforcement.',
    fix: 'Remove the matching text, or amend the rule if the pattern is now legitimate.',
    example: 'A rule forbidding `console.log` in a file that logs to the console.',
  },
  'forbidden-path': {
    what: 'A path the repository forbids was touched: the change reaches a file the rules say is out of bounds.',
    why: 'ADR-088: path checkers are declared beside the rules they protect, and a gate that watched content but not location would guard the words while the layout rotted.',
    fix: 'Revert the touch, move the work to an allowed path, or amend the rule.',
    example: 'A commit editing generated output the rules declare read-only.',
  },
  'gate-cwd-missing': {
    what: 'gates.cwd names a directory that is not a directory in this repository: the gate would run somewhere that does not exist.',
    why: 'ADR-017: a declared gate must be runnable, and a gate whose working directory is missing fails closed on every commit — after the commit was written, which is the wrong order. Reported here so the reader finds out before committing.',
    fix: 'Point gates.cwd at a directory in this repository, or remove it to run the gate at the root.',
    example: 'gates.cwd.test set to "frontend" after the directory was renamed to "web".',
  },
  'gate-cwd-outside': {
    what: 'gates.cwd resolves outside the repository: the gate would run outside the tree it is supposed to guard.',
    why: 'ADR-017: the dispatcher fails closed on a cwd outside the repository, because a gate running elsewhere enforces nothing here while reporting green. The finding names the gate and the path, since "no such directory" and "outside the repository" are repaired by different edits.',
    fix: 'Point gates.cwd at a directory inside this repository, or remove it.',
    example: 'gates.cwd.test set to "../shared" in a monorepo member.',
  },
  inconsistent: {
    what: 'The TypeScript base config disagrees with this tool\u2019s floor in a way no flag explains: the project\u2019s tsconfig and the shipped base describe different compilers.',
    why: 'ADR-025 and ADR-026: the base file is owned here and pointed at there, so a disagreement is a real fork in what the typechecker enforces — not a formatting choice. A repo that edited the owned bytes is not drift, but a repo whose config contradicts them is.',
    fix: 'Re-align the project tsconfig with the shipped base, or record why the fork is deliberate.',
    example: 'A project tsconfig setting strict false under a base that requires it.',
  },
  inert: {
    what: 'The TypeScript base config is present but inert: nothing in the repository reads it, so it constrains no file.',
    why: 'ADR-026: a config nobody reads is decoration that misdescribes the artefact — the same defect as a rule no surface projects. Reported so the dead file is either wired up or deleted.',
    fix: 'Point the project tsconfig at the base, or delete the base file.',
    example: 'A tsconfig.base.json no project tsconfig extends.',
  },
  invalid: {
    what: 'A file the tool reads declares something it cannot use: a rule with unparseable frontmatter, a manifest surface no editor documents, or a checker error the compiler reports.',
    why: 'The tool reads strictly and fails loudly (ADR-088 for rules and checkers, ADR-020 for surfaces): a profile that silently skipped the broken half would project a region nobody can account for, and `rules why` could not resolve it.',
    fix: 'Read the detail: it names the file and the reason. Repair the frontmatter key, the surface id, or the checker declaration it cites.',
    example: 'A rule whose frontmatter has `simt-applies: [node` — the detail names the line.',
  },
  'invalid-decision-frontmatter': {
    what: 'An ADR\u2019s structured frontmatter does not parse: simt-supersedes names a record or ruling that does not exist, or the shape is not [{ adr, ruling }].',
    why: 'Plan 0003 R34: supersession is data the tooling reads (`rules why`, `why`), and frontmatter that almost parses is a claim no reader can verify. Failing here is what keeps a typo from rewriting history silently.',
    fix: 'Fix the simt-supersedes entry to [{ adr: "ADR-NNN", ruling: N }], with a real record and ruling number.',
    example: 'simt-supersedes: [{ adr: "ADR-999", ruling: 1 }] when no ADR-999 exists.',
  },
  'lock-absent': {
    what: 'No lock is recorded: the projection was never locked, so there is nothing `--frozen` can compare against.',
    why: 'ADR-086: the lock is the byte-identical contract across machines, and `--frozen` without one would compare the projection against nothing and call it current. Reported only under --frozen, because a repository that never locked is not drift.',
    fix: 'Run: simt sync --yes to write the lock.',
    example: '`simt check --frozen` on a repo adopted before the lock existed.',
  },
  'lock-stale': {
    what: 'The inputs changed and the lock was not rewritten: something the projection is computed from moved without re-locking.',
    why: 'ADR-086: a stale lock is a lock describing another tree. Failing here is what makes the lock a contract rather than a souvenir — the wording says which of the two failures it was.',
    fix: 'Run: simt sync --yes to rewrite the lock from the current inputs.',
    example: 'A rule edited after the last sync, then `check --frozen`.',
  },
  'lock-unexplained': {
    what: 'The projection changed and the inputs did not: the outputs moved with no input change to explain them.',
    why: 'ADR-086: this is the failure the lock exists to catch — an output no input explains is either a tool bug or a hand edit inside the region, and both must be loud rather than absorbed.',
    fix: 'Run: simt sync --yes if the change is intended; if it recurs with no edits, file it as a tool defect with the lock diff.',
    example: 'Hand-edited generated text with untouched rules, then `check --frozen`.',
  },
  'lock-unreadable': {
    what: 'The lock file cannot be read or parsed: --frozen has a lock it cannot verify.',
    why: 'ADR-086: an unreadable lock is not an absent one — deleting the distinction would let a corrupted lock pass as "not yet locked". The error text is the detail, because the remedy depends on what broke.',
    fix: 'Read the error: repair the file, or delete it and run: simt sync --yes to rewrite it.',
    example: 'A lock file truncated by a crashed write: LOCK-UNREADABLE names the parse error.',
  },
  malformed: {
    what: 'The generated region\u2019s markers do not parse: the begin/end lines are damaged, duplicated, or in the wrong order.',
    why: 'The markers are the machine-readable boundary between owned prose and generated text. A region the parser cannot bound cannot be diffed, so the gate reports the damage (with the line) instead of guessing which half is yours.',
    fix: 'Restore the marker lines, or delete the whole region and run: simt sync --yes to rewrite it cleanly.',
    example: 'Two BEGIN lines after a bad merge: MALFORMED names the line.',
  },
  misplaced: {
    what: 'The region is intact but not at the top of the file, so it overrides the settings below it — and in this format the last matching definition wins, so the repository\u2019s own settings silently stop applying.',
    why: 'ADR-025: the baseline belongs where it cannot change meaning by position. The bytes are right and the meaning is wrong, which is the hardest kind of drift to notice, so it gets its own finding rather than a note.',
    fix: 'Move the region markers above your own settings, or delete the region and set what you need.',
    example: 'A project header prepended above the generated region in AGENTS.md.',
  },
  orphaned: {
    what: 'A managed rule file this run would not write: narrowing a surface\u2019s output left a file the tool once generated and now ignores.',
    why: 'ADR-021 ruling 6: sync does not delete a file it once wrote, and the gate must not fail on one either — a finding sync cannot repair and would never write again is a note with a remedy, not a problem (ADR-051 draws the same line for pointers).',
    fix: 'Delete it by hand if it is truly stale, or leave it: the gate reports and passes.',
    example: 'A .mcc rule dropped from the surface set, still on disk.',
  },
  'pack-declared-twice': {
    what: 'The manifest declares the same pack twice: the second declaration is read as the first, so one of them is dead text.',
    why: 'ADR-065: a pack declaration is a pin, and two pins for one name cannot both be true. The resolver reads the first and reports the second rather than merging them and guessing.',
    fix: 'Remove the duplicate entry, then: simt sync --yes.',
    example: 'Two { name: "house" } entries after a bad merge of simt.json.',
  },
  'pack-digest-mismatch': {
    what: 'The pack\u2019s bytes no longer match the digest the manifest pins: someone edited the vendored copy, or vendored different bytes than the pin records.',
    why: 'ADR-065: the digest is the per-repo answer to "which bytes were these". The pack still projects — dropping it would let the remedy delete the rules it carries, which is the opposite of what the reader meant — but the gate stays red until the pin is re-recorded, and both digests are printed.',
    fix: 'Restore the pinned bytes with: git checkout -- .simt/packs/<name> (or record the new digest, then: simt sync --yes).',
    example: 'A hand edit inside .simt/packs/house/rules/: PACK-DIGEST-MISMATCH prints both digests.',
  },
  'pack-missing': {
    what: 'The manifest declares a pack with no directory: every rule the pack carries is missing from this repository\u2019s projection.',
    why: 'ADR-065: a region rendered without half its rules tells the reader something false, and the next sync would overwrite the truth on disk with the shorter region. The remedy restores the bytes git has — sync cannot help, because it would render the region without the pack and call it current.',
    fix: 'Restore it with: git checkout -- .simt/packs/<name> (or remove the declaration, then: simt sync --yes).',
    example: 'A fresh clone with .simt/packs untracked: PACK-MISSING names the directory.',
  },
  'pack-name-invalid': {
    what: 'The manifest names a pack that cannot be a directory name: it escapes the pack directory or uses characters a path cannot hold.',
    why: 'ADR-065: a pack name is built into a path the renderer reads, so a hand-edited manifest pointing outside the repository would make the region depend on bytes the reader does not have — the one failure this tool exists to prevent.',
    fix: 'Correct or remove the entry, then: simt sync --yes.',
    example: '{ name: "../escape" }: PACK-NAME-INVALID, and the entry is not resolved as a pack.',
  },
  'pack-unpinned': {
    what: 'The pack has no digest: nothing records which bytes it was declared at. Its rules still render, and the gate stays green.',
    why: 'ADR-065: an absent pin is a missing record, not a mismatch — refusing to project would punish a repository for a field the tool treats as optional. Reported with the digest to record, so pinning is one copy-paste.',
    fix: 'Record the printed digest as its digest, then: simt sync --yes.',
    example: 'A freshly vendored pack before the first pin: PACK-UNPINNED prints the digest.',
  },
  'pointer-blocked': {
    what: 'The pointer file cannot be written where it belongs: something the tool does not own blocks the path.',
    why: 'ADR-051: the pointer is the reader\u2019s only route to the rules, so a blocked pointer is not a convenience failing — it is the rules going unread. The gate fails rather than leaving a reader with a pointer at a file that is not the rules.',
    fix: 'Remove or relocate the blocking file, then: simt sync --yes.',
    example: 'A hand-written CLAUDE.md where the pointer belongs: POINTER-BLOCKED.',
  },
  'pointer-unread': {
    what: 'The pointer aims at a file the reader will not read: it names a path no adopted surface documents.',
    why: 'ADR-051: a pointer the reader never follows is a rule nobody is held to. Sync refuses to write it (a gate whose remedy is the command being run is worse than a noisy gate); check is where it blocks.',
    fix: 'Point the surface at a path the reader loads, or drop the surface.',
    example: 'A surface aimed at docs/notes.md: POINTER-UNREAD names the path.',
  },
  'prose-partial-supersession': {
    what: 'An ADR states a partial supersession only in prose: "ruling N superseded by ADR-MMM" with no matching simt-supersedes frontmatter entry, so tooling cannot see the move.',
    why: 'Plan 0003 R34 with ADR-049: a supersession the parser cannot see is a ruling that `rules why` reports as still standing. Stating it twice — prose for the reader, frontmatter for the tool — is what keeps history from being rewritten by a typo.',
    fix: 'Declare simt-supersedes: [{ adr: "ADR-MMM", ruling: N }] in the record\u2019s frontmatter.',
    example: 'A status line "ruling 2 narrowed by ADR-024" with empty frontmatter: the lint names the raw clause.',
  },
  reformatted: {
    what: 'The manifest\u2019s content is what simt-dev would write, but the bytes differ: another formatter owns this file\u2019s shape.',
    why: 'ADR-050: a formatter that rewrites the file on every run and a tool that rewrites it back would fight forever, with init as the only repair — which re-runs adoption to change one file\u2019s formatting. Comparing content-to-content isolates the real question: does another tool own this file.',
    fix: 'Add simt.json to .prettierignore (a generated file is not prose), then: simt sync --yes.',
    example: 'Prettier collapsing the manifest to one line: REFORMATTED, content identical.',
  },
  'required-file': {
    what: 'A rule requires a file the repository does not have: the project is missing something its own rules demand.',
    why: 'ADR-088: required-file is a declared checker, and a declaration nobody verifies is a wish. The gate fails because the rule\u2019s author already decided this file is load-bearing.',
    fix: 'Add the file, or amend the rule if the requirement moved on.',
    example: 'A rule requiring SECURITY.md in a repo without one.',
  },
  'stale-generated-field': {
    what: 'Generated manifest fields do not match what simt-dev writes: the projection SHA, the stack, or the version pin drifted without a re-run.',
    why: 'ADR-050: sync repairs exactly this field set and nothing else, so init\u2019s re-adoption is never the repair for a stale field. check names the fields; sync rewrites them.',
    fix: 'Run: simt sync --yes.',
    example: 'A hand-bumped version pin with the old projection SHA still recorded.',
  },
  unmanaged: {
    what: 'The file exists but carries no generated region: the repository was never adopted, or the region was deleted by hand.',
    why: 'ADR-025: with no region there is no baseline to verify against. Unmanaged is the normal mid-migration state, and the gate says so with the command that moves it forward rather than failing mysteriously.',
    fix: 'Run: simt sync --yes to write the region (or simt init for a first adoption).',
    example: 'AGENTS.md present, hand-written, no simt region: UNMANAGED.',
  },
  'unknown-gate-cwd': {
    what: 'gates.cwd names a gate the manifest never declares: the working-directory override points at nothing.',
    why: 'ADR-017: an override for a gate that does not exist cannot run, and a gate that cannot run fails closed on every commit. Reported here so the typo surfaces before the first commit, not after.',
    fix: 'Correct the gate name in gates.cwd, or declare the gate it was meant for.',
    example: 'gates.cwd.test set while the manifest declares no test gate.',
  },
  unreadable: {
    what: 'The gate could not read a file it must verify: permissions, a broken symlink, or an I/O error — anything but a clean absence.',
    why: 'A check that is wrong about existence is worse than one that crashes: only ENOENT is absence, and every other failure is reported with its own code rather than folded into "missing". The gate refuses rather than passing a repository it never inspected.',
    fix: 'Read the detail (it carries the OS error): fix permissions, remove the broken link, then re-run.',
    example: 'AGENTS.md unreadable (EACCES): UNREADABLE with the errno, not ABSENT.',
  },
  unrunnable: {
    what: 'A declared gate cannot run here: the command it needs is not on PATH, or its runner is missing.',
    why: 'ADR-017: a gate that cannot run fails closed on every commit once hooks are installed — after the reader committed, which is the wrong order. check reports it before anyone installs anything, with the probe result that proved it.',
    fix: 'Install the missing program, declare the gate\u2019s command in gates.commands, or drop the gate from the manifest.',
    example: 'A lint gate naming eslint with no eslint on PATH: UNRUNNABLE names the probe.',
  },
  'version-mismatch': {
    what: 'The binary running the gate is not the version the manifest pins: the gate that runs is not the gate CI runs.',
    why: 'ADR-059: the version a repository runs is the one it pinned, and a stale binary would run a different gate than the one the pin promises. The mismatch fails the gate rather than warning, because a warning is a gate that passes while disagreeing with CI.',
    fix: 'Run: simt upgrade --yes to move the pin (and the binary) forward.',
    example: 'Pin simt-dev 0.5.0 with 0.6.2 installed: VERSION-MISMATCH names both.',
  },
};
