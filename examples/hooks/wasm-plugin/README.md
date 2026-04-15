# WASM Safety Plugin for Maestro

This is an example WebAssembly hook plugin that blocks dangerous shell commands.

## Building

```bash
# Install WASM target
rustup target add wasm32-unknown-unknown

# Build the plugin
cargo build --release --target wasm32-unknown-unknown

# The plugin will be at:
# target/wasm32-unknown-unknown/release/safety_plugin.wasm
```

## Installation

```bash
# Create plugins directory
mkdir -p ~/.maestro/plugins

# Copy the plugin
cp target/wasm32-unknown-unknown/release/safety_plugin.wasm ~/.maestro/plugins/
```

## Configuration

Add to `~/.maestro/hooks.toml`:

```toml
[[hooks]]
event = "PreToolUse"
tools = ["Bash"]
description = "WASM safety plugin"
wasm = "~/.maestro/plugins/safety_plugin.wasm"
```

## Plugin Interface

WASM plugins export these functions:

| Function | Signature | Description |
|----------|-----------|-------------|
| `alloc` | `(size: i32) -> i32` | Allocate memory for input |
| `dealloc_mem` | `(ptr: i32, size: i32)` | Free allocated memory |
| `on_pre_tool_use` | `(ptr: i32, len: i32) -> i32` | Main hook entry point |
| `get_result` | `(ptr: i32, len: i32) -> i32` | Get result JSON |
| `get_result_len` | `() -> i32` | Get result buffer size |

### Return Codes

| Code | Meaning |
|------|---------|
| 0 | Continue execution |
| 1 | Block execution |
| 2 | Modify input |
| 3 | Inject context |
| -1 | Error |

## Blocked Patterns

This plugin blocks these dangerous command patterns:

- `rm -rf /` - Recursive delete of root
- `rm -rf /*` - Recursive delete of root contents
- `rm -rf ~` - Recursive delete of home directory
- `mkfs.` - Filesystem creation
- `dd if=/dev/zero of=/dev/sd` - Disk overwrite
- `> /dev/sda` - Disk overwrite via redirect
- `chmod -R 777 /` - Dangerous permissions
- `:(){ :|:& };:` - Fork bomb

## Writing Your Own Plugin

1. Copy this example as a starting point
2. Modify the `is_dangerous_command` function
3. Build and install the plugin
4. Update `hooks.toml` to reference your plugin

### Input Format

The plugin receives JSON input:

```json
{
  "tool_name": "Bash",
  "tool_input": { "command": "ls -la" },
  "cwd": "/path/to/project",
  "session_id": "abc123"
}
```

### Output Format

The plugin returns JSON:

```json
{
  "continue": false,
  "block_reason": "Blocked dangerous pattern: rm -rf /"
}
```
