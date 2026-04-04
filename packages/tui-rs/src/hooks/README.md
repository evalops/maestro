# Maestro Hook System

The Rust TUI includes a comprehensive hook system for intercepting and modifying agent behavior.

## Features

- **Multiple backends**: Native Rust, Lua scripting, WASM plugins
- **17 Event types**: Full lifecycle coverage from message to tool execution
- **Safety hooks**: Built-in protection against dangerous commands
- **Metrics**: Execution timing and call counts
- **Hot reload**: Reload hooks without restarting
- **Notification system**: Terminal (OSC 9) and external program notifications

## Event Types

| Event | When | Can Block | Can Modify |
|-------|------|-----------|------------|
| `PreToolUse` | Before tool execution | Yes | Yes (input) |
| `PostToolUse` | After tool execution | No | Yes (context) |
| `PostToolUseFailure` | After tool failure | No | No |
| `SessionStart` | Session begins | No | No |
| `SessionEnd` | Session ends | No | No |
| `UserPromptSubmit` | User submits prompt | Yes | Yes |
| `PreCompact` | Before compaction | Yes | No |
| `PostCompact` | After compaction succeeds | No | No |
| `Notification` | Various notifications | No | No |
| `Overflow` | Context overflow detected | Yes | No |
| `PreMessage` | Before sending to model | Yes | Yes (message) |
| `PostMessage` | After model response | No | No |
| `OnError` | Error occurs | Yes | No |
| `EvalGate` | After tool (for eval) | No | No |
| `SubagentStart` | Before spawning subagent | Yes | Yes |
| `SubagentStop` | Subagent completes | No | No |
| `PermissionRequest` | Permission required | Yes | No |

## Configuration

Hooks are configured via TOML files:
- `~/.maestro/hooks.toml` - Global hooks
- `.maestro/hooks.toml` - Project-local hooks

### Example Configuration

```toml
[settings]
enabled = true
timeout_ms = 30000
log_file = "~/.maestro/hooks.log"

# Block dangerous commands
[[hooks]]
event = "PreToolUse"
tools = ["Bash"]
lua = """
if tool_name == "Bash" then
    local cmd = tool_input.command or ""
    if cmd:match("rm %-rf /") then
        return { block = true, reason = "Dangerous command blocked" }
    end
end
return { continue = true }
"""

# Load from file
[[hooks]]
event = "PreToolUse"
lua_file = "~/.maestro/hooks/safety.lua"

# WASM plugin
[[hooks]]
event = "PreToolUse"
wasm = "~/.maestro/plugins/safety.wasm"

# Block long messages
[[hooks]]
event = "PreMessage"
lua = """
if #message > 100000 then
    return { block = true, reason = "Message too long" }
end
return { continue = true }
"""

# Log errors
[[hooks]]
event = "OnError"
lua = """
print(string.format("[ERROR] %s: %s", error_kind, error))
return { continue = true }
"""
```

## Hook Types

### Native Rust Hooks

Implement traits directly:

```rust
use maestro_tui::hooks::{
    PreToolUseHook, PreMessageHook, OnErrorHook,
    HookResult, PreToolUseInput, PreMessageInput, OnErrorInput,
};
use std::sync::Arc;

// PreToolUse hook
struct MySafetyHook;

impl PreToolUseHook for MySafetyHook {
    fn on_pre_tool_use(&self, input: &PreToolUseInput) -> HookResult {
        if input.tool_name == "Bash" {
            if let Some(cmd) = input.tool_input.get("command").and_then(|v| v.as_str()) {
                if cmd.contains("rm -rf /") {
                    return HookResult::Block {
                        reason: "Dangerous command blocked".to_string(),
                    };
                }
            }
        }
        HookResult::Continue
    }
}

// PreMessage hook
struct MessageLimitHook {
    max_length: usize,
}

impl PreMessageHook for MessageLimitHook {
    fn on_pre_message(&self, input: &PreMessageInput) -> HookResult {
        if input.message.len() > self.max_length {
            HookResult::Block {
                reason: format!("Message exceeds {} chars", self.max_length),
            }
        } else {
            HookResult::Continue
        }
    }
}

// OnError hook
struct ErrorLoggerHook;

impl OnErrorHook for ErrorLoggerHook {
    fn on_error(&self, input: &OnErrorInput) -> HookResult {
        eprintln!("[{}] Error: {}", input.error_kind, input.error);
        HookResult::Continue
    }
}

// Register hooks
let mut registry = HookRegistry::new();
registry.register_pre_tool_use(Arc::new(MySafetyHook));
registry.register_pre_message(Arc::new(MessageLimitHook { max_length: 100000 }));
registry.register_on_error(Arc::new(ErrorLoggerHook));
```

