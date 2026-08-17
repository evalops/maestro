use anyhow::Result;
use serde_json::{json, Value};
use tokio::io::{AsyncWrite, AsyncWriteExt};

use super::{
    SafeResult, MAX_COMMAND_BYTES, MAX_OPERATION_ID_BYTES, MCP_PROTOCOL_VERSION, RESULT_SCHEMA,
    TOOL_NAME,
};

pub(super) fn initialize_result() -> Value {
    json!({
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "capabilities": {"tools": {"listChanged": false}},
        "serverInfo": {
            "name": "evalops-platform-tools",
            "version": env!("CARGO_PKG_VERSION")
        }
    })
}

pub(super) fn tool_definition() -> Value {
    json!({
        "name": TOOL_NAME,
        "description": "Execute a shell command only through EvalOps Platform ToolExecution. Platform owns policy, approval, sandbox execution, idempotency, and the durable result; Maestro never runs the command locally. Reuse the same operationId when retrying an ambiguous call.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": false,
            "required": ["operationId", "command"],
            "properties": {
                "operationId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": MAX_OPERATION_ID_BYTES,
                    "pattern": "^[A-Za-z0-9._-]+$",
                    "description": "Stable logical invocation id. Reuse it for retries; choose a new id for an intentionally repeated command."
                },
                "command": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": MAX_COMMAND_BYTES
                },
                "timeoutMs": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 900_000
                }
            }
        },
        "annotations": {
            "title": "Platform-governed shell",
            "readOnlyHint": false,
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false
        }
    })
}

pub(super) fn mcp_tool_result(result: SafeResult) -> Value {
    let text = serde_json::to_string(&result.body).unwrap_or_else(|_| {
        format!(
            "{{\"schema\":\"{RESULT_SCHEMA}\",\"failureCode\":\"result_serialization_failed\"}}"
        )
    });
    json!({
        "content": [{"type": "text", "text": text}],
        "isError": result.is_error
    })
}

pub(super) async fn write_jsonrpc<W: AsyncWrite + Unpin>(
    writer: &mut W,
    value: &Value,
) -> Result<()> {
    writer
        .write_all(serde_json::to_string(value)?.as_bytes())
        .await?;
    writer.write_all(b"\n").await?;
    writer.flush().await?;
    Ok(())
}

pub(super) fn jsonrpc_result(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

pub(super) fn jsonrpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {"code": code, "message": message}
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_schema_requires_a_stable_operation_id() {
        let tool = tool_definition();
        assert_eq!(tool["name"], TOOL_NAME);
        assert!(tool["inputSchema"]["required"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == "operationId"));
        assert_eq!(tool["annotations"]["destructiveHint"], true);
        assert_eq!(tool["annotations"]["idempotentHint"], false);
    }

    #[test]
    fn serialized_tool_errors_remain_structured_and_bounded() {
        let result = mcp_tool_result(SafeResult {
            body: json!({
                "schema": RESULT_SCHEMA,
                "failureCode": "platform_tool_execution_unavailable"
            }),
            is_error: true,
        });
        assert_eq!(result["isError"], true);
        let text = result["content"][0]["text"].as_str().unwrap();
        assert!(text.contains(RESULT_SCHEMA));
        assert!(!text.contains("resumeToken"));
    }
}
