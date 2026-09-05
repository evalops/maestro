# Native UI previews

This development-only executable renders the widgets in `maestro-presentation`.
Production never depends on this crate. The source stamp belongs to its build
script so changing preview inputs cannot invalidate the native TUI library.

From the Mono root, `make maestro-ui-review MAESTRO_UI_OUTPUT=/tmp/dex-review`
builds the executable and creates the complete comparison gallery. Use a new
output directory for every run. `make maestro-ui-test` runs the lightweight
Rust and screenshot-review checks.

Add structural scenes in `src/lib.rs::catalog` and render them with existing
production widgets. Appearance scenes come directly from the product's `LOOKS`
catalog. Stable IDs identify actions; row order is tested separately by the
native keyboard fixtures. Keep runtime facts supplied by the caller and time
supplied by `ViewClock`. Avoid network clients, persistence, and runtime startup.

See [the screenshot workflow](../../docs/tui-screenshots.md) for native tmux
captures, manifest checks, baseline acceptance, and reproducible comparisons.
