//! # Maestro TUI - Native Terminal Interface
//!
//! This is the main entry point for the Maestro native TUI application.
//! It's a pure Rust implementation with native AI provider integrations.
//!
//! ## Rust Concept: Doc Comments
//! Lines starting with `//!` are "inner doc comments" that document the
//! containing item (in this case, the entire module/file). They appear
//! in generated documentation via `cargo doc`.
//!
//! ## Usage
//!
//! ```bash
//! maestro-tui [options] [prompt]
//! ```

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTS
// ─────────────────────────────────────────────────────────────────────────────
//
// Rust Concept: The `use` keyword brings items into scope.
// Unlike JavaScript/TypeScript imports, Rust uses a module system where
// crates (packages) are declared in Cargo.toml, and we import specific
// items from them.

use anyhow::{Context, Result};
// `anyhow::Result` is a convenient error type that can hold any error.
// It's shorthand for `Result<T, anyhow::Error>` and is great for applications
// (as opposed to libraries) because it simplifies error handling.

use clap::{error::ErrorKind, Parser};
// `clap` is the standard CLI argument parsing library in Rust.
// The `Parser` trait enables derive macros to auto-generate argument parsing.

use crate::App;
// Import our main `App` struct from the library crate.
// In Rust, a package can have both a binary (main.rs) and a library (lib.rs).
// This imports from lib.rs.

use crate::tools::cleanup_background_processes;
// Import the process cleanup function for signal handlers.

use crate::hosted_runner_cli::run_hosted_runner_cli_from_env;
use crate::sandbox::SandboxPolicy;

/// SIGINT/SIGTERM/SIGHUP (Unix) / console-event (Windows) handling for the
/// interactive path: flushes the session writer, cleans up tracked
/// background processes, and restores the terminal on an externally
/// delivered shutdown signal. See its module docs for the full design.
mod shutdown_signal;

// ─────────────────────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/// The canonical set of native utility subcommands. This is the single
/// source of truth for which first-level argv tokens dispatch to the
/// utility handler instead of the interactive TUI, headless server, or
/// exec/print bridges; `packages/maestro-rs` no longer keeps an independent
/// copy of this list (see `maestro::cli::classify`).
pub const NATIVE_UTILITY_COMMANDS: [&str; 35] = [
    "acp",
    "sessions",
    "search",
    "cost",
    "stats",
    "models",
    "status",
    "hooks",
    "export",
    "import",
    "import-claude",
    "skill",
    "update",
    "modes",
    "agents",
    "painter",
    "anthropic",
    "memory",
    "mcp",
    "init",
    "openai",
    "config",
    "mission",
    "evalops",
    "operating-plane",
    "remote",
    "value",
    "scenario",
    "codex",
    "context",
    "run",
    "a2a",
    "plugins",
    "plugin",
    "doctor",
];

const GLOBAL_FLAGS_WITH_VALUES: [&str; 26] = [
    "--mode",
    "--provider",
    "--model",
    "-m",
    "--task-budget",
    "--models",
    "--models-file",
    "--api-key",
    "--port",
    "--system-prompt",
    "--append-system-prompt",
    "--session",
    "--approval-mode",
    "--auth",
    "--sandbox",
    "--output-schema",
    "--output-last-message",
    "--tools",
    "--composer",
    "--format",
    "--output-dir",
    "--profile",
    "--config",
    "--junit",
    "--replay",
    "--record-scenario",
];

/// Recognize a utility-subcommand invocation and reconstruct its forwarded
/// tokens. Returns `None` when `raw_args` should instead reach the
/// interactive TUI, headless server, or exec/print bridge.
pub fn native_utility_tokens(raw_args: &[std::ffi::OsString]) -> Option<Vec<String>> {
    let mut forwarded_prefix = Vec::new();
    let mut index = 0;
    while index < raw_args.len() {
        let token = raw_args[index].to_string_lossy();
        // `run` is only a utility when followed by reconstruct subcommands.
        if token == "run" {
            let rest = &raw_args[index + 1..];
            let mut j = 0;
            let mut has_sub = false;
            while j < rest.len() {
                let t = rest[j].to_string_lossy();
                if matches!(
                    t.as_ref(),
                    "inspect" | "ledger" | "replay" | "promote" | "help" | "--help" | "-h"
                ) {
                    has_sub = true;
                    break;
                }
                if t.starts_with('-') {
                    if matches!(t.as_ref(), "--json") {
                        j += 1;
                        continue;
                    }
                    j += 1;
                    continue;
                }
                break;
            }
            if !has_sub {
                return None;
            }
        }
        if NATIVE_UTILITY_COMMANDS.contains(&token.as_ref()) {
            let mut tokens = raw_args[index..]
                .iter()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            tokens.extend(forwarded_prefix);
            return Some(tokens);
        }
        if matches!(token.as_ref(), "--json" | "--force") {
            forwarded_prefix.push(token.into_owned());
            index += 1;
            continue;
        }
        if token == "--worktree" || token == "-w" {
            index += 1;
            if raw_args
                .get(index)
                .is_some_and(|value| !value.to_string_lossy().starts_with('-'))
            {
                index += 1;
            }
            continue;
        }
        if GLOBAL_FLAGS_WITH_VALUES.contains(&token.as_ref()) {
            let value = raw_args.get(index + 1)?;
            if matches!(token.as_ref(), "--provider" | "--session" | "--format") {
                forwarded_prefix.push(token.into_owned());
                forwarded_prefix.push(value.to_string_lossy().into_owned());
            }
            index += 2;
            continue;
        }
        if token.starts_with("--provider=")
            || token.starts_with("--session=")
            || token.starts_with("--format=")
        {
            forwarded_prefix.push(token.into_owned());
            index += 1;
            continue;
        }
        if token.starts_with('-') {
            index += 1;
            continue;
        }
        return None;
    }
    None
}

fn native_profile(raw_args: &[std::ffi::OsString]) -> Option<String> {
    let mut config_profile = None;
    for (index, argument) in raw_args.iter().enumerate() {
        let argument = argument.to_string_lossy();
        if argument == "--profile" {
            return raw_args
                .get(index + 1)
                .map(|value| value.to_string_lossy().into_owned());
        }
        if let Some(profile) = argument.strip_prefix("--profile=") {
            return Some(profile.to_owned());
        }
        let config = if argument == "--config" {
            raw_args.get(index + 1).map(|value| value.to_string_lossy())
        } else {
            argument
                .strip_prefix("--config=")
                .map(std::borrow::Cow::Borrowed)
        };
        if let Some(profile) =
            config.and_then(|value| value.strip_prefix("profile=").map(str::to_owned))
        {
            config_profile = Some(profile);
        }
    }
    config_profile
}

fn native_config_overrides(raw_args: &[std::ffi::OsString]) -> Vec<String> {
    let mut overrides = Vec::new();
    let mut index = 0;
    while index < raw_args.len() {
        let argument = raw_args[index].to_string_lossy();
        if argument == "--config" {
            if let Some(value) = raw_args.get(index + 1) {
                overrides.push(value.to_string_lossy().into_owned());
                index += 1;
            }
        } else if let Some(value) = argument.strip_prefix("--config=") {
            overrides.push(value.to_owned());
        }
        index += 1;
    }
    overrides
}