### Available Traits

| Trait | Event | Input Type |
|-------|-------|------------|
| `PreToolUseHook` | PreToolUse | `PreToolUseInput` |
| `PostToolUseHook` | PostToolUse | `PostToolUseInput` |
| `SessionStartHook` | SessionStart | `SessionStartInput` |
| `SessionEndHook` | SessionEnd | `SessionEndInput` |
| `OverflowHook` | Overflow | `OverflowInput` |
| `PreMessageHook` | PreMessage | `PreMessageInput` |
| `PostMessageHook` | PostMessage | `PostMessageInput` |
| `OnErrorHook` | OnError | `OnErrorInput` |
| `EvalGateHook` | EvalGate | `EvalGateInput` |
| `SubagentStartHook` | SubagentStart | `SubagentStartInput` |
| `SubagentStopHook` | SubagentStop | `SubagentStopInput` |
| `PermissionRequestHook` | PermissionRequest | `PermissionRequestInput` |

### Lua Hooks

Lua scripts receive globals and return a result table:

```lua
-- Globals available:
-- event_type, tool_name, tool_input, cwd, session_id
-- message, attachments, model (for PreMessage)
-- error, error_kind, context, recoverable (for OnError)
-- response, input_tokens, output_tokens, duration_ms, stop_reason (for PostMessage)

-- PreToolUse example
if tool_name == "Bash" then
    local cmd = tool_input.command or ""
    if cmd:match("dangerous") then
        return { block = true, reason = "Blocked" }
    end
end
return { continue = true }

-- Inject context example
return {
    continue = true,
    context = "Additional info for the model"
}

-- Modify input example
return {
    continue = true,
    modified_input = { command = "safe_command" }
}
```

Enable with: `cargo build --features lua`

### WASM Hooks

WASM plugins export these functions:

```rust
#[no_mangle]
pub extern "C" fn alloc(size: i32) -> i32;

#[no_mangle]
pub extern "C" fn on_pre_tool_use(input_ptr: i32, input_len: i32) -> i32;

#[no_mangle]
pub extern "C" fn on_post_tool_use(input_ptr: i32, input_len: i32) -> i32;

#[no_mangle]
pub extern "C" fn get_result(out_ptr: i32, out_len: i32) -> i32;

#[no_mangle]
pub extern "C" fn get_result_len() -> i32;
```

Return codes:
- 0: Continue
- 1: Block
- 2: Modify input
- 3: Inject context

Enable with: `cargo build --features wasm`

## Hook Results

Hooks can return:

| Result | Effect |
|--------|--------|
| `Continue` | Proceed with normal execution |
| `Block { reason }` | Stop execution, return error to model |
| `ModifyInput { new_input }` | Use modified tool input |
| `InjectContext { context }` | Append context to tool output |

## IntegratedHookSystem

The main entry point for hook execution:

