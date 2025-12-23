package com.evalops.composer

import com.evalops.composer.api.*
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*

/**
 * Tests for data models and JSON serialization.
 */
class ModelsTest {

    private val gson: Gson = GsonBuilder().setLenient().create()

    @Test
    fun `MessageRole serialization works correctly`() {
        assertEquals("\"user\"", gson.toJson(MessageRole.USER))
        assertEquals("\"assistant\"", gson.toJson(MessageRole.ASSISTANT))
        assertEquals("\"system\"", gson.toJson(MessageRole.SYSTEM))
        assertEquals("\"tool\"", gson.toJson(MessageRole.TOOL))
    }

    @Test
    fun `ThinkingLevel serialization works correctly`() {
        assertEquals("\"off\"", gson.toJson(ThinkingLevel.OFF))
        assertEquals("\"high\"", gson.toJson(ThinkingLevel.HIGH))
    }

    @Test
    fun `ComposerMessage getContentText returns string content`() {
        val message = ComposerMessage(
            role = MessageRole.ASSISTANT,
            content = "Hello, world!"
        )
        assertEquals("Hello, world!", message.getContentText())
    }

    @Test
    fun `ComposerMessage getContentText extracts text from content blocks`() {
        val message = ComposerMessage(
            role = MessageRole.ASSISTANT,
            content = listOf(
                mapOf("type" to "text", "text" to "First part"),
                mapOf("type" to "text", "text" to "Second part"),
                mapOf("type" to "image", "data" to "base64...")
            )
        )
        assertEquals("First part\nSecond part", message.getContentText())
    }

    @Test
    fun `ChatRequest serialization includes all fields`() {
        val request = ChatRequest(
            messages = listOf(
                ComposerMessage(
                    role = MessageRole.USER,
                    content = "Hello"
                )
            ),
            model = "claude-sonnet-4-5",
            thinkingLevel = ThinkingLevel.MEDIUM,
            sessionId = "test-session",
            stream = true
        )

        val json = gson.toJson(request)
        assertTrue(json.contains("\"model\":\"claude-sonnet-4-5\""))
        assertTrue(json.contains("\"stream\":true"))
        assertTrue(json.contains("\"sessionId\":\"test-session\""))
    }

    @Test
    fun `Session deserialization works correctly`() {
        val json = """
            {
                "id": "sess-123",
                "title": "Test Session",
                "createdAt": "2024-01-01T00:00:00Z",
                "updatedAt": "2024-01-01T01:00:00Z",
                "messageCount": 5,
                "messages": [],
                "favorite": false,
                "tags": ["test"]
            }
        """.trimIndent()

        val session = gson.fromJson(json, Session::class.java)
        assertEquals("sess-123", session.id)
        assertEquals("Test Session", session.title)
        assertEquals(5, session.messageCount)
        assertEquals(listOf("test"), session.tags)
    }

    @Test
    fun `DiagnosticInfo structure is correct`() {
        val diagnostic = DiagnosticInfo(
            message = "Unused variable",
            severity = 2,
            range = DiagnosticRange(
                start = DiagnosticPosition(10, 5),
                end = DiagnosticPosition(10, 15)
            ),
            source = "kotlin",
            code = "UNUSED_VARIABLE"
        )

        assertEquals("Unused variable", diagnostic.message)
        assertEquals(10, diagnostic.range.start.line)
        assertEquals(5, diagnostic.range.start.character)
    }

    @Test
    fun `LocationInfo serialization works`() {
        val location = LocationInfo(
            uri = "/path/to/file.kt",
            range = DiagnosticRange(
                start = DiagnosticPosition(0, 0),
                end = DiagnosticPosition(0, 10)
            )
        )

        val json = gson.toJson(location)
        assertTrue(json.contains("\"/path/to/file.kt\""))
    }

    @Test
    fun `AgentEvent types are distinguishable`() {
        val start = AgentEvent.AgentStart()
        val end = AgentEvent.AgentEnd()
        val error = AgentEvent.Error(message = "Test error")
        val heartbeat = AgentEvent.Heartbeat()

        assertTrue(start is AgentEvent.AgentStart)
        assertTrue(end is AgentEvent.AgentEnd)
        assertTrue(error is AgentEvent.Error)
        assertEquals("Test error", error.message)
        assertTrue(heartbeat is AgentEvent.Heartbeat)
    }

    @Test
    fun `ClientToolResult serialization includes all fields`() {
        val result = ClientToolResult(
            toolCallId = "call-123",
            content = listOf(mapOf("type" to "text", "text" to "Result")),
            isError = false
        )

        val json = gson.toJson(result)
        assertTrue(json.contains("\"toolCallId\":\"call-123\""))
        assertTrue(json.contains("\"isError\":false"))
    }
}
