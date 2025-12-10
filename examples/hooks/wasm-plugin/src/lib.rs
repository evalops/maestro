//! Safety Hook WASM Plugin
//!
//! This is an example WASM plugin that blocks dangerous shell commands.
//! It demonstrates the WASM hook plugin interface for Composer.
//!
//! # Building
//!
//! ```bash
//! # Add WASM target
//! rustup target add wasm32-unknown-unknown
//!
//! # Build the plugin
//! cargo build --release --target wasm32-unknown-unknown
//!
//! # Copy to hooks directory
//! cp target/wasm32-unknown-unknown/release/safety_plugin.wasm ~/.composer/plugins/
//! ```
//!
//! # Configuration
//!
//! Add to `~/.composer/hooks.toml`:
//!
//! ```toml
//! [[hooks]]
//! event = "PreToolUse"
//! tools = ["Bash"]
//! wasm = "~/.composer/plugins/safety_plugin.wasm"
//! ```

use serde::{Deserialize, Serialize};
use std::alloc::{alloc, dealloc, Layout};

/// Result codes returned by the hook
#[repr(i32)]
pub enum ResultCode {
    Continue = 0,
    Block = 1,
    Modify = 2,
    InjectContext = 3,
    Error = -1,
}

/// Input data for PreToolUse hooks
#[derive(Deserialize)]
struct PreToolUseInput {
    tool_name: String,
    tool_input: serde_json::Value,
    #[allow(dead_code)]
    cwd: String,
    #[allow(dead_code)]
    session_id: Option<String>,
}

/// Output data from the hook
#[derive(Serialize)]
struct HookOutput {
    #[serde(rename = "continue")]
    should_continue: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    block_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context: Option<String>,
}

/// Static buffer for result data
static mut RESULT_BUFFER: Vec<u8> = Vec::new();

/// Dangerous command patterns to block
const DANGEROUS_PATTERNS: &[&str] = &[
    "rm -rf /",
    "rm -rf /*",
    "rm -rf ~",
    "mkfs.",
    "dd if=/dev/zero of=/dev/sd",
    "> /dev/sda",
    "chmod -R 777 /",
    ":(){ :|:& };:",
];

/// Check if a command matches any dangerous pattern
fn is_dangerous_command(command: &str) -> Option<&'static str> {
    for pattern in DANGEROUS_PATTERNS {
        if command.contains(pattern) {
            return Some(pattern);
        }
    }
    None
}

/// Allocate memory for input data
///
/// Called by the host to allocate a buffer for passing input to the plugin.
#[no_mangle]
pub extern "C" fn alloc(size: i32) -> i32 {
    let layout = Layout::from_size_align(size as usize, 1).unwrap();
    unsafe {
        let ptr = alloc(layout);
        ptr as i32
    }
}

/// Free allocated memory
#[no_mangle]
pub extern "C" fn dealloc_mem(ptr: i32, size: i32) {
    let layout = Layout::from_size_align(size as usize, 1).unwrap();
    unsafe {
        dealloc(ptr as *mut u8, layout);
    }
}

/// Main hook entry point
///
/// Called by the host when a PreToolUse event occurs.
///
/// # Arguments
/// * `input_ptr` - Pointer to JSON input data
/// * `input_len` - Length of input data
///
/// # Returns
/// * 0 - Continue execution
/// * 1 - Block execution
/// * -1 - Error
#[no_mangle]
pub extern "C" fn on_pre_tool_use(input_ptr: i32, input_len: i32) -> i32 {
    // Read input from memory
    let input_slice = unsafe {
        std::slice::from_raw_parts(input_ptr as *const u8, input_len as usize)
    };

    // Parse JSON input
    let input: PreToolUseInput = match serde_json::from_slice(input_slice) {
        Ok(i) => i,
        Err(_) => return ResultCode::Error as i32,
    };

    // Only check Bash commands
    if input.tool_name != "Bash" && input.tool_name != "bash" {
        return store_result(HookOutput {
            should_continue: true,
            block_reason: None,
            context: None,
        });
    }

    // Get the command string
    let command = input
        .tool_input
        .get("command")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    // Check for dangerous patterns
    if let Some(pattern) = is_dangerous_command(command) {
        return store_result(HookOutput {
            should_continue: false,
            block_reason: Some(format!("Blocked dangerous pattern: {}", pattern)),
            context: None,
        });
    }

    // Continue execution
    store_result(HookOutput {
        should_continue: true,
        block_reason: None,
        context: None,
    })
}

/// Store result in the global buffer and return result code
fn store_result(output: HookOutput) -> i32 {
    let result_code = if output.should_continue {
        ResultCode::Continue
    } else {
        ResultCode::Block
    };

    // Serialize to JSON
    if let Ok(json) = serde_json::to_vec(&output) {
        unsafe {
            RESULT_BUFFER = json;
        }
    }

    result_code as i32
}

/// Get the result data
///
/// Called by the host to retrieve the result after on_pre_tool_use returns.
///
/// # Arguments
/// * `out_ptr` - Pointer to output buffer
/// * `out_len` - Maximum length of output buffer
///
/// # Returns
/// * Actual length of result data written
#[no_mangle]
pub extern "C" fn get_result(out_ptr: i32, out_len: i32) -> i32 {
    unsafe {
        let len = std::cmp::min(RESULT_BUFFER.len(), out_len as usize);
        if len > 0 {
            std::ptr::copy_nonoverlapping(
                RESULT_BUFFER.as_ptr(),
                out_ptr as *mut u8,
                len,
            );
        }
        len as i32
    }
}

/// Get the size of the result buffer
#[no_mangle]
pub extern "C" fn get_result_len() -> i32 {
    unsafe { RESULT_BUFFER.len() as i32 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dangerous_patterns() {
        assert!(is_dangerous_command("rm -rf /").is_some());
        assert!(is_dangerous_command("rm -rf ~").is_some());
        assert!(is_dangerous_command("mkfs.ext4 /dev/sda1").is_some());
        assert!(is_dangerous_command("ls -la").is_none());
        assert!(is_dangerous_command("echo hello").is_none());
    }

    #[test]
    fn test_hook_output_serialization() {
        let output = HookOutput {
            should_continue: false,
            block_reason: Some("test".to_string()),
            context: None,
        };
        let json = serde_json::to_string(&output).unwrap();
        assert!(json.contains("continue"));
        assert!(json.contains("block_reason"));
    }
}