```rust
use maestro_tui::hooks::IntegratedHookSystem;

// Create from working directory
let mut hooks = IntegratedHookSystem::load_from_config("/path/to/cwd");

// Session lifecycle
hooks.on_session_start("cli");
hooks.increment_turn();
hooks.on_session_end("user_quit");

// Tool execution
let result = hooks.execute_pre_tool_use("Bash", "call_123", &json!({"command": "ls"}));
match result {
    HookResult::Block { reason } => println!("Blocked: {}", reason),
    HookResult::Continue => { /* execute tool */ }
    _ => {}
}

// Message lifecycle
let result = hooks.execute_pre_message("Hello", &[], Some("claude-3-opus"));
let result = hooks.execute_post_message("Response", 1000, 500, 2500, Some("end_turn"));

// Error handling
hooks.execute_on_error("Connection failed", "NetworkError", Some("api_call"), true);

// Subagent lifecycle
hooks.execute_subagent_start("explore", "Find files", Some("parent_123"));
hooks.execute_subagent_stop("explore", "agent_456", Some("Found 15 files"), 5000, true);

// Permission requests
hooks.execute_permission_request("Bash", "call_789", &json!({}), "Requires approval");
```

## Built-in Hooks

### SafetyHook

Blocks dangerous commands:
- `rm -rf /`
- `rm -rf /*`
- Fork bombs
- Disk overwrite commands

### AutoCompactHook

Allows automatic compaction on overflow.

## Notification Hooks

Configure terminal and external program notifications:

```bash
# Environment variables
export MAESTRO_NOTIFY_PROGRAM=/path/to/script
export MAESTRO_NOTIFY_EVENTS=turn-complete,session-end,error
export MAESTRO_NOTIFY_TERMINAL=true  # Enable OSC 9 notifications

# Or via ~/.maestro/hooks.json
{
  "notify": {
    "program": "/path/to/script",
    "events": ["turn-complete", "session-end"],
    "terminalNotify": true
  }
}
```

Supported terminals for OSC 9: iTerm2, Ghostty, WezTerm, Windows Terminal

## Metrics

```rust
let metrics = hooks.metrics();
println!("PreToolUse calls: {}", metrics.pre_tool_use_count);
println!("PostToolUse calls: {}", metrics.post_tool_use_count);
println!("Overflow events: {}", metrics.overflow_count);
println!("Blocks: {}", metrics.blocks);
println!("Avg duration: {:?}", metrics.average_duration());
```

## Hot Reload

```rust
let result = hooks.reload()?;
println!("Reloaded {} Lua, {} WASM", result.lua_scripts, result.wasm_plugins);
```

Enable file watching with:
```rust
use maestro_tui::hooks::HotReloader;

let mut reloader = HotReloader::for_cwd("/path/to/cwd")?;
// In event loop:
for event in reloader.poll() {
    hooks.reload();
}
```

## /hooks Command

The TUI includes a `/hooks` command:

```
/hooks              # List all hooks
/hooks list         # Same as above
/hooks toggle       # Enable/disable hooks
/hooks enable       # Enable hooks
/hooks disable      # Disable hooks
/hooks reload       # Reload hooks from disk
/hooks metrics      # Show execution metrics
```

## Feature Flags

| Flag | Description |
|------|-------------|
| `lua` | Enable Lua scripting (requires mlua) |
| `wasm` | Enable WASM plugins (requires wasmtime) |
| `hot-reload` | Enable file watching for auto-reload |
| `hooks-full` | Enable all hook features |

## Examples

See `examples/hooks/` for:
- `hooks.toml` - Full configuration example
- `lua/safety.lua` - Lua safety hook
- `lua/logging.lua` - Lua logging hook
- `wasm-plugin/` - Complete WASM plugin example

## Use Cases

### Safety & Compliance

Block access to production systems:

```lua
-- Block production database access
if tool_name == "Bash" then
    local cmd = tool_input.command or ""
    if cmd:match("psql.*prod") or cmd:match("mysql.*production") then
        return { block = true, reason = "Production database access blocked" }
    end
end
return { continue = true }
```

### Audit Logging

Log all file modifications for compliance:

