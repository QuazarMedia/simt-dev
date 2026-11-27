---
simt-id: erlang
simt-title: Erlang/OTP
simt-applies: [has-rebar, has-erlang-mk]
simt-priority: convention
simt-scope: ["rebar.config", "erlang.mk", "**/*.erl", "**/*.hrl"]
---

# Stack profile: Erlang/OTP

Applies to: a committed `rebar.config` or `erlang.mk` build definition.

## Build and gates

- Use the repository-declared runner: rebar3 for a `rebar.config` project, or the
  Makefile targets supplied by `erlang.mk`. A globally installed tool or an
  undeclared runner is not a repository command.
- Keep dependencies and their lock data in the repository's build files. Do not
  replace a declared dependency with a copy that happens to exist on the machine.
- Run Dialyzer through the project's declared target or provider where it is
  configured. Do not add a speculative static-analysis gate or suppress a warning to
  make an unrelated command pass.

## OTP design

- Model long-lived work as OTP applications with explicit supervision trees. Start
  processes through their supervisor; an unsupervised process or ad hoc restart loop
  has no owner when it fails.
- Give supervisors a stated child strategy and shutdown behaviour. A supervisor that
  restarts every child forever can turn a deterministic defect into an outage.
- Keep process state local and pass immutable messages between processes. Do not use
  the process dictionary, mutable module state or an unowned public ETS table as
  global state.
- Handle expected failures as values or controlled process exits. Let the supervisor
  own crash recovery instead of catching every exception and continuing in an unknown
  state.

## Testing

- Use the repository's EUnit or Common Test runner. The card's focused templates are
  conventions for a declared runner, not permission to replace a project-specific
  test target.
- Keep tests deterministic: do not sleep for a mailbox message, control clocks and
  randomness at the boundary, and isolate named ETS tables and registered processes.
- Exercise supervision and failure behaviour through public process interfaces. A
  test that inspects another process's private state couples itself to an
  implementation detail.
- Run the repo-declared test target after changing an application or supervisor; a
  module compiling on its own does not prove the supervision tree starts cleanly.