/// Infer the AI provider from the model name.
///
/// # Rust Concepts Used
///
/// - **`&str` vs `String`**: `&str` is a borrowed string slice (a view into string data),
///   while `String` is an owned, heap-allocated string. We take `&str` as input because
///   we only need to read the model name, not own it.
///
/// - **`&'static str`**: The `'static` lifetime means the returned string lives for the
///   entire program duration. String literals like `"openai"` have this lifetime because
///   they're embedded in the binary.
///
/// - **`to_lowercase()`**: Returns a new `String` (owned) because the lowercase version
///   might have different UTF-8 byte lengths than the original.
///
/// # Arguments
///
/// * `model` - The model name to analyze (for example, "gpt-5.5")
///
/// # Returns
///
/// A static string identifying the provider (e.g., "openai", "anthropic")
fn infer_direct_provider_from_bare_model(model_lower: &str) -> Option<&'static str> {
    if matches!(model_lower, "deepseek-chat" | "deepseek-reasoner")
        || model_lower.starts_with("deepseek-v")
    {
        return Some("deepseek");
    }

    if model_lower.starts_with("kimi-")
        || model_lower == "kimi-latest"
        || model_lower.starts_with("moonshot-v1-")
    {
        return Some("moonshot");
    }

    if model_lower.starts_with("qwen3-")
        || matches!(
            model_lower,
            "qwen-max" | "qwen-plus" | "qwen-turbo" | "qwen-vl-max" | "qwq-32b"
        )
    {
        return Some("dashscope");
    }

    if matches!(
        model_lower,
        "minimax-m2" | "minimax-m2.5" | "minimax-m2.7" | "minimax-text-01"
    ) {
        return Some("minimax");
    }

    if model_lower.starts_with("glm-") {
        return Some("zai");
    }

    None
}

fn infer_provider_from_model(model: &str) -> &'static str {
    // Convert to lowercase for case-insensitive matching.
    // Note: This allocates a new String on the heap.
    let model_lower = model.to_lowercase();

    // Explicit "provider/model" prefixes win over heuristic name matching.
    if let Some((prefix, _)) = model_lower.split_once('/') {
        match prefix {
            "deepseek" => return "deepseek",
            "moonshot" | "kimi" => return "moonshot",
            "dashscope" | "qwen" => return "dashscope",
            "minimax" => return "minimax",
            "zai" | "zhipu" => return "zai",
            _ => {}
        }
    }

    if let Some(provider) = infer_direct_provider_from_bare_model(&model_lower) {
        return provider;
    }

    // OpenAI models - check various prefixes that indicate OpenAI
    // The `||` operator short-circuits: if the first condition is true,
    // subsequent conditions aren't evaluated.
    if model_lower.starts_with("gpt")
        || model_lower.starts_with("o1")
        || model_lower.starts_with("o3")
        || model_lower.contains("codex")
        || model_lower.starts_with("text-")
        || model_lower.starts_with("davinci")
    {
        // `return` exits the function early with the given value.
        // In Rust, the last expression without a semicolon is implicitly returned,
        // but explicit `return` is clearer for early exits.
        return "openai";
    }

    // Anthropic models (Claude family)
    if model_lower.starts_with("claude") {
        return "anthropic";
    }

    // Google/Gemini models
    if model_lower.starts_with("gemini") || model_lower.starts_with("palm") {
        return "google";
    }

    // xAI/Grok models
    if model_lower.starts_with("grok") {
        return "xai";
    }

    // Groq hosts Llama plus DeepSeek/Qwen distill/coder variants. Direct-provider
    // bare ids are handled earlier by `infer_direct_provider_from_bare_model`, so
    // these heuristics mirror the Groq fallback in `AiProvider::from_model` and
    // keep `--api-key` env wiring aligned with the client that actually runs
    // (e.g. deepseek-r1-distill-llama-70b, qwen-2.5-coder-32b -> GROQ_API_KEY).
    if model_lower.contains("groq")
        || model_lower.starts_with("llama-")
        || model_lower.starts_with("llama3")
        || model_lower.contains("deepseek")
        || model_lower.contains("qwen")
    {
        return "groq";
    }

    // Cerebras models
    if model_lower.contains("cerebras") {
        return "cerebras";
    }

    // OpenRouter uses a "provider/model" format (e.g., "anthropic/claude-3")
    if model_lower.contains('/') {
        return "openrouter";
    }

    // Default to OpenAI/Codex if we can't identify the provider
    // Note: No semicolon here - this is the implicit return value
    "openai"
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI ARGUMENTS DEFINITION
// ─────────────────────────────────────────────────────────────────────────────

/// Command-line arguments for the Maestro TUI.
#[derive(Parser, Debug)]
#[command(name = "maestro-tui")]
#[command(about = "Native terminal interface for Maestro")]
#[command(version = env!("CARGO_PKG_VERSION"))]
#[command(long_about = "Native terminal UI for Maestro (coding agent).\n\n\
Interactive: maestro-tui --provider openai -m gpt-4.1-mini\n\
Print mode:  maestro-tui -p --provider openai -m gpt-4.1-mini \"question\"\n\
Trust cwd:   maestro-tui trust\n\
Sandbox:     use /sandbox in-session or MAESTRO_SANDBOX_MODE")]
struct Args {
    /// Provider to use (for example, openai). When omitted, inferred from the model.
    #[arg(long)]
    provider: Option<String>,

    /// Model to use (for example, gpt-5.5).
    #[arg(short, long)]
    model: Option<String>,

    /// API key for authentication (defaults to env / op:// references).
    #[arg(long)]
    api_key: Option<String>,

    /// Continue the previous session.
    #[arg(short, long)]
    r#continue: bool,

    /// Open the session resume selector.
    #[arg(short, long)]
    resume: bool,

    /// Do not persist this conversation (ephemeral session).
    #[arg(long = "no-session")]
    no_session: bool,

    /// Run the session in a new git worktree at `../<repo>-wt-<name>` on a new branch.
    #[arg(short = 'w', long, value_name = "NAME")]
    worktree: Option<String>,

    /// Non-interactive print mode (single-shot). Prints the answer and exits.
    #[arg(long, short = 'p')]
    print: bool,

    /// With `--print`, emit simple JSONL events instead of plain text.
    #[arg(long)]
    json: bool,

    /// Run as native headless protocol server on stdio.
    #[arg(long)]
    headless: bool,

    /// Alias for `--headless` (RPC clients).
    #[arg(long)]
    rpc: bool,

    /// Write final assistant text to this file (exec parity).
    #[arg(long = "output-last-message")]
    output_last_message: Option<String>,

    /// Validate final assistant text against a JSON Schema file or inline JSON.
    #[arg(long = "output-schema")]
    output_schema: Option<String>,

