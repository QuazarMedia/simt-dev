# Finding codes

Every code `check` and its gates can emit, and `simt explain <CODE>` prints the full record
for each: what the defect is, the ruling behind it, the command that fixes it, and what a
reader sees. `EXPLAIN_CODES` in `src/explain.mjs` is the authority; this page is the map.

**Projection and drift** — `drift`, `current`, `reformatted`, `malformed`, `misplaced`,
`absent`, `unreadable`, `unmanaged`, `stale-generated-field`, `version-mismatch`, `inconsistent`,
`inert`, `unknown-gate-cwd`.

**Budget and size** — `budget`, `budget-cut`, `file-lines`, `file-lines-warn`,
`beyond-read-limit`, `generated`.

**Rules and checkers** — `forbid-regex`, `forbidden-path`, `required-file`, `check-unbuilt`,
`unresolvable`, `unrunnable`, `unknown`, `invalid`.

**Gates and hooks** — `gate-cwd-missing`, `gate-cwd-outside`, `hooks-disable`,
`generated-hooks`, `push`, `lock`, `lease`.

**Lock and packs** — `lock-absent`, `lock-stale`, `lock-unexplained`, `lock-unreadable`,
`pack-declared-twice`, `pack-digest-mismatch`, `pack-missing`, `pack-name-invalid`,
`pack-unpinned`, `pack`.

**Decisions** — `duplicate-decision-id`, `invalid-decision-frontmatter`,
`prose-partial-supersession`, `pointer-blocked`, `pointer-unread`, `orphaned`, `rewrite`.

Each code in the table above must also exist in `src/explain.mjs`: a code with no explanation
is a message the reader cannot act on, and a code in the table that no checker emits is a
message nothing produces.
