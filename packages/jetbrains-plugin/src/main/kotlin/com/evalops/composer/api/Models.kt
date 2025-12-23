package com.evalops.composer.api

import com.google.gson.annotations.SerializedName

/**
 * Message role in the conversation.
 */
enum class MessageRole {
    @SerializedName("user") USER,
    @SerializedName("assistant") ASSISTANT,
    @SerializedName("system") SYSTEM,
    @SerializedName("tool") TOOL
}

/**
 * Thinking level for extended reasoning.
 */
enum class ThinkingLevel {
    @SerializedName("off") OFF,
    @SerializedName("minimal") MINIMAL,
    @SerializedName("low") LOW,
    @SerializedName("medium") MEDIUM,
    @SerializedName("high") HIGH
}

/**
 * Tool call status.
 */
enum class ToolCallStatus {
    @SerializedName("pending") PENDING,
    @SerializedName("running") RUNNING,
    @SerializedName("completed") COMPLETED,
    @SerializedName("error") ERROR
}

/**
 * Content block types for rich message payloads.
 */
sealed class ContentBlock {
    data class Text(
        val type: String = "text",
        val text: String
    ) : ContentBlock()

    data class Image(
        val type: String = "image",
        val data: String,
        val mimeType: String
    ) : ContentBlock()

    data class Thinking(
        val type: String = "thinking",
        val thinking: String
    ) : ContentBlock()

    data class ToolCall(
        val type: String = "toolCall",
        val id: String,
        val name: String,
        val arguments: Map<String, Any?>
    ) : ContentBlock()
}

/**
 * Tool call within a message.
 */
data class ComposerToolCall(
    val name: String,
    val status: ToolCallStatus,
    val args: Map<String, Any?>? = null,
    val result: Any? = null,
    val toolCallId: String? = null
)

/**
 * Token usage statistics.
 */
data class ComposerUsage(
    val input: Int,
    val output: Int,
    val cacheRead: Int? = null,
    val cacheWrite: Int? = null,
    val cost: ComposerUsageCost? = null
)

/**
 * Cost breakdown for token usage.
 */
data class ComposerUsageCost(
    val input: Double,
    val output: Double,
    val cacheRead: Double? = null,
    val cacheWrite: Double? = null,
    val total: Double? = null
)

/**
 * A message in the Composer conversation.
 */
data class ComposerMessage(
    val role: MessageRole,
    val content: Any, // String or List<ContentBlock>
    val timestamp: String? = null,
    val thinking: String? = null,
    val tools: List<ComposerToolCall>? = null,
    val toolName: String? = null,
    val isError: Boolean? = null,
    val usage: ComposerUsage? = null
) {
    /**
     * Get content as string, extracting text from content blocks if needed.
     */
    fun getContentText(): String {
        return when (content) {
            is String -> content
            is List<*> -> {
                @Suppress("UNCHECKED_CAST")
                (content as? List<Map<String, Any?>>)
                    ?.filter { it["type"] == "text" }
                    ?.mapNotNull { it["text"] as? String }
                    ?.joinToString("\n")
                    ?: ""
            }
            else -> content.toString()
        }
    }
}

/**
 * Request payload for chat API.
 */
data class ChatRequest(
    val messages: List<ComposerMessage>,
    val model: String? = null,
    val thinkingLevel: ThinkingLevel? = null,
    val sessionId: String? = null,
    val stream: Boolean = true
)

/**
 * Session summary without full message history.
 */
data class SessionSummary(
    val id: String,
    val title: String? = null,
    val createdAt: String,
    val updatedAt: String,
    val messageCount: Int,
    val favorite: Boolean? = null,
    val tags: List<String>? = null
)

/**
 * Full session data including message history.
 */
data class Session(
    val id: String,
    val title: String? = null,
    val createdAt: String,
    val updatedAt: String,
    val messageCount: Int,
    val messages: List<ComposerMessage>,
    val favorite: Boolean? = null,
    val tags: List<String>? = null
)

/**
 * Model information.
 */
data class Model(
    val id: String,
    val provider: String,
    val name: String,
    val contextWindow: Int? = null,
    val maxOutputTokens: Int? = null
)

/**
 * Client tool result to send back to server.
 */
data class ClientToolResult(
    val toolCallId: String,
    val content: List<Map<String, Any?>>,
    val isError: Boolean
)

/**
 * Approval decision for action approval requests.
 */
data class ApprovalDecision(
    val requestId: String,
    val decision: String // "approved" or "denied"
)

/**
 * Agent events received via SSE.
 */
sealed class AgentEvent {
    data class AgentStart(val type: String = "agent_start") : AgentEvent()

    data class AgentEnd(
        val type: String = "agent_end",
        val messages: List<ComposerMessage>? = null,
        val aborted: Boolean? = null
    ) : AgentEvent()

    data class MessageStart(
        val type: String = "message_start",
        val message: ComposerMessage
    ) : AgentEvent()

    data class MessageUpdate(
        val type: String = "message_update",
        val message: ComposerMessage,
        val assistantMessageEvent: Map<String, Any?>? = null
    ) : AgentEvent()

    data class MessageEnd(
        val type: String = "message_end",
        val message: ComposerMessage
    ) : AgentEvent()

    data class ToolExecutionStart(
        val type: String = "tool_execution_start",
        val toolCallId: String,
        val toolName: String,
        val args: Map<String, Any?>
    ) : AgentEvent()

    data class ToolExecutionEnd(
        val type: String = "tool_execution_end",
        val toolCallId: String,
        val toolName: String,
        val result: Any?,
        val isError: Boolean
    ) : AgentEvent()

    data class ClientToolRequest(
        val type: String = "client_tool_request",
        val toolCallId: String,
        val toolName: String,
        val args: Map<String, Any?>?
    ) : AgentEvent()

    data class ActionApprovalRequired(
        val type: String = "action_approval_required",
        val request: Map<String, Any?>
    ) : AgentEvent()

    data class ActionApprovalResolved(
        val type: String = "action_approval_resolved",
        val request: Map<String, Any?>,
        val decision: Map<String, Any?>
    ) : AgentEvent()

    data class Error(
        val type: String = "error",
        val message: String
    ) : AgentEvent()

    data class Heartbeat(val type: String = "heartbeat") : AgentEvent()

    data class Aborted(val type: String = "aborted") : AgentEvent()

    data class Unknown(val type: String, val raw: String) : AgentEvent()
}

/**
 * Diagnostic information from IDE.
 */
data class DiagnosticInfo(
    val message: String,
    val severity: Int,
    val range: DiagnosticRange,
    val source: String? = null,
    val code: String? = null
)

/**
 * Range within a document.
 */
data class DiagnosticRange(
    val start: DiagnosticPosition,
    val end: DiagnosticPosition
)

/**
 * Position within a document.
 */
data class DiagnosticPosition(
    val line: Int,
    val character: Int
)

/**
 * Location information for definitions/references.
 */
data class LocationInfo(
    val uri: String,
    val range: DiagnosticRange
)
