# Composer Hook System

The Rust TUI includes a comprehensive hook system for intercepting and modifying agent behavior.

## Features

- **Multiple backends**: Native Rust, Lua scripting, WASM plugins
- **Event types**: PreToolUse, PostToolUse, SessionStart, SessionEnd, Overflow
- **Safety hooks**: Built-in protection against dangerous commands
- **Metrics**: Execution timing and call counts
- **Hot reload**: Reload hooks without restarting

## Configuration

Hooks are configured via TOML files:
- `~/.composer/hooks.toml` - Global hooks
- `.composer/hooks.toml` - Project-local hooks

### Example Configuration

```toml
[settings]
enabled = true
timeout_ms = 30000
log_file = "~/.composer/hooks.log"

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

[[hooks]]
event = "PreToolUse"
lua_file = "~/.composer/hooks/safety.lua"

[[hooks]]
event = "PreToolUse"
wasm = "~/.composer/plugins/safety.wasm"
```

## Hook Types

### Native Rust Hooks

Implement traits directly:

```rust
use composer_tui::hooks::{PreToolUseHook, HookResult, PreToolUseInput};

struct MyHook;

impl PreToolUseHook for MyHook {
    fn on_pre_tool_use(&self, input: &PreToolUseInput) -> HookResult {
        if input.tool_name == "Bash" {
            // Check command...
        }
        HookResult::Continue
    }
}
```

### Lua Hooks

Lua scripts receive globals and return a result table:

```lua
-- Globals available:
-- event_type, tool_name, tool_input, cwd, session_id

if tool_name == "Bash" then
    local cmd = tool_input.command or ""
    if cmd:match("dangerous") then
        return { block = true, reason = "Blocked" }
    end
end

return { continue = true }
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

## Built-in Hooks

### SafetyHook

Blocks dangerous commands:
- `rm -rf /`
- `rm -rf /*`
- Fork bombs
- Disk overwrite commands

### AutoCompactHook

Allows automatic compaction on overflow.

## Metrics

```rust
let metrics = hooks.metrics();
println!("PreToolUse calls: {}", metrics.pre_tool_use_count);
println!("Blocks: {}", metrics.blocks);
println!("Avg duration: {:?}", metrics.average_duration());
```

## Hot Reload

```rust
let result = hooks.reload()?;
println!("Reloaded {} Lua, {} WASM", result.lua_scripts, result.wasm_plugins);
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
