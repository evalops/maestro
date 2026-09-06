# maestro-execpolicy

Dependency-light parser and evaluator for Maestro command execution policies.

The crate is intentionally separate from the TUI so policy parsing, policy
fixture tests, and future callers do not pull in terminal rendering or the
agent runtime. The existing maestro_tui::execpolicy path remains a public
compatibility re-export.

This crate is not connected to the live approval path. Its load_policy helper
reads repository-controlled policy files and must not be wired into runtime
approval without a workspace-trust gate and the documented correctness fixes.
