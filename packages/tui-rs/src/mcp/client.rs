//! MCP Client Implementation
//!
//! This module provides the client for communicating with MCP servers.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex, RwLock};

use super::config::{expand_env_vars, McpServerConfig, McpTransport};
use super::http::HttpConnection;
use super::protocol::{
    ClientInfo, InitializeResult, McpRequest, McpResponse, McpTool, McpToolResult, ToolsListResult,
};

/// Error type for MCP operations
#[derive(Debug, thiserror::Error)]
pub enum McpError {
    /// Server not found
    #[error("MCP server not found: {0}")]
    ServerNotFound(String),

    /// Connection failed
    #[error("Failed to connect to MCP server: {0}")]
    ConnectionFailed(String),

    /// Request failed
    #[error("MCP request failed: {0}")]
    RequestFailed(String),

    /// Tool not found
    #[error("Tool not found: {0}")]
    ToolNotFound(String),

    /// Timeout
    #[error("MCP operation timed out")]
    Timeout,

    /// Protocol error
    #[error("Protocol error: {0}")]
    Protocol(String),

    /// IO error
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    /// JSON error
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

/// Connection backend type
enum ConnectionBackend {
    /// Stdio subprocess
    Stdio {
        process: Child,
        stdin: tokio::process::ChildStdin,
        response_rx: mpsc::UnboundedReceiver<McpResponse>,
    },
    /// HTTP/SSE connection
    Http(HttpConnection),
}

/// Connection to a single MCP server
pub struct McpConnection {
    /// Server name
    name: String,
    /// Server configuration
    config: McpServerConfig,
    /// Connection backend
    backend: Option<ConnectionBackend>,
    /// Request ID counter (for stdio)
    next_id: AtomicU64,
    /// Pending requests (for stdio)
    pending: Arc<Mutex<HashMap<u64, tokio::sync::oneshot::Sender<McpResponse>>>>,
    /// Available tools
    tools: Vec<McpTool>,
    /// Whether initialized
    initialized: bool,

    /// Whether a reconnect is currently in progress
    ///
    /// Used to avoid overlapping reconnect attempts.
    reconnecting: bool,
}

impl McpConnection {
    /// Create a new connection (not yet connected)
    pub fn new(config: McpServerConfig) -> Self {
        Self {
            name: config.name.clone(),
            config,
            backend: None,
            next_id: AtomicU64::new(1),
            pending: Arc::new(Mutex::new(HashMap::new())),
            tools: Vec::new(),
            initialized: false,
            reconnecting: false,
        }
    }

    /// Get the server name
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Connect to the MCP server
    pub async fn connect(&mut self) -> Result<(), McpError> {
        match self.config.transport {
            McpTransport::Stdio => self.connect_stdio().await,
            McpTransport::Http | McpTransport::Sse => self.connect_http().await,
        }
    }

    /// Connect via HTTP/SSE transport
    async fn connect_http(&mut self) -> Result<(), McpError> {
        let mut http_conn = HttpConnection::new(self.config.clone())?;
        http_conn.connect().await?;

        // Copy tools from HTTP connection
        self.tools = http_conn.tools().to_vec();
        self.initialized = true;
        self.backend = Some(ConnectionBackend::Http(http_conn));

        Ok(())
    }

