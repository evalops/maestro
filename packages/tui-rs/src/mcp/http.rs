//! HTTP and SSE Transport for MCP
//!
//! This module provides HTTP-based transports for MCP servers,
//! supporting both standard HTTP POST and Server-Sent Events (SSE).

use std::collections::HashMap;
use std::future::{poll_fn, Future};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::task::Poll;
use std::time::Duration;

use eventsource_stream::Eventsource;
use futures::StreamExt;
use reqwest::{header, Client};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_util::sync::CancellationToken;

use super::client::McpError;
use super::config::{expand_env_vars_for_scope, McpServerConfig, McpTransport};
use super::protocol::{
    ClientInfo, InitializeResult, McpIncomingMessage, McpNotification, McpPrompt, McpRequest,
    McpResource, McpResponse, McpTool, McpToolResult, PromptGetResult, PromptsListResult,
    ResourceReadResult, ResourcesListResult, ToolsListResult,
};

async fn await_request_or_cancellation<F>(
    request_future: F,
    cancel: &CancellationToken,
) -> Option<F::Output>
where
    F: std::future::Future,
{
    tokio::pin!(request_future);
    let cancellation = cancel.cancelled();
    tokio::pin!(cancellation);

    enum InitialPoll<T> {
        Cancelled,
        Completed(T),
        Dispatched,
    }

    let initial = poll_fn(|cx| {
        if cancellation.as_mut().poll(cx).is_ready() {
            return Poll::Ready(InitialPoll::Cancelled);
        }

        Poll::Ready(match request_future.as_mut().poll(cx) {
            Poll::Ready(result) => InitialPoll::Completed(result),
            Poll::Pending => InitialPoll::Dispatched,
        })
    })
    .await;

    match initial {
        InitialPoll::Cancelled => return None,
        InitialPoll::Completed(result) => return Some(result),
        InitialPoll::Dispatched => {}
    }

    tokio::select! {
        biased;
        result = &mut request_future => Some(result),
        () = cancel.cancelled() => None,
    }
}

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
        let scope = self.config.scope;

        // Spawn SSE reader task
        let task = tokio::spawn(async move {
            let mut request = client.get(&url);

            // Add custom headers
            for (key, value) in &headers {
                request = request.header(key, expand_env_vars_for_scope(value, scope));
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

    /// Call a tool and notify the server when the client cancels the request.
    pub async fn call_tool_cancellable(
        &mut self,
        tool_name: &str,
        arguments: serde_json::Value,
        cancel: &CancellationToken,
    ) -> Result<McpToolResult, McpError> {
        if !self.tools.iter().any(|tool| tool.name == tool_name) {
            return Err(McpError::ToolNotFound(tool_name.to_string()));
        }

        let request = McpRequest::call_tool(self.next_id(), tool_name, arguments);
        let response = self.send_request_cancellable(request, cancel).await?;
        if let Some(error) = response.error {
            return Err(McpError::RequestFailed(error.message));
        }
        response
            .result_as()
            .map_err(|error| McpError::Protocol(format!("Invalid tool result: {error}")))
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

    async fn send_request_cancellable(
        &mut self,
        request: McpRequest,
        cancel: &CancellationToken,
    ) -> Result<McpResponse, McpError> {
        if cancel.is_cancelled() {
            return Err(McpError::Cancelled);
        }

        let request_id = request.id;
        if let Some(result) =
            await_request_or_cancellation(self.send_request(request), cancel).await
        {
            return result;
        }

        // A cancelled SSE waiter may already have inserted its response
        // channel; remove it before telling the server to stop work.
        self.pending_sse.lock().await.remove(&request_id);
        let delivery = tokio::time::timeout(
            Duration::from_millis(500),
            self.send_notification(&McpNotification::cancelled(
                request_id,
                "Maestro turn cancelled",
            )),
        )
        .await;
        match delivery {
            Ok(Ok(())) => Err(McpError::Indeterminate(
                "Cancellation notification was acknowledged, but the remote request outcome is unknown"
                    .to_string(),
            )),
            Ok(Err(error)) => Err(McpError::Indeterminate(format!(
                "Failed to deliver cancellation notification: {error}"
            ))),
            Err(_) => Err(McpError::Indeterminate(
                "Timed out delivering cancellation notification".to_string(),
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
            req = req.header(key, expand_env_vars_for_scope(value, self.config.scope));
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
            req = req.header(key, expand_env_vars_for_scope(value, self.config.scope));
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
            req = req.header(key, expand_env_vars_for_scope(value, self.config.scope));
        }

        let response = req
            .send()
            .await
            .map_err(|e| McpError::RequestFailed(format!("Notification failed: {e}")))?;
        if !response.status().is_success() {
            return Err(McpError::RequestFailed(format!(
                "Notification HTTP error: {}",
                response.status()
            )));
        }

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
    use crate::mcp::protocol::MCP_CANCELLED_METHOD;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

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
            headers_helper: None,
            auth_preset: None,
            supports_parallel_tool_calls: None,
            requires_project_approval: None,
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

    async fn read_request_body(socket: &mut TcpStream) -> String {
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 1024];
        loop {
            let read = socket.read(&mut buffer).await.unwrap_or(0);
            if read == 0 {
                return String::new();
            }
            bytes.extend_from_slice(&buffer[..read]);
            if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        let header_end = bytes
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("HTTP header terminator");
        let headers = String::from_utf8_lossy(&bytes[..header_end]);
        let content_length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
            .unwrap_or(0);
        let body_start = header_end + 4;
        while bytes.len() < body_start + content_length {
            let read = socket.read(&mut buffer).await.unwrap_or(0);
            if read == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..read]);
        }
        String::from_utf8_lossy(&bytes[body_start..body_start + content_length]).into_owned()
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

    #[tokio::test]
    async fn acknowledged_http_cancellation_remains_indeterminate() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (call_seen_tx, call_seen_rx) = tokio::sync::oneshot::channel();
        let (notification_tx, notification_rx) = tokio::sync::oneshot::channel();

        tokio::spawn(async move {
            let (mut call_socket, _) = listener.accept().await.unwrap();
            let call_body = read_request_body(&mut call_socket).await;
            let call: serde_json::Value = serde_json::from_str(&call_body).unwrap();
            assert_eq!(call["method"], "tools/call");
            let _ = call_seen_tx.send(());

            // Keep the original request socket open while cancellation is
            // delivered over a second HTTP request.
            let (mut notification_socket, _) = listener.accept().await.unwrap();
            let notification_body = read_request_body(&mut notification_socket).await;
            let notification: serde_json::Value = serde_json::from_str(&notification_body).unwrap();
            assert_eq!(notification["method"], MCP_CANCELLED_METHOD);
            let _ = notification_tx.send(notification);
            let response =
                b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            let _ = notification_socket.write_all(response).await;
        });

        let mut config = test_config(McpTransport::Http);
        config.url = Some(format!("http://{addr}"));
        let mut conn = HttpConnection::new(config).unwrap();
        let request_id = conn.next_id();
        let request = McpRequest::call_tool(request_id, "mutate", serde_json::json!({}));
        let cancel = CancellationToken::new();
        tokio::spawn({
            let cancel = cancel.clone();
            async move {
                call_seen_rx.await.expect("server saw tool request");
                cancel.cancel();
            }
        });

        let result = conn.send_request_cancellable(request, &cancel).await;
        assert!(
            matches!(result, Err(McpError::Indeterminate(ref message)) if message.contains("outcome is unknown")),
            "acknowledgement must not imply that the remote mutation was cancelled: {result:?}"
        );
        let notification = notification_rx.await.expect("server saw cancellation");
        assert_eq!(notification["params"]["requestId"], request_id);
    }

    #[tokio::test]
    async fn completed_request_wins_after_dispatch_when_cancellation_is_already_ready() {
        let cancel = CancellationToken::new();
        let cancel_from_request = cancel.clone();
        let mut first_poll = true;
        let request = poll_fn(move |cx| {
            if first_poll {
                first_poll = false;
                cancel_from_request.cancel();
                cx.waker().wake_by_ref();
                Poll::Pending
            } else {
                Poll::Ready(42)
            }
        });

        let result = await_request_or_cancellation(request, &cancel).await;

        assert_eq!(result, Some(42));
    }

    #[tokio::test]
    async fn pre_cancelled_http_request_never_reaches_the_server() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut requests = 0;
            while let Ok(Ok((mut socket, _))) =
                tokio::time::timeout(Duration::from_millis(100), listener.accept()).await
            {
                requests += 1;
                let _ = read_request_body(&mut socket).await;
                let response =
                    b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                let _ = socket.write_all(response).await;
            }
            requests
        });

        let mut config = test_config(McpTransport::Http);
        config.url = Some(format!("http://{addr}"));
        let mut conn = HttpConnection::new(config).unwrap();
        let request = McpRequest::call_tool(conn.next_id(), "mutate", serde_json::json!({}));
        let cancel = CancellationToken::new();
        cancel.cancel();

        let result = conn.send_request_cancellable(request, &cancel).await;

        assert!(matches!(result, Err(McpError::Cancelled)));
        assert_eq!(
            server.await.unwrap(),
            0,
            "a pre-cancelled mutating request must not be polled or sent"
        );
    }

    #[tokio::test]
    async fn hanging_http_cancellation_notification_is_bounded() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (call_seen_tx, call_seen_rx) = tokio::sync::oneshot::channel();

        tokio::spawn(async move {
            let (mut call_socket, _) = listener.accept().await.unwrap();
            let call_body = read_request_body(&mut call_socket).await;
            let call: serde_json::Value = serde_json::from_str(&call_body).unwrap();
            assert_eq!(call["method"], "tools/call");
            let _ = call_seen_tx.send(());

            let (mut notification_socket, _) = listener.accept().await.unwrap();
            let notification_body = read_request_body(&mut notification_socket).await;
            let notification: serde_json::Value = serde_json::from_str(&notification_body).unwrap();
            assert_eq!(notification["method"], MCP_CANCELLED_METHOD);
            tokio::time::sleep(Duration::from_secs(2)).await;
        });

        let mut config = test_config(McpTransport::Http);
        config.url = Some(format!("http://{addr}"));
        config.timeout = Some(30_000);
        let mut conn = HttpConnection::new(config).unwrap();
        let request = McpRequest::call_tool(conn.next_id(), "mutate", serde_json::json!({}));
        let cancel = CancellationToken::new();
        tokio::spawn({
            let cancel = cancel.clone();
            async move {
                call_seen_rx.await.expect("server saw tool request");
                cancel.cancel();
            }
        });

        let started = tokio::time::Instant::now();
        let result = conn.send_request_cancellable(request, &cancel).await;

        assert!(
            matches!(result, Err(McpError::Indeterminate(ref message))
                if message.contains("cancellation notification")),
            "notification timeout must remain visible: {result:?}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "cancellation delivery must not inherit the 30-second request timeout"
        );
    }

    #[tokio::test]
    async fn rejected_http_cancellation_is_not_reported_as_cancelled() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (call_seen_tx, call_seen_rx) = tokio::sync::oneshot::channel();

        tokio::spawn(async move {
            let (mut call_socket, _) = listener.accept().await.unwrap();
            let call_body = read_request_body(&mut call_socket).await;
            let call: serde_json::Value = serde_json::from_str(&call_body).unwrap();
            assert_eq!(call["method"], "tools/call");
            let _ = call_seen_tx.send(());

            let (mut notification_socket, _) = listener.accept().await.unwrap();
            let notification_body = read_request_body(&mut notification_socket).await;
            let notification: serde_json::Value = serde_json::from_str(&notification_body).unwrap();
            assert_eq!(notification["method"], MCP_CANCELLED_METHOD);
            let response = b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            let _ = notification_socket.write_all(response).await;
        });

        let mut config = test_config(McpTransport::Http);
        config.url = Some(format!("http://{addr}"));
        let mut conn = HttpConnection::new(config).unwrap();
        let request = McpRequest::call_tool(conn.next_id(), "mutate", serde_json::json!({}));
        let cancel = CancellationToken::new();
        tokio::spawn({
            let cancel = cancel.clone();
            async move {
                call_seen_rx.await.expect("server saw tool request");
                cancel.cancel();
            }
        });

        let result = conn.send_request_cancellable(request, &cancel).await;

        assert!(
            matches!(result, Err(McpError::Indeterminate(ref message)) if message.contains("503")),
            "server rejection must remain visible instead of becoming Cancelled: {result:?}"
        );
    }
}
