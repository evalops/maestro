package com.evalops.composer.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.util.xmlb.XmlSerializerUtil

/**
 * Persistent settings for the Composer plugin.
 */
@State(
    name = "com.evalops.composer.settings.ComposerSettings",
    storages = [Storage("ComposerSettings.xml")]
)
class ComposerSettings : PersistentStateComponent<ComposerSettings> {

    /**
     * URL of the Composer API server.
     */
    var apiEndpoint: String = "http://localhost:8080"

    /**
     * Default model ID to use for chat.
     */
    var defaultModel: String = "claude-sonnet-4-5"

    /**
     * Default thinking level for extended reasoning.
     */
    var defaultThinkingLevel: String = "off"

    /**
     * Maximum context size in characters to inject.
     */
    var maxContextSize: Int = 50000

    /**
     * Whether to auto-inject active file context on first message.
     */
    var autoInjectActiveFile: Boolean = true

    /**
     * Whether to show thinking blocks in the UI.
     */
    var showThinkingBlocks: Boolean = true

    /**
     * Whether to show tool execution details in the UI.
     */
    var showToolDetails: Boolean = true

    /**
     * Connection timeout in seconds.
     */
    var connectionTimeout: Int = 30

    override fun getState(): ComposerSettings = this

    override fun loadState(state: ComposerSettings) {
        XmlSerializerUtil.copyBean(state, this)
    }

    companion object {
        fun getInstance(): ComposerSettings {
            return ApplicationManager.getApplication().getService(ComposerSettings::class.java)
        }
    }
}
