# Codex Parity Conformance

Maestro borrows several high-leverage interaction contracts from Codex, but
twists them for EvalOps runtime, web, and hosted-runner use. This lightweight
suite keeps those surfaces visible so parity does not regress by accident while
implementation continues to move.

The executable manifest lives at
[`codex-parity-conformance.json`](./codex-parity-conformance.json). It pins
anchors for:

- ChatGPT Codex auth/session routing
- native `apply_patch` grammar and staged patch behavior
- MCP resource and prompt bridge helpers
- prompt queue and Tab-submit/queue behavior across TypeScript and Rust TUI
- hosted headless runtime conformance

Run locally with:

```bash
npm run check:codex-parity
```

The check is intentionally compact. It is not a substitute for the focused unit
and runtime suites; it is the tripwire that says, "if this anchor moved, update
the conformance map and the surrounding tests deliberately."
