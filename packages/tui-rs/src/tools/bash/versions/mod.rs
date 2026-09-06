//! Version-specific behavior modules for the bash tool.
//!
//! Pattern adopted from grok-build (`xai-grok-tools`): each pinned legacy
//! contract version lives in its own module here, while the current behavior
//! remains in `bash/mod.rs`. Selection between them goes through
//! [`super::BashVersion`], and the selected version is stamped into
//! `BashDetails` so the tool receipt / session entry records exactly which
//! behavior produced a result — session replay can read that field and pin
//! the same version via `ToolExecutor::pin_tool_version`.
//!
//! - `legacy_1`: observable behavior from before the #3070 security
//!   hardening — full-output captures written to the shared system temp dir
//!   with default permissions (no private state dir, no 0600 mode, no stale
//!   sweep), and the pre-hardening auto-approval rules (whitespace-split
//!   `find` flag detection, unrestricted `git branch`/`git remote`,
//!   auto-approved `cargo check`).

pub(crate) mod legacy_1;
