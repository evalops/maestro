package com.evalops.composer.settings

import com.evalops.composer.services.ComposerApplicationService
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.dsl.builder.*
import javax.swing.JComponent

/**
 * Settings UI for the Composer plugin.
 */
class ComposerSettingsConfigurable : Configurable {

    private var panel: DialogPanel? = null
    private val settings = ComposerSettings.getInstance()

    // Local state for form binding
    private var apiEndpoint: String = settings.apiEndpoint
    private var defaultModel: String = settings.defaultModel
    private var defaultThinkingLevel: String = settings.defaultThinkingLevel
    private var maxContextSize: Int = settings.maxContextSize
    private var autoInjectActiveFile: Boolean = settings.autoInjectActiveFile
    private var showThinkingBlocks: Boolean = settings.showThinkingBlocks
    private var showToolDetails: Boolean = settings.showToolDetails
    private var connectionTimeout: Int = settings.connectionTimeout

    override fun getDisplayName(): String = "Composer"

    override fun createComponent(): JComponent {
        panel = panel {
            group("Server Connection") {
                row("API Endpoint:") {
                    textField()
                        .bindText(::apiEndpoint)
                        .comment("URL of the Composer server (e.g., http://localhost:8080)")
                        .columns(COLUMNS_LARGE)
                }
                row("Connection Timeout:") {
                    intTextField(1..300)
                        .bindIntText(::connectionTimeout)
                        .comment("Timeout in seconds")
                }
            }

            group("Model Settings") {
                row("Default Model:") {
                    textField()
                        .bindText(::defaultModel)
                        .comment("Model ID to use for chat (e.g., claude-sonnet-4-5)")
                        .columns(COLUMNS_MEDIUM)
                }
                row("Thinking Level:") {
                    comboBox(listOf("off", "minimal", "low", "medium", "high"))
                        .bindItem(::defaultThinkingLevel.toNullableProperty())
                        .comment("Extended reasoning level for supported models")
                }
            }

            group("Context Settings") {
                row("Max Context Size:") {
                    intTextField(1000..500000)
                        .bindIntText(::maxContextSize)
                        .comment("Maximum characters to inject as context")
                }
                row {
                    checkBox("Auto-inject active file on first message")
                        .bindSelected(::autoInjectActiveFile)
                }
            }

            group("Display Settings") {
                row {
                    checkBox("Show thinking blocks")
                        .bindSelected(::showThinkingBlocks)
                        .comment("Display model reasoning in the UI")
                }
                row {
                    checkBox("Show tool execution details")
                        .bindSelected(::showToolDetails)
                        .comment("Display tool names and arguments")
                }
            }
        }
        return panel ?: throw IllegalStateException("Panel was not created")
    }

    override fun isModified(): Boolean {
        return apiEndpoint != settings.apiEndpoint ||
                defaultModel != settings.defaultModel ||
                defaultThinkingLevel != settings.defaultThinkingLevel ||
                maxContextSize != settings.maxContextSize ||
                autoInjectActiveFile != settings.autoInjectActiveFile ||
                showThinkingBlocks != settings.showThinkingBlocks ||
                showToolDetails != settings.showToolDetails ||
                connectionTimeout != settings.connectionTimeout
    }

    override fun apply() {
        val endpointChanged = apiEndpoint != settings.apiEndpoint
        val timeoutChanged = connectionTimeout != settings.connectionTimeout

        settings.apiEndpoint = apiEndpoint
        settings.defaultModel = defaultModel
        settings.defaultThinkingLevel = defaultThinkingLevel
        settings.maxContextSize = maxContextSize
        settings.autoInjectActiveFile = autoInjectActiveFile
        settings.showThinkingBlocks = showThinkingBlocks
        settings.showToolDetails = showToolDetails
        settings.connectionTimeout = connectionTimeout

        // Refresh connection if endpoint changed
        if (endpointChanged || timeoutChanged) {
            ApplicationManager.getApplication().executeOnPooledThread {
                ComposerApplicationService.getInstance().refreshConnection()
            }
        }
    }

    override fun reset() {
        apiEndpoint = settings.apiEndpoint
        defaultModel = settings.defaultModel
        defaultThinkingLevel = settings.defaultThinkingLevel
        maxContextSize = settings.maxContextSize
        autoInjectActiveFile = settings.autoInjectActiveFile
        showThinkingBlocks = settings.showThinkingBlocks
        showToolDetails = settings.showToolDetails
        connectionTimeout = settings.connectionTimeout
        panel?.reset()
    }

    override fun disposeUIResources() {
        panel = null
    }
}
