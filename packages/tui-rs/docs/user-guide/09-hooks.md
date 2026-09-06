# Hooks

Hooks intercept agent lifecycle events so you can validate, block, log, or transform tool use. Design detail: [Hooks System](../../../../docs/design/HOOKS_SYSTEM.md).

---

## Config locations

| Scope | Path |
|-------|------|
| User JSON | `~/.maestro/hooks.json` |
| Project JSON | `.maestro/hooks.json` |
| User / project TOML | `~/.maestro/hooks.toml`, project hooks TOML |
| Legacy | `~/.composer/hooks.toml`, `.composer/hooks.toml` |

Examples ship under `examples/hooks/` in the repo.

---

## Events

| Event | Can block | Notes |
|-------|-----------|-------|
| `PreToolUse` | yes | Before tool execution; can modify input |
| `PostToolUse` | no | After success |
| `PostToolUseFailure` | no | After failure |
| `SessionStart` / `SessionEnd` | no | Session lifecycle |
| `SubagentStart` / `SubagentStop` | start can block | Subagent lifecycle |
| `UserPromptSubmit` | yes | When the user submits a prompt |
| `Notification` | no | Notifications |
| `PreCompact` | yes | Before context compaction |
| `PermissionRequest` | yes | Permission flows |

---

## Hook types

Depending on runtime support:

| Type | Description |
|------|-------------|
| `command` | Shell command; JSON on stdin |
| `lua` / `lua_file` | Inline or file Lua |
| `wasm` | WASM plugin |

---

## Environment variables

```bash
export MAESTRO_HOOKS_PRE_TOOL_USE="./hooks/pre-tool.sh"
export MAESTRO_HOOKS_POST_TOOL_USE="./hooks/post-tool.sh"
export MAESTRO_HOOKS_USER_PROMPT_SUBMIT="./hooks/validate-prompt.sh"
```

---

## JSON example

```json
{
  "hooks": [
    {
      "event": "PreToolUse",
      "matcher": "bash",
      "command": "./hooks/pre-tool.sh"
    }
  ]
}
```

Exact schema fields can vary by surface; start from `examples/hooks/` and the design doc.

---

## TOML example (legacy-compatible sample)

```toml
[settings]
enabled = true
timeout_ms = 30000

[[hooks]]
event = "PreToolUse"
tools = ["Bash"]
description = "Block dangerous shell commands"
lua = """
if tool_name == "Bash" then
  local cmd = tool_input.command or ""
  if cmd:match("rm %-rf /") then
    return { block = true, reason = "Dangerous rm command blocked" }
  end
end
return { continue = true }
"""
```

```toml
[[hooks]]
event = "PreToolUse"
wasm = "~/.maestro/plugins/safety.wasm"
required = false # explicit advisory behavior
```

WASM `PreToolUse` hooks are fail-closed by default because they can enforce a
tool policy. Set `required = false` explicitly when a WASM hook is advisory;
load, timeout, resource, and invalid-result failures are then logged and the
tool call continues. A build without the optional `wasm` feature never treats
a configured WASM hook as active.

---

## In-session management

```text
/hooks
/hooks list
/hooks toggle
/hooks reload
/hooks metrics
/hooks enable
/hooks disable
```

Alias: `/hook`. Native CLI also exposes `maestro hooks` early-exit helpers via `maestro`.
