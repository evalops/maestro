# Native UI previews

This development-only executable renders the widgets in `maestro-presentation`.
Production never depends on this crate. The source stamp belongs to its build
script so changing preview inputs cannot invalidate the native TUI library.

From the public repository root (or `products/maestro` in Mono), run:

```sh
cargo run --locked -p maestro-ui-preview -- --list
cargo run --locked -p maestro-ui-preview -- --scene startup --width 100 --height 10
cargo test --locked -p maestro-ui-preview
```

The executable prints ANSI terminal previews. In Mono, the optional
`make maestro-ui-review MAESTRO_UI_OUTPUT=/tmp/dex-review` wrapper builds a
comparison gallery; use a new output directory for each run. That wrapper and
its baseline acceptance checks are internal tooling.

Add structural scenes in `src/lib.rs::catalog` and render them with existing
production widgets. Appearance scenes come directly from the product's `LOOKS`
catalog. Stable IDs identify actions; row order is tested separately by the
native keyboard fixtures. Keep runtime facts supplied by the caller and time
supplied by `ViewClock`. Avoid network clients, persistence, and runtime startup.

See [the screenshot workflow](../../docs/tui-screenshots.md) for native tmux
captures, manifest checks, baseline acceptance, and reproducible comparisons.

## Conversation components

`conversation-typing`, `conversation-streaming`, `conversation-error`,
`conversation-approval`, `conversation-queued`, and `conversation-completed`
render the same composer and tool-result widgets used by the native transcript.
Each appears at 40, 60, and 100 columns. The examples supply state; they do not
execute tools or grant approvals.

For focused terminal previews from the same directory:

```sh
for scene in conversation-typing conversation-streaming conversation-error conversation-approval; do
  cargo run --locked -p maestro-ui-preview -- --scene "$scene" --width 100 --height 10
done
```

These commands render individual scenes, not complete screenshot baselines.
Native before/after checks in Mono still use `capture-tui-suite.py`.
