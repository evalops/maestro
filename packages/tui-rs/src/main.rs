//! # Composer TUI - Native Terminal Interface
//!
//! This is the main entry point for the Composer CLI application.
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
//! composer-tui [options] [prompt]
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

use composer_tui::App;
// Import our main `App` struct from the library crate.
// In Rust, a package can have both a binary (main.rs) and a library (lib.rs).
// This imports from lib.rs.

use composer_tui::tools::cleanup_background_processes;
// Import the process cleanup function for signal handlers.

// ─────────────────────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

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
/// * `model` - The model name to analyze (e.g., "gpt-4", "claude-3-opus")
///
/// # Returns
///
/// A static string identifying the provider (e.g., "openai", "anthropic")
fn infer_provider_from_model(model: &str) -> &'static str {
    // Convert to lowercase for case-insensitive matching.
    // Note: This allocates a new String on the heap.
    let model_lower = model.to_lowercase();

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

    // Groq models (they host llama, mixtral, etc.)
    if model_lower.contains("groq") {
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

    // Default to Anthropic if we can't identify the provider
    // Note: No semicolon here - this is the implicit return value
    "anthropic"
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI ARGUMENTS DEFINITION
// ─────────────────────────────────────────────────────────────────────────────

/// Command-line arguments for the Composer TUI.
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
#[command(name = "composer-tui")]
#[command(about = "Native terminal interface for Composer")]
struct Args {
    /// Provider to use (e.g., anthropic, openai).
    /// When None, we infer from the model name.
    #[arg(long)]
    provider: Option<String>,

    /// Model to use (e.g., claude-3-opus, gpt-4).
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
/// - **Error Propagation with `?`**: When you see `foo()?`, it means "if foo()
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
            eprintln!("[panic] Cleaned up {} background process(es)", count);
        }
        // Call the default panic hook to print the panic message
        default_hook(panic_info);
    }));

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
                "anthropic"
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
            // `_` matches anything not explicitly handled above
            _ => std::env::set_var("ANTHROPIC_API_KEY", api_key),
        }
    }

    // Set model from CLI if provided.
    // This environment variable is read by the App during initialization.
    if let Some(model) = &args.model {
        std::env::set_var("COMPOSER_MODEL", model);
    }

    // Create the application instance.
    //
    // `App::new()` returns `Result<App>`. The `?` operator unwraps the Ok
    // value or returns the error from main() if it failed.
    let app = App::new()?;

    // Run the application's main loop.
    //
    // `.await` suspends this function until the Future completes.
    // The app handles all user interaction, AI communication, and rendering.
    let exit_code = app.run().await?;

    // Final cleanup - the app should have already cleaned up, but this is a safety net.
    // This catches cases where the app returned without going through its normal exit path.
    let remaining = cleanup_background_processes();
    if remaining > 0 {
        eprintln!("[main] Final cleanup: {} background process(es)", remaining);
    }

    // Exit with the appropriate code.
    //
    // `std::process::exit` terminates the process immediately.
    // We use this instead of returning because we need to pass the exit code
    // to the shell. This function never returns (it's marked `-> !`).
    std::process::exit(exit_code);
}
