package com.evalops.composer

import maestro.v1.Headless
import maestro.v1.helloMessage
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class HeadlessProtoGenerationTest {

    @Test
    fun `generated Kotlin DSL builds headless hello message`() {
        val message = helloMessage {
            protocolVersion = "2026-04-02"
        }

        assertEquals("2026-04-02", message.protocolVersion)
        assertEquals(Headless.HelloMessage::class.java, message::class.java)
    }
}