    /// Connect via stdio transport
    async fn connect_stdio(&mut self) -> Result<(), McpError> {
        let command = self.config.command.as_ref().ok_or_else(|| {
            McpError::ConnectionFailed("No command specified for stdio transport".to_string())
        })?;

        // Expand environment variables in command and args
        let command = expand_env_vars(command);
        let args: Vec<String> = self
            .config
            .args
            .iter()
            .map(|a| expand_env_vars(a))
            .collect();

        // Build command
        let mut cmd = Command::new(&command);
        cmd.args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

        // Set working directory
        if let Some(cwd) = &self.config.cwd {
            cmd.current_dir(expand_env_vars(cwd));
        }

        // Set environment variables (expand values)
        for (key, value) in &self.config.env {
            cmd.env(key, expand_env_vars(value));
        }

        // Don't inherit all env vars for security (only essential ones)
        cmd.env_clear();
        for key in ["PATH", "HOME", "USER", "SHELL", "TERM"] {
            if let Ok(value) = std::env::var(key) {
                cmd.env(key, value);
            }
        }
        // Re-add configured env vars after clearing
        for (key, value) in &self.config.env {
            cmd.env(key, expand_env_vars(value));
        }

        // Spawn the process
        let mut child = cmd.spawn().map_err(|e| {
            McpError::ConnectionFailed(format!("Failed to spawn {}: {}", command, e))
        })?;

        // Take stdin/stdout
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| McpError::ConnectionFailed("Failed to get stdin".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| McpError::ConnectionFailed("Failed to get stdout".to_string()))?;

        // Set up response reader
        let (response_tx, response_rx) = mpsc::unbounded_channel();
        let pending = self.pending.clone();

        // Spawn stdout reader task
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();

            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => break, // EOF
                    Ok(_) => {
                        if let Ok(response) = serde_json::from_str::<McpResponse>(&line) {
                            // Try to send to pending request
                            if let Some(id) = response.id {
                                let mut pending = pending.lock().await;
                                if let Some(sender) = pending.remove(&id) {
                                    let _ = sender.send(response);
                                    continue;
                                }
                            }
                            // Otherwise send to general receiver
                            let _ = response_tx.send(response);
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        self.backend = Some(ConnectionBackend::Stdio {
            process: child,
            stdin,
            response_rx,
        });

        // Initialize the connection
        self.initialize().await?;

        Ok(())
    }

    /// Initialize the MCP connection
    async fn initialize(&mut self) -> Result<(), McpError> {
        let request = McpRequest::initialize(self.next_id(), &ClientInfo::default());
        let response = self.send_request(request).await?;

        let _init_result: InitializeResult = response
            .result_as()
            .map_err(|e| McpError::Protocol(format!("Invalid initialize response: {}", e)))?;

        // Send initialized notification
        let notification = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        });
        self.send_raw(&notification).await?;

        // List available tools
        self.refresh_tools().await?;

        self.initialized = true;
        Ok(())
    }

    /// Refresh the list of available tools
    pub async fn refresh_tools(&mut self) -> Result<(), McpError> {
        let request = McpRequest::list_tools(self.next_id());
        let response = self.send_request(request).await?;

        let tools_result: ToolsListResult = response
            .result_as()
            .map_err(|e| McpError::Protocol(format!("Invalid tools/list response: {}", e)))?;

        self.tools = tools_result.tools;
        Ok(())
    }

    /// Get available tools
    pub fn tools(&self) -> &[McpTool] {
        &self.tools
    }

    /// Call a tool
    pub async fn call_tool(
        &mut self,
        tool_name: &str,
        arguments: serde_json::Value,
    ) -> Result<McpToolResult, McpError> {
        // Ensure stdio transport is alive before using cached tools list.
        self.ensure_stdio_connected().await?;

        // Verify tool exists
        if !self.tools.iter().any(|t| t.name == tool_name) {
            return Err(McpError::ToolNotFound(tool_name.to_string()));
        }

        // Delegate to HTTP backend if using HTTP/SSE
        if let Some(ConnectionBackend::Http(ref mut http)) = self.backend {
            return http.call_tool(tool_name, arguments).await;
        }

        let request = McpRequest::call_tool(self.next_id(), tool_name, arguments);
        let response = self.send_request(request).await?;

        if let Some(error) = response.error {
            return Err(McpError::RequestFailed(error.message));
        }

        let result: McpToolResult = response
            .result_as()
            .map_err(|e| McpError::Protocol(format!("Invalid tool result: {}", e)))?;

        Ok(result)
    }

