# Find evidence in one local scope

Run these commands from a Git checkout with SIMT installed. Replace `handbook` in
the path and scope arguments with the directory and scope id you want to use.
Stage or commit the Markdown you want to search before building.

```sh
simt work inspect
simt work setup --scope handbook --path handbook --kind document
simt work setup --scope handbook --path handbook --kind document --yes
simt knowledge build --scope handbook
simt knowledge build --scope handbook --yes
simt knowledge rank --scope handbook --query "device checkout retention"
simt knowledge rank --scope handbook --query "device checkout retention" --where jurisdiction=DE
simt knowledge why device-checkout-current#device-checkout --scope handbook
simt knowledge why retention.current --scope handbook --as-of 2024-06-01 --known-at 2024-06-01
```

Use the returned path and anchor to open the section in your editor. The scope limits
which repository files enter the corpus. The optional `--where` limits which
metadata values can answer a particular query. A historical query supplies both
the effective date and the date through which observations may be used.

To attach a reviewed claim, record its jurisdiction and dates in the existing
source and put the claim marker under the relevant heading. These are example
values for a maintainer who has reviewed a 30-day rule.

```markdown
---
id: device-checkout-current
scope: {"jurisdiction":"DE"}
authority: reviewed
validFrom: 2025-01-01
knownAt: 2025-01-02
---
# Device checkout

Device checkout retention is 30 days.

<!-- claim: id=retention.current subject=device-checkout predicate=retention type=number value=30 unit=days status=reviewed -->
```

Rebuild after updating a source. For an absent answer, check that the file is
tracked and inside the scope. Try its path as an exact query. Ordinary sections
can be cited as evidence, and SIMT reports when a section lacks a reviewed claim.