```lua
-- Log every file write
if tool_name == "Write" or tool_name == "Edit" then
    local log = io.open(os.getenv("HOME") .. "/.maestro/audit.log", "a")
    if log then
        log:write(os.date("%Y-%m-%d %H:%M:%S") .. " " .. tool_input.file_path .. "\n")
        log:close()
    end
end
return { continue = true }
```

### Context Injection

Automatically remind the model of project conventions:

```lua
-- Inject project-specific context
if tool_name == "Bash" then
    return {
        continue = true,
        context = "Project uses pnpm (not npm). Use 'pnpm run' for scripts."
    }
end
return { continue = true }
```

### Cost Control

Enforce token budgets per session:

```toml
[[hooks]]
event = "PostMessage"
lua = """
-- Track cumulative tokens (use external state file for persistence)
local total = (input_tokens or 0) + (output_tokens or 0)
if total > 500000 then
    return { block = true, reason = "Session token budget (500k) exceeded" }
end
return { continue = true }
"""
```

### Desktop Notifications

Get notified when long-running tasks complete:

```toml
[[hooks]]
event = "SessionEnd"
lua = """
os.execute('osascript -e \\'display notification \"Session complete\" with title \"Maestro\"\\'')
return { continue = true }
"""
```

Or use the built-in notification system:

```bash
export MAESTRO_NOTIFY_TERMINAL=true
export MAESTRO_NOTIFY_EVENTS=turn-complete,session-end,error
```

### Auto-Approval Patterns

Auto-approve safe operations without prompts:

```toml
[[hooks]]
event = "PermissionRequest"
lua = """
-- Auto-approve reads in safe directories
if tool_name == "Read" then
    local path = tool_input.file_path or tool_input.path or ""
    if path:match("^/usr/share/") or path:match("^/etc/") then
        return { continue = true }  -- auto-approve
    end
end
-- Let other requests go through normal approval
return { continue = true }
"""
```

### Subagent Control

Restrict which agent types can be spawned:

```toml
[[hooks]]
event = "SubagentStart"
lua = """
local allowed = { explore = true, plan = true }
if not allowed[subagent_type] then
    return { block = true, reason = "Agent type '" .. subagent_type .. "' not allowed" }
end
return { continue = true }
"""
```

### Input Rewriting / Sandboxing

Redirect operations to sandboxed locations:

```toml
[[hooks]]
event = "PreToolUse"
tools = ["Write"]
lua = """
local path = tool_input.file_path or ""
-- Redirect /tmp writes to sandbox
if path:match("^/tmp/") then
    local new_path = path:gsub("^/tmp/", "/sandbox/tmp/")
    return {
        modified_input = {
            file_path = new_path,
            content = tool_input.content
        }
    }
end
return { continue = true }
"""
```

### Rate Limiting

Prevent runaway tool execution:

```lua
-- Simple rate limiter (resets on hook reload)
local call_count = 0
local max_calls = 100

call_count = call_count + 1
if call_count > max_calls then
    return { block = true, reason = "Rate limit exceeded (" .. max_calls .. " calls)" }
end
return { continue = true }
```

### Error Recovery

Custom handling for specific error types:

```toml
[[hooks]]
event = "OnError"
lua = """
-- Suppress transient network errors
if error_kind == "NetworkError" and recoverable then
    print("[hooks] Suppressing recoverable network error: " .. error)
    return { block = true }  -- block = suppress error propagation
end
return { continue = true }
"""
```

### Eval Gating

Control what outputs are acceptable for evaluation:

```toml
[[hooks]]
event = "EvalGate"
lua = """
-- Require non-empty output for Bash commands
if tool_name == "Bash" and (tool_output == nil or tool_output == "") then
    return { block = true, reason = "Bash command produced no output" }
end
return { continue = true }
"""
```

## Performance

Hook execution is extremely fast:

| Operation | Time |
|-----------|------|
| System creation | ~85 ns |
| Empty hook check | ~11 ns |
| Safety hook execution | ~32 ns |
| Full pre_tool_use pipeline | ~300 ns |

For comparison, a typical API call takes 500-2000ms. Hook overhead is effectively invisible.
