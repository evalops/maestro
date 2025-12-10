//! WebAssembly plugin support for hooks
//!
//! Provides sandboxed execution of WASM plugins for hooks. WASM plugins offer:
//! - Strong sandboxing (no filesystem/network access by default)
//! - Language agnostic (write hooks in Rust, Go, C, AssemblyScript, etc.)
//! - Fast startup and execution
//!
//! # Plugin Interface
//!
//! WASM plugins export these functions:
//!
//! ```text
//! // Called on PreToolUse events
//! // Returns: 0 = continue, 1 = block, 2 = modify
//! extern "C" fn on_pre_tool_use(input_ptr: i32, input_len: i32) -> i32;
//!
//! // Get the result data (block reason, modified input, etc.)
//! extern "C" fn get_result(out_ptr: i32, out_len: i32) -> i32;
//!
//! // Allocate memory for input data
//! extern "C" fn alloc(size: i32) -> i32;
//!
//! // Free allocated memory
//! extern "C" fn dealloc(ptr: i32, size: i32);
//! ```
//!
//! # Example Plugin (Rust)
//!
//! ```rust,ignore
//! #[no_mangle]
//! pub extern "C" fn on_pre_tool_use(input_ptr: i32, input_len: i32) -> i32 {
//!     // Parse input JSON from memory
//!     let input = unsafe {
//!         let slice = std::slice::from_raw_parts(input_ptr as *const u8, input_len as usize);
//!         serde_json::from_slice::<PreToolUseInput>(slice).unwrap()
//!     };
//!
//!     // Check for dangerous commands
//!     if input.tool_name == "Bash" {
//!         if let Some(cmd) = input.tool_input.get("command") {
//!             if cmd.as_str().unwrap_or("").contains("rm -rf /") {
//!                 return 1; // Block
//!             }
//!         }
//!     }
//!
//!     0 // Continue
//! }
//! ```

use super::types::*;
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// WASM hook executor (stub - requires wasmtime dependency)
///
/// To enable WASM hooks, add to Cargo.toml:
/// ```toml
/// wasmtime = "18"
/// ```
pub struct WasmHookExecutor {
    /// Loaded plugins
    plugins: Vec<WasmPlugin>,
}

struct WasmPlugin {
    path: PathBuf,
    event: HookEventType,
    tools: Vec<String>,
    /// Cached WASM bytes
    #[allow(dead_code)]
    bytes: Vec<u8>,
}

/// Result codes from WASM plugins
#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WasmResultCode {
    Continue = 0,
    Block = 1,
    Modify = 2,
    InjectContext = 3,
    Error = -1,
}

impl From<i32> for WasmResultCode {
    fn from(code: i32) -> Self {
        match code {
            0 => WasmResultCode::Continue,
            1 => WasmResultCode::Block,
            2 => WasmResultCode::Modify,
            3 => WasmResultCode::InjectContext,
            _ => WasmResultCode::Error,
        }
    }
}

impl WasmHookExecutor {
    /// Create a new WASM executor
    pub fn new() -> Self {
        Self {
            plugins: Vec::new(),
        }
    }

    /// Load a WASM plugin from a file
    pub fn load_plugin(
        &mut self,
        path: &Path,
        event: HookEventType,
        tools: Vec<String>,
    ) -> Result<()> {
        let bytes = std::fs::read(path)
            .with_context(|| format!("Failed to read WASM plugin: {}", path.display()))?;

        // Basic WASM validation (check magic number)
        if bytes.len() < 8 || &bytes[0..4] != b"\0asm" {
            anyhow::bail!("Invalid WASM file: {}", path.display());
        }

        self.plugins.push(WasmPlugin {
            path: path.to_path_buf(),
            event,
            tools,
            bytes,
        });

        Ok(())
    }

    /// Execute PreToolUse hooks
    pub fn execute_pre_tool_use(&self, input: &PreToolUseInput) -> HookResult {
        for plugin in &self.plugins {
            if plugin.event != HookEventType::PreToolUse {
                continue;
            }
            if !plugin.tools.is_empty() && !plugin.tools.contains(&input.tool_name) {
                continue;
            }

            match self.run_wasm_plugin(plugin, input) {
                Ok(result) => {
                    if !matches!(result, HookResult::Continue) {
                        return result;
                    }
                }
                Err(e) => {
                    eprintln!(
                        "[wasm-hook] Error running {}: {}",
                        plugin.path.display(),
                        e
                    );
                }
            }
        }
        HookResult::Continue
    }