    /// Initial prompt to send (all remaining arguments are joined).
    #[arg(trailing_var_arg = true)]
    prompt: Vec<String>,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct NativeExecOptions {
    json: bool,
    model: Option<String>,
    output_last: Option<std::path::PathBuf>,
    output_schema: Option<String>,
    sandbox: Option<String>,
    approval_mode: Option<String>,
    provider: Option<String>,
    api_key: Option<String>,
    prompt_stdin: bool,
    prompt: String,
}

fn parse_native_exec_options(raw_args: &[std::ffi::OsString]) -> NativeExecOptions {
    let mut options = NativeExecOptions::default();
    let mut prompt_parts = Vec::new();
    let mut positional_only = false;
    let mut i = 0usize;
    while i < raw_args.len() {
        let arg = raw_args[i].to_string_lossy();
        if positional_only {
            prompt_parts.push(arg.into_owned());
        } else if arg == "--" {
            positional_only = true;
        } else if arg == "--json" || arg == "--mode=json" {
            options.json = true;
        } else if arg == "--mode" {
            i += 1;
            if i < raw_args.len() && raw_args[i] == "json" {
                options.json = true;
            }
        } else if arg == "--model" || arg == "-m" {
            i += 1;
            if i < raw_args.len() {
                options.model = Some(raw_args[i].to_string_lossy().into_owned());
            }
        } else if let Some(value) = arg.strip_prefix("--model=") {
            options.model = Some(value.to_string());
        } else if arg == "--output-last-message" {
            i += 1;
            if i < raw_args.len() {
                options.output_last = Some(std::path::PathBuf::from(&raw_args[i]));
            }
        } else if let Some(value) = arg.strip_prefix("--output-last-message=") {
            options.output_last = Some(std::path::PathBuf::from(value));
        } else if arg == "--output-schema" {
            i += 1;
            if i < raw_args.len() {
                options.output_schema = Some(raw_args[i].to_string_lossy().into_owned());
            }
        } else if let Some(value) = arg.strip_prefix("--output-schema=") {
            options.output_schema = Some(value.to_string());
        } else if arg == "--sandbox" {
            i += 1;
            if i < raw_args.len() {
                options.sandbox = Some(raw_args[i].to_string_lossy().into_owned());
            }
        } else if let Some(value) = arg.strip_prefix("--sandbox=") {
            options.sandbox = Some(value.to_string());
        } else if arg == "--approval-mode" {
            i += 1;
            if i < raw_args.len() {
                options.approval_mode = Some(raw_args[i].to_string_lossy().into_owned());
            }
        } else if let Some(value) = arg.strip_prefix("--approval-mode=") {
            options.approval_mode = Some(value.to_string());
        } else if arg == "--provider" {
            i += 1;
            if i < raw_args.len() {
                options.provider = Some(raw_args[i].to_string_lossy().into_owned());
            }
        } else if let Some(value) = arg.strip_prefix("--provider=") {
            options.provider = Some(value.to_string());
        } else if arg == "--api-key" {
            i += 1;
            if i < raw_args.len() {
                options.api_key = Some(raw_args[i].to_string_lossy().into_owned());
            }
        } else if let Some(value) = arg.strip_prefix("--api-key=") {
            options.api_key = Some(value.to_string());
        } else if arg == "--prompt-stdin" {
            options.prompt_stdin = true;
        } else if arg == "--worktree" || arg == "-w" {
            // Session worktree is created before dispatch; consume its value
            // so it never leaks into the prompt.
            i += 1;
        } else if arg.starts_with("--worktree=") || (arg.starts_with("-w") && arg.len() > 2) {
            // Inline forms; handled before dispatch.
        } else if arg == "--session" || arg == "--config" || arg == "--profile" {
            // Compatibility option whose value must never leak into the prompt.
            i += 1;
        } else if arg.starts_with("--config=") || arg.starts_with("--profile=") {
            // Parsed before command dispatch; consume inline forms here as well.
        } else if !arg.starts_with('-') {
            prompt_parts.push(arg.into_owned());
        }
        i += 1;
    }
    options.prompt = prompt_parts.join(" ");
    options
}

fn native_exec_sandbox_policy(
    value: Option<&str>,
) -> std::result::Result<Option<SandboxPolicy>, String> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None | Some("danger-full-access") => Ok(None),
        Some("read-only") => Ok(Some(SandboxPolicy::ReadOnly)),
        Some("native" | "workspace-write") => Ok(Some(SandboxPolicy::WorkspaceWrite {
            writable_roots: Vec::new(),
            network_access: true,
            exclude_tmpdir_env_var: false,
            exclude_slash_tmp: false,
        })),
        Some(value) => Err(format!(
            "Unsupported exec sandbox `{value}`; use read-only, workspace-write, native, or danger-full-access"
        )),
    }
}

fn native_exec_model(provider: Option<&str>, model: Option<&str>) -> Option<String> {
    let provider = provider.map(str::trim).filter(|value| !value.is_empty());
    let model = model.map(str::trim).filter(|value| !value.is_empty());
    match (provider, model) {
        (None, None) => None,
        (None, Some(model)) => Some(model.to_string()),
        (Some(provider), Some(model)) if model.starts_with(&format!("{provider}/")) => {
            Some(model.to_string())
        }
        (Some(provider), Some(model)) => Some(format!("{provider}/{model}")),
        (Some(provider), None) => {
            let model_provider = if matches!(provider, "evalops" | "maestro-managed") {
                std::env::var("MAESTRO_EVALOPS_PROVIDER")
                    .ok()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| "openai".to_string())
            } else {
                provider.to_string()
            };
            Some(format!(
                "{provider}/{}",
                default_model_for_provider(&model_provider)
            ))
        }
    }
}

fn default_model_for_provider(provider: &str) -> &'static str {
    if let Some(default) = crate::model_catalog::default_model_for_provider(provider) {
        return default;
    }
    match provider.to_ascii_lowercase().as_str() {
        "bedrock" | "aws-bedrock" => "claude-sonnet-4-6",
        "google-gemini-cli" | "google-antigravity" => "gemini-2.5-pro",
        "groq" => "llama-3.3-70b-versatile",
        "deepseek" => "deepseek-chat",
        "moonshot" | "kimi" => "kimi-k2.6",
        "dashscope" | "qwen" => "qwen3-max",
        "minimax" => "MiniMax-M2",
        "zai" | "zhipu" => "glm-4.6",
        "mistral" => "mistral-large-latest",
        "openrouter" => "openai/gpt-4o-mini",
        "evalops" | "maestro-managed" => "gpt-4o-mini",
        _ => "gpt-5.5",
    }
}

