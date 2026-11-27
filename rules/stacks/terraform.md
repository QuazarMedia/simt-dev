---
simt-id: terraform
simt-title: Terraform and OpenTofu
simt-applies: [has-terraform, has-opentofu]
simt-priority: convention
simt-scope: ["**/*.tf", "**/*.tofu", "**/*.tfvars", "**/*.tfvars.json", ".terraform.lock.hcl", "**/.terraform.lock.hcl"]
---

# Stack profile: Terraform and OpenTofu

Applies to: Terraform `.tf` or OpenTofu `.tofu` configuration in this repository.

## Tool and checks

- Use `terraform` for `.tf` roots and `tofu` for `.tofu` roots. Do not mix the two CLIs
  in one root module or treat one as an interchangeable alias for the other.
- Check formatting without rewriting files: `terraform fmt -check -recursive` or
  `tofu fmt -check -recursive`. Run the matching formatter without `-check` only when
  the formatting change is intended.
- Validate with `terraform validate` or `tofu validate` after the repository's
  documented initialization step. `init -backend=false` is appropriate for validation
  when backend credentials must not be touched; review any lockfile change it makes.
- Keep modules in separate roots when their state or apply lifecycle differs. A single
  root spanning unrelated systems makes plans impossible to review safely.

## State and secrets

- Never commit state, plan files, `.terraform` directories or credential files. State
  can contain secrets even when the configuration marks a value sensitive.
- Use the repository's remote backend with encryption, access control and locking.
  Local state is acceptable only for an isolated throwaway workspace.
- Do not put secrets in `.tf` or `.tfvars` files, including defaults. Mark sensitive
  outputs, but remember that masking output does not remove the value from state.
- Bind variables to the narrowest input source and document which values CI must supply.
  Commit example variable files with placeholders, never real credentials.

## Providers and modules

- Constrain provider and module versions, and commit `.terraform.lock.hcl` so every
  machine selects the same provider packages. Review lockfile updates as dependency
  changes.
- Pin module sources to an immutable release or commit. A floating branch makes the
  next plan depend on somebody else's later push.
- Keep provider configuration in the root module. Repeating credentials in child
  modules makes ownership and rotation unclear.

## Plans and changes

- Generate a saved plan with `terraform plan -out=tfplan` or `tofu plan -out=tfplan`
  when an apply may follow. Review the complete resource and output diff before seeking
  approval.
- Saved plans may contain sensitive values. Store them only in the approved secure
  location and remove local copies when the operation is complete.
- Apply only the exact reviewed plan in the approved workspace, and only with explicit
  authorization. Never run a speculative `apply`, use auto-approve to skip review, or
  apply a newly generated plan that nobody inspected.
