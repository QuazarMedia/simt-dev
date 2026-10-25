"""The ``simt`` command, installed from PyPI.

simt-dev is a Node program. It has zero runtime dependencies and it does not
need a build step, which means the whole thing is a directory of `.mjs` files
and a `package.json` - about 1.3 MB of text. So the wheel carries those bytes
directly, alongside this file, and the only question left is *which node runs
them*.

That question is the whole content of {@link find_node}, and it is asked in an
order rather than answered with a guess:

    SIMT_DEV_NODE          an explicit override, for anyone who wants to say
    nodejs_wheel           the bundled node, if the [node] extra was installed
    PATH                   whatever node this machine already has

and then a refusal, not a fallback to something invented. A placeholder node
path is worse than no path: it produces "file not found" from a depth that has
nothing to do with the problem, when the problem is that node is not installed
and the reader can fix that in one command.

This file is also why the process is *replaced* rather than *spawned*.
``os.execv`` hands the file descriptors over, so terminal width, a tty, stdin,
Ctrl-C, and the exit code all arrive unchanged. A subprocess wrapper has to
reimplement every one of those, and the day one of them is forgotten is the day
somebody's editor-integrated ``simt`` loses its colours.
"""

import os
import shutil
import sys

__all__ = ["main", "find_node", "vendored_root"]

# The env var that names a node binary. SIMT_DEV_NODE rather than SIMT_DEV_BIN,
# because SIMT_DEV_BIN already means something and means it well: it names the
# *tool* (an executable, or a .mjs entry point to hand to node), and the hook
# shims and the CI workflow both read it. This names the *runtime*. Two names
# for two questions; reusing one would make the value's meaning depend on which
# of the two files is reading it.
ENV_NODE = "SIMT_DEV_NODE"

# The env var that names the program to run instead of the one this wheel ships.
# Same meaning it has in the shim: a path to a .mjs entry point, so somebody
# working on simt-dev itself can `pip install -e .` and still point at their
# checkout without editing anything.
ENV_BIN = "SIMT_DEV_BIN"

BIN_REL = os.path.join("bin", "simt.mjs")


def vendored_root():
    """The directory this wheel placed the tool's own source in.

    Resolved from ``__file__``, because that is the one location that is correct
    in a checkout, in a wheel, in a virtualenv and in a system install alike. A
    path derived from the current working directory would be wrong the moment
    a hook ran this from inside a repository - which is the normal case.

    One level up from this file, not two: this module is `simt_dev/cli.py` and
    the vendored tree sits beside it at `simt_dev/vendored/`. (It was written as
    two while the package layout was still a guess, and the symptom was an
    install that worked and a command that reported its own wheel as
    incomplete.)
    """
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendored")


def _executable(candidate):
    """Whether `candidate` names a file this user may execute."""
    return candidate is not None and os.path.isfile(candidate) and os.access(candidate, os.X_OK)


def _from_env():
    """`SIMT_DEV_NODE`, as a path or as a name to look up.

    Accepted in both spellings because the reader who sets it has one in mind: a
    Homebrew prefix or an nvm path is a path, and `node` is a name. Deciding by
    the presence of a separator is the usual way this is done and the wrong test
    to be clever about - `./node` and `node` are both things people type.
    """
    value = os.environ.get(ENV_NODE)
    if not value:
        return None
    if os.sep in value or (os.altsep and os.altsep in value):
        return value if _executable(value) else None
    return shutil.which(value)


def _from_bundled():
    """The node that ships with the `[node]` extra, if that extra is installed.

    Imported lazily and guarded, because the default install does not have it:
    `pip install simt-dev` must not pay for, or fail on, an optional wheel it
    did not ask for. An ImportError here means "no bundled node", which is an
    ordinary outcome and not an error to report.
    """
    try:
        import nodejs_wheel  # noqa: PLC0415  the whole point is that it may be absent
    except Exception:
        return None
    try:
        return nodejs_wheel.node()
    except Exception:
        # Present but unusable - a broken install, a platform with no wheel.
        # Reported rather than swallowed by returning a path that does not run.
        return None