fn set_provider_api_key(provider: &str, api_key: &str) {
    match provider {
        "openai" => std::env::set_var("OPENAI_API_KEY", api_key),
        "openai-codex" => std::env::set_var("OPENAI_CODEX_TOKEN", api_key),
        "google" | "gemini" => std::env::set_var("GEMINI_API_KEY", api_key),
        "google-gemini-cli" => std::env::set_var("GOOGLE_GEMINI_CLI_TOKEN", api_key),
        "google-antigravity" => std::env::set_var("GOOGLE_ANTIGRAVITY_TOKEN", api_key),
        "evalops" | "maestro-managed" => std::env::set_var("MAESTRO_EVALOPS_ACCESS_TOKEN", api_key),
        "azure-openai" | "azure" => std::env::set_var("AZURE_OPENAI_API_KEY", api_key),
        "mistral" => std::env::set_var("MISTRAL_API_KEY", api_key),
        "xai" => std::env::set_var("XAI_API_KEY", api_key),
        "groq" => std::env::set_var("GROQ_API_KEY", api_key),
        "cerebras" => std::env::set_var("CEREBRAS_API_KEY", api_key),
        "openrouter" => std::env::set_var("OPENROUTER_API_KEY", api_key),
        "deepseek" => std::env::set_var("DEEPSEEK_API_KEY", api_key),
        "moonshot" | "kimi" => std::env::set_var("MOONSHOT_API_KEY", api_key),
        "dashscope" | "qwen" => std::env::set_var("DASHSCOPE_API_KEY", api_key),
        "minimax" => std::env::set_var("MINIMAX_API_KEY", api_key),
        "zai" | "zhipu" => std::env::set_var("ZAI_API_KEY", api_key),
        "writer" => std::env::set_var("WRITER_API_KEY", api_key),
        _ => std::env::set_var("ANTHROPIC_API_KEY", api_key),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FUNCTION
// ─────────────────────────────────────────────────────────────────────────────

/// Application entry point.
///
/// # Rust Concepts Used
///
/// - **`#[tokio::main]`**: This attribute macro transforms `async fn main()`
///   into a synchronous main that sets up the Tokio async runtime. Without it,
///   we couldn't use `.await` in main.
///
/// - **`async/await`**: Rust's async programming model. `async fn` returns a
///   Future that must be `.await`ed to get the result. This enables non-blocking
///   I/O without callbacks.
///
/// - **`Result<()>`**: Returns either `Ok(())` (success with unit type) or an
///   error. The `?` operator propagates errors up the call stack automatically.
///
/// - **Error Propagation with `?`**: When you see `foo()?`, it means "if `foo()`
///   returns an error, return that error from this function; otherwise, unwrap
///   the Ok value and continue."
pub async fn run_cli(raw_args: Vec<std::ffi::OsString>) -> Result<()> {
    // Set up panic hook for process cleanup on unexpected termination.
    // This ensures background processes are killed even if the app panics.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        // Clean up background processes before panicking
        let count = cleanup_background_processes();
        if count > 0 {
            eprintln!("[panic] Cleaned up {count} background process(es)");
        }
        // Call the default panic hook to print the panic message
        default_hook(panic_info);
    }));

    if raw_args
        .get(1)
        .and_then(|arg| arg.to_str())
        .is_some_and(|arg| arg == "hosted-runner")
    {
        let mut hosted_args = vec![std::ffi::OsString::from("maestro-tui hosted-runner")];
        hosted_args.extend(raw_args.into_iter().skip(2));
        run_hosted_runner_cli_from_env(hosted_args).await?;
        return Ok(());
    }

    // Lightweight CLI helpers (no TUI / no full interactive loop). Utility
    // argument normalization lives here so the package shim can forward argv.
    if let Some(profile) = native_profile(&raw_args[1..]) {
        // SAFETY: `run_cli` is the sole top-level future of this process's
        // `#[tokio::main]` body and this runs before its first `.await` or
        // `tokio::spawn`, so no other task can be concurrently reading or
        // writing the environment even though the runtime's (idle) worker
        // threads already exist. The profile is converted to the same
        // environment contract used by Rust config loading.
        unsafe { std::env::set_var("MAESTRO_PROFILE", profile) };
    }
    let config_overrides = native_config_overrides(&raw_args[1..]);
    if !config_overrides.is_empty() {
        // SAFETY: see above — still before this task's first `.await` or spawn.
        unsafe {
            std::env::set_var(
                "MAESTRO_CLI_CONFIG_OVERRIDES",
                config_overrides.join("\u{1f}"),
            );
        };
    }
    if let Some(tokens) = native_utility_tokens(&raw_args[1..]) {
        if tokens.first().is_some_and(|token| token == "agents") {
            configure_agents_api_key(&raw_args[1..]);
            let outcome = match crate::agents_cli::run(&tokens[1..]) {
                Ok(outcome) => outcome,
                Err(error) => {
                    eprintln!("{error:#}");
                    std::process::exit(1);
                }
            };
            match outcome {
                crate::agents_cli::Outcome::Exit(code) => std::process::exit(code),
                crate::agents_cli::Outcome::Generate { prompt, target } => {
                    let cwd = std::env::current_dir()?;
                    let display = target
                        .strip_prefix(&cwd)
                        .map(|relative| format!("./{}", relative.display()))
                        .unwrap_or_else(|_| target.display().to_string());
                    println!("Drafting AGENTS.md at {display}...");
                    let model = raw_option_value(&raw_args[1..], &["--model", "-m"]);
                    let code =
                        crate::print_mode::run_print_mode(crate::print_mode::PrintModeOptions {
                            prompt,
                            json: false,
                            model,
                            output_last_message: None,
                            output_schema: None,
                            sandbox_policy: None,
                            fail_on_approval: false,
                        })
                        .await?;
                    std::process::exit(code);
                }
            }
        }
        match crate::cli_commands::run_cli_command(&tokens).await {
            Ok(code) => std::process::exit(code),
            Err(err) => {
                eprintln!("{err:#}");
                std::process::exit(1);
            }
        }
    }

    // Droid-style session worktree (`-w` / `--worktree`): set up before any
    // agent surface so the interactive TUI, `exec`, and print mode all run
    // with the worktree as their working directory. Utility commands above
    // dispatch first and never create worktrees.
    let worktree = match crate::worktree::requested_name(&raw_args[1..]) {
        Some(Ok(name)) => {
            let cwd = std::env::current_dir()?;
            match crate::worktree::WorktreeSession::create_in(&cwd, &name) {
                Ok(session) => {
                    if let Err(err) = std::env::set_current_dir(session.path()) {
                        eprintln!(
                            "Failed to enter worktree {}: {err}",
                            session.path().display()
                        );
                        std::process::exit(1);
                    }
                    eprintln!("Using worktree: {}", session.path().display());
                    Some(session)
                }
                Err(err) => {
                    eprintln!("Worktree setup failed: {err:#}");
                    std::process::exit(1);
                }
            }
        }
        Some(Err(message)) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
        None => None,
    };

    let result = run_agent(raw_args).await;
    if let Some(session) = worktree {
        session.finish();
    }
    let exit_code = result?;
    std::process::exit(exit_code);
}

/// Which fast path (if any) `run_agent` takes before falling back to the
/// full clap-derived `Args` parse. This is the single decision point for the
/// `headless`/`rpc`/`fork`/`exec`/`print` subcommand words, consumed by `run_agent`
/// and exercised directly by `tests/entrypoint.rs` so a routing change
/// here can't silently drift from what the test matrix expects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentEntry {
    /// First argv token is `headless` or `rpc`.
    HeadlessSubcommand,
    /// First argv token is `fork`.
    ForkSubcommand,
    /// First argv token is `exec` or `print`; carries the literal word for
    /// the usage message.
    ExecOrPrintSubcommand(&'static str),
    /// First argv token is `trust` (grant/revoke/status for cwd).
    TrustSubcommand,
    /// Falls through to `Args::try_parse_from` (interactive TUI, `-p`,
    /// `--headless`/`--rpc` flags, unknown commands, `--help`/`--version`
    /// on the `maestro-tui` binary directly, or a parse error).
    ClapParsed,
}

/// Classify the first argv token for `run_agent`'s subcommand fast path.
pub fn classify_agent_entry(raw_args: &[std::ffi::OsString]) -> AgentEntry {
    if let Some(cmd) = raw_args.get(1).and_then(|a| a.to_str()) {
        if cmd == "headless" || cmd == "rpc" {
            return AgentEntry::HeadlessSubcommand;
        }
        if cmd == "fork" {
            return AgentEntry::ForkSubcommand;
        }
        if cmd == "exec" {
            return AgentEntry::ExecOrPrintSubcommand("exec");
        }
        if cmd == "print" {
            return AgentEntry::ExecOrPrintSubcommand("print");
        }
        if cmd == "trust" {
            return AgentEntry::TrustSubcommand;
        }
    }
    AgentEntry::ClapParsed
}

/// What `AgentEntry::ClapParsed` resolves to once the argv is actually run
/// through the real `Args` clap derive. Mirrors the branching `run_agent`
/// performs on its own parsed `Args` (see the `args.headless || args.rpc`
/// and `args.print` checks below); kept alongside `classify_agent_entry` so
/// `tests/entrypoint.rs` exercises the production `Args` parser directly
/// for flag-driven routing (`-p`, `--headless`, `--rpc`, `--mode=headless`)
/// rather than re-describing clap's flag names in the test.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClapDispatch {
    /// Starts the headless server from either supported headless flag.
    Headless,
    /// Runs a single non-interactive prompt and prints its result.
    Print,
    /// Continues into the interactive agent path.
    Interactive,
    /// Rejects argv that the real clap parser does not accept.
    ParseError,
}

