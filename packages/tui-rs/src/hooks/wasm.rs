//! WebAssembly plugin support for hooks
//!
//! Provides sandboxed execution of WASM plugins for hooks. WASM plugins offer:
//! - Strong sandboxing (no filesystem/network access by default)
//! - Language agnostic (write hooks in Rust, Go, C, AssemblyScript, etc.)
//! - Fast startup and execution
//!
//! # Feature Flag
//!
//! Enable with: `cargo build --features wasm`
//!
//! # Plugin Interface
//!
//! WASM plugins export these functions:
//!
//! ```text
//! // Called on PreToolUse events
//! // Returns: 0 = continue, 1 = block, 2 = modify, 3 = inject_context
//! extern "C" fn on_pre_tool_use(input_ptr: i32, input_len: i32) -> i32;
//!
//! // Get the result data (block reason, modified input, etc.)
//! extern "C" fn get_result(out_ptr: i32, out_len: i32) -> i32;
//!
//! // Get the result data length
//! extern "C" fn get_result_len() -> i32;
//!
//! // Allocate memory for input data
//! extern "C" fn alloc(size: i32) -> i32;
//!
//! // Free allocated memory
//! extern "C" fn dealloc(ptr: i32, size: i32);
//! ```

use super::types::*;
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

#[cfg(feature = "wasm")]
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
#[cfg(feature = "wasm")]
use std::time::{Duration, Instant};

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

/// Cached WASM plugin with metadata
#[allow(dead_code)]
struct WasmPlugin {
    path: PathBuf,
    event: HookEventType,
    tools: Vec<String>,
    bytes: Vec<u8>,
}

// ============================================================================
// Stub Implementation (no wasmtime feature)
// ============================================================================

#[cfg(not(feature = "wasm"))]
pub struct WasmHookExecutor {
    plugins: Vec<WasmPlugin>,
}

#[cfg(not(feature = "wasm"))]
impl WasmHookExecutor {
    pub fn new() -> Self {
        Self {
            plugins: Vec::new(),
        }
    }

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

    pub fn execute_pre_tool_use(&self, input: &PreToolUseInput) -> HookResult {
        for plugin in &self.plugins {
            if plugin.event != HookEventType::PreToolUse {
                continue;
            }
            if !plugin.tools.is_empty() && !plugin.tools.contains(&input.tool_name) {
                continue;
            }

            // Stub: log that we would run the plugin
            eprintln!(
                "[wasm-hook] Would execute plugin: {} for tool: {} (enable 'wasm' feature for full support)",
                plugin.path.display(),
                input.tool_name
            );
        }
        HookResult::Continue
    }

    pub fn execute_post_tool_use(&self, input: &PostToolUseInput) -> HookResult {
        for plugin in &self.plugins {
            if plugin.event != HookEventType::PostToolUse {
                continue;
            }
            if !plugin.tools.is_empty() && !plugin.tools.contains(&input.tool_name) {
                continue;
            }

            // Stub: log that we would run the plugin
            eprintln!(
                "[wasm-hook] Would execute post-hook: {} for tool: {} (enable 'wasm' feature for full support)",
                plugin.path.display(),
                input.tool_name
            );
        }
        HookResult::Continue
    }

    pub fn has_plugins(&self) -> bool {
        !self.plugins.is_empty()
    }

    pub fn plugin_count(&self) -> usize {
        self.plugins.len()
    }

    pub fn plugin_paths(&self) -> Vec<&Path> {
        self.plugins.iter().map(|p| p.path.as_path()).collect()
    }

    pub fn reload(&mut self) -> Result<usize> {
        let mut reloaded = 0;
        for plugin in &mut self.plugins {
            if plugin.path.exists() {
                if let Ok(new_bytes) = std::fs::read(&plugin.path) {
                    if new_bytes.len() >= 8 && &new_bytes[0..4] == b"\0asm" {
                        plugin.bytes = new_bytes;
                        reloaded += 1;
                    }
                }
            }
        }
        Ok(reloaded)
    }
}

