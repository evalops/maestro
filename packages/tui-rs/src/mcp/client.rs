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
    ClientInfo, InitializeResult, McpIncomingMessage, McpNotification, McpPrompt, McpRequest,
    McpResource, McpResponse, McpTool, McpToolAnnotations, McpToolResult, PromptGetResult,
    PromptsListResult, ResourceReadResult, ResourcesListResult, ToolsListResult,
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

/// Runtime notification surfaced from an MCP server.
#[derive(Debug, Clone, PartialEq)]
pub enum McpRuntimeEvent {
    ToolsListChanged {
        server: String,
    },
    ResourcesListChanged {
        server: String,
    },
    PromptsListChanged {
        server: String,
    },
    Progress {
        server: String,
        progress: f64,
        total: Option<f64>,
        message: Option<String>,
    },
    Log {
        server: String,
        level: String,
        logger: Option<String>,
        data: serde_json::Value,
    },
}

impl McpRuntimeEvent {
    #[must_use]
    pub fn changes_tools(&self) -> bool {
        matches!(self, Self::ToolsListChanged { .. })
    }

    #[must_use]
    pub fn affects_badges(&self) -> bool {
        self.changes_tools()
    }
}

/// Connection backend type
#[allow(clippy::large_enum_variant)]
enum ConnectionBackend {
    /// Stdio subprocess
    Stdio {
        process: Child,
        stdin: tokio::process::ChildStdin,
        notification_rx: mpsc::UnboundedReceiver<McpNotification>,
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
    /// Available resources
    resources: Vec<McpResource>,
    /// Available prompts
    prompts: Vec<McpPrompt>,
    /// Whether initialized
    initialized: bool,

    /// Whether a reconnect is currently in progress
    ///
    /// Used to avoid overlapping reconnect attempts.
    reconnecting: bool,
}

impl McpConnection {
    /// Create a new connection (not yet connected)
    #[must_use]
    pub fn new(config: McpServerConfig) -> Self {
        Self {
            name: config.name.clone(),
            config,
            backend: None,
            next_id: AtomicU64::new(1),
            pending: Arc::new(Mutex::new(HashMap::new())),
            tools: Vec::new(),
            resources: Vec::new(),
            prompts: Vec::new(),
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
        self.resources = http_conn.resources().to_vec();
        self.prompts = http_conn.prompts().to_vec();
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
        for key in [
            "PATH",
            "HOME",
            "USER",
            "SHELL",
            "TERM",
            "USERPROFILE",
            "HOMEDRIVE",
            "HOMEPATH",
            "TEMP",
            "TMP",
            "COMSPEC",
            "PATHEXT",
        ] {
            if let Ok(value) = std::env::var(key) {
                cmd.env(key, value);
            }
        }
        if std::env::var("HOME").is_err() {
            if let Some(home) = dirs::home_dir()
                .and_then(|path| path.to_str().map(std::string::ToString::to_string))
            {
                cmd.env("HOME", home);
            }
        }
        // Re-add configured env vars after clearing
        for (key, value) in &self.config.env {
            cmd.env(key, expand_env_vars(value));
        }

        // Spawn the process
        let mut child = cmd
            .spawn()
            .map_err(|e| McpError::ConnectionFailed(format!("Failed to spawn {command}: {e}")))?;

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
        let (notification_tx, notification_rx) = mpsc::unbounded_channel();
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
                        if let Ok(message) = serde_json::from_str::<McpIncomingMessage>(&line) {
                            match message {
                                McpIncomingMessage::Response(response) => {
                                    if let Some(id) = response.id {
                                        let mut pending = pending.lock().await;
                                        if let Some(sender) = pending.remove(&id) {
                                            let _ = sender.send(response);
                                            continue;
                                        }
                                    }
                                }
                                McpIncomingMessage::Notification(notification) => {
                                    let _ = notification_tx.send(notification);
                                }
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        self.backend = Some(ConnectionBackend::Stdio {
            process: child,
            stdin,
            notification_rx,
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
            .map_err(|e| McpError::Protocol(format!("Invalid initialize response: {e}")))?;

        // Send initialized notification
        let notification = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        });
        self.send_raw(&notification).await?;

        // List available tools
        self.refresh_tools().await?;
        // List resources (best effort)
        let _ = self.refresh_resources().await;
        // List prompts (best effort)
        let _ = self.refresh_prompts().await;

        self.initialized = true;
        Ok(())
    }

    /// Refresh the list of available tools
    pub async fn refresh_tools(&mut self) -> Result<(), McpError> {
        if let Some(ConnectionBackend::Http(ref mut http)) = self.backend {
            http.refresh_tools().await?;
            self.tools = http.tools().to_vec();
            return Ok(());
        }

        let request = McpRequest::list_tools(self.next_id());
        let response = self.send_request(request).await?;

        let tools_result: ToolsListResult = response
            .result_as()
            .map_err(|e| McpError::Protocol(format!("Invalid tools/list response: {e}")))?;

        self.tools = tools_result.tools;
        Ok(())
    }

    /// Refresh the list of available resources
    pub async fn refresh_resources(&mut self) -> Result<(), McpError> {
        if let Some(ConnectionBackend::Http(ref mut http)) = self.backend {
            http.refresh_resources().await?;
            self.resources = http.resources().to_vec();
            return Ok(());
        }

        let request = McpRequest::list_resources(self.next_id());
        let response = self.send_request(request).await?;

        let resources_result: ResourcesListResult = response
            .result_as()
            .map_err(|e| McpError::Protocol(format!("Invalid resources/list response: {e}")))?;

        self.resources = resources_result.resources;
        Ok(())
    }

    /// Refresh the list of available prompts
    pub async fn refresh_prompts(&mut self) -> Result<(), McpError> {
        if let Some(ConnectionBackend::Http(ref mut http)) = self.backend {
            http.refresh_prompts().await?;
            self.prompts = http.prompts().to_vec();
            return Ok(());
        }

        let request = McpRequest::list_prompts(self.next_id());
        let response = self.send_request(request).await?;

        let prompts_result: PromptsListResult = response
            .result_as()
            .map_err(|e| McpError::Protocol(format!("Invalid prompts/list response: {e}")))?;

        self.prompts = prompts_result.prompts;
        Ok(())
    }

    /// Drain pending server notifications, refresh cached lists when needed, and surface runtime events.
    pub async fn poll_notifications(&mut self) -> Result<Vec<McpRuntimeEvent>, McpError> {
        if self.config.transport == McpTransport::Stdio && self.initialized {
            self.ensure_stdio_connected().await?;
        }

        let server = self.server_name().to_string();
        let mut events = Vec::new();

        while let Some(notification) = self.try_recv_notification() {
            if notification.is_tools_list_changed() {
                self.refresh_tools().await?;
                events.push(McpRuntimeEvent::ToolsListChanged {
                    server: server.clone(),
                });
            } else if notification.is_resources_list_changed() {
                self.refresh_resources().await?;
                events.push(McpRuntimeEvent::ResourcesListChanged {
                    server: server.clone(),
                });
            } else if notification.is_prompts_list_changed() {
                self.refresh_prompts().await?;
                events.push(McpRuntimeEvent::PromptsListChanged {
                    server: server.clone(),
                });
            } else if let Some(params) = notification.progress_params() {
                events.push(McpRuntimeEvent::Progress {
                    server: server.clone(),
                    progress: params.progress,
                    total: params.total,
                    message: params.message,
                });
            } else if let Some(params) = notification.log_message_params() {
                events.push(McpRuntimeEvent::Log {
                    server: server.clone(),
                    level: params.level,
                    logger: params.logger,
                    data: params.data,
                });
            }
        }

        Ok(events)
    }

    /// Get available tools
    pub fn tools(&self) -> &[McpTool] {
        &self.tools
    }

    /// Get available resources
    pub fn resources(&self) -> &[McpResource] {
        &self.resources
    }

    /// Get available prompts
    pub fn prompts(&self) -> &[McpPrompt] {
        &self.prompts
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
            .map_err(|e| McpError::Protocol(format!("Invalid tool result: {e}")))?;

        Ok(result)
    }

    /// Read a resource by URI
    pub async fn read_resource(&mut self, uri: &str) -> Result<ResourceReadResult, McpError> {
        self.ensure_stdio_connected().await?;

        if let Some(ConnectionBackend::Http(ref mut http)) = self.backend {
            return http.read_resource(uri).await;
        }

        let request = McpRequest::read_resource(self.next_id(), uri);
        let response = self.send_request(request).await?;

        if let Some(error) = response.error {
            return Err(McpError::RequestFailed(error.message));
        }

        let result: ResourceReadResult = response
            .result_as()
            .map_err(|e| McpError::Protocol(format!("Invalid resource read result: {e}")))?;

        Ok(result)
    }

    /// Get a prompt by name
    pub async fn get_prompt(
        &mut self,
        name: &str,
        arguments: Option<serde_json::Value>,
    ) -> Result<PromptGetResult, McpError> {
        self.ensure_stdio_connected().await?;

        if let Some(ConnectionBackend::Http(ref mut http)) = self.backend {
            return http.get_prompt(name, arguments).await;
        }

        let request = McpRequest::get_prompt(self.next_id(), name, arguments);
        let response = self.send_request(request).await?;

        if let Some(error) = response.error {
            return Err(McpError::RequestFailed(error.message));
        }

        let result: PromptGetResult = response
            .result_as()
            .map_err(|e| McpError::Protocol(format!("Invalid prompt get result: {e}")))?;

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
                        "MCP stdio server exited: {status}"
                    )));
                }