/// Classify a `ClapParsed` argv (see [`AgentEntry`]) by running it through
/// the real `Args::try_parse_from`.
pub fn classify_clap_dispatch(raw_args: &[std::ffi::OsString]) -> ClapDispatch {
    match Args::try_parse_from(raw_args) {
        Ok(args) => {
            if args.headless || args.rpc {
                ClapDispatch::Headless
            } else if args.print {
                ClapDispatch::Print
            } else {
                ClapDispatch::Interactive
            }
        }
        Err(error)
            if matches!(
                error.kind(),
                ErrorKind::DisplayHelp | ErrorKind::DisplayVersion
            ) =>
        {
            ClapDispatch::Interactive
        }
        Err(_) => ClapDispatch::ParseError,
    }
}

/// Agent dispatch shared by the interactive TUI, fork/resume, exec, print,
/// and headless modes. Returns the process exit code instead of exiting
/// directly so the caller can run worktree teardown first.
async fn run_agent(raw_args: Vec<std::ffi::OsString>) -> Result<i32> {
    // Prefer Codex ChatGPT auth from CODEX_HOME when present so
    // openai-codex/* models resolve without a separate OPENAI_API_KEY.
    let _ = crate::codex_auth::apply_codex_auth_to_process_env();

    match classify_agent_entry(&raw_args) {
        AgentEntry::HeadlessSubcommand => {
            let code = crate::headless_server::run_headless_server().await?;
            return Ok(code);
        }
        AgentEntry::ForkSubcommand => return run_fork(&raw_args[2..]).await,
        AgentEntry::TrustSubcommand => return run_trust_cli(&raw_args[2..]),
        AgentEntry::ExecOrPrintSubcommand(cmd) => {
            // maestro-tui print|exec [--json] [--model X] [--output-last-message P]
            //   [--output-schema S] <prompt...>
            let mut options = parse_native_exec_options(&raw_args[2..]);
            let env_sandbox = std::env::var("MAESTRO_SANDBOX_MODE").ok();
            let sandbox_value = options.sandbox.as_deref().or(env_sandbox.as_deref());
            let sandbox_policy = match native_exec_sandbox_policy(sandbox_value) {
                Ok(policy) => policy,
                Err(message) => {
                    eprintln!("{message}");
                    return Ok(2);
                }
            };
            if let Some(api_key) = &options.api_key {
                let provider = options.provider.as_deref().unwrap_or_else(|| {
                    options
                        .model
                        .as_deref()
                        .map(infer_provider_from_model)
                        .unwrap_or("openai")
                });
                set_provider_api_key(provider, api_key);
            }
            if options.prompt_stdin {
                use tokio::io::AsyncReadExt as _;
                tokio::io::stdin()
                    .read_to_string(&mut options.prompt)
                    .await?;
            }
            if options.prompt.is_empty() {
                eprintln!(
                    "Usage: maestro-tui {cmd} [--json] [--model <id>] [--output-last-message <path>] [--output-schema <path|json>] <prompt>"
                );
                return Ok(2);
            }
            let model = native_exec_model(options.provider.as_deref(), options.model.as_deref());
            let code = crate::print_mode::run_print_mode(crate::print_mode::PrintModeOptions {
                prompt: options.prompt,
                json: options.json,
                model,
                output_last_message: options.output_last,
                output_schema: options.output_schema,
                sandbox_policy,
                fail_on_approval: options.approval_mode.as_deref() == Some("fail"),
            })
            .await?;
            return Ok(code);
        }
        AgentEntry::ClapParsed => {}
    }

    // Parse command-line arguments using clap.
    // `Args::parse()` reads from std::env::args() and returns our Args struct.
    // If parsing fails (e.g., unknown flag), clap prints help and exits.
    let args = match Args::try_parse_from(raw_args.clone()) {
        Ok(args) => args,
        Err(error)
            if matches!(
                error.kind(),
                ErrorKind::DisplayHelp | ErrorKind::DisplayVersion
            ) =>
        {
            error.print()?;
            return Ok(0);
        }
        Err(error) => return Err(error.into()),
    };

    // Set API key from CLI if provided.
    // This allows users to override environment variables via command line.
    //
    // Rust Concept: `if let Some(x) = option` is pattern matching that only
    // executes the block if the Option is Some, binding the inner value to `x`.
    if let Some(api_key) = &args.api_key {
        // Determine which provider's API key to set.
        //
        // Rust Concept: `unwrap_or_else` takes a closure (anonymous function)
        // that's only called if the Option is None. This is lazier than
        // `unwrap_or` which always evaluates its argument.
        //
        // The `|| { ... }` syntax creates a closure. The `||` are the parameter
        // list (empty in this case), and `{ ... }` is the body.
        let provider = args.provider.as_deref().unwrap_or_else(|| {
            // Infer provider from model name if no explicit provider given
            if let Some(model) = &args.model {
                infer_provider_from_model(model)
            } else {
                "openai"
            }
        });

        // Set the appropriate environment variable based on provider.
        //
        // Rust Concept: `match` is exhaustive pattern matching. Unlike switch
        // in other languages, it must handle all possible cases (or use `_`
        // as a catch-all).
        set_provider_api_key(provider, api_key);
    }

    // Set model from CLI if provided.
    // This environment variable is read by the App during initialization.
    if let Some(model) = &args.model {
        std::env::set_var("MAESTRO_MODEL", model);
    }

    // Worktree setup already ran in run_cli before clap parsing; the field
    // stays in Args so the flag validates and shows up in --help.
    let _ = args.worktree.as_deref();

    if args.no_session {
        // SessionManager still creates an id for UI purposes, but callers that
        // honor this env skip durable transcript persistence.
        std::env::set_var("MAESTRO_NO_SESSION", "1");
    }

    // Trailing positional args become the initial prompt (Grok-style).
    let initial_prompt = if args.prompt.is_empty() {
        None
    } else {
        Some(args.prompt.join(" "))
    };

    // Native headless/RPC server (kills TS agent path for these modes)
    if args.headless || args.rpc {
        let code = crate::headless_server::run_headless_server().await?;
        return Ok(code);
    }

    // Non-interactive print mode (single-shot / exec bridge)
    if args.print {
        let prompt = initial_prompt.unwrap_or_default();
        if prompt.is_empty() {
            eprintln!("--print requires a prompt");
            return Ok(2);
        }
        let code = crate::print_mode::run_print_mode(crate::print_mode::PrintModeOptions {
            prompt,
            json: args.json,
            model: args.model.clone(),
            output_last_message: args
                .output_last_message
                .as_ref()
                .map(std::path::PathBuf::from),
            output_schema: args.output_schema.clone(),
            sandbox_policy: None,
            fail_on_approval: false,
        })
        .await?;
        return Ok(code);
    }

    run_interactive_with_shutdown(move || App::new_with_initial_prompt(initial_prompt)).await
}

/// `maestro-tui trust [status|grant|revoke]` — writes global trust for cwd.
fn run_trust_cli(args: &[std::ffi::OsString]) -> Result<i32> {
    let action = args
        .first()
        .and_then(|a| a.to_str())
        .unwrap_or("grant")
        .to_ascii_lowercase();
    let cwd = std::env::current_dir().context("failed to resolve current directory")?;
    match action.as_str() {
        "status" | "show" => {
            let trusted = crate::config::workspace_trusted_in_global_config(&cwd);
            println!(
                "{}: {}",
                cwd.display(),
                if trusted { "trusted" } else { "untrusted" }
            );
            Ok(0)
        }
        "grant" | "on" | "yes" | "true" | "trusted" => {
            let path = crate::config::set_workspace_trust_in_global_config(&cwd, true)
                .map_err(anyhow::Error::msg)?;
            println!("Trusted {}. Wrote {}.", cwd.display(), path.display());
            println!("Reload skills with /skills reload in a running TUI, or restart.");
            Ok(0)
        }
        "revoke" | "off" | "no" | "false" | "untrusted" => {
            let path = crate::config::set_workspace_trust_in_global_config(&cwd, false)
                .map_err(anyhow::Error::msg)?;
            println!(
                "Revoked trust for {}. Wrote {}.",
                cwd.display(),
                path.display()
            );
            Ok(0)
        }
        "help" | "-h" | "--help" => {
            println!("Usage: maestro-tui trust [status|grant|revoke]");
            println!("Grant or revoke project skills/plugins/hooks for the current workspace.");
            println!("Writes only ~/.composer/config.toml (repositories cannot self-trust).");
            Ok(0)
        }
        other => {
            eprintln!("Unknown trust action: {other}");
            eprintln!("Usage: maestro-tui trust [status|grant|revoke]");
            Ok(2)
        }
    }
}

