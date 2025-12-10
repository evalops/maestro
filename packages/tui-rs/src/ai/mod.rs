//! AI Client Module
//!
//! This module provides a unified abstraction for communicating with multiple AI providers
//! (Anthropic's Claude API and OpenAI's GPT API). It handles streaming responses, SSE parsing,
//! and provides a common interface regardless of the underlying provider.
//!
//! # Architecture
//!
//! The module uses a trait-based design for polymorphism:
//!
//! - `AiClient` trait: Defines the common interface that all AI providers must implement
//! - `AnthropicClient`: Implementation for Anthropic's Claude API
//! - `OpenAiClient`: Implementation for OpenAI's GPT API (supports both Chat Completions and Responses APIs)
//! - `UnifiedClient`: Enum-based wrapper that can hold either provider
//!
//! # Rust Concepts Used
//!
//! ## Trait Objects and Dynamic Dispatch
//!
//! The `AiClient` trait allows us to write code that works with any AI provider:
//!
//! ```rust,ignore
//! pub trait AiClient: Send + Sync {
//!     async fn stream(&self, messages: &[Message], config: &RequestConfig)
//!         -> Result<mpsc::UnboundedReceiver<StreamEvent>>;
//! }
//! ```
//!
//! This uses dynamic dispatch when you use `dyn AiClient`, allowing runtime polymorphism.
//! However, we primarily use the `UnifiedClient` enum for zero-cost static dispatch.
//!
//! ## Async Streaming with Tokio
//!
//! All API communication is async using tokio:
//!
//! - `async fn`: Functions that return futures and can be awaited
//! - `mpsc::UnboundedReceiver`: Channel for streaming events from spawned tasks
//! - `tokio::spawn`: Spawn background tasks to handle SSE streams
//!
//! ## Serde for JSON Serialization
//!
//! The `serde` crate handles JSON serialization/deserialization:
//!
//! - `#[derive(Serialize, Deserialize)]`: Auto-generate JSON conversion code
//! - `#[serde(tag = "type")]`: Tagged enums for JSON variant discrimination
//! - `#[serde(rename_all = "snake_case")]`: Field name conversion
//!
//! ## Error Handling
//!
//! Uses `anyhow::Result` for ergonomic error propagation:
//!
//! - `?` operator: Propagate errors up the call stack
//! - `.context("message")`: Add context to errors for better debugging
//!
//! # Example Usage
//!
//! ```rust,ignore
//! use composer_tui::ai::{create_client_for_model, Message, RequestConfig};
//!
//! // Create a client based on model name
//! let client = create_client_for_model("claude-opus-4-5")?;
//!
//! // Build request
//! let messages = vec![Message::user("Hello!")];
//! let config = RequestConfig::new("claude-opus-4-5", 4096);
//!
//! // Stream response
//! let mut rx = client.stream(&messages, &config).await?;
//! while let Some(event) = rx.recv().await {
//!     match event {
//!         StreamEvent::TextDelta { text, .. } => print!("{}", text),
//!         StreamEvent::MessageStop => break,
//!         _ => {}
//!     }
//! }
//! ```

mod anthropic;
mod client;
mod openai;
mod transform;
mod types;

pub use anthropic::AnthropicClient;
pub use client::{create_client, create_client_for_model, AiClient, AiProvider, UnifiedClient};
pub use openai::OpenAiClient;
pub use transform::{transform_messages, transform_messages_full};
pub use types::*;