                let json = serde_json::to_string(value)?;
                if let Err(e) = stdin.write_all(json.as_bytes()).await {
                    self.initialized = false;
                    return Err(McpError::ConnectionFailed(format!(
                        "Failed to write to MCP stdio stdin: {e}"
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
    pub fn try_recv_notification(&mut self) -> Option<McpNotification> {
        match &mut self.backend {
            Some(ConnectionBackend::Stdio {
                notification_rx, ..
            }) => notification_rx.try_recv().ok(),
            Some(ConnectionBackend::Http(http)) => http.try_recv_notification(),
            None => None,
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
    #[must_use]
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

    /// Drain pending server notifications across all active connections.
    pub async fn poll_notifications(&self) -> Result<Vec<McpRuntimeEvent>, McpError> {
        let connections = {
            let guard = self.connections.read().await;
            guard.values().cloned().collect::<Vec<_>>()
        };
        let mut events = Vec::new();

        for conn in connections {
            let mut conn = conn.lock().await;
            events.extend(conn.poll_notifications().await?);
        }

        Ok(events)
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

    /// Get tool names grouped by server
    pub async fn list_tools_by_server(&self) -> Vec<(String, Vec<String>)> {
        let connections = self.connections.read().await;
        let mut results = Vec::new();

        for (name, conn) in connections.iter() {
            let conn = conn.lock().await;
            let tools = conn
                .tools()
                .iter()
                .map(|t| t.name.clone())
                .collect::<Vec<_>>();
            results.push((name.clone(), tools));
        }

        results
    }

    /// Get tool annotations for all connected servers
    pub async fn list_tool_annotations(&self) -> HashMap<String, McpToolAnnotations> {
        let connections = self.connections.read().await;
        let mut annotations = HashMap::new();

        for (name, conn) in connections.iter() {
            let conn = conn.lock().await;
            for tool in conn.tools() {
                if let Some(meta) = tool.annotations.clone() {
                    let prefixed = tool.to_tool(name).name;
                    annotations.insert(prefixed, meta);
                }
            }
        }

        annotations
    }

    /// Get available resources from all connected servers
    pub async fn list_all_resources(&self) -> Vec<(String, Vec<String>)> {
        let connections = self.connections.read().await;
        let mut results = Vec::new();

        for (name, conn) in connections.iter() {
            let conn = conn.lock().await;
            let resources = conn
                .resources()
                .iter()
                .map(|r| r.uri.clone())
                .collect::<Vec<_>>();
            results.push((name.clone(), resources));
        }

        results
    }

    /// Get available prompts from all connected servers
    pub async fn list_all_prompts(&self) -> Vec<(String, Vec<String>)> {
        let connections = self.connections.read().await;
        let mut results = Vec::new();

        for (name, conn) in connections.iter() {
            let conn = conn.lock().await;
            let prompts = conn
                .prompts()
                .iter()
                .map(|p| p.name.clone())
                .collect::<Vec<_>>();
            results.push((name.clone(), prompts));
        }

        results
    }

    /// Get a prompt from a connected server
    pub async fn get_prompt(
        &self,
        server_name: &str,
        name: &str,
        arguments: Option<HashMap<String, String>>,
    ) -> Result<PromptGetResult, McpError> {
        let connections = self.connections.read().await;
        let conn = connections
            .get(server_name)
            .ok_or_else(|| McpError::ServerNotFound(server_name.to_string()))?;
        let mut conn = conn.lock().await;
        let args_value = arguments
            .map(|args| serde_json::to_value(args).unwrap_or_else(|_| serde_json::json!({})));
        conn.get_prompt(name, args_value).await
    }

    /// Call a tool (parses server name from prefixed tool name)
    pub async fn call_tool(
        &self,
        prefixed_name: &str,
        arguments: serde_json::Value,
    ) -> Result<McpToolResult, McpError> {
        let connections = self.connections.read().await;
        let (_, tool_name, conn) =
            Self::resolve_prefixed_tool_with_connections(prefixed_name, &connections)?;
        let mut conn = conn.lock().await;
        conn.call_tool(&tool_name, arguments).await
    }

    /// Call a tool and return resolved server/tool metadata for the same parse.
    pub async fn call_tool_with_metadata(
        &self,
        prefixed_name: &str,
        arguments: serde_json::Value,
    ) -> Result<(String, String, McpToolResult), McpError> {
        let connections = self.connections.read().await;
        let (server_name, tool_name, conn) =
            Self::resolve_prefixed_tool_with_connections(prefixed_name, &connections)?;
        let mut conn = conn.lock().await;
        let result = conn.call_tool(&tool_name, arguments).await?;
        Ok((server_name, tool_name, result))
    }

    /// Parse a prefixed MCP tool name into (server, tool) using known connections
    pub async fn parse_prefixed_name(
        &self,
        prefixed_name: &str,
    ) -> Result<(String, String), McpError> {
        let connections = self.connections.read().await;
        Self::parse_prefixed_name_with_connections(prefixed_name, &connections)
    }

    fn parse_prefixed_name_with_connections(
        prefixed_name: &str,
        connections: &HashMap<String, Arc<Mutex<McpConnection>>>,
    ) -> Result<(String, String), McpError> {
        if let Some(rest) = prefixed_name.strip_prefix("mcp__") {
            let parts: Vec<&str> = rest.split("__").collect();
            if parts.len() < 2 {
                return Err(McpError::ToolNotFound(format!(
                    "Invalid MCP tool name format: {prefixed_name}"
                )));
            }
            for idx in (1..parts.len()).rev() {
                let candidate = parts[..idx].join("__");
                if connections.contains_key(&candidate) {
                    return Ok((candidate, parts[idx..].join("__")));
                }
            }
            return Ok((parts[0].to_string(), parts[1..].join("__")));
        }

        if let Some(rest) = prefixed_name.strip_prefix("mcp_") {
            let parts: Vec<&str> = rest.split('_').collect();
            if parts.len() < 2 {
                return Err(McpError::ToolNotFound(format!(
                    "Invalid MCP tool name format: {prefixed_name}"
                )));
            }
            for idx in (1..parts.len()).rev() {
                let candidate = parts[..idx].join("_");
                if connections.contains_key(&candidate) {
                    return Ok((candidate, parts[idx..].join("_")));
                }
            }
            return Ok((parts[0].to_string(), parts[1..].join("_")));
        }

        Err(McpError::ToolNotFound(format!(
            "Invalid MCP tool name format: {prefixed_name}"
        )))
    }

    fn resolve_prefixed_tool_with_connections(
        prefixed_name: &str,
        connections: &HashMap<String, Arc<Mutex<McpConnection>>>,
    ) -> Result<(String, String, Arc<Mutex<McpConnection>>), McpError> {
        let (server_name, tool_name) =
            Self::parse_prefixed_name_with_connections(prefixed_name, connections)?;
        let conn = connections
            .get(&server_name)
            .ok_or_else(|| McpError::ServerNotFound(server_name.clone()))?;
        Ok((server_name, tool_name, Arc::clone(conn)))
    }

    /// Check if a tool name is an MCP tool
    #[must_use]
    pub fn is_mcp_tool(name: &str) -> bool {
        if name == "mcp_list_resources"
            || name == "mcp_read_resource"
            || name == "mcp_list_prompts"
            || name == "mcp_get_prompt"
        {
            return false;
        }
        name.starts_with("mcp__") || name.starts_with("mcp_")
    }

    /// Read a resource from a connected server
    pub async fn read_resource(
        &self,
        server_name: &str,
        uri: &str,
    ) -> Result<ResourceReadResult, McpError> {
        let connections = self.connections.read().await;
        let conn = connections
            .get(server_name)
            .ok_or_else(|| McpError::ServerNotFound(server_name.to_string()))?;
        let mut conn = conn.lock().await;
        conn.read_resource(uri).await
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
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering as AtomicOrdering};
    use std::sync::Arc;
    use std::time::Duration;

    use super::*;
    use crate::mcp::config::McpServerConfig;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::{mpsc, Mutex};

    fn stub_config(name: &str) -> McpServerConfig {
        McpServerConfig {
            name: name.to_string(),
            transport: McpTransport::Stdio,
            command: Some("echo".to_string()),
            args: Vec::new(),
            env: HashMap::new(),
            cwd: None,
            url: None,
            headers: HashMap::new(),
            timeout: None,
            enabled: true,
            disabled: false,
            scope: crate::mcp::McpConfigScope::User,
        }
    }

    async fn read_http_request(socket: &mut TcpStream) -> Option<(String, String)> {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 1024];

        loop {
            let bytes_read = socket.read(&mut chunk).await.ok()?;
            if bytes_read == 0 {
                return None;
            }
            buffer.extend_from_slice(&chunk[..bytes_read]);
            if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }

        let header_end = buffer.windows(4).position(|window| window == b"\r\n\r\n")?;
        let header_bytes = &buffer[..header_end];
        let header_text = String::from_utf8_lossy(header_bytes);
        let request_line = header_text.lines().next()?;
        let path = request_line.split_whitespace().nth(1)?.to_string();
        let content_length = header_text
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                if name.eq_ignore_ascii_case("content-length") {
                    value.trim().parse::<usize>().ok()
                } else {
                    None
                }
            })
            .unwrap_or(0);

        let mut body = buffer[(header_end + 4)..].to_vec();
        while body.len() < content_length {
            let bytes_read = socket.read(&mut chunk).await.ok()?;
            if bytes_read == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..bytes_read]);
        }

        Some((
            path,
            String::from_utf8_lossy(&body[..content_length]).to_string(),
        ))
    }

    async fn write_http_response(
        socket: &mut TcpStream,
        status_line: &str,
        content_type: &str,
        body: &str,
    ) {
        let response = format!(
            "{status_line}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = socket.write_all(response.as_bytes()).await;
        let _ = socket.shutdown().await;
    }

    async fn send_sse_event_when_ready(
        sse_sender: Arc<Mutex<Option<mpsc::UnboundedSender<String>>>>,
        event: String,
    ) {
        for _ in 0..100 {
            if let Some(sender) = sse_sender.lock().await.clone() {
                let _ = sender.send(event);
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn start_sse_notification_server() -> std::net::SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let current_tool_version = Arc::new(AtomicUsize::new(0));
        let notification_sent = Arc::new(AtomicBool::new(false));
        let sse_sender = Arc::new(Mutex::new(None::<mpsc::UnboundedSender<String>>));

        tokio::spawn({
            let current_tool_version = Arc::clone(&current_tool_version);
            let notification_sent = Arc::clone(&notification_sent);
            let sse_sender = Arc::clone(&sse_sender);
            async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    let current_tool_version = Arc::clone(&current_tool_version);
                    let notification_sent = Arc::clone(&notification_sent);
                    let sse_sender = Arc::clone(&sse_sender);

                    tokio::spawn(async move {
                        let Some((path, body)) = read_http_request(&mut socket).await else {
                            return;
                        };

                        if path == "/sse" {
                            let (tx, mut rx) = mpsc::unbounded_channel::<String>();
                            {
                                let mut sender = sse_sender.lock().await;
                                *sender = Some(tx);
                            }

                            let headers = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n";
                            if socket.write_all(headers.as_bytes()).await.is_err() {
                                return;
                            }

                            while let Some(event) = rx.recv().await {
                                let payload = format!("data: {event}\n\n");
                                if socket.write_all(payload.as_bytes()).await.is_err() {
                                    break;
                                }
                            }
                            return;
                        }

                        let request = serde_json::from_str::<serde_json::Value>(&body)
                            .unwrap_or_else(|_| serde_json::json!({}));
                        let method = request
                            .get("method")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let request_id = request.get("id").and_then(serde_json::Value::as_u64);

                        let response_event = match method.as_str() {
                            "initialize" => Some(
                                serde_json::json!({
                                    "jsonrpc": "2.0",
                                    "id": request_id,
                                    "result": {
                                        "protocolVersion": "2024-11-05",
                                        "capabilities": {"tools": {}},
                                        "serverInfo": {"name": "test", "version": "1.0.0"}
                                    }
                                })
                                .to_string(),
                            ),
                            "tools/list" => {
                                let version = current_tool_version.load(AtomicOrdering::SeqCst);
                                if !notification_sent.swap(true, AtomicOrdering::SeqCst) {
                                    current_tool_version.store(1, AtomicOrdering::SeqCst);
                                    let sse_sender = Arc::clone(&sse_sender);
                                    tokio::spawn(async move {
                                        send_sse_event_when_ready(
                                            sse_sender,
                                            serde_json::json!({
                                                "jsonrpc": "2.0",
                                                "method": "notifications/tools/list_changed"
                                            })
                                            .to_string(),
                                        )
                                        .await;
                                    });
                                }

                                let tools = if version == 0 {
                                    vec![serde_json::json!({
                                        "name": "first_tool",
                                        "description": "Initial tool"
                                    })]
                                } else {
                                    vec![
                                        serde_json::json!({
                                            "name": "first_tool",
                                            "description": "Initial tool"
                                        }),
                                        serde_json::json!({
                                            "name": "second_tool",
                                            "description": "Updated tool"
                                        }),
                                    ]
                                };

                                Some(
                                    serde_json::json!({
                                        "jsonrpc": "2.0",
                                        "id": request_id,
                                        "result": {"tools": tools}
                                    })
                                    .to_string(),
                                )
                            }
                            "resources/list" => Some(
                                serde_json::json!({
                                    "jsonrpc": "2.0",
                                    "id": request_id,
                                    "result": {"resources": []}
                                })
                                .to_string(),
                            ),
                            "prompts/list" => Some(
                                serde_json::json!({
                                    "jsonrpc": "2.0",
                                    "id": request_id,
                                    "result": {"prompts": []}
                                })
                                .to_string(),
                            ),
                            _ => None,
                        };

                        write_http_response(
                            &mut socket,
                            "HTTP/1.1 200 OK",
                            "application/json",
                            "{}",
                        )
                        .await;

                        if let Some(event) = response_event {
                            send_sse_event_when_ready(Arc::clone(&sse_sender), event).await;
                        }
                    });
                }
            }
        });

        addr
    }

    async fn start_sse_runtime_event_server() -> std::net::SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let notifications_sent = Arc::new(AtomicBool::new(false));
        let sse_sender = Arc::new(Mutex::new(None::<mpsc::UnboundedSender<String>>));

        tokio::spawn({
            let notifications_sent = Arc::clone(&notifications_sent);
            let sse_sender = Arc::clone(&sse_sender);
            async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    let notifications_sent = Arc::clone(&notifications_sent);
                    let sse_sender = Arc::clone(&sse_sender);

                    tokio::spawn(async move {
                        let Some((path, body)) = read_http_request(&mut socket).await else {
                            return;
                        };

                        if path == "/sse" {
                            let (tx, mut rx) = mpsc::unbounded_channel::<String>();
                            {
                                let mut sender = sse_sender.lock().await;
                                *sender = Some(tx);
                            }

                            let headers = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n";
                            if socket.write_all(headers.as_bytes()).await.is_err() {
                                return;
                            }

                            while let Some(event) = rx.recv().await {
                                let payload = format!("data: {event}\n\n");
                                if socket.write_all(payload.as_bytes()).await.is_err() {
                                    break;
                                }
                            }
                            return;
                        }

                        let request = serde_json::from_str::<serde_json::Value>(&body)
                            .unwrap_or_else(|_| serde_json::json!({}));
                        let method = request
                            .get("method")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let request_id = request.get("id").and_then(serde_json::Value::as_u64);

                        let response_event = match method.as_str() {
                            "initialize" => Some(
                                serde_json::json!({
                                    "jsonrpc": "2.0",
                                    "id": request_id,
                                    "result": {
                                        "protocolVersion": "2024-11-05",
                                        "capabilities": {"tools": {}},
                                        "serverInfo": {"name": "runtime", "version": "1.0.0"}
                                    }
                                })
                                .to_string(),
                            ),
                            "tools/list" => {
                                if !notifications_sent.swap(true, AtomicOrdering::SeqCst) {
                                    let sse_sender = Arc::clone(&sse_sender);
                                    tokio::spawn(async move {
                                        send_sse_event_when_ready(
                                            Arc::clone(&sse_sender),
                                            serde_json::json!({
                                                "jsonrpc": "2.0",
                                                "method": "notifications/progress",
                                                "params": {
                                                    "progressToken": "job-1",
                                                    "progress": 4,
                                                    "total": 10,
                                                    "message": "Indexing"
                                                }
                                            })
                                            .to_string(),
                                        )
                                        .await;
                                        send_sse_event_when_ready(
                                            sse_sender,
                                            serde_json::json!({
                                                "jsonrpc": "2.0",
                                                "method": "notifications/message",
                                                "params": {
                                                    "level": "warning",
                                                    "data": "Slow response"
                                                }
                                            })
                                            .to_string(),
                                        )
                                        .await;
                                    });
                                }

                                Some(
                                    serde_json::json!({
                                        "jsonrpc": "2.0",
                                        "id": request_id,
                                        "result": {"tools": [{
                                            "name": "runtime_tool",
                                            "description": "Runtime tool"
                                        }]}
                                    })
                                    .to_string(),
                                )
                            }
                            "resources/list" => Some(
                                serde_json::json!({
                                    "jsonrpc": "2.0",
                                    "id": request_id,
                                    "result": {"resources": []}
                                })
                                .to_string(),
                            ),
                            "prompts/list" => Some(
                                serde_json::json!({
                                    "jsonrpc": "2.0",
                                    "id": request_id,
                                    "result": {"prompts": []}
                                })
                                .to_string(),
                            ),
                            _ => None,
                        };

                        write_http_response(
                            &mut socket,
                            "HTTP/1.1 200 OK",
                            "application/json",
                            "{}",
                        )
                        .await;

                        if let Some(event) = response_event {
                            send_sse_event_when_ready(Arc::clone(&sse_sender), event).await;
                        }
                    });
                }
            }
        });

        addr
    }