    /// Ensure stdio transport is connected, with a single auto-reconnect if the process died.
    async fn ensure_stdio_connected(&mut self) -> Result<(), McpError> {
        if self.config.transport != McpTransport::Stdio {
            return Ok(());
        }

        // If not initialized or backend missing, connect fresh.
        if !self.initialized || !matches!(self.backend, Some(ConnectionBackend::Stdio { .. })) {
            return self.connect_stdio().await;
        }

        // Check child is still alive, reconnect once if not.
        let exited = if let Some(ConnectionBackend::Stdio { process, .. }) = &mut self.backend {
            matches!(process.try_wait(), Ok(Some(_)))
        } else {
            false
        };

        if exited {
            if self.reconnecting {
                return Err(McpError::ConnectionFailed(
                    "MCP stdio server exited while reconnecting".to_string(),
                ));
            }
            self.reconnecting = true;
            self.disconnect().await;
            tokio::time::sleep(Duration::from_millis(250)).await;
            let result = self.connect_stdio().await;
            self.reconnecting = false;
            return result;
        }

        Ok(())
    }

    /// Send a request and wait for response (stdio only)
    async fn send_request(&mut self, request: McpRequest) -> Result<McpResponse, McpError> {
        let id = request.id;

        // Set up response channel
        let (tx, rx) = tokio::sync::oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            pending.insert(id, tx);
        }

        // Send request
        if let Err(send_err) = self.send_raw(&request).await {
            let mut pending = self.pending.lock().await;
            pending.remove(&id);
            return Err(send_err);
        }

        // Wait for response with timeout
        let timeout = Duration::from_millis(self.config.timeout.unwrap_or(30_000));
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(_)) => Err(McpError::Protocol("Response channel closed".to_string())),
            Err(_) => {
                // Remove from pending
                let mut pending = self.pending.lock().await;
                pending.remove(&id);
                Err(McpError::Timeout)
            }
        }
    }

    /// Send raw JSON to the server (stdio only)
    async fn send_raw(&mut self, value: &impl serde::Serialize) -> Result<(), McpError> {
        match &mut self.backend {
            Some(ConnectionBackend::Stdio { process, stdin, .. }) => {
                if let Ok(Some(status)) = process.try_wait() {
                    self.initialized = false;
                    return Err(McpError::ConnectionFailed(format!(
                        "MCP stdio server exited: {}",
                        status
                    )));
                }

                let json = serde_json::to_string(value)?;
                if let Err(e) = stdin.write_all(json.as_bytes()).await {
                    self.initialized = false;
                    return Err(McpError::ConnectionFailed(format!(
                        "Failed to write to MCP stdio stdin: {}",
                        e
                    )));
                }
                stdin.write_all(b"\n").await?;
                stdin.flush().await?;
                Ok(())
            }
            _ => Err(McpError::ConnectionFailed(
                "Not connected via stdio".to_string(),
            )),
        }
    }

    /// Get next request ID
    fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    /// Try to receive a server notification (non-blocking)
    ///
    /// Returns any pending notifications from the server that weren't
    /// responses to specific requests (e.g., progress updates, log messages).
    pub fn try_recv_notification(&mut self) -> Option<McpResponse> {
        if let Some(ConnectionBackend::Stdio { response_rx, .. }) = &mut self.backend {
            response_rx.try_recv().ok()
        } else {
            None
        }
    }

    /// Disconnect from the server
    pub async fn disconnect(&mut self) {
        match self.backend.take() {
            Some(ConnectionBackend::Stdio { mut process, .. }) => {
                let _ = process.kill().await;
            }
            Some(ConnectionBackend::Http(mut http)) => {
                http.disconnect().await;
            }
            None => {}
        }
        self.initialized = false;
    }

    /// Check if connected
    pub fn is_connected(&self) -> bool {
        if !self.initialized {
            return false;
        }
        match &self.backend {
            Some(ConnectionBackend::Stdio { .. }) => true,
            Some(ConnectionBackend::Http(http)) => http.is_connected(),
            None => false,
        }
    }

    /// Get the server name for this connection
    pub fn server_name(&self) -> &str {
        match &self.backend {
            Some(ConnectionBackend::Http(http)) => http.name(),
            _ => &self.name,
        }
    }
}

