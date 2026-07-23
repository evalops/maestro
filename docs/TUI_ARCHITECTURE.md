# TUI Architecture

The interactive terminal UI is native Rust and runs in the canonical `maestro` process. Its implementation lives in `packages/tui-rs` and uses ratatui/crossterm around the same agent core used by print, exec, headless, web chat, and hosted execution.

The internal crate and development binary retain the `maestro-tui` name, but users install and invoke `maestro` only. There is no launcher subprocess or alternate agent implementation.

Key modules include the entrypoint and command parser, agent/provider loop, tool registry and approval engine, session persistence, headless protocol, hosted runner, hooks, and UI components. Tests under `packages/tui-rs/tests` exercise the direct CLI, protocol, security, migration, hosted, and replay boundaries.