    #[test]
    fn test_is_mcp_tool() {
        assert!(McpClient::is_mcp_tool("mcp__server__tool"));
        assert!(McpClient::is_mcp_tool("mcp_server_tool"));
        assert!(!McpClient::is_mcp_tool("mcp_list_resources"));
        assert!(!McpClient::is_mcp_tool("mcp_read_resource"));
        assert!(!McpClient::is_mcp_tool("mcp_list_prompts"));
        assert!(!McpClient::is_mcp_tool("mcp_get_prompt"));
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

    #[test]
    fn parse_prefixed_name_with_double_underscore_server() {
        let mut connections = HashMap::new();
        let conn = McpConnection::new(stub_config("my__local"));
        connections.insert("my__local".to_string(), Arc::new(Mutex::new(conn)));

        let (server, tool) =
            McpClient::parse_prefixed_name_with_connections("mcp__my__local__tool", &connections)
                .expect("parse prefixed name");

        assert_eq!(server, "my__local");
        assert_eq!(tool, "tool");
    }

    #[tokio::test]
    async fn sse_list_changed_notifications_refresh_cached_tools() {
        let addr = start_sse_notification_server().await;
        let mut config = stub_config("test");
        config.transport = McpTransport::Sse;
        config.command = None;
        config.url = Some(format!("http://{addr}"));
        config.timeout = Some(2_000);

        let mut conn = McpConnection::new(config);
        conn.connect().await.expect("connect");
        assert_eq!(conn.tools().len(), 1);

        let events = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let events = conn.poll_notifications().await.expect("poll notifications");
                if !events.is_empty() {
                    break events;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("notification timeout");

        assert!(events
            .iter()
            .any(|event| matches!(event, McpRuntimeEvent::ToolsListChanged { server } if server == "test")));
        assert_eq!(conn.tools().len(), 2);
        assert_eq!(conn.tools()[1].name, "second_tool");
    }

    #[tokio::test]
    async fn sse_runtime_notifications_surface_progress_and_logs() {
        let addr = start_sse_runtime_event_server().await;
        let mut config = stub_config("runtime");
        config.transport = McpTransport::Sse;
        config.command = None;
        config.url = Some(format!("http://{addr}"));
        config.timeout = Some(2_000);

        let mut conn = McpConnection::new(config);
        conn.connect().await.expect("connect");

        let events = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let events = conn.poll_notifications().await.expect("poll notifications");
                if events.len() >= 2 {
                    break events;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("notification timeout");

        assert!(events.iter().any(|event| matches!(
            event,
            McpRuntimeEvent::Progress {
                server,
                progress,
                total,
                message,
            } if server == "runtime"
                && (*progress - 4.0).abs() < f64::EPSILON
                && *total == Some(10.0)
                && message.as_deref() == Some("Indexing")
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            McpRuntimeEvent::Log {
                server,
                level,
                data,
                ..
            } if server == "runtime"
                && level == "warning"
                && data == &serde_json::Value::String("Slow response".to_string())
        )));
    }
}
