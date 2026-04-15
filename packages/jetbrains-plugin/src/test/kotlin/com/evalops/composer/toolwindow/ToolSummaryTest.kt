package com.evalops.composer.toolwindow

import com.evalops.composer.api.ComposerToolCall
import com.evalops.composer.api.ToolCallStatus
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class ToolSummaryTest {

    @Test
    fun `summarizes read tool calls with leaf path`() {
        val tool = ComposerToolCall(
            name = "read",
            status = ToolCallStatus.COMPLETED,
            args = mapOf("file_path" to "/workspace/src/package.json")
        )

        assertEquals("Read package.json", summarizeToolCall(tool))
    }

    @Test
    fun `summarizes command tools with command text`() {
        val tool = ComposerToolCall(
            name = "exec_command",
            status = ToolCallStatus.RUNNING,
            args = mapOf("command" to "bun run bun:lint")
        )

        assertEquals("Ran bun run bun:lint", summarizeToolCall(tool))
    }

    @Test
    fun `humanizes unknown mcp tool names`() {
        val tool = ComposerToolCall(
            name = "mcp__filesystem__read_file",
            status = ToolCallStatus.COMPLETED,
            args = emptyMap()
        )

        assertEquals("Ran read file", summarizeToolCall(tool))
    }
}
