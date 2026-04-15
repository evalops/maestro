//! HTTP and SSE Transport for MCP
//!
//! This module provides HTTP-based transports for MCP servers,
//! supporting both standard HTTP POST and Server-Sent Events (SSE).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use eventsource_stream::Eventsource;
use futures::StreamExt;
use reqwest::{header, Client};
use tokio::sync::{mpsc, oneshot, Mutex};

use super::client::McpError;
use super::config::{expand_env_vars, McpServerConfig, McpTransport};
use super::protocol::{
    ClientInfo, InitializeResult, McpIncomingMessage, McpNotification, McpPrompt, McpRequest,
    McpResource, McpResponse, McpTool, McpToolResult, PromptGetResult, PromptsListResult,
    ResourceReadResult, ResourcesListResult, ToolsListResult,
};

/// HTTP-based MCP connection
pub struct HttpConnection {
    /// Server name
    name: String,
    /// Server configuration
    config: McpServerConfig,
    /// HTTP client
    client: Client,
    /// Base URL for the server
    base_url: String,
    /// Request ID counter
    next_id: AtomicU64,
    /// Available tools
    tools: Vec<McpTool>,
    /// Available resources
    resources: Vec<McpResource>,
    /// Available prompts
    prompts: Vec<McpPrompt>,
    /// Whether initialized
    initialized: bool,
    /// SSE notification receiver (for SSE transport)
    notification_rx: Option<mpsc::UnboundedReceiver<McpNotification>>,
    /// Pending SSE requests
    pending_sse: Arc<Mutex<HashMap<u64, oneshot::Sender<McpResponse>>>>,
    /// SSE task handle
    sse_task: Option<tokio::task::JoinHandle<()>>,
}

impl HttpConnection {
    /// Create a new HTTP connection
    pub fn new(config: McpServerConfig) -> Result<Self, McpError> {
        let base_url = config.url.clone().ok_or_else(|| {
            McpError::ConnectionFailed("URL required for HTTP/SSE transport".to_string())
        })?;

        // Build HTTP client with timeout
        let timeout = Duration::from_millis(config.timeout.unwrap_or(30_000));
        let client = Client::builder().timeout(timeout).build().map_err(|e| {
            McpError::ConnectionFailed(format!("Failed to create HTTP client: {e}"))
        })?;

        Ok(Self {
            name: config.name.clone(),
            config,
            client,
            base_url,
            next_id: AtomicU64::new(1),
            tools: Vec::new(),
            resources: Vec::new(),
            prompts: Vec::new(),
            initialized: false,
            notification_rx: None,
            pending_sse: Arc::new(Mutex::new(HashMap::new())),
            sse_task: None,
        })
    }

    /// Connect and initialize
    pub async fn connect(&mut self) -> Result<(), McpError> {
        match self.config.transport {
            McpTransport::Http => self.connect_http().await,
            McpTransport::Sse => self.connect_sse().await,
            McpTransport::Stdio => Err(McpError::ConnectionFailed(
                "Use McpConnection for stdio".to_string(),
            )),
        }
    }

    /// Connect via HTTP (stateless request/response)
    async fn connect_http(&mut self) -> Result<(), McpError> {
        // Initialize the connection
        self.initialize().await?;
        Ok(())
    }

    /// Connect via SSE (persistent streaming connection)
    async fn connect_sse(&mut self) -> Result<(), McpError> {
        // Start SSE event stream
        let (tx, rx) = mpsc::unbounded_channel();
        self.notification_rx = Some(rx);

        let url = format!("{}/sse", self.base_url.trim_end_matches('/'));
        let pending = self.pending_sse.clone();
        let client = self.client.clone();
        let headers = self.config.headers.clone();

        // Spawn SSE reader task
        let task = tokio::spawn(async move {
            let mut request = client.get(&url);

            // Add custom headers
            for (key, value) in &headers {
                request = request.header(key, expand_env_vars(value));
            }

            let response = match request.send().await {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("[mcp/sse] Connection failed: {e}");
                    return;
                }
            };

            let mut stream = response.bytes_stream().eventsource();

            while let Some(event) = stream.next().await {
                match event {
                    Ok(ev) => {
                        if let Ok(message) = serde_json::from_str::<McpIncomingMessage>(&ev.data) {
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
                                    let _ = tx.send(notification);
                                }
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[mcp/sse] Stream error: {e}");
                        break;
                    }
                }
            }
        });

