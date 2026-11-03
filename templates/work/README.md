# Work adapters

`adapter.schema.json` is the versioned descriptor a work adapter publishes. It is data: the
tool validates it, and loading it never runs the adapter's code.

An adapter names the interfaces it implements (`observer`, `validator`, `executor`,
`recipe-mapper`), the capability it is installed with (`observe-only` or `execute`), its
input/output bounds, the permissions it needs and the widest side effect it may produce.

Two rules the schema encodes:

- **`observe-only` may not declare a side effect.** An observer that can write is an executor
  wearing the wrong label, and the descriptor is refused rather than trusted.
- **A lease, an approval or a file mode is not a permission an adapter can grant itself.** It
  lists what it needs; the caller and the platform decide whether it has it.

Validate a descriptor with the tool's own conformance suite, and pin its `version` and `digest`
in the installation that consumes it. A descriptor whose digest does not match the installed
package is a different adapter.
