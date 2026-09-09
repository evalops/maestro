//! WebAssembly plugin support for hooks
//!
//! Provides sandboxed execution of WASM plugins for hooks. WASM plugins offer:
//! - Strong sandboxing (no filesystem/network access by default)
//! - Language agnostic (write hooks in Rust, Go, C, `AssemblyScript`, etc.)
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

use super::types::{HookEventType, HookResult, PostToolUseInput, PreToolUseInput};
#[cfg(feature = "wasm")]
use anyhow::Context;
use anyhow::Result;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[cfg(feature = "wasm")]
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
#[cfg(feature = "wasm")]
use std::time::Instant;

#[cfg(feature = "wasm")]
const WASM_MEMORY_LIMIT_BYTES: usize = 16 * 1024 * 1024;
#[cfg(feature = "wasm")]
const WASM_TABLE_ELEMENTS_LIMIT: usize = 1_024;
#[cfg(feature = "wasm")]
const WASM_FUEL_LIMIT: u64 = 5_000_000;
#[cfg(feature = "wasm")]
const WASM_RESULT_LIMIT_BYTES: usize = 1024 * 1024;

/// Whether a WASM plugin's `tools` list selects `tool_name`.
///
/// Entries are anchored, case-insensitive regular expressions, the same
/// contract command and HTTP hooks use (`crate::hooks::matcher`). Config load
/// already rejects a pattern that does not compile.
fn matches_tool(tools: &[String], tool_name: &str) -> bool {
    super::matcher::matcher_or_match_all(tools).matches(tool_name)
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

/// Cached WASM plugin with metadata
#[allow(dead_code)]
struct WasmPlugin {
    path: PathBuf,
    event: HookEventType,
    tools: Vec<String>,
    required: bool,
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
    #[must_use]
    pub fn new() -> Self {
        Self {
            plugins: Vec::new(),
        }
    }

    pub fn set_timeout(&mut self, _timeout: Duration) {}

    pub fn load_plugin(
        &mut self,
        path: &Path,
        event: HookEventType,
        tools: Vec<String>,
    ) -> Result<()> {
        self.load_plugin_with_policy(path, event, tools, false)
    }

    /// WASM is an optional backend. A binary built without the backend must
    /// reject configured plugins instead of retaining a stub that reports
    /// `Continue` and makes a policy hook look active.
    pub fn load_plugin_with_policy(
        &mut self,
        path: &Path,
        _event: HookEventType,
        _tools: Vec<String>,
        _required: bool,
    ) -> Result<()> {
        anyhow::bail!(
            "WASM hooks are unavailable in this build; rebuild maestro-tui with the `wasm` feature (configured plugin: {})",
            path.display()
        )
    }

    #[must_use]
    pub fn execute_pre_tool_use(&self, input: &PreToolUseInput) -> HookResult {
        for plugin in &self.plugins {
            if plugin.event != HookEventType::PreToolUse {
                continue;
            }
            if !matches_tool(&plugin.tools, &input.tool_name) {
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

    #[must_use]
    pub fn execute_post_tool_use(&self, input: &PostToolUseInput) -> HookResult {
        for plugin in &self.plugins {
            if plugin.event != HookEventType::PostToolUse {
                continue;
            }
            if !matches_tool(&plugin.tools, &input.tool_name) {
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

    #[must_use]
    pub fn has_plugins(&self) -> bool {
        !self.plugins.is_empty()
    }

    #[must_use]
    pub fn plugin_count(&self) -> usize {
        self.plugins.len()
    }

    #[must_use]
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
    engine: Option<Engine>,
    init_error: Option<String>,
    plugins: Vec<CompiledPlugin>,
    timeout: Duration,
    fuel_limit: u64,
}

#[cfg(feature = "wasm")]
struct CompiledPlugin {
    path: PathBuf,
    event: HookEventType,
    tools: Vec<String>,
    required: bool,
    module: Module,
}

#[cfg(feature = "wasm")]
struct WasmStoreState {
    limits: StoreLimits,
}

#[cfg(feature = "wasm")]
impl WasmStoreState {
    fn new() -> Self {
        Self {
            limits: StoreLimitsBuilder::new()
                .memory_size(WASM_MEMORY_LIMIT_BYTES)
                .table_elements(WASM_TABLE_ELEMENTS_LIMIT)
                .instances(1)
                .tables(4)
                .memories(1)
                .trap_on_grow_failure(true)
                .build(),
        }
    }
}

#[cfg(feature = "wasm")]
struct EpochWatchdog {
    timed_out: Arc<AtomicBool>,
    done_tx: Option<mpsc::Sender<()>>,
    handle: Option<std::thread::JoinHandle<()>>,
}

#[cfg(feature = "wasm")]
impl EpochWatchdog {
    fn start(engine: &Engine, timeout: Duration) -> Self {
        let timed_out = Arc::new(AtomicBool::new(false));
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let timed_out_clone = timed_out.clone();
        let engine = engine.clone();
        let handle = std::thread::spawn(move || {
            if done_rx.recv_timeout(timeout).is_err() {
                timed_out_clone.store(true, Ordering::Relaxed);
                engine.increment_epoch();
            }
        });
        Self {
            timed_out,
            done_tx: Some(done_tx),
            handle: Some(handle),
        }
    }

    fn stop(&mut self) -> bool {
        if let Some(done_tx) = self.done_tx.take() {
            let _ = done_tx.send(());
        }
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
        self.timed_out.load(Ordering::Relaxed)
    }
}

#[cfg(feature = "wasm")]
impl Drop for EpochWatchdog {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(feature = "wasm")]
impl WasmHookExecutor {
    pub fn new() -> Self {
        let mut config = Config::new();
        config.wasm_backtrace_details(WasmBacktraceDetails::Enable);
        config.epoch_interruption(true);
        config.consume_fuel(true);

        let engine = Engine::new(&config);

        match engine {
            Ok(engine) => Self {
                engine: Some(engine),
                init_error: None,
                plugins: Vec::new(),
                timeout: Duration::from_secs(30),
                fuel_limit: WASM_FUEL_LIMIT,
            },
            Err(err) => Self {
                engine: None,
                init_error: Some(err.to_string()),
                plugins: Vec::new(),
                timeout: Duration::from_secs(30),
                fuel_limit: WASM_FUEL_LIMIT,
            },
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn set_timeout(&mut self, timeout: Duration) {
        self.timeout = timeout;
    }

    /// Override the per-invocation instruction budget, primarily for focused
    /// tests and hosts with a stricter policy budget.
    pub fn with_fuel_limit(mut self, fuel_limit: u64) -> Self {
        self.fuel_limit = fuel_limit.min(WASM_FUEL_LIMIT);
        self
    }

    fn engine(&self) -> Result<&Engine> {
        self.engine.as_ref().ok_or_else(|| {
            anyhow::anyhow!(
                "WASM engine unavailable: {}",
                self.init_error
                    .as_deref()
                    .unwrap_or("initialization failed")
            )
        })
    }

    pub fn load_plugin(
        &mut self,
        path: &Path,
        event: HookEventType,
        tools: Vec<String>,
    ) -> Result<()> {
        self.load_plugin_with_policy(path, event, tools, false)
    }

    /// Load a plugin and retain whether it is a fail-closed policy hook.
    pub fn load_plugin_with_policy(
        &mut self,
        path: &Path,
        event: HookEventType,
        tools: Vec<String>,
        required: bool,
    ) -> Result<()> {
        let engine = self.engine()?;
        let bytes = std::fs::read(path)
            .with_context(|| format!("Failed to read WASM plugin: {}", path.display()))?;

        // Basic WASM validation
        if bytes.len() < 8 || &bytes[0..4] != b"\0asm" {
            anyhow::bail!("Invalid WASM file: {}", path.display());
        }

        // Compile the module
        let module = Module::new(engine, &bytes).map_err(|error| {
            anyhow::anyhow!("Failed to compile WASM module {}: {error}", path.display())
        })?;

        self.plugins.push(CompiledPlugin {
            path: path.to_path_buf(),
            event,
            tools,
            required,
            module,
        });

        Ok(())
    }

    fn failure_result(&self, plugin: &CompiledPlugin, error: impl std::fmt::Display) -> HookResult {
        let reason = format!("WASM hook {} failed: {error}", plugin.path.display());
        eprintln!("[wasm-hook] {reason}");
        if plugin.required {
            HookResult::Block { reason }
        } else {
            HookResult::Continue
        }
    }

    pub fn execute_pre_tool_use(&self, input: &PreToolUseInput) -> HookResult {
        let deadline = Instant::now() + self.timeout;

        for plugin in &self.plugins {
            if plugin.event != HookEventType::PreToolUse {
                continue;
            }
            if !matches_tool(&plugin.tools, &input.tool_name) {
                continue;
            }

            // Share one deadline across the configured chain. Each plugin
            // receives only the remaining portion of the hook budget.
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return self.failure_result(plugin, "execution timed out");
            }

            match self.execute_plugin(plugin, input, remaining) {
                Ok(result) => {
                    if !matches!(result, HookResult::Continue) {
                        return result;
                    }
                }
                Err(e) => {
                    let result = self.failure_result(plugin, e);
                    if !matches!(result, HookResult::Continue) {
                        return result;
                    }
                }
            }
        }
        HookResult::Continue
    }

    fn execute_plugin(
        &self,
        plugin: &CompiledPlugin,
        input: &PreToolUseInput,
        timeout: Duration,
    ) -> Result<HookResult> {
        let engine = self.engine()?;
        let mut store = Store::new(engine, WasmStoreState::new());
        store.limiter(|state| &mut state.limits);
        store
            .set_fuel(self.fuel_limit)
            .map_err(|error| anyhow::anyhow!("failed to configure WASM fuel limit: {error}"))?;

        // Set epoch deadline for timeout
        store.set_epoch_deadline(1);

        // Keep the watchdog active for instantiation, allocation, the hook
        // call, and result decoding. Each operation enters guest code and can
        // otherwise block before the original call-site watchdog starts.
        let mut watchdog = EpochWatchdog::start(engine, timeout);
        let result = (|| {
            // Create instance
            let instance = Instance::new(&mut store, &plugin.module, &[])
                .map_err(|error| anyhow::anyhow!("Failed to instantiate WASM module: {error}"))?;

            // Get memory export
            let memory = instance
                .get_memory(&mut store, "memory")
                .ok_or_else(|| anyhow::anyhow!("No memory export in WASM module"))?;

            // Get function exports
            let alloc_fn = instance
                .get_typed_func::<i32, i32>(&mut store, "alloc")
                .map_err(|error| anyhow::anyhow!("Missing 'alloc' export: {error}"))?;
            let dealloc_fn = instance
                .get_typed_func::<(i32, i32), ()>(&mut store, "dealloc")
                .ok();

            let on_pre_tool_use_fn = instance
                .get_typed_func::<(i32, i32), i32>(&mut store, "on_pre_tool_use")
                .map_err(|error| anyhow::anyhow!("Missing 'on_pre_tool_use' export: {error}"))?;

            let get_result_len_fn = instance
                .get_typed_func::<(), i32>(&mut store, "get_result_len")
                .ok();

            let get_result_fn = instance
                .get_typed_func::<(i32, i32), i32>(&mut store, "get_result")
                .ok();

            // Serialize input to JSON
            let input_json = serde_json::to_vec(input)?;
            let input_len = i32::try_from(input_json.len())
                .context("WASM hook input exceeds the i32 ABI limit")?;

            // Allocate memory in WASM for input
            let input_ptr = alloc_fn.call(&mut store, input_len)?;
            if input_ptr < 0 {
                anyhow::bail!("WASM hook returned a negative input pointer");
            }

            // Copy input to WASM memory
            memory.write(&mut store, input_ptr as usize, &input_json)?;

            // Call the hook function
            let result_code = on_pre_tool_use_fn.call(&mut store, (input_ptr, input_len))?;

            // Parse result based on code
            match WasmResultCode::from(result_code) {
                WasmResultCode::Continue => Ok(HookResult::Continue),

                WasmResultCode::Block => {
                    // A block without a valid reason is a malformed result.
                    // Let the policy mode decide whether that failure blocks.
                    let reason = self.read_result_string(
                        &mut store,
                        memory,
                        &alloc_fn,
                        dealloc_fn.as_ref(),
                        get_result_len_fn.as_ref(),
                        get_result_fn.as_ref(),
                    )?;

                    Ok(HookResult::Block { reason })
                }

                WasmResultCode::Modify => {
                    // Try to read modified input from WASM memory
                    let json_str = self.read_result_string(
                        &mut store,
                        memory,
                        &alloc_fn,
                        dealloc_fn.as_ref(),
                        get_result_len_fn.as_ref(),
                        get_result_fn.as_ref(),
                    )?;
                    let new_input = serde_json::from_str(&json_str)
                        .context("WASM hook returned invalid modified input JSON")?;
                    Ok(HookResult::ModifyInput { new_input })
                }

                WasmResultCode::InjectContext => {
                    let context = self.read_result_string(
                        &mut store,
                        memory,
                        &alloc_fn,
                        dealloc_fn.as_ref(),
                        get_result_len_fn.as_ref(),
                        get_result_fn.as_ref(),
                    )?;

                    Ok(HookResult::InjectContext { context })
                }

                WasmResultCode::Error => {
                    let error = match self.read_result_string(
                        &mut store,
                        memory,
                        &alloc_fn,
                        dealloc_fn.as_ref(),
                        get_result_len_fn.as_ref(),
                        get_result_fn.as_ref(),
                    ) {
                        Ok(error) => error,
                        Err(error) => format!("plugin returned error without details: {error}"),
                    };
                    anyhow::bail!("WASM plugin returned an error: {error}");
                }
            }
        })();

        if watchdog.stop() {
            Err(anyhow::anyhow!("WASM hook execution timed out"))
        } else {
            result
        }
    }

    fn read_result_string(
        &self,
        store: &mut Store<WasmStoreState>,
        memory: Memory,
        alloc_fn: &TypedFunc<i32, i32>,
        dealloc_fn: Option<&TypedFunc<(i32, i32), ()>>,
        get_result_len_fn: Option<&TypedFunc<(), i32>>,
        get_result_fn: Option<&TypedFunc<(i32, i32), i32>>,
    ) -> Result<String> {
        let get_len =
            get_result_len_fn.ok_or_else(|| anyhow::anyhow!("missing 'get_result_len' export"))?;
        let get_result =
            get_result_fn.ok_or_else(|| anyhow::anyhow!("missing 'get_result' export"))?;

        let len = get_len.call(&mut *store, ())?;
        if len <= 0 {
            anyhow::bail!("WASM hook returned an empty result");
        }
        let len = usize::try_from(len).context("WASM hook returned a negative result length")?;
        if len > WASM_RESULT_LIMIT_BYTES {
            anyhow::bail!(
                "WASM hook result exceeds the {} byte limit",
                WASM_RESULT_LIMIT_BYTES
            );
        }

        let len_i32 = i32::try_from(len).context("WASM hook result exceeds the i32 ABI limit")?;
        let alloc_ptr = alloc_fn.call(&mut *store, len_i32)?;
        if alloc_ptr < 0 {
            anyhow::bail!("WASM hook returned a negative result pointer");
        }
        let dealloc = |store: &mut Store<WasmStoreState>| {
            if let Some(dealloc_fn) = dealloc_fn {
                let _ = dealloc_fn.call(store, (alloc_ptr, len_i32));
            }
        };

        let written = match get_result.call(&mut *store, (alloc_ptr, len_i32)) {
            Ok(written) if written > 0 => {
                usize::try_from(written).context("WASM hook returned a negative result length")?
            }
            Err(_) => {
                dealloc(&mut *store);
                anyhow::bail!("WASM hook failed to write its result");
            }
            Ok(_) => {
                dealloc(&mut *store);
                anyhow::bail!("WASM hook wrote an empty result");
            }
        };

        if written > len {
            dealloc(&mut *store);
            anyhow::bail!("WASM hook result exceeds the allocated output buffer");
        }

        // Read from WASM memory at the output location
        let read_len = written.min(len);
        let mut buffer = vec![0u8; read_len];
        if memory
            .read(&mut *store, alloc_ptr as usize, &mut buffer)
            .is_err()
        {
            dealloc(&mut *store);
            anyhow::bail!("WASM hook result could not be read from memory");
        }

        dealloc(&mut *store);
        String::from_utf8(buffer).context("WASM hook result was not valid UTF-8")
    }

    pub fn execute_post_tool_use(&self, input: &PostToolUseInput) -> HookResult {
        let deadline = Instant::now() + self.timeout;

        for plugin in &self.plugins {
            if plugin.event != HookEventType::PostToolUse {
                continue;
            }
            if !matches_tool(&plugin.tools, &input.tool_name) {
                continue;
            }

            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return self.failure_result(plugin, "post-hook execution timed out");
            }

            if let Err(e) = self.execute_post_plugin(plugin, input, remaining) {
                let result = self.failure_result(plugin, e);
                if !matches!(result, HookResult::Continue) {
                    return result;
                }
            }
        }
        HookResult::Continue
    }

    fn execute_post_plugin(
        &self,
        plugin: &CompiledPlugin,
        input: &PostToolUseInput,
        timeout: Duration,
    ) -> Result<()> {
        let engine = self.engine()?;
        let mut store = Store::new(engine, WasmStoreState::new());
        store.limiter(|state| &mut state.limits);
        store
            .set_fuel(self.fuel_limit)
            .map_err(|error| anyhow::anyhow!("failed to configure WASM fuel limit: {error}"))?;
        store.set_epoch_deadline(1);

        let mut watchdog = EpochWatchdog::start(engine, timeout);
        let result = (|| {
            let instance = Instance::new(&mut store, &plugin.module, &[])
                .map_err(|error| anyhow::anyhow!("Failed to instantiate WASM module: {error}"))?;

            let memory = instance
                .get_memory(&mut store, "memory")
                .ok_or_else(|| anyhow::anyhow!("No memory export in WASM module"))?;

            // Get alloc function
            let alloc_fn = instance
                .get_typed_func::<i32, i32>(&mut store, "alloc")
                .map_err(|error| anyhow::anyhow!("Missing 'alloc' export: {error}"))?;

            // Try to get on_post_tool_use - if not present, skip silently
            let on_post_tool_use_fn =
                match instance.get_typed_func::<(i32, i32), i32>(&mut store, "on_post_tool_use") {
                    Ok(f) => f,
                    Err(_) => return Ok(()), // No post hook in this plugin
                };

            // Serialize input to JSON
            let input_json = serde_json::to_string(input)?;
            let input_bytes = input_json.as_bytes();
            let input_len = i32::try_from(input_bytes.len())
                .context("WASM hook input exceeds the i32 ABI limit")?;

            // Allocate memory in WASM
            let input_ptr = alloc_fn.call(&mut store, input_len)?;
            if input_ptr < 0 {
                anyhow::bail!("WASM hook returned a negative input pointer");
            }

            // Write input to WASM memory
            memory.write(&mut store, input_ptr as usize, input_bytes)?;

            // Call the hook (return value ignored for post hooks)
            on_post_tool_use_fn.call(&mut store, (input_ptr, input_len))?;
            Ok(())
        })();

        if watchdog.stop() {
            Err(anyhow::anyhow!("WASM post-hook execution timed out"))
        } else {
            result
        }
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
        let engine = self.engine()?.clone();
        let mut reloaded = 0;
        let mut new_plugins = Vec::with_capacity(self.plugins.len());

        for plugin in &self.plugins {
            let replacement = std::fs::read(&plugin.path)
                .with_context(|| format!("Failed to read WASM plugin: {}", plugin.path.display()))
                .and_then(|bytes| {
                    if bytes.len() < 8 || &bytes[0..4] != b"\0asm" {
                        anyhow::bail!("Invalid WASM file: {}", plugin.path.display());
                    }
                    Module::new(&engine, &bytes).map_err(|error| {
                        anyhow::anyhow!(
                            "Failed to compile WASM module {}: {error}",
                            plugin.path.display()
                        )
                    })
                });

            let module = match replacement {
                Ok(module) => {
                    reloaded += 1;
                    module
                }
                Err(error) => {
                    // A reload is an atomic policy update. Keep the last-known
                    // compiled module so one successful sibling cannot remove a
                    // required hook whose new bytes are unavailable or invalid.
                    eprintln!(
                        "[wasm-hook] Failed to reload {}; keeping last-known module: {error}",
                        plugin.path.display()
                    );
                    plugin.module.clone()
                }
            };

            new_plugins.push(CompiledPlugin {
                path: plugin.path.clone(),
                event: plugin.event,
                tools: plugin.tools.clone(),
                required: plugin.required,
                module,
            });
        }

        self.plugins = new_plugins;
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
    fn test_wasm_backend_is_explicitly_unavailable_without_feature() {
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

            assert!(
                result
                    .expect_err("the no-feature build must reject configured WASM")
                    .to_string()
                    .contains("WASM hooks are unavailable")
            );
            assert!(!executor.has_plugins());
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

    #[cfg(feature = "wasm")]
    fn pre_tool_input() -> PreToolUseInput {
        PreToolUseInput {
            hook_event_name: "PreToolUse".to_string(),
            cwd: "/tmp".to_string(),
            session_id: None,
            timestamp: "2026-01-01T00:00:00Z".to_string(),
            tool_name: "Bash".to_string(),
            tool_call_id: "call-1".to_string(),
            tool_input: serde_json::json!({"command": "echo safe"}),
        }
    }

    #[cfg(feature = "wasm")]
    fn wasm_file(source: &str) -> NamedTempFile {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(&wat::parse_str(source).unwrap()).unwrap();
        file
    }

    #[cfg(feature = "wasm")]
    fn minimal_hook(result_code: i32) -> NamedTempFile {
        wasm_file(&format!(
            r#"(module
                (memory (export "memory") 1)
                (func (export "alloc") (param i32) (result i32) (i32.const 1024))
                (func (export "on_pre_tool_use") (param i32 i32) (result i32) (i32.const {result_code}))
            )"#
        ))
    }

    #[cfg(feature = "wasm")]
    fn blocking_hook() -> NamedTempFile {
        wasm_file(
            r#"(module
                (memory (export "memory") 1)
                (func (export "alloc") (param i32) (result i32) (i32.const 1024))
                (func (export "on_pre_tool_use") (param i32 i32) (result i32) (i32.const 1))
                (func (export "get_result_len") (result i32) (i32.const 1))
                (func (export "get_result") (param $ptr i32) (param $len i32) (result i32)
                    local.get $ptr
                    i32.const 120
                    i32.store8
                    i32.const 1
                )
            )"#,
        )
    }

    #[cfg(feature = "wasm")]
    fn modifying_hook() -> NamedTempFile {
        wasm_file(
            r#"(module
                (memory (export "memory") 1)
                (data (i32.const 2048) "{\"command\":\"safe\"}")
                (func (export "alloc") (param i32) (result i32) (i32.const 1024))
                (func (export "on_pre_tool_use") (param i32 i32) (result i32) (i32.const 2))
                (func (export "get_result_len") (result i32) (i32.const 18))
                (func (export "get_result") (param $ptr i32) (param $len i32) (result i32)
                    local.get $ptr
                    i32.const 2048
                    i32.const 18
                    memory.copy
                    i32.const 18
                )
            )"#,
        )
    }

    #[cfg(feature = "wasm")]
    #[test]
    fn required_plugin_continue_and_block_results_are_honored() {
        let continue_file = minimal_hook(0);
        let block_file = blocking_hook();
        let mut executor = WasmHookExecutor::new();
        executor
            .load_plugin_with_policy(
                continue_file.path(),
                HookEventType::PreToolUse,
                vec!["Bash".to_string()],
                true,
            )
            .unwrap();
        executor
            .load_plugin_with_policy(
                block_file.path(),
                HookEventType::PreToolUse,
                vec!["Bash".to_string()],
                true,
            )
            .unwrap();

        assert!(matches!(
            executor.execute_pre_tool_use(&pre_tool_input()),
            HookResult::Block { .. }
        ));
    }

    #[cfg(feature = "wasm")]
    #[test]
    fn configured_tool_matching_is_case_insensitive() {
        let file = blocking_hook();
        let mut executor = WasmHookExecutor::new();
        executor
            .load_plugin_with_policy(
                file.path(),
                HookEventType::PreToolUse,
                vec!["Bash".to_string()],
                true,
            )
            .unwrap();

        let mut input = pre_tool_input();
        input.tool_name = "bash".to_string();
        assert!(matches!(
            executor.execute_pre_tool_use(&input),
            HookResult::Block { .. }
        ));
    }

    #[cfg(feature = "wasm")]
    #[test]
    fn legitimate_modify_result_is_preserved() {
        let file = modifying_hook();
        let mut executor = WasmHookExecutor::new();
        executor
            .load_plugin_with_policy(file.path(), HookEventType::PreToolUse, Vec::new(), true)
            .unwrap();

        assert!(matches!(
            executor.execute_pre_tool_use(&pre_tool_input()),
            HookResult::ModifyInput { new_input }
                if new_input == serde_json::json!({"command": "safe"})
        ));
    }

    #[cfg(feature = "wasm")]
    #[test]
    fn plugin_error_and_invalid_result_fail_closed_only_when_required() {
        let error_file = minimal_hook(-1);
        let mut required = WasmHookExecutor::new();
        required
            .load_plugin_with_policy(
                error_file.path(),
                HookEventType::PreToolUse,
                Vec::new(),
                true,
            )
            .unwrap();
        assert!(matches!(
            required.execute_pre_tool_use(&pre_tool_input()),
            HookResult::Block { .. }
        ));

        let invalid_file = minimal_hook(2);
        let mut advisory = WasmHookExecutor::new();
        advisory
            .load_plugin_with_policy(
                invalid_file.path(),
                HookEventType::PreToolUse,
                Vec::new(),
                false,
            )
            .unwrap();
        assert!(matches!(
            advisory.execute_pre_tool_use(&pre_tool_input()),
            HookResult::Continue
        ));

        let missing_reason_file = minimal_hook(1);
        let mut advisory_block = WasmHookExecutor::new();
        advisory_block
            .load_plugin_with_policy(
                missing_reason_file.path(),
                HookEventType::PreToolUse,
                Vec::new(),
                false,
            )
            .unwrap();
        assert!(matches!(
            advisory_block.execute_pre_tool_use(&pre_tool_input()),
            HookResult::Continue
        ));

        let unknown_code_file = minimal_hook(999);
        let mut unknown_code = WasmHookExecutor::new();
        unknown_code
            .load_plugin_with_policy(
                unknown_code_file.path(),
                HookEventType::PreToolUse,
                Vec::new(),
                true,
            )
            .unwrap();
        assert!(matches!(
            unknown_code.execute_pre_tool_use(&pre_tool_input()),
            HookResult::Block { .. }
        ));
    }

    #[cfg(feature = "wasm")]
    #[test]
    fn required_plugin_timeout_is_fail_closed() {
        let timeout_file = wasm_file(
            r#"(module
                (memory (export "memory") 1)
                (func (export "alloc") (param i32) (result i32) (i32.const 1024))
                (func (export "on_pre_tool_use") (param i32 i32) (result i32)
                    (loop br 0)
                    unreachable
                )
            )"#,
        );
        let mut executor = WasmHookExecutor::new()
            .with_timeout(Duration::from_millis(10))
            .with_fuel_limit(u64::MAX);
        executor
            .load_plugin_with_policy(
                timeout_file.path(),
                HookEventType::PreToolUse,
                Vec::new(),
                true,
            )
            .unwrap();

        assert!(matches!(
            executor.execute_pre_tool_use(&pre_tool_input()),
            HookResult::Block { .. }
        ));
    }

    #[cfg(feature = "wasm")]
    #[test]
    fn timeout_budget_is_shared_across_plugin_chain() {
        let timeout_file = wasm_file(
            r#"(module
                (memory (export "memory") 1)
                (func (export "alloc") (param i32) (result i32) (i32.const 1024))
                (func (export "on_pre_tool_use") (param i32 i32) (result i32)
                    (loop br 0)
                    unreachable
                )
            )"#,
        );
        let continue_file = minimal_hook(0);
        let mut executor = WasmHookExecutor::new()
            .with_timeout(Duration::from_millis(10))
            .with_fuel_limit(u64::MAX);
        executor
            .load_plugin_with_policy(
                timeout_file.path(),
                HookEventType::PreToolUse,
                Vec::new(),
                false,
            )
            .unwrap();
        executor
            .load_plugin_with_policy(
                continue_file.path(),
                HookEventType::PreToolUse,
                Vec::new(),
                true,
            )
            .unwrap();

        assert!(matches!(
            executor.execute_pre_tool_use(&pre_tool_input()),
            HookResult::Block { .. }
        ));
    }

    #[cfg(feature = "wasm")]
    #[test]
    fn malicious_memory_growth_is_limited() {
        let memory_file = wasm_file(
            r#"(module
                (memory (export "memory") 512)
                (func (export "alloc") (param i32) (result i32) (i32.const 1024))
                (func (export "on_pre_tool_use") (param i32 i32) (result i32) (i32.const 0))
            )"#,
        );
        let mut executor = WasmHookExecutor::new();
        executor
            .load_plugin_with_policy(
                memory_file.path(),
                HookEventType::PreToolUse,
                Vec::new(),
                true,
            )
            .unwrap();

        assert!(matches!(
            executor.execute_pre_tool_use(&pre_tool_input()),
            HookResult::Block { .. }
        ));
    }

    #[cfg(feature = "wasm")]
    #[test]
    fn malicious_fuel_consumption_is_limited() {
        let fuel_file = wasm_file(
            r#"(module
                (memory (export "memory") 1)
                (func (export "alloc") (param i32) (result i32) (i32.const 1024))
                (func (export "on_pre_tool_use") (param i32 i32) (result i32)
                    (loop
                        drop (i32.const 1)
                        br 0
                    )
                    unreachable
                )
            )"#,
        );
        let mut executor = WasmHookExecutor::new().with_fuel_limit(1000);
        executor
            .load_plugin_with_policy(
                fuel_file.path(),
                HookEventType::PreToolUse,
                Vec::new(),
                true,
            )
            .unwrap();

        assert!(matches!(
            executor.execute_pre_tool_use(&pre_tool_input()),
            HookResult::Block { .. }
        ));
    }

    #[cfg(feature = "wasm")]
    #[test]
    fn partial_reload_keeps_last_known_required_hook() {
        let required_file = blocking_hook();
        let optional_file = minimal_hook(0);
        let mut executor = WasmHookExecutor::new();
        executor
            .load_plugin_with_policy(
                required_file.path(),
                HookEventType::PreToolUse,
                Vec::new(),
                true,
            )
            .unwrap();
        executor
            .load_plugin_with_policy(
                optional_file.path(),
                HookEventType::PreToolUse,
                Vec::new(),
                false,
            )
            .unwrap();

        std::fs::write(required_file.path(), b"invalid replacement").unwrap();
        std::fs::write(
            optional_file.path(),
            wat::parse_str(
                r#"(module
                    (memory (export "memory") 1)
                    (func (export "alloc") (param i32) (result i32) (i32.const 1024))
                    (func (export "on_pre_tool_use") (param i32 i32) (result i32) (i32.const 0))
                )"#,
            )
            .unwrap(),
        )
        .unwrap();

        assert_eq!(executor.reload().unwrap(), 1);
        assert_eq!(executor.plugin_count(), 2);
        assert!(matches!(
            executor.execute_pre_tool_use(&pre_tool_input()),
            HookResult::Block { .. }
        ));
    }
}