        self.sse_task = Some(task);

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
        self.send_notification(&notification).await?;

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
        let request = McpRequest::list_prompts(self.next_id());
        let response = self.send_request(request).await?;

        let prompts_result: PromptsListResult = response
            .result_as()
            .map_err(|e| McpError::Protocol(format!("Invalid prompts/list response: {e}")))?;

        self.prompts = prompts_result.prompts;
        Ok(())
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

    /// Get server name
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Try to receive a server notification (non-blocking).
    pub fn try_recv_notification(&mut self) -> Option<McpNotification> {
        self.notification_rx
            .as_mut()
            .and_then(|rx| rx.try_recv().ok())
    }

    /// Call a tool
    pub async fn call_tool(
        &mut self,
        tool_name: &str,
        arguments: serde_json::Value,
    ) -> Result<McpToolResult, McpError> {
        // Verify tool exists
        if !self.tools.iter().any(|t| t.name == tool_name) {
            return Err(McpError::ToolNotFound(tool_name.to_string()));
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

    /// Send a request and wait for response
    async fn send_request(&mut self, request: McpRequest) -> Result<McpResponse, McpError> {
        match self.config.transport {
            McpTransport::Http => self.send_http_request(request).await,
            McpTransport::Sse => self.send_sse_request(request).await,
            McpTransport::Stdio => Err(McpError::ConnectionFailed(
                "HttpConnection does not support stdio transport".to_string(),
            )),
        }
    }

    /// Send request via HTTP POST
    async fn send_http_request(&self, request: McpRequest) -> Result<McpResponse, McpError> {
        let url = format!("{}/message", self.base_url.trim_end_matches('/'));

        let mut req = self
            .client
            .post(&url)
            .header(header::CONTENT_TYPE, "application/json")
            .json(&request);

        // Add custom headers
        for (key, value) in &self.config.headers {
            req = req.header(key, expand_env_vars(value));
        }

        let response = req
            .send()
            .await
            .map_err(|e| McpError::RequestFailed(format!("HTTP request failed: {e}")))?;

        if !response.status().is_success() {
            return Err(McpError::RequestFailed(format!(
                "HTTP error: {}",
                response.status()
            )));
        }

        let mcp_response: McpResponse = response
            .json()
            .await
            .map_err(|e| McpError::Protocol(format!("Failed to parse response: {e}")))?;

        Ok(mcp_response)
    }

    /// Send request via SSE channel
    async fn send_sse_request(&mut self, request: McpRequest) -> Result<McpResponse, McpError> {
        let id = request.id;

        // Set up response channel
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending_sse.lock().await;
            pending.insert(id, tx);
        }

        // Send via HTTP POST (SSE is for receiving)
        let url = format!("{}/message", self.base_url.trim_end_matches('/'));

        let mut req = self
            .client
            .post(&url)
            .header(header::CONTENT_TYPE, "application/json")
            .json(&request);

        // Add custom headers
        for (key, value) in &self.config.headers {
            req = req.header(key, expand_env_vars(value));
        }

        let response = match req.send().await {
            Ok(response) => response,
            Err(e) => {
                let mut pending = self.pending_sse.lock().await;
                pending.remove(&id);
                return Err(McpError::RequestFailed(format!("SSE send failed: {e}")));
            }
        };

        if !response.status().is_success() {
            let mut pending = self.pending_sse.lock().await;
            pending.remove(&id);
            return Err(McpError::RequestFailed(format!(
                "HTTP error: {}",
                response.status()
            )));
        }

        // Wait for response via SSE stream
        let timeout = Duration::from_millis(self.config.timeout.unwrap_or(30_000));
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(_)) => {
                let mut pending = self.pending_sse.lock().await;
                pending.remove(&id);
                Err(McpError::Protocol(
                    "SSE response channel closed".to_string(),
                ))
            }
            Err(_) => {
                // Remove from pending
                let mut pending = self.pending_sse.lock().await;
                pending.remove(&id);
                Err(McpError::Timeout)
            }
        }
    }

    /// Send a notification (no response expected)
    async fn send_notification(&self, value: &impl serde::Serialize) -> Result<(), McpError> {
        let url = format!("{}/message", self.base_url.trim_end_matches('/'));

        let mut req = self
            .client
            .post(&url)
            .header(header::CONTENT_TYPE, "application/json")
            .json(value);

        // Add custom headers
        for (key, value) in &self.config.headers {
            req = req.header(key, expand_env_vars(value));
        }

        req.send()
            .await
            .map_err(|e| McpError::RequestFailed(format!("Notification failed: {e}")))?;

        Ok(())
    }

    /// Get next request ID
    fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    /// Disconnect from the server
    pub async fn disconnect(&mut self) {
        if let Some(task) = self.sse_task.take() {
            task.abort();
        }
        self.notification_rx = None;
        self.initialized = false;
    }

    /// Check if connected
    pub fn is_connected(&self) -> bool {
        self.initialized
    }
}

