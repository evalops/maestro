package com.evalops.composer.toolwindow

import com.evalops.composer.api.AgentEvent
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class RuntimeStatusTest {

    @Test
    fun `formats compacting status events`() {
        val event = AgentEvent.Status(status = "compacting")
        assertEquals("Compacting conversation...", formatRuntimeStatus(event))
    }

    @Test
    fun `trims status values before formatting`() {
        val event = AgentEvent.Status(status = " compacting ")
        assertEquals("Compacting conversation...", formatRuntimeStatus(event))
    }

    @Test
    fun `formats compaction events`() {
        val event = AgentEvent.Compaction(
            summary = "Summary",
            firstKeptEntryIndex = 4,
            tokensBefore = 1200,
            auto = true,
            timestamp = "2026-04-01T00:00:00Z"
        )
        assertEquals("Compacted conversation automatically", formatRuntimeStatus(event))
    }

    @Test
    fun `ignores unrelated events`() {
        assertNull(formatRuntimeStatus(AgentEvent.AgentStart()))
    }
}