/// Construct and run an interactive app under the complete shutdown lifecycle.
///
/// The constructor runs only after process signal receivers are registered,
/// so both terminal initialization and any startup session restoration are
/// covered by the same orderly signal path as the main event loop.
async fn run_interactive_with_shutdown<F>(constructor: F) -> Result<i32>
where
    F: FnOnce() -> Result<App> + Send + 'static,
{
    // Register process signal streams before terminal initialization. Tokio
    // keeps its process-wide signal disposition installed, so the monitor
    // must retain active receivers from this point through final process exit.
    let mut shutdown = shutdown_signal::ShutdownMonitor::register()
        .context("Failed to register interactive shutdown signals")?;
    let app = match shutdown_signal::construct_while_monitoring(&mut shutdown, constructor).await? {
        Ok(app) => app,
        Err((signal, construction)) => {
            // `construction`'s closure cannot be cancelled now that
            // `spawn_blocking` has started it, and it may still be mid-way
            // through `terminal::init()` (raw mode / bracketed paste /
            // mouse capture applied before the global TTY handle is
            // published -- see `terminal/setup.rs::init`). Calling
            // `terminal::restore()` without first waiting for it to finish
            // would race that setup: the abandoned thread can re-enable
            // modes after our restore call returns, and nothing runs a
            // second restore before `run_cli`'s `std::process::exit` a few
            // frames up the stack. Await it first so restore always runs
            // strictly after whatever terminal setup already happened --
            // this part must stay on the async worker. A wedged constructor
            // is still bounded: `ShutdownMonitor`'s second-signal watchdog
            // runs on its own detached task and force-exits on a repeated
            // signal regardless of this await.
            let construction_result = construction.await;
            let (disable_theme_reporting, construction_error) = match construction_result {
                Ok(Ok(mut app)) => {
                    let disable_theme_reporting = app.prepare_terminal_restore();
                    drop(app);
                    (disable_theme_reporting, None)
                }
                Ok(Err(error)) => (false, Some(format!("{error:#}"))),
                Err(error) => (false, Some(error.to_string())),
            };

            // Deliberately not `eprintln!`'d inline here, mirroring
            // `run_with_shutdown` in shutdown_signal.rs: this arm runs on
            // the async worker, and `eprintln!` takes stderr's process-
            // global lock and performs a real (possibly blocking) write
            // syscall -- on a full pipe or wedged terminal that would stall
            // this worker with nothing left on a single-worker runtime to
            // poll the repeat-signal monitor the escape hatch above depends
            // on. All of this arm's diagnostics, plus the blocking terminal
            // restore itself, now run together on a blocking thread, same
            // as the run-loop shutdown branch.
            tokio::task::spawn_blocking(move || {
                eprintln!("[shutdown] received signal during app construction");
                if let Some(error) = construction_error {
                    eprintln!(
                        "[shutdown] app construction task ended unexpectedly while waiting for it: {error}"
                    );
                }
                if disable_theme_reporting {
                    let _ = crate::terminal::disable_theme_reporting();
                }
                if let Err(error) = crate::terminal::restore() {
                    eprintln!("[shutdown] failed to restore terminal: {error}");
                }
            })
            .await
            .map_err(|error| anyhow::anyhow!("shutdown cleanup task failed: {error}"))?;
            shutdown.complete_platform_cleanup();
            return Ok(signal.exit_code());
        }
    };

    // Run the application's main loop, racing it against SIGINT/SIGTERM/
    // SIGHUP (Unix) or the equivalent console events (Windows). An external
    // termination now flushes the session writer, cleans up tracked
    // background processes, and restores the terminal instead of hitting
    // the OS default disposition (immediate exit, no `Drop`, no panic
    // hook). See `shutdown_signal` for the full design, including why this
    // cannot and does not change in-app Ctrl+C-as-keypress behavior.
    //
    // `.await` suspends this function until the Future completes.
    // The app handles all user interaction, AI communication, and rendering.
    let exit_code = shutdown_signal::run_with_shutdown(app, shutdown).await?;

    // Final cleanup - the app should have already cleaned up, but this is a safety net.
    // This catches cases where the app returned without going through its normal exit path.
    // (On the signal path above this is a no-op: cleanup already ran there.)
    let remaining = cleanup_background_processes();
    if remaining > 0 {
        eprintln!("[main] Final cleanup: {remaining} background process(es)");
    }

    // Return the exit code to `run_cli`, which runs worktree teardown and
    // then terminates the process with it via `std::process::exit`.
    Ok(exit_code)
}

/// Parsed `maestro fork` arguments.
#[derive(Debug)]
enum ForkRequest {
    Help,
    Fork { session_id: Option<String> },
}

fn parse_fork_args(args: &[std::ffi::OsString]) -> std::result::Result<ForkRequest, String> {
    let mut session_id: Option<String> = None;
    for arg in args {
        let token = arg.to_string_lossy();
        if matches!(token.as_ref(), "help" | "--help" | "-h") {
            return Ok(ForkRequest::Help);
        }
        if token.starts_with('-') {
            return Err(format!("unknown fork flag: {token}"));
        }
        if session_id.is_some() {
            return Err(format!("unexpected extra argument: {token}"));
        }
        session_id = Some(token.into_owned());
    }
    Ok(ForkRequest::Fork { session_id })
}

/// `maestro fork [session-id]`: copy a session JSONL under a new session id
/// and continue it interactively, so a conversation can be branched for
/// what-if experiments. Defaults to the most recent session for the current
/// working directory.
async fn run_fork(args: &[std::ffi::OsString]) -> Result<i32> {
    let session_id = match parse_fork_args(args) {
        Ok(ForkRequest::Help) => {
            println!("Usage: maestro fork [session-id]");
            println!();
            println!("Copy a session (default: most recent for this directory) under a new");
            println!("session id and continue it in the TUI. The fork starts with the full");
            println!("history but records new messages independently of the source session.");
            return Ok(0);
        }
        Ok(ForkRequest::Fork { session_id }) => session_id,
        Err(message) => {
            eprintln!("{message}");
            return Ok(2);
        }
    };

    let cwd = std::env::current_dir()?;
    let manager = crate::session::SessionManager::new(cwd.to_string_lossy().to_string());
    let source = match session_id.as_deref() {
        Some(id) => manager
            .load_session(id)
            .map_err(|err| anyhow::anyhow!("failed to load session {id}: {err}"))?,
        None => manager
            .most_recent_session()?
            .ok_or_else(|| anyhow::anyhow!("no session to fork for {}", cwd.display()))?,
    };
    let forked = crate::session::fork_session_file(std::path::Path::new(&source.file_path))?;

    // Continue with the model that recorded the source session unless the
    // user already pinned one (`spawn_agent` reads MAESTRO_MODEL).
    if std::env::var_os("MAESTRO_MODEL").is_none() && !source.header.model.is_empty() {
        // SAFETY: the agent has not spawned worker threads yet.
        unsafe { std::env::set_var("MAESTRO_MODEL", &source.header.model) };
    }

    println!(
        "Forked session {} -> {} ({})",
        source.header.id,
        forked.id,
        forked.path.display()
    );

    run_interactive_with_shutdown(move || {
        let mut app = App::new_with_initial_prompt(None)?;
        app.resume_session_at_startup(&forked.id);
        Ok(app)
    })
    .await
}

