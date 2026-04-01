package com.evalops.composer.services

import com.evalops.composer.api.AgentEvent
import com.evalops.composer.api.ComposerMessage
import com.evalops.composer.api.ComposerToolCall
import com.evalops.composer.api.MessageRole
import com.evalops.composer.api.ToolCallStatus
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Test

class LiveToolStateTest {

    @Test
    fun `tool execution start adds a running tool to the last assistant message`() {
        val messages = listOf(
            ComposerMessage(role = MessageRole.USER, content = "Hello"),
            ComposerMessage(role = MessageRole.ASSISTANT, content = "Working...")
        )

        val updated = applyLiveToolEvent(
            messages,
            AgentEvent.ToolExecutionStart(
                toolCallId = "call-1",
                toolName = "read",
                args = mapOf("file_path" to "/tmp/package.json")
            )
        )

        val assistant = updated.last()
        assertEquals(1, assistant.tools?.size)
        assertEquals(
            ComposerToolCall(
                name = "read",
                status = ToolCallStatus.RUNNING,
                args = mapOf("file_path" to "/tmp/package.json"),
                toolCallId = "call-1"
            ),
            assistant.tools?.single()
        )
    }

    @Test
    fun `tool execution end updates an existing live tool`() {
        val messages = listOf(
            ComposerMessage(
                role = MessageRole.ASSISTANT,
                content = "Working...",
                tools = listOf(
                    ComposerToolCall(
                        name = "read",
                        status = ToolCallStatus.RUNNING,
                        args = mapOf("file_path" to "/tmp/package.json"),
                        toolCallId = "call-1"
                    )
                )
            )
        )

        val updated = applyLiveToolEvent(
            messages,
            AgentEvent.ToolExecutionEnd(
                toolCallId = "call-1",
                toolName = "read",
                result = "done",
                isError = false
            )
        )

        assertEquals(
            ComposerToolCall(
                name = "read",
                status = ToolCallStatus.COMPLETED,
                args = mapOf("file_path" to "/tmp/package.json"),
                result = "done",
                toolCallId = "call-1"
            ),
            updated.last().tools?.single()
        )
    }

    @Test
    fun `tool execution end appends a completed tool when no live entry exists`() {
        val messages = listOf(
            ComposerMessage(role = MessageRole.ASSISTANT, content = "Working...")
        )

        val updated = applyLiveToolEvent(
            messages,
            AgentEvent.ToolExecutionEnd(
                toolCallId = "call-2",
                toolName = "bash",
                result = "ok",
                isError = false
            )
        )

        assertEquals(1, updated.last().tools?.size)
        assertEquals(
            ComposerToolCall(
                name = "bash",
                status = ToolCallStatus.COMPLETED,
                result = "ok",
                toolCallId = "call-2"
            ),
            updated.last().tools?.single()
        )
    }

    @Test
    fun `non tool events leave the messages untouched`() {
        val messages = listOf(
            ComposerMessage(role = MessageRole.USER, content = "Hello")
        )

        val updated = applyLiveToolEvent(messages, AgentEvent.Heartbeat())

        assertSame(messages, updated)
    }
}
