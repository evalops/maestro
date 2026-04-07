//! Model Context Protocol (MCP) Client
//!
//! This module implements a client for the Model Context Protocol, enabling
//! the agent to communicate with external MCP servers that provide additional
//! tools and capabilities.
//!
//! # Overview
//!
//! MCP servers extend the agent with custom tools, prompts, and resources.
//! This implementation supports:
//!
//! - **Stdio transport**: Spawn a subprocess and communicate via stdin/stdout
//! - **HTTP transport**: Connect to HTTP-based MCP servers
//! - **SSE transport**: Server-Sent Events for streaming responses
//!
//! # Configuration
//!
//! MCP servers are configured via JSON files with precedence:
//!
//! 1. Enterprise: `~/.composer/enterprise/mcp.json`
//! 2. Project: `.composer/mcp.json`
//! 3. Local: `.composer/mcp.local.json` (git-ignored)
//! 4. User: `~/.composer/mcp.json`
//!
//! # Example Configuration
//!
//! ```json
//! {
//!   "servers": [
//!     {
//!       "name": "my-server",
//!       "transport": "stdio",
//!       "command": "node",
//!       "args": ["path/to/server.js"],
//!       "env": { "API_KEY": "..." }
//!     }
//!   ]
//! }
//! ```
//!
//! # Example Usage
//!
//! ```rust,ignore
//! use maestro_tui::mcp::{McpClient, McpConfig, McpServerConfig};
//!
//! // Load configuration
//! let config = McpConfig::load("/path/to/project")?;
//!
//! // Connect to servers
//! let mut client = McpClient::new();
//! for server in config.servers {
//!     client.connect(server).await?;
//! }
//!
//! // List available tools
//! let tools = client.list_tools().await?;
//!
//! // Call a tool
//! let result = client.call_tool("my-server", "tool_name", args).await?;
//! ```

mod client;
mod config;
mod http;
mod prompt_formatting;
pub mod protocol;

pub use client::{McpClient, McpConnection, McpError, McpRuntimeEvent};
pub use config::{load_mcp_config, McpConfig, McpConfigScope, McpServerConfig, McpTransport};
pub use prompt_formatting::append_mcp_prompt_summary;
pub use protocol::{
    McpContent, McpPrompt, McpPromptArgument, McpPromptContent, McpPromptMessage, McpRequest,
    McpResponse, McpTool, McpToolAnnotations, McpToolResult, PromptGetResult, PromptsListResult,
};
