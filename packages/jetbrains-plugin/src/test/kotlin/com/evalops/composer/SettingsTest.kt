package com.evalops.composer

import com.evalops.composer.settings.ComposerSettings
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*

/**
 * Tests for plugin settings defaults and serialization.
 */
class SettingsTest {

    @Test
    fun `default settings have expected values`() {
        val settings = ComposerSettings()

        assertEquals("http://localhost:8080", settings.apiEndpoint)
        assertEquals("claude-sonnet-4-5", settings.defaultModel)
        assertEquals("off", settings.defaultThinkingLevel)
        assertEquals(50000, settings.maxContextSize)
        assertTrue(settings.autoInjectActiveFile)
        assertTrue(settings.showThinkingBlocks)
        assertTrue(settings.showToolDetails)
        assertEquals(30, settings.connectionTimeout)
    }

    @Test
    fun `settings can be modified`() {
        val settings = ComposerSettings()

        settings.apiEndpoint = "http://custom:9090"
        settings.defaultModel = "gpt-4"
        settings.maxContextSize = 100000
        settings.autoInjectActiveFile = false

        assertEquals("http://custom:9090", settings.apiEndpoint)
        assertEquals("gpt-4", settings.defaultModel)
        assertEquals(100000, settings.maxContextSize)
        assertFalse(settings.autoInjectActiveFile)
    }

    @Test
    fun `getState returns self`() {
        val settings = ComposerSettings()
        assertSame(settings, settings.state)
    }
}
