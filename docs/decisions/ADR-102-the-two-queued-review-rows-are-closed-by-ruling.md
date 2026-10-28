---
simt-affects: ["docs/reviews/0002-full-review-adoption-and-public-release.md"]
simt-supersedes: []
---

# ADR-102 — the two rows review 0002 left queued are closed by ruling

Status: **accepted** · 2026-10-28

## Context

Review 0002's §3 tracker is the only tracker of slice state, and two rows in it
still read Queued while everything around them shipped: S38 (workspace token
cost) and S39 (estate policy as a pack). Both rows' evidence cells are
palimpsests — notes from three different landings disagreeing about what is
still open — so reading them as a work list sends the next reader to build what
is already built. Closing plan 0001 meant the same audit, and ADR-033 is the
precedent: rows closed by saying what shipped, what was refused by ruling, and
where the remainder lives, not by authoring what they asked for.

## Ruling

1. **S38 is Complete.** The instrument shipped (`simt tokens`, ADR-064), the
   declaration shipped (`budget.bytes` beside `limits` and `gates`, ADR-072),
   and the gate raises it as a finding through one `budgetFinding` read from
   one place by both `tokens` and `check` — the "still open" clause the row's
   first note ends on. Kernel-line packing shipped with it (R07's `mode:
   kernel`, R08's budget compilation). Blocking enforcement is refused, not
   outstanding: a gate that fails a repository for exceeding a ceiling it set
   itself, when nothing was cut, has no repair except lowering the declared
   number (ADR-072). The one genuine remainder is the kernel-default
   compliance study, and it is owned by plan 0003 R07's own note, not by this
   row — the study gates making `kernel` the default, which no row asks to
   decide here.

2. **S39 is Complete.** The mechanism shipped (packs vendored and digest-pinned,
   ADR-065; measured ΔR, plan 0003 R45). P4's pack-carries-the-registry line was
   superseded by ADR-061, which made the registry workspace data, so there is
   no registry-carrying pack to build. The remaining half — moving estate
   policy into a pack — is the estate's own commit: no estate content may enter
   this repository, and a row that waits on another repository's commit is
   closed by recording whose commit it waits on.

## Consequences

- The §3 tracker reads Complete on both rows, with this record as the evidence,
  so the next audit starts from rulings rather than from mid-flight notes.
- A reader asking for a blocking budget gate or a registry-carrying pack gets
  the refusal and its reason instead of an open row that looks like a promise.
