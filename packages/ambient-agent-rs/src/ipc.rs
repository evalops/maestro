//! IPC (Inter-Process Communication)
//!
//! Unix socket-based communication between CLI and daemon.
//! Allows CLI commands like `stop`, `status`, and `stats` to communicate
//! with a running daemon.

use crate::daemon::DaemonStats;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tracing::{info, warn};

/// Default socket path
pub fn default_socket_path() -> PathBuf {
    dirs::runtime_dir()
        .or_else(|| dirs::data_local_dir())
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("ambient-agent.sock")
}

/// IPC request from CLI to daemon
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum IpcRequest {
    /// Stop the daemon
    Stop,
    /// Get daemon status
    Status,
    /// Get daemon stats
    Stats,
    /// Pause processing
    Pause,
    /// Resume processing
    Resume,
    /// Ping to check if daemon is alive
    Ping,
}

/// IPC response from daemon to CLI
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum IpcResponse {
    /// Success with optional message
    Ok(Option<String>),
    /// Error with message
    Error(String),
    /// Status response
    Status(StatusResponse),
    /// Stats response
    Stats(StatsResponse),
    /// Pong response
    Pong,
}

/// Status information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusResponse {
    pub running: bool,
    pub status: String,
    pub uptime_secs: u64,
    pub pid: u32,
}

/// Stats information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatsResponse {
    pub events_processed: u64,
    pub tasks_executed: u64,
    pub tasks_succeeded: u64,
    pub tasks_failed: u64,
    pub prs_created: u64,
    pub total_cost: f64,
    pub uptime_secs: u64,
}

impl From<DaemonStats> for StatsResponse {
    fn from(stats: DaemonStats) -> Self {
        Self {
            events_processed: stats.events_processed,
            tasks_executed: stats.tasks_executed,
            tasks_succeeded: stats.tasks_succeeded,
            tasks_failed: stats.tasks_failed,
            prs_created: stats.prs_created,
            total_cost: stats.total_cost,
            uptime_secs: stats.uptime_secs,
        }
    }
}

/// IPC Server that runs alongside the daemon
pub struct IpcServer {
    socket_path: PathBuf,
    listener: Option<UnixListener>,
}

impl IpcServer {
    /// Create a new IPC server
    pub fn new(socket_path: PathBuf) -> Self {
        Self {
            socket_path,
            listener: None,
        }
    }

    /// Bind to the socket
    pub async fn bind(&mut self) -> anyhow::Result<()> {
        // Remove existing socket if present
        if self.socket_path.exists() {
            std::fs::remove_file(&self.socket_path)?;
        }

        // Create parent directory if needed
        if let Some(parent) = self.socket_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let listener = UnixListener::bind(&self.socket_path)?;
        info!("IPC server listening on {:?}", self.socket_path);
        self.listener = Some(listener);
        Ok(())
    }

    /// Accept a connection
    pub async fn accept(&self) -> anyhow::Result<UnixStream> {
        let listener = self.listener.as_ref()
            .ok_or_else(|| anyhow::anyhow!("Server not bound"))?;
        let (stream, _) = listener.accept().await?;
        Ok(stream)
    }

    /// Read a request from a stream
    pub async fn read_request(stream: &mut UnixStream) -> anyhow::Result<IpcRequest> {
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).await?;
        let request: IpcRequest = serde_json::from_str(&line)?;
        Ok(request)
    }

    /// Write a response to a stream
    pub async fn write_response(stream: &mut UnixStream, response: &IpcResponse) -> anyhow::Result<()> {
        let json = serde_json::to_string(response)?;
        stream.write_all(json.as_bytes()).await?;
        stream.write_all(b"\n").await?;
        stream.flush().await?;
        Ok(())
    }

    /// Clean up the socket file
    pub fn cleanup(&self) {
        if self.socket_path.exists() {
            if let Err(e) = std::fs::remove_file(&self.socket_path) {
                warn!("Failed to remove socket file: {}", e);
            }
        }
    }
}

impl Drop for IpcServer {
    fn drop(&mut self) {
        self.cleanup();
    }
}

/// IPC Client for CLI commands
pub struct IpcClient {
    socket_path: PathBuf,
}

impl IpcClient {
    /// Create a new IPC client
    pub fn new(socket_path: PathBuf) -> Self {
        Self { socket_path }
    }

    /// Check if daemon is running (socket exists)
    pub fn is_daemon_running(&self) -> bool {
        self.socket_path.exists()
    }

    /// Connect to the daemon
    async fn connect(&self) -> anyhow::Result<UnixStream> {
        if !self.socket_path.exists() {
            anyhow::bail!("Daemon not running (socket not found)");
        }
        let stream = UnixStream::connect(&self.socket_path).await?;
        Ok(stream)
    }

    /// Send a request and get a response
    pub async fn send(&self, request: IpcRequest) -> anyhow::Result<IpcResponse> {
        let mut stream = self.connect().await?;

        // Write request
        let json = serde_json::to_string(&request)?;
        stream.write_all(json.as_bytes()).await?;
        stream.write_all(b"\n").await?;
        stream.flush().await?;

        // Read response
        let mut reader = BufReader::new(&mut stream);
        let mut line = String::new();
        reader.read_line(&mut line).await?;
        let response: IpcResponse = serde_json::from_str(&line)?;
        Ok(response)
    }

    /// Ping the daemon
    pub async fn ping(&self) -> anyhow::Result<bool> {
        match self.send(IpcRequest::Ping).await {
            Ok(IpcResponse::Pong) => Ok(true),
            Ok(_) => Ok(false),
            Err(_) => Ok(false),
        }
    }

    /// Stop the daemon
    pub async fn stop(&self) -> anyhow::Result<()> {
        match self.send(IpcRequest::Stop).await {
            Ok(IpcResponse::Ok(_)) => Ok(()),
            Ok(IpcResponse::Error(e)) => anyhow::bail!(e),
            _ => anyhow::bail!("Unexpected response"),
        }
    }

    /// Get daemon status
    pub async fn status(&self) -> anyhow::Result<StatusResponse> {
        match self.send(IpcRequest::Status).await {
            Ok(IpcResponse::Status(s)) => Ok(s),
            Ok(IpcResponse::Error(e)) => anyhow::bail!(e),
            _ => anyhow::bail!("Unexpected response"),
        }
    }

    /// Get daemon stats
    pub async fn stats(&self) -> anyhow::Result<StatsResponse> {
        match self.send(IpcRequest::Stats).await {
            Ok(IpcResponse::Stats(s)) => Ok(s),
            Ok(IpcResponse::Error(e)) => anyhow::bail!(e),
            _ => anyhow::bail!("Unexpected response"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_ipc_roundtrip() {
        let temp = TempDir::new().unwrap();
        let socket_path = temp.path().join("test.sock");

        // Start server
        let mut server = IpcServer::new(socket_path.clone());
        server.bind().await.unwrap();

        // Spawn server handler
        let server_handle = tokio::spawn(async move {
            let mut stream = server.accept().await.unwrap();
            let request = IpcServer::read_request(&mut stream).await.unwrap();

            let response = match request {
                IpcRequest::Ping => IpcResponse::Pong,
                _ => IpcResponse::Error("Unexpected".to_string()),
            };

            IpcServer::write_response(&mut stream, &response).await.unwrap();
        });

        // Give server time to start
        tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;

        // Client ping
        let client = IpcClient::new(socket_path);
        let result = client.ping().await.unwrap();
        assert!(result);

        server_handle.await.unwrap();
    }
}
