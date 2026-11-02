# Write a decision record

A decision is what the tool believes: which gates run, what a rule requires, how a conflict
is classified. It is a numbered file in `docs/decisions/`, and it is the only place a ruling
lives.

```sh
simt decide new "a short title that names the ruling" --yes
simt decide lint          # the structure a supersession needs
```

1. **Number and title.** `simt decide` picks the next number. The title states the ruling as
   a claim ("the index has one format"), not the topic ("index formats").
2. **Status line.** `Status: accepted · <date>`. A record that is no longer in force says so
   in the same line, and names the record that changed it.
3. **Context, Rulings, Consequences, Rejected.** The rulings are numbered, because later
   records supersede *rulings*, not documents. Rejected alternatives earn their place by
   recording the option that looked right and was not.
4. **Supersede in two places.** Write the new record, and edit the superseded one's status to
   say which ruling moved and to where. `simt decide lint` reads both; a claim only the newer
   record makes is a claim the parser cannot find.
5. **Regenerate the index.** `simt rules decisions --yes` rewrites `docs/decisions-index.md`;
   a test fails when it is stale. `simt rules why ADR-NNN` prints a record, including whether
   it is still in force.

A ruling that changes shipped rule text is a change to every adopting repository at once.
State which existing behaviour it invalidates, and bump the records that settled it rather
than editing a ruling in place.
