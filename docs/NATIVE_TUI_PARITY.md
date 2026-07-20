# Native TUI Parity Audit

Audience: contributors tracking feature parity after the TypeScript TUI removal
(PR [#2891](https://github.com/evalops/maestro-internal/pull/2891)).

**Baseline:** former interactive TypeScript agent (`src/cli-tui` + shared
TS agent/tools/MCP/hooks).  
**Current interactive UI:** native `maestro-tui` (`packages/tui-rs`).

Statuses:

| Status | Meaning |
|--------|---------|
| **Present** | Implemented in `packages/tui-rs` with clear code ownership |
| **Partial** | Core path exists; config, UX, or edge coverage may differ from former TS |
| **Open** | Not verified from a quick code audit, or known gap |

This checklist is derived from greps and module layout under `packages/tui-rs`,
not a full behavioral test suite. Update as gaps close.

---

## Summary table

| Area | Status | Evidence (native) | Notes |
|------|--------|-------------------|--------|
| Interactive launch | **Present** | `src/cli/native-tui-launcher.ts`, `src/main.ts` | CLI hands off to `maestro-tui` |
| Agent loop | **Present** | `agent/native.rs`, `agent/protocol.rs` | Standalone Rust agent; no Node subprocess |
| MCP | **Present** | `mcp/` (client, config, http, protocol) | Stdio / HTTP / SSE; `~/.maestro/mcp.json` + project + legacy composer paths |
| Hooks | **Present** | `hooks/` (Lua, WASM, native, bridge) | TOML config; optional Node hook bridge |
| Approvals | **Present** | `components/approval.rs`, `ApprovalMode` in state/badges | YOLO / Selective / Safe; `/approvals` |
| Sandbox | **Present** | `sandbox.rs` | macOS Seatbelt; Linux Landlock + seccomp; other OS unsupported |
| Firewall / safe mode | **Present** | `safety/` | Path containment, bash analysis, `MAESTRO_SAFE_MODE`-style policy |
| Session resume | **Present** | `session/manager.rs`, CLI `--resume` / `--continue` | JSONL; session switcher component |
| Session branching | **Present** | `session/branching.rs` | — |
| Skills | **Present** | `skills/` loaded from `app.rs` | Maestro + legacy composer + `.agents`; Grok-style `/skill` slash |
| Prompt queue / steer | **Present** | `app/prompt_queue.rs` | Follow-up + steer kinds; capacity limits |
| Slash commands | **Present** | `commands/registry.rs` | Built-ins + skills + flat commands/prompts; built-ins win |
| Trailing initial prompt | **Present** | `main.rs` + `shouldLaunchNativeInteractiveTui` | TTY `maestro "…"` → native; `--mode text|json` stays TS |
| Custom prompts / command templates | **Present** | `prompts.rs` | `~/.maestro/{prompts,commands}` + project + legacy |
| Providers | **Partial** | `ai/` (anthropic, openai, google, vertex, …) | Confirm full registry parity vs `packages/ai` as open work |
| Headless protocol | **Present** | `headless/` | Shared contracts; used beyond pure TUI |
| Hosted runner | **Present** | `hosted_runner/`, `maestro-hosted-runner` bin | Continuity / remote runner |
| Context compaction | **Present** | `agent/compaction.rs` | Default auto-threshold ~0.85 |
| LSP | **Partial** | `lsp.rs` | Client present; tool surface depth vs former TS is open |
| Background tasks | **Present** | `tools/background_tasks.rs` | Log rotation under `~/.maestro/logs` |
| Web / Exa / GH tools | **Present** | `tools/exa.rs`, `web_fetch.rs`, `gh.rs`, … | — |
| Connectors (product “connectors”) | **Open** | No dedicated `connector` module name under `tui-rs` | Clarify product meaning (OAuth integrations vs MCP vs A2A) |
| A2A fleet / peer commands | **Partial** | Commands parsed in native registry; see protocols docs | Full controller UX may still grow |
| Telemetry / cost | **Partial** | `telemetry/`, `usage/` | Align dashboards with TS paths as open work |
| Custom commands / prompts | **Present** | `prompts.rs` + slash extensions | Flat md as `/name`; skills preferred on collision |
| Guardian / Semgrep gate | **Open** | — | May remain CLI/scripts outside native agent |
| Enterprise policy surface | **Open** | Policy pieces in `safety/policy.rs` | Full enterprise RBAC UX not audited here |

---

## Area notes

### MCP

- Module: `packages/tui-rs/src/mcp/`
- Transports: stdio, HTTP, SSE
- Config loads user/project/enterprise paths under `~/.maestro` (and legacy
  `~/.composer` / `.composer` for compatibility)
- Slash: `/mcp` for status

### Hooks

- Module: `packages/tui-rs/src/hooks/`
- Backends: native Rust traits, Lua, WASM, optional TypeScript IPC bridge
- Lifecycle events include PreToolUse, PostToolUse, session, compact, overflow,
  subagent, permission (see `hooks/README.md`)

### Approvals & sandbox

- UI: approval modal + controller in `components/approval.rs`
- Modes exposed on status badges (`runtime_badges.rs`)
- Sandbox is OS-native for command execution; pair with firewall for path/command policy

### Session resume

- `SessionManager::resume_session_by_path`, continue-last helpers
- CLI flags: `--resume` / `-r`, continue last session
- Headless supervisor also has recorded-session resume paths

### Skills

- `SkillLoader` / `SkillRegistry` in `skills/`
- `App` loads skills at init and can refresh; injects into system prompt via
  `skills_to_prompt`

### Connectors

Marked **open**: the codebase does not use a single “connectors” crate/module
name. Likely product buckets map to MCP servers, OAuth provider logins (CLI),
A2A peers, or hosted/bridge surfaces. Treat parity as undefined until product
lists the intended matrix.

---

## How to re-audit

```bash
# Module presence
ls packages/tui-rs/src/{mcp,hooks,skills,session,safety,sandbox.rs,app}

# Feature greps
rg -n "McpClient|HookRegistry|SkillLoader|ApprovalMode|spawn_sandboxed|resume_session" packages/tui-rs/src --type rust

# Interactive handoff still native-only
rg -n "launchNativeTui|shouldLaunchNativeInteractiveTui" src/main.ts src/cli/native-tui-launcher.ts
```

## Related

- [TUI Architecture](TUI_ARCHITECTURE.md)
- [packages/tui-rs/ARCHITECTURE.md](../packages/tui-rs/ARCHITECTURE.md)
- [Prompt Queue](PROMPT_QUEUE.md)
- [Safety](SAFETY.md)