    /// Run a WASM plugin (stub implementation)
    ///
    /// Full implementation requires wasmtime or wasmer runtime.
    fn run_wasm_plugin(&self, plugin: &WasmPlugin, input: &PreToolUseInput) -> Result<HookResult> {
        // Stub implementation - just log that we would run the plugin
        eprintln!(
            "[wasm-hook] Would execute plugin: {} for tool: {}",
            plugin.path.display(),
            input.tool_name
        );

        // In a full implementation, this would:
        // 1. Create a wasmtime Engine and Store
        // 2. Compile the WASM module
        // 3. Create an instance with memory imports
        // 4. Serialize input to JSON and copy to WASM memory
        // 5. Call on_pre_tool_use export
        // 6. Read result from WASM memory
        // 7. Parse and return HookResult

        Ok(HookResult::Continue)
    }

    /// Check if any WASM plugins are loaded
    pub fn has_plugins(&self) -> bool {
        !self.plugins.is_empty()
    }

    /// Get the number of loaded plugins
    pub fn plugin_count(&self) -> usize {
        self.plugins.len()
    }

    /// Get plugin paths
    pub fn plugin_paths(&self) -> Vec<&Path> {
        self.plugins.iter().map(|p| p.path.as_path()).collect()
    }
}

impl Default for WasmHookExecutor {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// Full WASM Implementation (requires wasmtime feature)
// ============================================================================

#[cfg(feature = "wasm")]
mod full_wasm {
    use super::*;
    use wasmtime::*;

    pub struct FullWasmExecutor {
        engine: Engine,
        modules: HashMap<PathBuf, Module>,
    }

    impl FullWasmExecutor {
        pub fn new() -> Result<Self> {
            let engine = Engine::default();
            Ok(Self {
                engine,
                modules: HashMap::new(),
            })
        }

        pub fn load_module(&mut self, path: &Path) -> Result<()> {
            let module = Module::from_file(&self.engine, path)?;
            self.modules.insert(path.to_path_buf(), module);
            Ok(())
        }

        pub fn execute(&self, path: &Path, input: &PreToolUseInput) -> Result<HookResult> {
            let module = self
                .modules
                .get(path)
                .ok_or_else(|| anyhow::anyhow!("Module not loaded: {}", path.display()))?;

            let mut store = Store::new(&self.engine, ());
            let instance = Instance::new(&mut store, module, &[])?;

            // Get exports
            let alloc = instance.get_typed_func::<i32, i32>(&mut store, "alloc")?;
            let on_pre_tool_use =
                instance.get_typed_func::<(i32, i32), i32>(&mut store, "on_pre_tool_use")?;
            let memory = instance
                .get_memory(&mut store, "memory")
                .ok_or_else(|| anyhow::anyhow!("No memory export"))?;

            // Serialize input
            let input_json = serde_json::to_vec(input)?;
            let input_len = input_json.len() as i32;

            // Allocate memory in WASM
            let input_ptr = alloc.call(&mut store, input_len)?;

            // Copy input to WASM memory
            memory.write(&mut store, input_ptr as usize, &input_json)?;

            // Call hook function
            let result_code = on_pre_tool_use.call(&mut store, (input_ptr, input_len))?;

            match WasmResultCode::from(result_code) {
                WasmResultCode::Continue => Ok(HookResult::Continue),
                WasmResultCode::Block => {
                    // Would read reason from WASM memory
                    Ok(HookResult::Block {
                        reason: "Blocked by WASM plugin".to_string(),
                    })
                }
                WasmResultCode::Modify => {
                    // Would read modified input from WASM memory
                    Ok(HookResult::Continue)
                }
                WasmResultCode::InjectContext => {
                    // Would read context from WASM memory
                    Ok(HookResult::InjectContext {
                        context: "Context from WASM".to_string(),
                    })
                }
                WasmResultCode::Error => {
                    anyhow::bail!("WASM plugin returned error")
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn test_wasm_executor_stub() {
        let executor = WasmHookExecutor::new();
        assert!(!executor.has_plugins());
        assert_eq!(executor.plugin_count(), 0);
    }

    #[test]
    fn test_invalid_wasm_rejected() {
        let mut executor = WasmHookExecutor::new();

        // Create a temp file with invalid WASM content
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(b"not a wasm file").unwrap();

        let result = executor.load_plugin(
            file.path(),
            HookEventType::PreToolUse,
            vec!["Bash".to_string()],
        );

        assert!(result.is_err());
    }

    #[test]
    fn test_valid_wasm_header() {
        let mut executor = WasmHookExecutor::new();

        // Create a temp file with valid WASM magic number (minimal valid module)
        let mut file = NamedTempFile::new().unwrap();
        // WASM magic: \0asm + version 1
        file.write_all(&[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
            .unwrap();

        let result = executor.load_plugin(
            file.path(),
            HookEventType::PreToolUse,
            vec!["Bash".to_string()],
        );

        assert!(result.is_ok());
        assert!(executor.has_plugins());
    }
}