impl Drop for HttpConnection {
    fn drop(&mut self) {
        if let Some(task) = self.sse_task.take() {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn test_config(transport: McpTransport) -> McpServerConfig {
        McpServerConfig {
            name: "test".to_string(),
            transport,
            command: None,
            args: vec![],
            env: HashMap::new(),
            cwd: None,
            url: Some("http://localhost:8080".to_string()),
            headers: HashMap::new(),
            timeout: Some(5000),
            enabled: true,
            disabled: false,
            scope: crate::mcp::McpConfigScope::User,
        }
    }

    #[test]
    fn test_http_connection_new() {
        let config = test_config(McpTransport::Http);
        let conn = HttpConnection::new(config);
        assert!(conn.is_ok());
    }

    #[test]
    fn test_http_connection_requires_url() {
        let mut config = test_config(McpTransport::Http);
        config.url = None;
        let conn = HttpConnection::new(config);
        assert!(conn.is_err());
    }

    #[test]
    fn test_sse_connection_new() {
        let config = test_config(McpTransport::Sse);
        let conn = HttpConnection::new(config);
        assert!(conn.is_ok());
    }

    #[tokio::test]
    async fn test_http_connection_not_connected_initially() {
        let config = test_config(McpTransport::Http);
        let conn = HttpConnection::new(config).unwrap();
        assert!(!conn.is_connected());
    }

    #[test]
    fn test_next_id_increments() {
        let config = test_config(McpTransport::Http);
        let conn = HttpConnection::new(config).unwrap();
        assert_eq!(conn.next_id(), 1);
        assert_eq!(conn.next_id(), 2);
        assert_eq!(conn.next_id(), 3);
    }

    async fn start_error_server() -> std::net::SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let mut buffer = [0u8; 1024];
                let _ = socket.read(&mut buffer).await;
                let response = b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n";
                let _ = socket.write_all(response).await;
                let _ = socket.shutdown().await;
            }
        });

        addr
    }

    #[tokio::test]
    async fn test_send_sse_request_clears_pending_on_http_error() {
        let addr = start_error_server().await;
        let mut config = test_config(McpTransport::Sse);
        config.url = Some(format!("http://{}", addr));
        config.timeout = Some(100);

        let mut conn = HttpConnection::new(config).unwrap();
        let request = McpRequest::list_tools(conn.next_id());

        let result = conn.send_sse_request(request).await;
        assert!(matches!(result, Err(McpError::RequestFailed(_))));

        let pending_len = conn.pending_sse.lock().await.len();
        assert_eq!(pending_len, 0);
    }
}
