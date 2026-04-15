package com.evalops.composer.api

import okhttp3.Request
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class ComposerApiClientTest {

    @Test
    fun `applyClientHeaders includes composer and maestro client headers`() {
        val request = ComposerApiClient.applyClientHeaders(
            Request.Builder().url("http://localhost:8080/api/models")
        ).build()

        assertEquals("jetbrains", request.header("X-Composer-Client"))
        assertEquals("jetbrains", request.header("X-Maestro-Client"))
        assertEquals("0.10.0", request.header("X-Composer-Client-Version"))
        assertNull(request.header("X-Composer-Client-Tools"))
        assertNull(request.header("X-Maestro-Client-Tools"))
        assertNull(request.header("X-Composer-Slim-Events"))
        assertNull(request.header("X-Maestro-Slim-Events"))
    }

    @Test
    fun `applyClientHeaders opts into client tools and slim events`() {
        val request = ComposerApiClient.applyClientHeaders(
            Request.Builder().url("http://localhost:8080/api/chat"),
            includeClientTools = true,
            includeSlimEvents = true
        ).build()

        assertEquals("1", request.header("X-Composer-Client-Tools"))
        assertEquals("1", request.header("X-Maestro-Client-Tools"))
        assertEquals("1", request.header("X-Composer-Slim-Events"))
        assertEquals("1", request.header("X-Maestro-Slim-Events"))
    }
}