def _from_path():
    """Whatever node this machine already has.

    `shutil.which` rather than a list of well-known install directories. A
    hardcoded `/opt/homebrew/bin/node` list is three guesses and a surprise:
    it starts preferring a guess over the reader's own PATH, and it is already
    out of date for anyone who installs node differently.
    """
    return shutil.which("node")


def find_node(env=None):
    """The node binary that should run the tool, or None if there is not one.

    The order is load-bearing and not aesthetic. An explicit override wins, so
    a reader who has a reason can say so. The bundled node comes next rather
    than before `PATH`, because a machine that already has node should keep
    using the node it uses everywhere else - installing the `[node]` extra on
    such a machine is meant to add a fallback, not to silently switch the
    runtime underneath an otherwise-working setup.

    @param env an environment mapping; defaults to `os.environ`
    @returns {str|None} a path to a node binary, or None
    """
    env = os.environ if env is None else env

    explicit = env.get(ENV_NODE)
    if explicit:
        candidate = _from_env()
        if candidate is not None:
            return candidate
        # Falling through on a bad override would run a *different* node than
        # the one asked for, which is the one outcome worse than failing.
        sys.stderr.write(
            f"simt: {ENV_NODE} names {explicit!r}, which is not an executable node.\n"
            f"  set {ENV_NODE} to a node binary or a name on PATH, or unset it to let simt find one.\n"
        )
        return None

    bundled = _from_bundled()
    if bundled is not None:
        return bundled

    return _from_path()


def _program(vendored):
    """Which `.mjs` entry point to run, honouring SIMT_DEV_BIN the way the shim does."""
    override = os.environ.get(ENV_BIN)
    if override:
        if " " in override:
            # The shim's rule, kept: the value names one program. A value with a
            # space in it is either a command line, which there is no safe way to
            # split here, or a genuine path with a space in it - and refusing
            # both costs nothing, while accepting the first is a shell injection.
            sys.stderr.write(
                f"simt: {ENV_BIN} names a command line, not a program.\n"
                f"  set it to a single executable or a .mjs path, e.g.\n"
                f"    {ENV_BIN}=/path/to/checkout/bin/simt.mjs\n"
            )
            return None
        return override if override.endswith(".mjs") else None
    return os.path.join(vendored, BIN_REL)


def _remedy():
    """What to do about the missing node, in a form the reader can act on.

    The `[node]` extra first because it is the one remedy that is the same
    command on every platform. Platform package managers are deliberately not
    listed: `apt`, `dnf`, `pacman` and `brew` differ, getting one wrong is
    itself a broken remedy, and a wrong remedy is a second problem stacked on
    the first - which is the failure this project's rules exist to prevent.
    """
    return (
        "  REMEDY: pip install simt-dev[node]   (installs a bundled node, and works on every platform)\n"
        "          or install Node.js yourself and make sure `node` is on PATH\n"
        "          or set SIMT_DEV_NODE=/path/to/node"
    )


def main(argv=None):
    """Replace this process with `node <entry point> <args>`.

    @param argv arguments to forward; defaults to `sys.argv[1:]` so an explicit
      caller gets a slash list while an installed entry point gets the shell's
    @returns {int} only ever 2 (an error before exec); otherwise this does not return
    """
    argv = sys.argv[1:] if argv is None else argv

    node = find_node()
    if node is None:
        sys.stderr.write(
            "simt: cannot find node, which is the runtime this tool is written in.\n"
            f"{_remedy()}\n"
        )
        return 2

    vendored = vendored_root()
    program = _program(vendored)
    if program is None:
        # `_program` has already said which env var was wrong and how.
        return 2
    if not os.path.isfile(program):
        sys.stderr.write(
            f"simt: {program} is not in this installation.\n"
            "  this usually means the wheel is incomplete - reinstall with:\n"
            "    pip install --force-reinstall --no-cache-dir simt-dev\n"
        )
        return 2

    os.execv(node, [node, program, *argv])
    raise AssertionError("unreachable: execv does not return")


if __name__ == "__main__":
    sys.exit(main())
