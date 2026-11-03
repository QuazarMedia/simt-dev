# Playbooks

Five supported paths, each with the commands that actually exist. Nothing here is a future
command or a command from another repository: every name below is a row in the command spec, and
`test/work-release.test.mjs` fails when one is not.

## Docs-only change

A change to prose, a rule body or a decision record.

```sh
simt plan next
simt brief "clarify the retry wording"
simt check
```

`simt check` reports a stale generated region without writing one; when it does, run `simt sync
--yes` and include the result in the same commit. A docs-only change has no code gate, so the
evidence for it is the check above and the rendered region you read.

## Mixed knowledge and scripts

A change that touches retrieved knowledge and the code that reads it.

```sh
simt brief "add the effective-date rule"
simt why src/knowledge/debt.mjs
simt gate --changed
simt evidence
```

`simt gate --changed` names the tests the change reaches; run them with the repository's own
runner. `simt evidence` reports what has been recorded against this tree, and it says plainly when
nothing has.

## API-authored change

An operation against an externally stored rule, through an adapter.

```sh
simt review
simt evidence
```

The intent, its authorization, the review bundle and the observed result are separate records. A
passing HTTP status is not a result: the bundle carries the read-back, and a missing incarnation or
revision leaves the outcome unknown.

## UI-only operation

A target whose capability is exposed only through a form.

```sh
simt status
simt evidence
```

A UI path is bound to a form identity, semantic field locators and a widget signature before it is
submitted; an unexpected structure triggers bounded rediscovery and then a refusal. A path that
cannot set a required field is refused rather than attempted, which is why the assurance report
names it as unmediated.

## SSH-operated target

A target reached through a declared runner rather than an SDK.

```sh
simt status
simt evidence
```

The runner is a registered command with validated argv, not a shell string handed to an executor.
Fencing is only as strong as the target's own compare-and-set: without it the lease is reported as
advisory, with its residual race.

## What is not supported

- A live pilot run. The pilots in this tree are synthetic fixtures; running one against a real
  target is a separate, authorised act with its own evidence.
- Rollback of a remote effect. `simt undo` restores journaled local files and makes no remote
  claim.
- Exactly-once delivery. Without server-side deduplication or an atomic precondition the guarantee
  is at-least-once, and the report says so.
- A model that decides policy. Advice is a candidate; a reviewed record and the repository's own
  policy decide.