#[cfg(not(feature = "wasm"))]
impl Default for WasmHookExecutor {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// Full Implementation (with wasmtime feature)
// ============================================================================

#[cfg(feature = "wasm")]
use wasmtime::*;

#[cfg(feature = "wasm")]
pub struct WasmHookExecutor {
    engine: Engine,
    plugins: Vec<CompiledPlugin>,
    timeout: Duration,
}

#[cfg(feature = "wasm")]
struct CompiledPlugin {
    path: PathBuf,
    event: HookEventType,
    tools: Vec<String>,
    module: Module,
}

#[cfg(feature = "wasm")]
impl WasmHookExecutor {
    pub fn new() -> Self {
        let mut config = Config::new();
        config.wasm_backtrace_details(WasmBacktraceDetails::Enable);
        config.epoch_interruption(true);

        let engine = Engine::new(&config).expect("Failed to create WASM engine");

        Self {
            engine,
            plugins: Vec::new(),
            timeout: Duration::from_secs(30),
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn load_plugin(
        &mut self,
        path: &Path,
        event: HookEventType,
        tools: Vec<String>,
    ) -> Result<()> {
        let bytes = std::fs::read(path)
            .with_context(|| format!("Failed to read WASM plugin: {}", path.display()))?;

        // Basic WASM validation
        if bytes.len() < 8 || &bytes[0..4] != b"\0asm" {
            anyhow::bail!("Invalid WASM file: {}", path.display());
        }

        // Compile the module
        let module = Module::new(&self.engine, &bytes)
            .with_context(|| format!("Failed to compile WASM module: {}", path.display()))?;

        self.plugins.push(CompiledPlugin {
            path: path.to_path_buf(),
            event,
            tools,
            module,
        });

        Ok(())
    }

    pub fn execute_pre_tool_use(&self, input: &PreToolUseInput) -> HookResult {
        let start = Instant::now();

        for plugin in &self.plugins {
            if plugin.event != HookEventType::PreToolUse {
                continue;
            }
            if !plugin.tools.is_empty() && !plugin.tools.contains(&input.tool_name) {
                continue;
            }

            // Check timeout
            if start.elapsed() > self.timeout {
                eprintln!("[wasm-hook] Timeout exceeded");
                return HookResult::Continue;
            }

            match self.execute_plugin(plugin, input) {
                Ok(result) => {
                    if !matches!(result, HookResult::Continue) {
                        return result;
                    }
                }
                Err(e) => {
                    eprintln!("[wasm-hook] Error running {}: {}", plugin.path.display(), e);
                }
            }
        }
        HookResult::Continue
    }

    fn execute_plugin(
        &self,
        plugin: &CompiledPlugin,
        input: &PreToolUseInput,
    ) -> Result<HookResult> {
        let mut store = Store::new(&self.engine, ());

        // Set epoch deadline for timeout
        store.set_epoch_deadline(1);

        // Create instance
        let instance = Instance::new(&mut store, &plugin.module, &[])
            .with_context(|| "Failed to instantiate WASM module")?;

        // Get memory export
        let memory = instance
            .get_memory(&mut store, "memory")
            .ok_or_else(|| anyhow::anyhow!("No memory export in WASM module"))?;

        // Get function exports
        let alloc_fn = instance
            .get_typed_func::<i32, i32>(&mut store, "alloc")
            .with_context(|| "Missing 'alloc' export")?;
        let dealloc_fn = instance
            .get_typed_func::<(i32, i32), ()>(&mut store, "dealloc")
            .ok();

        let on_pre_tool_use_fn = instance
            .get_typed_func::<(i32, i32), i32>(&mut store, "on_pre_tool_use")
            .with_context(|| "Missing 'on_pre_tool_use' export")?;

        let get_result_len_fn = instance
            .get_typed_func::<(), i32>(&mut store, "get_result_len")
            .ok();

        let get_result_fn = instance
            .get_typed_func::<(i32, i32), i32>(&mut store, "get_result")
            .ok();

        // Serialize input to JSON
        let input_json = serde_json::to_vec(input)?;
        let input_len = input_json.len() as i32;

        // Allocate memory in WASM for input
        let input_ptr = alloc_fn.call(&mut store, input_len)?;

        // Copy input to WASM memory
        memory.write(&mut store, input_ptr as usize, &input_json)?;

        // Start timeout watchdog for WASM execution
        let timed_out = Arc::new(AtomicBool::new(false));
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let engine = self.engine.clone();
        let timeout = self.timeout;
        let timed_out_clone = timed_out.clone();
        let watchdog_handle = std::thread::spawn(move || {
            if done_rx.recv_timeout(timeout).is_err() {
                timed_out_clone.store(true, Ordering::Relaxed);
                engine.increment_epoch();
            }
        });

        // Call the hook function
        let result_code = match on_pre_tool_use_fn.call(&mut store, (input_ptr, input_len)) {
            Ok(code) => code,
            Err(err) => {
                let _ = done_tx.send(());
                let _ = watchdog_handle.join();
                if timed_out.load(Ordering::Relaxed) {
                    return Err(anyhow::anyhow!("WASM hook execution timed out"));
                }
                return Err(err);
            }
        };

        let _ = done_tx.send(());
        let _ = watchdog_handle.join();

        // Parse result based on code
        match WasmResultCode::from(result_code) {
            WasmResultCode::Continue => Ok(HookResult::Continue),

            WasmResultCode::Block => {
                // Try to read the block reason from WASM memory
                let reason = self
                    .read_result_string(
                        &mut store,
                        memory,
                        &alloc_fn,
                        dealloc_fn.as_ref(),
                        get_result_len_fn.as_ref(),
                        get_result_fn.as_ref(),
                    )
                    .unwrap_or_else(|| "Blocked by WASM plugin".to_string());

                Ok(HookResult::Block { reason })
            }

            WasmResultCode::Modify => {
                // Try to read modified input from WASM memory
                if let Some(json_str) = self.read_result_string(
                    &mut store,
                    memory,
                    &alloc_fn,
                    dealloc_fn.as_ref(),
                    get_result_len_fn.as_ref(),
                    get_result_fn.as_ref(),
                ) {
                    if let Ok(new_input) = serde_json::from_str(&json_str) {
                        return Ok(HookResult::ModifyInput { new_input });
                    }
                }
                Ok(HookResult::Continue)
            }

            WasmResultCode::InjectContext => {
                let context = self
                    .read_result_string(
                        &mut store,
                        memory,
                        &alloc_fn,
                        dealloc_fn.as_ref(),
                        get_result_len_fn.as_ref(),
                        get_result_fn.as_ref(),
                    )
                    .unwrap_or_else(|| "Context from WASM plugin".to_string());

                Ok(HookResult::InjectContext { context })
            }

            WasmResultCode::Error => {
                let error = self
                    .read_result_string(
                        &mut store,
                        memory,
                        &alloc_fn,
                        dealloc_fn.as_ref(),
                        get_result_len_fn.as_ref(),
                        get_result_fn.as_ref(),
                    )
                    .unwrap_or_else(|| "Unknown error".to_string());

                eprintln!("[wasm-hook] Plugin error: {}", error);
                Ok(HookResult::Continue)
            }
        }
    }

    fn read_result_string(
        &self,
        store: &mut Store<()>,
        memory: Memory,
        alloc_fn: &TypedFunc<i32, i32>,
        dealloc_fn: Option<&TypedFunc<(i32, i32), ()>>,
        get_result_len_fn: Option<&TypedFunc<(), i32>>,
        get_result_fn: Option<&TypedFunc<(i32, i32), i32>>,
    ) -> Option<String> {
        let get_len = get_result_len_fn?;
        let get_result = get_result_fn?;

        let len = get_len.call(&mut *store, ()).ok()? as usize;
        if len == 0 {
            return None;
        }

        let len_i32 = len as i32;
        let alloc_ptr = alloc_fn.call(&mut *store, len_i32).ok()?;
        let dealloc = |store: &mut Store<()>| {
            if let Some(dealloc_fn) = dealloc_fn {
                let _ = dealloc_fn.call(store, (alloc_ptr, len_i32));
            }
        };

        let written = match get_result.call(&mut *store, (alloc_ptr, len_i32)) {
            Ok(written) => written as usize,
            Err(_) => {
                dealloc(&mut *store);
                return None;
            }
        };

        if written == 0 {
            dealloc(&mut *store);
            return None;
        }

        // Read from WASM memory at the output location
        let read_len = written.min(len);
        let mut buffer = vec![0u8; read_len];
        if memory
            .read(&mut *store, alloc_ptr as usize, &mut buffer)
            .is_err()
        {
            dealloc(&mut *store);
            return None;
        }

        dealloc(&mut *store);
        String::from_utf8(buffer).ok()
    }

    pub fn execute_post_tool_use(&self, input: &PostToolUseInput) -> HookResult {
        let start = Instant::now();

        for plugin in &self.plugins {
            if plugin.event != HookEventType::PostToolUse {
                continue;
            }
            if !plugin.tools.is_empty() && !plugin.tools.contains(&input.tool_name) {
                continue;
            }

            // Check timeout
            if start.elapsed() > self.timeout {
                eprintln!("[wasm-hook] PostToolUse timeout exceeded");
                return HookResult::Continue;
            }

            if let Err(e) = self.execute_post_plugin(plugin, input) {
                eprintln!(
                    "[wasm-hook] PostToolUse error in {}: {}",
                    plugin.path.display(),
                    e
                );
            }
        }
        HookResult::Continue
    }

    fn execute_post_plugin(&self, plugin: &CompiledPlugin, input: &PostToolUseInput) -> Result<()> {
        let mut store = Store::new(&self.engine, ());
        store.set_epoch_deadline(1);

        let instance = Instance::new(&mut store, &plugin.module, &[])
            .with_context(|| "Failed to instantiate WASM module")?;

        let memory = instance
            .get_memory(&mut store, "memory")
            .ok_or_else(|| anyhow::anyhow!("No memory export in WASM module"))?;

        // Get alloc function
        let alloc_fn = instance
            .get_typed_func::<i32, i32>(&mut store, "alloc")
            .with_context(|| "Missing 'alloc' export")?;

        // Try to get on_post_tool_use - if not present, skip silently
        let on_post_tool_use_fn =
            match instance.get_typed_func::<(i32, i32), i32>(&mut store, "on_post_tool_use") {
                Ok(f) => f,
                Err(_) => return Ok(()), // No post hook in this plugin
            };

        // Serialize input to JSON
        let input_json = serde_json::to_string(input)?;
        let input_bytes = input_json.as_bytes();
        let input_len = input_bytes.len() as i32;

        // Allocate memory in WASM
        let input_ptr = alloc_fn.call(&mut store, input_len)?;

        // Write input to WASM memory
        memory.write(&mut store, input_ptr as usize, input_bytes)?;

        // Start timeout watchdog for WASM execution
        let timed_out = Arc::new(AtomicBool::new(false));
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let engine = self.engine.clone();
        let timeout = self.timeout;
        let timed_out_clone = timed_out.clone();
        let watchdog_handle = std::thread::spawn(move || {
            if done_rx.recv_timeout(timeout).is_err() {
                timed_out_clone.store(true, Ordering::Relaxed);
                engine.increment_epoch();
            }
        });

        // Call the hook (return value ignored for post hooks)
        match on_post_tool_use_fn.call(&mut store, (input_ptr, input_len)) {
            Ok(_) => {}
            Err(err) => {
                let _ = done_tx.send(());
                let _ = watchdog_handle.join();
                if timed_out.load(Ordering::Relaxed) {
                    return Err(anyhow::anyhow!("WASM post-hook execution timed out"));
                }
                return Err(err);
            }
        }

        let _ = done_tx.send(());
        let _ = watchdog_handle.join();

        Ok(())
    }

    pub fn has_plugins(&self) -> bool {
        !self.plugins.is_empty()
    }

    pub fn plugin_count(&self) -> usize {
        self.plugins.len()
    }

    pub fn plugin_paths(&self) -> Vec<&Path> {
        self.plugins.iter().map(|p| p.path.as_path()).collect()
    }

    pub fn reload(&mut self) -> Result<usize> {
        let mut reloaded = 0;
        let mut new_plugins = Vec::new();

        for plugin in &self.plugins {
            if plugin.path.exists() {
                if let Ok(bytes) = std::fs::read(&plugin.path) {
                    if bytes.len() >= 8 && &bytes[0..4] == b"\0asm" {
                        if let Ok(module) = Module::new(&self.engine, &bytes) {
                            new_plugins.push(CompiledPlugin {
                                path: plugin.path.clone(),
                                event: plugin.event,
                                tools: plugin.tools.clone(),
                                module,
                            });
                            reloaded += 1;
                            continue;
                        }
                    }
                }
            }
            // Keep old module if reload failed
            // Can't clone Module, so we'd need to re-compile from stored bytes
            // For now, just note that reload failed for this plugin
            eprintln!("[wasm-hook] Failed to reload: {}", plugin.path.display());
        }

        if reloaded > 0 {
            self.plugins = new_plugins;
        }

        Ok(reloaded)
    }
}

#[cfg(feature = "wasm")]
impl Default for WasmHookExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn test_wasm_executor_creation() {
        let executor = WasmHookExecutor::new();
        assert!(!executor.has_plugins());
        assert_eq!(executor.plugin_count(), 0);
    }

    #[test]
    fn test_invalid_wasm_rejected() {
        let mut executor = WasmHookExecutor::new();

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
    fn test_valid_wasm_header_stub() {
        #[cfg(not(feature = "wasm"))]
        {
            let mut executor = WasmHookExecutor::new();

            let mut file = NamedTempFile::new().unwrap();
            // Minimal WASM magic + version
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

    #[test]
    fn test_result_code_conversion() {
        assert_eq!(WasmResultCode::from(0), WasmResultCode::Continue);
        assert_eq!(WasmResultCode::from(1), WasmResultCode::Block);
        assert_eq!(WasmResultCode::from(2), WasmResultCode::Modify);
        assert_eq!(WasmResultCode::from(3), WasmResultCode::InjectContext);
        assert_eq!(WasmResultCode::from(-1), WasmResultCode::Error);
        assert_eq!(WasmResultCode::from(99), WasmResultCode::Error);
    }
}