fn raw_option_value(raw_args: &[std::ffi::OsString], names: &[&str]) -> Option<String> {
    for (index, argument) in raw_args.iter().enumerate() {
        let argument = argument.to_string_lossy();
        if names.contains(&argument.as_ref()) {
            return raw_args
                .get(index + 1)
                .map(|value| value.to_string_lossy().into_owned());
        }
        for name in names {
            if let Some(value) = argument.strip_prefix(&format!("{name}=")) {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn configure_agents_api_key(raw_args: &[std::ffi::OsString]) {
    let Some(api_key) = raw_option_value(raw_args, &["--api-key"]) else {
        return;
    };
    let model = raw_option_value(raw_args, &["--model", "-m"]);
    let provider = raw_option_value(raw_args, &["--provider"])
        .unwrap_or_else(|| infer_provider_from_model(model.as_deref().unwrap_or("")).to_string());
    let variable = match provider.as_str() {
        "openai" => "OPENAI_API_KEY",
        "google" => "GOOGLE_API_KEY",
        "xai" => "XAI_API_KEY",
        "groq" => "GROQ_API_KEY",
        "cerebras" => "CEREBRAS_API_KEY",
        "openrouter" => "OPENROUTER_API_KEY",
        "deepseek" => "DEEPSEEK_API_KEY",
        "moonshot" | "kimi" => "MOONSHOT_API_KEY",
        "dashscope" | "qwen" => "DASHSCOPE_API_KEY",
        "minimax" => "MINIMAX_API_KEY",
        "zai" | "zhipu" => "ZAI_API_KEY",
        _ => "ANTHROPIC_API_KEY",
    };
    std::env::set_var(variable, api_key);
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn args_use_maestro_branding() {
        let command = Args::command();
        assert_eq!(command.get_name(), "maestro-tui");
        assert_eq!(
            command.get_about().map(|about| about.to_string()),
            Some("Native terminal interface for Maestro".to_string())
        );
    }

    #[test]
    fn print_flag_parses() {
        use clap::Parser;
        let args = Args::try_parse_from(["maestro-tui", "--print", "--json", "hello"])
            .expect("parse print");
        assert!(args.print);
        assert!(args.json);
        assert_eq!(args.prompt, vec!["hello"]);
    }

    #[test]
    fn worktree_flag_parses() {
        use clap::Parser;
        let args = Args::try_parse_from(["maestro-tui", "--worktree", "feat-x", "do", "it"])
            .expect("parse worktree");
        assert_eq!(args.worktree.as_deref(), Some("feat-x"));
        assert_eq!(args.prompt, vec!["do", "it"]);

        let args = Args::try_parse_from(["maestro-tui", "-w", "feat-x"]).expect("parse -w");
        assert_eq!(args.worktree.as_deref(), Some("feat-x"));

        let args =
            Args::try_parse_from(["maestro-tui", "--worktree=feat-x"]).expect("parse inline");
        assert_eq!(args.worktree.as_deref(), Some("feat-x"));

        // Droid-style: the worktree name is required.
        assert!(Args::try_parse_from(["maestro-tui", "--worktree"]).is_err());
    }

    #[test]
    fn trailing_prompt_args_are_captured() {
        use clap::Parser;
        let args = Args::try_parse_from(["maestro-tui", "--model", "gpt-5.1", "fix", "the", "bug"])
            .expect("parse trailing prompt");
        assert_eq!(args.model.as_deref(), Some("gpt-5.1"));
        assert_eq!(args.prompt, vec!["fix", "the", "bug"]);
        assert_eq!(args.prompt.join(" "), "fix the bug");
    }

    #[test]
    fn fork_args_parse_session_id_and_help() {
        let empty: Vec<std::ffi::OsString> = Vec::new();
        assert!(matches!(
            parse_fork_args(&empty),
            Ok(ForkRequest::Fork { session_id: None })
        ));

        let with_id = [std::ffi::OsString::from("abc123")];
        match parse_fork_args(&with_id) {
            Ok(ForkRequest::Fork { session_id }) => {
                assert_eq!(session_id.as_deref(), Some("abc123"));
            }
            other => panic!("expected fork request, got {other:?}"),
        }

        let help = [std::ffi::OsString::from("--help")];
        assert!(matches!(parse_fork_args(&help), Ok(ForkRequest::Help)));

        let unknown_flag = [std::ffi::OsString::from("--json")];
        assert!(parse_fork_args(&unknown_flag).is_err());

        let extra = [
            std::ffi::OsString::from("abc123"),
            std::ffi::OsString::from("def456"),
        ];
        assert!(parse_fork_args(&extra).is_err());
    }

    #[test]
    fn fork_is_not_dispatched_as_a_utility_command() {
        // `maestro fork` must reach the agent path so it can launch the TUI;
        // utility dispatch exits after running and would never resume.
        let args = ["fork", "abc123"]
            .into_iter()
            .map(std::ffi::OsString::from)
            .collect::<Vec<_>>();
        assert_eq!(native_utility_tokens(&args), None);
    }

    #[test]
    fn native_utility_tokens_forward_command_argv() {
        let args = ["stats", "month", "--json", "--session", "session-1"]
            .into_iter()
            .map(std::ffi::OsString::from)
            .collect::<Vec<_>>();
        assert_eq!(
            native_utility_tokens(&args),
            Some(vec![
                "stats".into(),
                "month".into(),
                "--json".into(),
                "--session".into(),
                "session-1".into(),
            ])
        );
    }

    #[test]
    fn native_utility_tokens_preserve_relevant_global_options() {
        let args = [
            "--profile",
            "local",
            "--provider",
            "openai",
            "models",
            "providers",
        ]
        .into_iter()
        .map(std::ffi::OsString::from)
        .collect::<Vec<_>>();
        assert_eq!(
            native_utility_tokens(&args),
            Some(vec![
                "models".into(),
                "providers".into(),
                "--provider".into(),
                "openai".into(),
            ])
        );
    }

    #[test]
    fn native_utility_tokens_forward_force_before_agents() {
        let args = ["--force", "agents", "init", "/tmp/project"]
            .into_iter()
            .map(std::ffi::OsString::from)
            .collect::<Vec<_>>();

        assert_eq!(
            native_utility_tokens(&args),
            Some(vec![
                "agents".to_string(),
                "init".to_string(),
                "/tmp/project".to_string(),
                "--force".to_string(),
            ])
        );
    }

    #[test]
    fn native_utility_tokens_skip_all_value_taking_cli_globals() {
        for flag in [
            "--output-schema",
            "--output-last-message",
            "--output-dir",
            "--junit",
            "--replay",
            "--record-scenario",
        ] {
            let args = [flag, "ignored-value", "modes", "describe", "high"]
                .into_iter()
                .map(std::ffi::OsString::from)
                .collect::<Vec<_>>();
            assert_eq!(
                native_utility_tokens(&args),
                Some(vec!["modes".into(), "describe".into(), "high".into()]),
                "scanner did not consume {flag}'s value"
            );
        }
    }

    #[test]
    fn native_utility_tokens_dispatch_modes_with_provider() {
        let args = [
            "--provider",
            "openai",
            "modes",
            "describe",
            "high",
            "--json",
        ]
        .into_iter()
        .map(std::ffi::OsString::from)
        .collect::<Vec<_>>();
        assert_eq!(
            native_utility_tokens(&args),
            Some(vec![
                "modes".into(),
                "describe".into(),
                "high".into(),
                "--json".into(),
                "--provider".into(),
                "openai".into(),
            ])
        );
    }

    #[test]
    fn native_utility_tokens_consume_named_worktree_before_modes() {
        let args = ["--worktree", "feature-branch", "modes", "describe", "high"]
            .into_iter()
            .map(std::ffi::OsString::from)
            .collect::<Vec<_>>();
        assert_eq!(
            native_utility_tokens(&args),
            Some(vec!["modes".into(), "describe".into(), "high".into(),])
        );

        let short = ["-w", "feature-branch", "modes", "describe", "high"]
            .into_iter()
            .map(std::ffi::OsString::from)
            .collect::<Vec<_>>();
        assert_eq!(
            native_utility_tokens(&short),
            Some(vec!["modes".into(), "describe".into(), "high".into(),])
        );
    }

    #[test]
    fn native_exec_options_consume_worktree_flag() {
        let args = ["-w", "feat-x", "fix", "the", "bug"].map(std::ffi::OsString::from);
        let options = parse_native_exec_options(&args);
        assert_eq!(options.prompt, "fix the bug");

        let inline = ["--worktree=feat-x", "fix", "the", "bug"].map(std::ffi::OsString::from);
        let options = parse_native_exec_options(&inline);
        assert_eq!(options.prompt, "fix the bug");

        let attached = ["-wfeat-x", "fix", "the", "bug"].map(std::ffi::OsString::from);
        let options = parse_native_exec_options(&attached);
        assert_eq!(options.prompt, "fix the bug");
    }

    #[test]
    fn native_exec_options_accept_prompt_stdin() {
        let args = ["--approval-mode", "fail", "--prompt-stdin"].map(std::ffi::OsString::from);
        let options = parse_native_exec_options(&args);
        assert!(options.prompt_stdin);
        assert!(options.prompt.is_empty());
    }

    #[test]
    fn native_utility_tokens_dispatch_plugins() {
        let args = ["plugins", "list", "--json"]
            .into_iter()
            .map(std::ffi::OsString::from)
            .collect::<Vec<_>>();
        assert_eq!(
            native_utility_tokens(&args),
            Some(vec!["plugins".into(), "list".into(), "--json".into(),])
        );
        let alias = ["plugin", "info", "team-tools"]
            .into_iter()
            .map(std::ffi::OsString::from)
            .collect::<Vec<_>>();
        assert_eq!(
            native_utility_tokens(&alias),
            Some(vec!["plugin".into(), "info".into(), "team-tools".into(),])
        );
    }

    #[test]
    fn native_utility_tokens_do_not_scan_prompt_text() {
        let args = ["write", "a", "models", "command"]
            .into_iter()
            .map(std::ffi::OsString::from)
            .collect::<Vec<_>>();
        assert_eq!(native_utility_tokens(&args), None);
    }

    #[test]
    fn native_profile_accepts_split_and_inline_forms() {
        let split = ["--profile", "local", "skill", "list"]
            .into_iter()
            .map(std::ffi::OsString::from)
            .collect::<Vec<_>>();
        let inline = ["--profile=review", "skill", "list"]
            .into_iter()
            .map(std::ffi::OsString::from)
            .collect::<Vec<_>>();
        assert_eq!(native_profile(&split).as_deref(), Some("local"));
        assert_eq!(native_profile(&inline).as_deref(), Some("review"));
    }

    #[test]
    fn native_profile_uses_config_fallback_but_explicit_profile_wins() {
        let fallback = ["--config", "profile=review", "skill", "list"]
            .into_iter()
            .map(std::ffi::OsString::from)
            .collect::<Vec<_>>();
        let explicit = [
            "--config=profile=review",
            "--profile",
            "release",
            "skill",
            "list",
        ]
        .into_iter()
        .map(std::ffi::OsString::from)
        .collect::<Vec<_>>();
        assert_eq!(native_profile(&fallback).as_deref(), Some("review"));
        assert_eq!(native_profile(&explicit).as_deref(), Some("release"));
    }

    #[test]
    fn native_config_overrides_preserve_all_cli_entries() {
        let args = [
            "--config",
            "profile=review",
            "--config=projects.\"/tmp/repo\".trust_level=trusted",
            "skill",
            "list",
        ]
        .map(std::ffi::OsString::from);
        assert_eq!(
            native_config_overrides(&args),
            [
                "profile=review",
                "projects.\"/tmp/repo\".trust_level=trusted",
            ]
        );
    }

    #[test]
    fn codex_models_infer_openai_provider() {
        assert_eq!(infer_provider_from_model("gpt-5.1-codex-max"), "openai");
        assert_eq!(infer_provider_from_model("codex-mini-latest"), "openai");
    }

    #[test]
    fn chinese_bare_models_infer_direct_provider() {
        assert_eq!(infer_provider_from_model("deepseek-chat"), "deepseek");
        assert_eq!(infer_provider_from_model("kimi-k2.6"), "moonshot");
        assert_eq!(infer_provider_from_model("qwen3-max"), "dashscope");
        assert_eq!(infer_provider_from_model("MiniMax-M2"), "minimax");
        assert_eq!(infer_provider_from_model("glm-4.6"), "zai");
    }

    #[test]
    fn groq_hosted_bare_models_infer_groq() {
        // Key inference must mirror AiProvider::from_model so --api-key writes the
        // env var the actually-selected client reads.
        assert_eq!(
            infer_provider_from_model("deepseek-r1-distill-llama-70b"),
            "groq"
        );
        assert_eq!(infer_provider_from_model("qwen-2.5-coder-32b"), "groq");
        assert_eq!(infer_provider_from_model("llama-3.3-70b-versatile"), "groq");
    }

    #[test]
    fn unknown_models_default_to_openai() {
        assert_eq!(infer_provider_from_model("unknown-model"), "openai");
        assert_eq!(infer_provider_from_model(""), "openai");
    }

    #[test]
    fn native_exec_consumes_compatibility_option_values() {
        let args = [
            "--full-auto",
            "--sandbox",
            "docker",
            "--approval-mode",
            "fail",
            "--provider",
            "openai-codex",
            "--api-key",
            "secret",
            "--config",
            "profile=sandbox",
            "--profile=review",
            "--json",
            "fix the issue",
        ]
        .map(std::ffi::OsString::from);
        let options = parse_native_exec_options(&args);
        assert_eq!(options.sandbox.as_deref(), Some("docker"));
        assert_eq!(options.approval_mode.as_deref(), Some("fail"));
        assert_eq!(options.provider.as_deref(), Some("openai-codex"));
        assert_eq!(options.api_key.as_deref(), Some("secret"));
        assert!(options.json);
        assert_eq!(options.prompt, "fix the issue");
        assert!(native_exec_sandbox_policy(Some("docker")).is_err());
        assert!(matches!(
            native_exec_sandbox_policy(Some("workspace-write")),
            Ok(Some(SandboxPolicy::WorkspaceWrite { .. }))
        ));
        assert_eq!(
            native_exec_model(Some("anthropic"), None).as_deref(),
            Some("anthropic/claude-sonnet-4-6")
        );
        assert_eq!(
            native_exec_model(Some("evalops"), Some("gpt-4o-mini")).as_deref(),
            Some("evalops/gpt-4o-mini")
        );
    }
}
