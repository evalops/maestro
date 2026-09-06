# Shared Dex Code presentation

The native TUI and lightweight workbench use these same renderers. Inputs are
borrowed presentation values; the application keeps execution, approvals, queue
semantics, preferences, and persistence.

## Composer

`components::composer::Composer` borrows the existing `maestro_ui::textarea::TextArea`,
preformatted queue rows, completion text, runtime footer, and a `UiTheme`.
Use `cursor_pos(area)` to place the terminal cursor. Rendering uses that same
viewport and keeps the cursor's wrapped row visible when the terminal shrinks.
Queue previews reserve an editor row and disclose clipping.

The existing TUI textarea path re-exports this editor for compatibility. Its
paste folding preserves original submitted bytes. Callers using `TextAreaWidget`
directly can supply a wrapped-row offset with `scroll(rows)`.

## Tool result

`components::tool_result::ToolResult` receives a typed `ToolPhase`, summary,
arguments, bounded output, optional truncation notice, and explicit expansion.
The native adapter remains responsible for tool summaries and output limits.
Execution identities appear in expanded details. Compact results show five
content rows and a remaining-line count; expanded results preserve blank rows
and show up to fifty output rows. Upstream truncation remains visible.

Use `lines(width)` for transcript composition or `height(width)` and `Widget`
for direct rendering. Measurement and rendering share the same layout.
Never derive success or permission from output text or a visual style.

## Adding a state

1. Reuse a production widget and pass values from the existing application owner.
2. Add a named example to `ui-preview-rs/src/conversation.rs` for each relevant state.
3. Test observable boundaries: cursor visibility, clipping, output disclosure, and status.
4. Run the focused preview command, then the full catalog and native capture cases.

`cargo test -p maestro-presentation -p maestro-ui -p maestro-ui-preview --locked`
runs the lightweight component tests. The workbench README has gallery commands.
