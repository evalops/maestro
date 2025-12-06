//! AI client module
//!
//! Handles communication with AI providers (Anthropic, OpenAI).

mod anthropic;
mod client;
mod openai;
mod types;

pub use anthropic::AnthropicClient;
pub use client::{create_client, create_client_for_model, AiClient, AiProvider, UnifiedClient};
pub use openai::OpenAiClient;
pub use types::*;
