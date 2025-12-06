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
        if let Some(provider) = &args.provider {
            match provider.as_str() {
                "openai" => std::env::set_var("OPENAI_API_KEY", api_key),
                "anthropic" | _ => std::env::set_var("ANTHROPIC_API_KEY", api_key),
            }
        } else {
            // Default to Anthropic
            std::env::set_var("ANTHROPIC_API_KEY", api_key);
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
