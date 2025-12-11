//! MCP Protocol Types and Messages
//!
//! This module defines the JSON-RPC based protocol for MCP communication.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// JSON-RPC request message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpRequest {
    /// JSON-RPC version (always "2.0")
    pub jsonrpc: String,
    /// Request ID for correlation
    pub id: u64,
    /// Method name
    pub method: String,
    /// Method parameters
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

impl McpRequest {
    /// Create a new request
    pub fn new(id: u64, method: impl Into<String>, params: Option<Value>) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            method: method.into(),
            params,
        }
    }

    /// Create an initialize request
    pub fn initialize(id: u64, client_info: &ClientInfo) -> Self {
        Self::new(
            id,
            "initialize",
            Some(serde_json::json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {}
                },
                "clientInfo": client_info
            })),
        )
    }

    /// Create a tools/list request
    pub fn list_tools(id: u64) -> Self {
        Self::new(id, "tools/list", None)
    }

    /// Create a tools/call request
    pub fn call_tool(id: u64, name: &str, arguments: Value) -> Self {
        Self::new(
            id,
            "tools/call",
            Some(serde_json::json!({
                "name": name,
                "arguments": arguments
            })),
        )
    }
}

/// JSON-RPC response message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpResponse {
    /// JSON-RPC version
    pub jsonrpc: String,
    /// Request ID for correlation
    pub id: Option<u64>,
    /// Successful result
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    /// Error response
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<McpError>,
}

impl McpResponse {
    /// Check if this is an error response
    pub fn is_error(&self) -> bool {
        self.error.is_some()
    }

    /// Get the result as a specific type
    pub fn result_as<T: for<'de> Deserialize<'de>>(&self) -> Result<T, String> {
        match &self.result {
            Some(v) => serde_json::from_value(v.clone())
                .map_err(|e| format!("Failed to deserialize result: {}", e)),
            None => Err("No result in response".to_string()),
        }
    }
}

/// JSON-RPC error
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpError {
    /// Error code
    pub code: i32,
    /// Error message
    pub message: String,
    /// Additional error data
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl std::fmt::Display for McpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "MCP error {}: {}", self.code, self.message)
    }
}

impl std::error::Error for McpError {}

/// Client information sent during initialization
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientInfo {
    /// Client name
    pub name: String,
    /// Client version
    pub version: String,
}

impl Default for ClientInfo {
    fn default() -> Self {
        Self {
            name: "composer-tui".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
        }
    }
}

/// Server information received during initialization
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    /// Server name
    pub name: String,
    /// Server version
    #[serde(default)]
    pub version: Option<String>,
}

/// Initialize response
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    /// Protocol version
    pub protocol_version: String,
    /// Server capabilities
    #[serde(default)]
    pub capabilities: ServerCapabilities,
    /// Server info
    #[serde(default)]
    pub server_info: Option<ServerInfo>,
}

/// Server capabilities
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ServerCapabilities {
    /// Tool capabilities
    #[serde(default)]
    pub tools: Option<Value>,
    /// Prompt capabilities
    #[serde(default)]
    pub prompts: Option<Value>,
    /// Resource capabilities
    #[serde(default)]
    pub resources: Option<Value>,
}

/// MCP Tool definition
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    /// Tool name
    pub name: String,
    /// Tool description
    #[serde(default)]
    pub description: Option<String>,
    /// Input schema (JSON Schema)
    #[serde(default)]
    pub input_schema: Option<Value>,
}

impl McpTool {
    /// Convert to our internal Tool type
    pub fn to_tool(&self, server_name: &str) -> crate::ai::Tool {
        let prefixed_name = format!("mcp_{}_{}", server_name, self.name);
        let description = self.description.clone().unwrap_or_default();

        let mut tool = crate::ai::Tool::new(&prefixed_name, &description);
        if let Some(schema) = &self.input_schema {
            tool = tool.with_schema(schema.clone());
        }
        tool
    }
}

/// Tools list response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolsListResult {
    /// Available tools
    pub tools: Vec<McpTool>,
}

/// Tool call result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolResult {
    /// Result content
    pub content: Vec<McpContent>,
    /// Whether the tool call was an error
    #[serde(default, rename = "isError")]
    pub is_error: bool,
}

impl McpToolResult {
    /// Convert to a string representation
    pub fn as_string(&self) -> String {
        self.content
            .iter()
            .map(|c| c.to_string())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// Content in tool results
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum McpContent {
    /// Text content
    Text {
        /// The text
        text: String,
    },
    /// Image content
    Image {
        /// Base64 encoded image data
        data: String,
        /// MIME type
        #[serde(rename = "mimeType")]
        mime_type: String,
    },
    /// Resource reference
    Resource {
        /// Resource URI
        uri: String,
        /// MIME type
        #[serde(rename = "mimeType", default)]
        mime_type: Option<String>,
        /// Optional text content
        #[serde(default)]
        text: Option<String>,
    },
}

impl std::fmt::Display for McpContent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            McpContent::Text { text } => write!(f, "{}", text),
            McpContent::Image { mime_type, .. } => write!(f, "[Image: {}]", mime_type),
            McpContent::Resource { uri, .. } => write!(f, "[Resource: {}]", uri),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_request_serialize() {
        let req = McpRequest::new(1, "test", None);
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"jsonrpc\":\"2.0\""));
        assert!(json.contains("\"id\":1"));
        assert!(json.contains("\"method\":\"test\""));
    }

    #[test]
    fn test_request_initialize() {
        let req = McpRequest::initialize(1, &ClientInfo::default());
        assert_eq!(req.method, "initialize");
        assert!(req.params.is_some());
    }

    #[test]
    fn test_request_list_tools() {
        let req = McpRequest::list_tools(2);
        assert_eq!(req.method, "tools/list");
        assert!(req.params.is_none());
    }

    #[test]
    fn test_request_call_tool() {
        let req = McpRequest::call_tool(3, "my_tool", serde_json::json!({"arg": "value"}));
        assert_eq!(req.method, "tools/call");
        assert!(req.params.is_some());
    }

    #[test]
    fn test_response_deserialize_result() {
        let json = r#"{"jsonrpc":"2.0","id":1,"result":{"key":"value"}}"#;
        let resp: McpResponse = serde_json::from_str(json).unwrap();
        assert!(!resp.is_error());
        assert!(resp.result.is_some());
    }

    #[test]
    fn test_response_deserialize_error() {
        let json =
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"Invalid request"}}"#;
        let resp: McpResponse = serde_json::from_str(json).unwrap();
        assert!(resp.is_error());
        assert_eq!(resp.error.as_ref().unwrap().code, -32600);
    }

    #[test]
    fn test_mcp_tool_to_tool() {
        let mcp_tool = McpTool {
            name: "test_tool".to_string(),
            description: Some("A test tool".to_string()),
            input_schema: Some(serde_json::json!({"type": "object"})),
        };
        let tool = mcp_tool.to_tool("myserver");
        assert_eq!(tool.name, "mcp_myserver_test_tool");
        assert_eq!(tool.description, "A test tool");
    }

    #[test]
    fn test_mcp_content_text() {
        let content = McpContent::Text {
            text: "Hello".to_string(),
        };
        assert_eq!(content.to_string(), "Hello");
    }

    #[test]
    fn test_mcp_tool_result() {
        let result = McpToolResult {
            content: vec![
                McpContent::Text {
                    text: "Line 1".to_string(),
                },
                McpContent::Text {
                    text: "Line 2".to_string(),
                },
            ],
            is_error: false,
        };
        assert_eq!(result.as_string(), "Line 1\nLine 2");
    }
}
