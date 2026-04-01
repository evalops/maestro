package com.evalops.composer.services

import com.evalops.composer.api.AgentEvent
import com.evalops.composer.api.ComposerMessage
import com.evalops.composer.api.ComposerToolCall
import com.evalops.composer.api.MessageRole
import com.evalops.composer.api.ToolCallStatus

internal fun applyLiveToolEvent(
    messages: List<ComposerMessage>,
    event: AgentEvent
): List<ComposerMessage> {
    val assistantIndex = messages.indexOfLast { it.role == MessageRole.ASSISTANT }
    if (assistantIndex == -1) {
        return messages
    }

    val assistant = messages[assistantIndex]
    val updatedAssistant = when (event) {
        is AgentEvent.ToolExecutionStart -> assistant.withUpsertedTool(
            ComposerToolCall(
                name = event.toolName,
                status = ToolCallStatus.RUNNING,
                args = event.args,
                toolCallId = event.toolCallId
            )
        )
        is AgentEvent.ToolExecutionEnd -> assistant.withUpsertedTool(
            ComposerToolCall(
                name = event.toolName,
                status = if (event.isError) ToolCallStatus.ERROR else ToolCallStatus.COMPLETED,
                result = event.result,
                toolCallId = event.toolCallId
            )
        )
        else -> return messages
    }

    if (updatedAssistant == assistant) {
        return messages
    }

    return messages.toMutableList().apply {
        this[assistantIndex] = updatedAssistant
    }
}

private fun ComposerMessage.withUpsertedTool(tool: ComposerToolCall): ComposerMessage {
    val currentTools = tools.orEmpty()
    val existingIndex = currentTools.indexOfFirst { it.toolCallId == tool.toolCallId }
    val nextTools = currentTools.toMutableList()

    if (existingIndex >= 0) {
        val existing = nextTools[existingIndex]
        nextTools[existingIndex] = existing.copy(
            name = tool.name,
            status = tool.status,
            args = tool.args ?: existing.args,
            result = tool.result ?: existing.result,
            toolCallId = tool.toolCallId ?: existing.toolCallId
        )
    } else {
        nextTools.add(tool)
    }

    return copy(tools = nextTools)
}
