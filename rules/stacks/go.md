---
simt-id: go
simt-title: Go
simt-applies: [has-go-mod]
simt-priority: convention
simt-scope: ["go.mod", "**/*.go"]
---

# Stack profile: Go

Applies to: Go modules — a committed `go.mod`.

## Build and gates

- `go build ./...`, `go test ./...` are the entrypoints; `go vet ./...` runs with
  them. Never rely on a file the build does not include.
- Format with `gofmt` (or `go fmt ./...`). A diff that is only formatting is a
  defect: the gate fails closed on it.
- Depend on the module, not on a `GOPATH` layout. A package import that resolves
  only because of a local checkout is a broken dependency.

## Style

- Errors are values, not exceptions. Wrap with `fmt.Errorf("...: %w", err)` so the
  caller can `errors.Is`/`errors.As`; a bare string loses the chain.
- `context.Context` is the first parameter of anything that can be cancelled; never
  store one in a struct.
- Table-driven tests: one `for range` over named cases beats ten copy-pasted
  subtests.

## Testing

- `go test ./...` is the gate; a package with no test file is allowed to have none,
  but a change that touches one must not break its neighbours.
- Benchmark with `-bench` only where the number is a decision; an unowned benchmark
  is decoration.
