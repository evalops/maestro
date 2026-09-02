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
//! - **HTTP transport**: Connect to Streamable HTTP MCP endpoints, with legacy
//!   `/message` compatibility
//! - **SSE transport**: Server-Sent Events for streaming responses
//!
//! # Configuration
//!
//! MCP servers are configured via JSON files with precedence:
//!
//! 1. Enterprise: `~/.composer/enterprise/mcp.json`
//! 2. Project: `.maestro/mcp.json` (legacy `.composer` also supported)
//! 3. Local: `.maestro/mcp.local.json` (git-ignored)
//! 4. User: `~/.maestro/mcp.json` (legacy `.composer` also supported)
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

mod auth;
mod client;
mod config;
mod http;
mod prompt_formatting;
pub mod protocol;

pub(crate) use client::McpApiCapabilities;
pub use client::{ManagedMcpPolicy, McpClient, McpConnection, McpError, McpRuntimeEvent};
pub(crate) use config::effective_user_config_path;
pub use config::{
    McpConfig, McpConfigScope, McpServerConfig, McpTransport, append_managed_mcp_connections,
    expand_env_vars_for_scope, load_mcp_config, load_mcp_config_with_managed_connections,
    server_requires_workspace_approval,
};
pub use prompt_formatting::append_mcp_prompt_summary;
pub use protocol::{
    MAX_MCP_TOOL_RESULT_BYTES, McpContent, McpPrompt, McpPromptArgument, McpPromptContent,
    McpPromptMessage, McpRequest, McpResponse, McpTool, McpToolAnnotations, McpToolFingerprint,
    McpToolResult, PromptGetResult, PromptsListResult,
};
