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

use anyhow::Result;
// `anyhow::Result` is a convenient error type that can hold any error.
// It's shorthand for `Result<T, anyhow::Error>` and is great for applications
// (as opposed to libraries) because it simplifies error handling.

use clap::Parser;
// `clap` is the standard CLI argument parsing library in Rust.
// The `Parser` trait enables derive macros to auto-generate argument parsing.

use maestro_tui::App;
// Import our main `App` struct from the library crate.
// In Rust, a package can have both a binary (main.rs) and a library (lib.rs).
// This imports from lib.rs.

use maestro_tui::tools::cleanup_background_processes;
// Import the process cleanup function for signal handlers.

use maestro_tui::hosted_runner_cli::run_hosted_runner_cli_from_env;

// ─────────────────────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

const NATIVE_UTILITY_COMMANDS: [&str; 17] = [
    "sessions",
    "cost",
    "stats",
    "models",
    "status",
    "hooks",
    "export",
    "import",
    "update",
    "skill",
    "modes",
    "agents",
    "painter",
    "anthropic",
    "memory",
    "init",
    "openai",
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

fn native_utility_tokens(raw_args: &[std::ffi::OsString]) -> Option<Vec<String>> {
    let mut forwarded_prefix = Vec::new();
    let mut index = 0;
    while index < raw_args.len() {
        let token = raw_args[index].to_string_lossy();
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
        if token == "--worktree" {
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
/// * `model` - The model name to analyze (for example, "gpt-5.1-codex-max")
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
///
/// # Rust Concepts Used
///
/// - **Derive Macros**: `#[derive(Parser, Debug)]` automatically generates code.
///   `Parser` generates CLI parsing logic, `Debug` enables `{:?}` formatting.
///
/// - **Attributes**: `#[command(...)]` and `#[arg(...)]` are attributes that
///   provide metadata to the derive macro about how to parse arguments.
///
/// - **`Option<T>`**: Rust's way of representing optional values. Unlike null
///   in other languages, you must explicitly handle the None case. This prevents
///   null pointer exceptions at compile time.
///
/// - **Raw Identifiers**: `r#continue` uses `r#` prefix because `continue` is
///   a reserved keyword in Rust. This lets us use it as an identifier anyway.
#[derive(Parser, Debug)]
#[command(name = "maestro-tui")]
#[command(about = "Native terminal interface for Maestro")]
struct Args {
    /// Provider to use (for example, openai).
    /// When None, we infer from the model name.
    #[arg(long)]
    provider: Option<String>,

    /// Model to use (for example, gpt-5.1-codex-max).
    /// `-m` is the short flag, `--model` is the long flag.
    #[arg(short, long)]
    model: Option<String>,

    /// API key for authentication.
    /// If not provided, falls back to environment variables.
    #[arg(long)]
    api_key: Option<String>,

    /// Continue the previous session.
    /// `r#continue` uses raw identifier syntax because `continue` is a keyword.
    #[arg(short, long)]
    r#continue: bool,

    /// Open the session resume selector.
    #[arg(short, long)]
    resume: bool,

    /// Create or reuse a git worktree for this session (Grok-style isolation).
    ///
    /// - `--worktree` uses an auto name (`maestro-<timestamp>`)
    /// - `--worktree=feat-x` uses/creates that worktree name under
    ///   `<repo>/.maestro/worktrees/<name>`
    #[arg(long, num_args = 0..=1, default_missing_value = "")]
    worktree: Option<String>,

    /// Non-interactive print mode (Grok-style single-shot). Prints the answer and exits.
    #[arg(long, short = 'p')]
    print: bool,

    /// With `--print`, emit simple JSONL events instead of plain text.
    #[arg(long)]
    json: bool,

    /// Run as native headless protocol server on stdio (replaces TS headless agent).
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
    /// `trailing_var_arg = true` means all positional args after flags go here.
    #[arg(trailing_var_arg = true)]
    prompt: Vec<String>,
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
#[tokio::main]
async fn main() -> Result<()> {
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

    let raw_args = std::env::args_os().collect::<Vec<_>>();
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
        // SAFETY: this process has not started worker threads yet. The profile is
        // converted to the same environment contract used by Rust config loading.
        unsafe { std::env::set_var("MAESTRO_PROFILE", profile) };
    }
    let config_overrides = native_config_overrides(&raw_args[1..]);
    if !config_overrides.is_empty() {
        // SAFETY: utility dispatch occurs before worker threads are started.
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
            let outcome = match maestro_tui::agents_cli::run(&tokens[1..]) {
                Ok(outcome) => outcome,
                Err(error) => {
                    eprintln!("{error:#}");
                    std::process::exit(1);
                }
            };
            match outcome {
                maestro_tui::agents_cli::Outcome::Exit(code) => std::process::exit(code),
                maestro_tui::agents_cli::Outcome::Generate { prompt, target } => {
                    let cwd = std::env::current_dir()?;
                    let display = target
                        .strip_prefix(&cwd)
                        .map(|relative| format!("./{}", relative.display()))
                        .unwrap_or_else(|_| target.display().to_string());
                    println!("Drafting AGENTS.md at {display}...");
                    let model = raw_option_value(&raw_args[1..], &["--model", "-m"]);
                    let code = maestro_tui::print_mode::run_print_mode(
                        maestro_tui::print_mode::PrintModeOptions {
                            prompt,
                            json: false,
                            model,
                            output_last_message: None,
                            output_schema: None,
                        },
                    )
                    .await?;
                    std::process::exit(code);
                }
            }
        }
        match maestro_tui::cli_commands::run_cli_command(&tokens).await {
            Ok(code) => std::process::exit(code),
            Err(err) => {
                eprintln!("{err:#}");
                std::process::exit(1);
            }
        }
    }

    if let Some(cmd) = raw_args.get(1).and_then(|a| a.to_str()) {
        if cmd == "headless" || cmd == "rpc" {
            let code = maestro_tui::headless_server::run_headless_server().await?;
            std::process::exit(code);
        }
        if cmd == "print" || cmd == "exec" {
            // maestro-tui print|exec [--json] [--model X] [--output-last-message P]
            //   [--output-schema S] <prompt...>
            let mut json = false;
            let mut model = None;
            let mut output_last = None;
            let mut output_schema = None;
            let mut prompt_parts = Vec::new();
            let mut i = 2usize;
            while i < raw_args.len() {
                let a = raw_args[i].to_string_lossy();
                if a == "--json" {
                    json = true;
                } else if a == "--model" || a == "-m" {
                    i += 1;
                    if i < raw_args.len() {
                        model = Some(raw_args[i].to_string_lossy().into_owned());
                    }
                } else if a.starts_with("--model=") {
                    model = Some(a.trim_start_matches("--model=").to_string());
                } else if a == "--output-last-message" {
                    i += 1;
                    if i < raw_args.len() {
                        output_last = Some(std::path::PathBuf::from(
                            raw_args[i].to_string_lossy().as_ref(),
                        ));
                    }
                } else if let Some(rest) = a.strip_prefix("--output-last-message=") {
                    output_last = Some(std::path::PathBuf::from(rest));
                } else if a == "--output-schema" {
                    i += 1;
                    if i < raw_args.len() {
                        output_schema = Some(raw_args[i].to_string_lossy().into_owned());
                    }
                } else if let Some(rest) = a.strip_prefix("--output-schema=") {
                    output_schema = Some(rest.to_string());
                } else if a == "--" {
                    // rest is prompt
                } else if !a.starts_with('-') {
                    prompt_parts.push(a.into_owned());
                }
                i += 1;
            }
            let prompt = prompt_parts.join(" ");
            if prompt.is_empty() {
                eprintln!(
                    "Usage: maestro-tui {cmd} [--json] [--model <id>] [--output-last-message <path>] [--output-schema <path|json>] <prompt>"
                );
                std::process::exit(2);
            }
            let code = maestro_tui::print_mode::run_print_mode(
                maestro_tui::print_mode::PrintModeOptions {
                    prompt,
                    json,
                    model,
                    output_last_message: output_last,
                    output_schema,
                },
            )
            .await?;
            std::process::exit(code);
        }
    }

    // Parse command-line arguments using clap.
    // `Args::parse()` reads from std::env::args() and returns our Args struct.
    // If parsing fails (e.g., unknown flag), clap prints help and exits.
    let args = Args::parse();

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
        match provider {
            "openai" => std::env::set_var("OPENAI_API_KEY", api_key),
            "google" => std::env::set_var("GOOGLE_API_KEY", api_key),
            "xai" => std::env::set_var("XAI_API_KEY", api_key),
            "groq" => std::env::set_var("GROQ_API_KEY", api_key),
            "cerebras" => std::env::set_var("CEREBRAS_API_KEY", api_key),
            "openrouter" => std::env::set_var("OPENROUTER_API_KEY", api_key),
            "deepseek" => std::env::set_var("DEEPSEEK_API_KEY", api_key),
            "moonshot" | "kimi" => std::env::set_var("MOONSHOT_API_KEY", api_key),
            "dashscope" | "qwen" => std::env::set_var("DASHSCOPE_API_KEY", api_key),
            "minimax" => std::env::set_var("MINIMAX_API_KEY", api_key),
            "zai" | "zhipu" => std::env::set_var("ZAI_API_KEY", api_key),
            // `_` matches anything not explicitly handled above
            _ => std::env::set_var("ANTHROPIC_API_KEY", api_key),
        }
    }

    // Set model from CLI if provided.
    // This environment variable is read by the App during initialization.
    if let Some(model) = &args.model {
        std::env::set_var("MAESTRO_MODEL", model);
    }

    // Optional git worktree isolation before the TUI starts.
    if let Some(name) = args.worktree.as_ref() {
        match setup_worktree(name) {
            Ok(path) => {
                if let Err(err) = std::env::set_current_dir(&path) {
                    eprintln!("Failed to enter worktree {}: {err}", path.display());
                    std::process::exit(1);
                }
                eprintln!("Using worktree: {}", path.display());
            }
            Err(err) => {
                eprintln!("Worktree setup failed: {err}");
                std::process::exit(1);
            }
        }
    }

    // Trailing positional args become the initial prompt (Grok-style).
    let initial_prompt = if args.prompt.is_empty() {
        None
    } else {
        Some(args.prompt.join(" "))
    };

    // Native headless/RPC server (kills TS agent path for these modes)
    if args.headless || args.rpc {
        let code = maestro_tui::headless_server::run_headless_server().await?;
        std::process::exit(code);
    }

    // Non-interactive print mode (single-shot / exec bridge)
    if args.print {
        let prompt = initial_prompt.unwrap_or_default();
        if prompt.is_empty() {
            eprintln!("--print requires a prompt");
            std::process::exit(2);
        }
        let code =
            maestro_tui::print_mode::run_print_mode(maestro_tui::print_mode::PrintModeOptions {
                prompt,
                json: args.json,
                model: args.model.clone(),
                output_last_message: args
                    .output_last_message
                    .as_ref()
                    .map(std::path::PathBuf::from),
                output_schema: args.output_schema.clone(),
            })
            .await?;
        std::process::exit(code);
    }

    let app = App::new_with_initial_prompt(initial_prompt)?;

    // Run the application's main loop.
    //
    // `.await` suspends this function until the Future completes.
    // The app handles all user interaction, AI communication, and rendering.
    let exit_code = app.run().await?;

    // Final cleanup - the app should have already cleaned up, but this is a safety net.
    // This catches cases where the app returned without going through its normal exit path.
    let remaining = cleanup_background_processes();
    if remaining > 0 {
        eprintln!("[main] Final cleanup: {remaining} background process(es)");
    }

    // Exit with the appropriate code.
    //
    // `std::process::exit` terminates the process immediately.
    // We use this instead of returning because we need to pass the exit code
    // to the shell. This function never returns (it's marked `-> !`).
    std::process::exit(exit_code);
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

/// Create or reuse a git worktree for isolated work.
///
/// Empty name → auto `maestro-<unix_secs>`.
fn setup_worktree(name: &str) -> anyhow::Result<std::path::PathBuf> {
    use std::process::Command;

    let cwd = std::env::current_dir()?;
    // Ensure we're inside a git repo
    let root_out = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(&cwd)
        .output()?;
    if !root_out.status.success() {
        anyhow::bail!("--worktree requires a git repository");
    }
    let repo_root = std::path::PathBuf::from(String::from_utf8_lossy(&root_out.stdout).trim());

    let branch_name = if name.trim().is_empty() {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        format!("maestro-{secs}")
    } else {
        name.trim().replace('/', "-")
    };

    let worktrees_root = repo_root.join(".maestro").join("worktrees");
    std::fs::create_dir_all(&worktrees_root)?;
    let worktree_path = worktrees_root.join(&branch_name);

    if worktree_path.exists() {
        return Ok(worktree_path);
    }

    // Prefer creating a new branch worktree from HEAD.
    let status = Command::new("git")
        .args([
            "worktree",
            "add",
            "-b",
            &branch_name,
            worktree_path.to_str().unwrap_or("."),
            "HEAD",
        ])
        .current_dir(&repo_root)
        .status()?;
    if !status.success() {
        // Branch may already exist — try without -b
        let status = Command::new("git")
            .args([
                "worktree",
                "add",
                worktree_path.to_str().unwrap_or("."),
                &branch_name,
            ])
            .current_dir(&repo_root)
            .status()?;
        if !status.success() {
            anyhow::bail!(
                "git worktree add failed for '{branch_name}' (is git available? does the branch exist?)"
            );
        }
    }

    Ok(worktree_path)
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

        let args =
            Args::try_parse_from(["maestro-tui", "--worktree"]).expect("parse bare worktree");
        assert_eq!(args.worktree.as_deref(), Some(""));
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
    fn hosted_runner_subcommand_is_reserved_before_prompt_capture() {
        let raw_args = [
            std::ffi::OsString::from("maestro-tui"),
            std::ffi::OsString::from("hosted-runner"),
            std::ffi::OsString::from("--runner-session-id"),
            std::ffi::OsString::from("mrs_test"),
        ];
        assert_eq!(
            raw_args.get(1).and_then(|arg| arg.to_str()),
            Some("hosted-runner")
        );
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
}
