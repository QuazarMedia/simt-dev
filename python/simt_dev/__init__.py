"""simt-dev, installed from PyPI.

The package this wheel ships is a Node program. See {@link simt_dev.cli} for
what this file is for and why it works the way it does; nothing here needs to
be remembered twice.
"""

from .cli import find_node, main, vendored_root

__all__ = ["main", "find_node", "vendored_root", "__version__"]


def _version():
    """The version of the vendored tool, read from its own manifest.

    Not from this wheel's distribution metadata. The two are asserted equal by
    a test, and reading the vendored one here is what makes a disagreement
    visible to a reader: `simt --version` reporting the bytes that actually
    shipped, rather than a number that was correct at packaging time.
    """
    import json
    import os

    path = os.path.join(vendored_root(), "package.json")
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)["version"]
    except (OSError, ValueError, KeyError):
        return None


__version__ = _version()