impl Drop for McpConnection {
    fn drop(&mut self) {
        // Try to kill the process synchronously
        if let Some(ConnectionBackend::Stdio { mut process, .. }) = self.backend.take() {
            let _ = process.start_kill();
        }
    }
}

/// MCP Client managing multiple server connections
pub struct McpClient {
    /// Active connections
    connections: RwLock<HashMap<String, Arc<Mutex<McpConnection>>>>,
}

impl McpClient {
    /// Create a new MCP client
    pub fn new() -> Self {
        Self {
            connections: RwLock::new(HashMap::new()),
        }
    }

    /// Connect to an MCP server
    pub async fn connect(&self, config: McpServerConfig) -> Result<(), McpError> {
        let name = config.name.clone();
        let mut connection = McpConnection::new(config);
        connection.connect().await?;

        let mut connections = self.connections.write().await;
        connections.insert(name, Arc::new(Mutex::new(connection)));

        Ok(())
    }

    /// Disconnect from a server
    pub async fn disconnect(&self, name: &str) -> Result<(), McpError> {
        let mut connections = self.connections.write().await;
        if let Some(conn) = connections.remove(name) {
            let mut conn = conn.lock().await;
            conn.disconnect().await;
        }
        Ok(())
    }

    /// Disconnect from all servers
    pub async fn disconnect_all(&self) {
        let mut connections = self.connections.write().await;
        for (_, conn) in connections.drain() {
            let mut conn = conn.lock().await;
            conn.disconnect().await;
        }
    }

    /// Get all available tools from all connected servers
    pub async fn list_all_tools(&self) -> Vec<crate::ai::Tool> {
        let connections = self.connections.read().await;
        let mut tools = Vec::new();

        for (name, conn) in connections.iter() {
            let conn = conn.lock().await;
            for tool in conn.tools() {
                tools.push(tool.to_tool(name));
            }
        }

        tools
    }

    /// Call a tool (parses server name from prefixed tool name)
    pub async fn call_tool(
        &self,
        prefixed_name: &str,
        arguments: serde_json::Value,
    ) -> Result<McpToolResult, McpError> {
        // Parse mcp_servername_toolname
        let parts: Vec<&str> = prefixed_name.splitn(3, '_').collect();
        if parts.len() != 3 || parts[0] != "mcp" {
            return Err(McpError::ToolNotFound(format!(
                "Invalid MCP tool name format: {}",
                prefixed_name
            )));
        }

        let server_name = parts[1];
        let tool_name = parts[2];

        let connections = self.connections.read().await;
        let conn = connections
            .get(server_name)
            .ok_or_else(|| McpError::ServerNotFound(server_name.to_string()))?;

        let mut conn = conn.lock().await;
        conn.call_tool(tool_name, arguments).await
    }

    /// Check if a tool name is an MCP tool
    pub fn is_mcp_tool(name: &str) -> bool {
        name.starts_with("mcp_")
    }

    /// Get connected server names
    pub async fn connected_servers(&self) -> Vec<String> {
        let connections = self.connections.read().await;
        connections.keys().cloned().collect()
    }
}

impl Default for McpClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_mcp_tool() {
        assert!(McpClient::is_mcp_tool("mcp_server_tool"));
        assert!(!McpClient::is_mcp_tool("bash"));
        assert!(!McpClient::is_mcp_tool("read"));
    }

    #[test]
    fn test_mcp_client_new() {
        let client = McpClient::new();
        // Just verify construction works
        assert!(client.connections.try_read().is_ok());
    }

    #[tokio::test]
    async fn test_connected_servers_empty() {
        let client = McpClient::new();
        let servers = client.connected_servers().await;
        assert!(servers.is_empty());
    }

    #[tokio::test]
    async fn test_list_all_tools_empty() {
        let client = McpClient::new();
        let tools = client.list_all_tools().await;
        assert!(tools.is_empty());
    }
}
