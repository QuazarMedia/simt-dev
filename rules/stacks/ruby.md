---
simt-id: ruby
simt-title: Ruby
simt-applies: [has-gemfile]
---

# Stack profile: Ruby

Applies to: `has-gemfile` — a Bundled application or gem.

## Build and gates

- `bundle install` then `bundle exec rspec` are the entrypoints; run every command
  through `bundle exec`, never a bare binary, so the Gemfile.lock is the only
  source of truth for versions.
- `bundle exec rubocop` is the lint gate where the repo has a `.rubocop.yml`; a
  cop the repo disabled is a decision, and re-enabling it is a change, not a fix.
- `Gemfile.lock` is committed for an application; for a library it is not, and the
  distinction is a decision the repo made, not one to reverse silently.

## Style

- Frozen string literals (`# frozen_string_literal: true`) at the top of new files
  where the repo already uses them; a mixed repo is a transition, not a licence to
  pick either.
- Prefer `case`/`when` or a hash over a chain of `if`/`elsif` on one variable; a
  five-branch if-chain is a lookup table somebody refused to name.
- `raise` with a message that names the failure and the value that caused it; a
  bare `raise` is a defect the next reader cannot debug.

## Testing

- RSpec is the runner where the repo has one; do not add a second framework to a
  repo that has one.
- Assert on behaviour through the public interface; a spec that stubs everything
  and asserts on the stub is testing the stub, not the code.
