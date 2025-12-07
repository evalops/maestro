//! Composer TUI - Native terminal interface
//!
//! This is the main entry point for the Composer CLI.
//! The Rust binary owns the terminal and spawns a Node.js
//! subprocess for agent logic.
//!
//! ## Usage
//!
//! ```bash
//! composer-tui [options] [prompt]
//! ```

use anyhow::Result;
use clap::Parser;
use composer_tui::App;

/// Infer provider from model name
fn infer_provider_from_model(model: &str) -> &'static str {
    let model_lower = model.to_lowercase();

    // OpenAI models
    if model_lower.starts_with("gpt")
        || model_lower.starts_with("o1")
        || model_lower.starts_with("o3")
        || model_lower.contains("codex")
        || model_lower.starts_with("text-")
        || model_lower.starts_with("davinci")
    {
        return "openai";
    }

    // Anthropic models
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

    // Groq models (llama, mixtral hosted on Groq)
    if model_lower.contains("groq") {
        return "groq";
    }

    // Cerebras models
    if model_lower.contains("cerebras") {
        return "cerebras";
    }

    // OpenRouter (uses / in model name like "anthropic/claude-3")
    if model_lower.contains('/') {
        return "openrouter";
    }

    // Default to Anthropic
    "anthropic"
}

/// Native Composer TUI
#[derive(Parser, Debug)]
#[command(name = "composer-tui")]
#[command(about = "Native terminal interface for Composer")]
struct Args {
    /// Provider to use (e.g., anthropic, openai)
    #[arg(long)]
    provider: Option<String>,

    /// Model to use
    #[arg(short, long)]
    model: Option<String>,

    /// API key
    #[arg(long)]
    api_key: Option<String>,

    /// Continue previous session
    #[arg(short, long)]
    r#continue: bool,

    /// Resume session selector
    #[arg(short, long)]
    resume: bool,

    /// Initial prompt
    #[arg(trailing_var_arg = true)]
    prompt: Vec<String>,
}

impl Args {
    /// Convert to arguments for the Node.js agent
    fn to_agent_args(&self) -> Vec<String> {
        let mut args = Vec::new();

        if let Some(provider) = &self.provider {
            args.push("--provider".to_string());
            args.push(provider.clone());
        }

        if let Some(model) = &self.model {
            args.push("--model".to_string());
            args.push(model.clone());
        }

        if let Some(api_key) = &self.api_key {
            args.push("--api-key".to_string());
            args.push(api_key.clone());
        }

        if self.r#continue {
            args.push("--continue".to_string());
        }

        if self.resume {
            args.push("--resume".to_string());
        }

        args
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let agent_args = args.to_agent_args();

    // Set API key from CLI if provided (for native agent)
    if let Some(api_key) = &args.api_key {
        // Determine provider from explicit flag or model name
        let provider = args.provider.as_deref().unwrap_or_else(|| {
            // Infer provider from model name
            if let Some(model) = &args.model {
                infer_provider_from_model(model)
            } else {
                "anthropic"
            }
        });

        match provider {
            "openai" => std::env::set_var("OPENAI_API_KEY", api_key),
            "google" => std::env::set_var("GOOGLE_API_KEY", api_key),
            "xai" => std::env::set_var("XAI_API_KEY", api_key),
            "groq" => std::env::set_var("GROQ_API_KEY", api_key),
            "cerebras" => std::env::set_var("CEREBRAS_API_KEY", api_key),
            "openrouter" => std::env::set_var("OPENROUTER_API_KEY", api_key),
            _ => std::env::set_var("ANTHROPIC_API_KEY", api_key),
        }
    }

    // Set model from CLI if provided
    if let Some(model) = &args.model {
        std::env::set_var("COMPOSER_MODEL", model);
    }

    // Create and run the application
    let app = App::with_args(agent_args)?;
    let exit_code = app.run().await?;

    std::process::exit(exit_code);
}
