package com.evalops.composer.toolwindow

import com.evalops.composer.api.AgentEvent
import com.evalops.composer.api.ComposerMessage
import com.evalops.composer.api.MessageRole
import com.evalops.composer.services.ComposerApplicationService
import com.evalops.composer.services.ComposerProjectService
import com.evalops.composer.settings.ComposerSettings
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.*
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.openapi.wm.WindowManager
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.*
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import javax.swing.*
import javax.swing.border.EmptyBorder

/**
 * Main panel for the Composer tool window.
 */
class ComposerPanel(private val project: Project) : SimpleToolWindowPanel(true, true) {

    private val projectService = ComposerProjectService.getInstance(project)
    private val appService = ComposerApplicationService.getInstance()
    private val settings = ComposerSettings.getInstance()

    private val messagesPanel = JPanel()
    private val messagesScrollPane: JBScrollPane
    private val inputArea = JBTextArea(3, 40)
    private val sendButton = JButton("Send")
    private val statusLabel = JBLabel("Disconnected")

    init {
        // Messages panel setup
        messagesPanel.layout = BoxLayout(messagesPanel, BoxLayout.Y_AXIS)
        messagesPanel.background = UIUtil.getPanelBackground()
        messagesScrollPane = JBScrollPane(messagesPanel)
        messagesScrollPane.border = null
        messagesScrollPane.verticalScrollBarPolicy = ScrollPaneConstants.VERTICAL_SCROLLBAR_AS_NEEDED

        // Input area setup
        inputArea.lineWrap = true
        inputArea.wrapStyleWord = true
        inputArea.border = JBUI.Borders.empty(8)
        inputArea.addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                if (e.keyCode == KeyEvent.VK_ENTER && e.isControlDown) {
                    sendMessage()
                    e.consume()
                }
            }
        })

        // Send button
        sendButton.addActionListener { sendMessage() }

        // Build input panel
        val inputPanel = JPanel(BorderLayout())
        inputPanel.border = JBUI.Borders.empty(8)

        val inputScrollPane = JBScrollPane(inputArea)
        inputScrollPane.preferredSize = Dimension(0, 80)

        val buttonPanel = JPanel(FlowLayout(FlowLayout.RIGHT))
        buttonPanel.add(sendButton)

        inputPanel.add(inputScrollPane, BorderLayout.CENTER)
        inputPanel.add(buttonPanel, BorderLayout.SOUTH)

        // Status bar
        val statusBar = JPanel(BorderLayout())
        statusBar.border = JBUI.Borders.empty(4, 8)
        statusLabel.font = statusLabel.font.deriveFont(11f)
        statusBar.add(statusLabel, BorderLayout.WEST)

        // Bottom panel combines status bar and input
        val bottomPanel = JPanel(BorderLayout())
        bottomPanel.add(statusBar, BorderLayout.NORTH)
        bottomPanel.add(inputPanel, BorderLayout.CENTER)

        // Main layout
        val mainPanel = JPanel(BorderLayout())
        mainPanel.add(messagesScrollPane, BorderLayout.CENTER)
        mainPanel.add(bottomPanel, BorderLayout.SOUTH)

        setContent(mainPanel)
        toolbar = createToolbar()

        // Register listeners
        projectService.addMessageListener { messages -> updateMessages(messages) }
        projectService.addProcessingListener { processing -> updateProcessingState(processing) }
        appService.addConnectionListener { connected -> updateConnectionState(connected) }

        // Initial state
        refreshConnection()
        updateMessages(projectService.messages)
    }

    private fun createToolbar(): JComponent {
        val actionGroup = DefaultActionGroup().apply {
            add(RefreshAction())
            add(ClearAction())
            addSeparator()
            add(SessionsAction())
            add(SettingsAction())
        }

        val toolbar = ActionManager.getInstance()
            .createActionToolbar("ComposerToolbar", actionGroup, true)
        toolbar.targetComponent = this
        return toolbar.component
    }

    private fun sendMessage() {
        val text = inputArea.text.trim()
        if (text.isEmpty()) return
        if (projectService.isProcessing) return

        inputArea.text = ""

        // Get active file for context
        val activeFile = FileEditorManager.getInstance(project).selectedFiles.firstOrNull()

        projectService.sendMessage(text, activeFile)
    }

    private fun updateMessages(messages: List<ComposerMessage>) {
        ApplicationManager.getApplication().invokeLater {
            messagesPanel.removeAll()

            for (message in messages) {
                val bubble = createMessageBubble(message)
                messagesPanel.add(bubble)
                messagesPanel.add(Box.createVerticalStrut(8))
            }

            messagesPanel.add(Box.createVerticalGlue())
            messagesPanel.revalidate()
            messagesPanel.repaint()

            // Scroll to bottom
            SwingUtilities.invokeLater {
                val scrollBar = messagesScrollPane.verticalScrollBar
                scrollBar.value = scrollBar.maximum
            }
        }
    }

    private fun createMessageBubble(message: ComposerMessage): JPanel {
        val isUser = message.role == MessageRole.USER
        val isAssistant = message.role == MessageRole.ASSISTANT

        val bubble = JPanel(BorderLayout())
        bubble.border = JBUI.Borders.empty(8, 12)

        val bgColor = when {
            isUser -> JBColor(Color(0xE3F2FD), Color(0x1E3A5F))
            isAssistant -> JBColor(Color(0xF5F5F5), Color(0x2B2B2B))
            else -> UIUtil.getPanelBackground()
        }
        bubble.background = bgColor

        // Role label
        val roleLabel = JBLabel(if (isUser) "You" else "Assistant")
        roleLabel.font = roleLabel.font.deriveFont(Font.BOLD, 12f)
        roleLabel.border = JBUI.Borders.emptyBottom(4)

        // Content
        val contentText = message.getContentText()
        val contentArea = JBTextArea(contentText)
        contentArea.isEditable = false
        contentArea.lineWrap = true
        contentArea.wrapStyleWord = true
        contentArea.background = bgColor
        contentArea.border = null
        contentArea.font = UIUtil.getLabelFont()

        // Tool calls indicator
        val toolsPanel = JPanel()
        toolsPanel.layout = BoxLayout(toolsPanel, BoxLayout.Y_AXIS)
        toolsPanel.background = bgColor

        if (settings.showToolDetails) {
            message.tools?.forEach { tool ->
                val toolLabel = JBLabel("${tool.name}: ${tool.status}")
                toolLabel.icon = when (tool.status.name) {
                    "COMPLETED" -> AllIcons.Actions.Commit
                    "ERROR" -> AllIcons.General.Error
                    "RUNNING" -> AllIcons.Process.Step_1
                    else -> AllIcons.Actions.Execute
                }
                toolLabel.font = toolLabel.font.deriveFont(11f)
                toolsPanel.add(toolLabel)
            }
        }

        // Thinking indicator
        if (settings.showThinkingBlocks && !message.thinking.isNullOrEmpty()) {
            val thinkingLabel = JBLabel("Thinking...")
            thinkingLabel.icon = AllIcons.Actions.IntentionBulb
            thinkingLabel.font = thinkingLabel.font.deriveFont(Font.ITALIC, 11f)
            thinkingLabel.foreground = JBColor.GRAY
            toolsPanel.add(thinkingLabel)
        }

        bubble.add(roleLabel, BorderLayout.NORTH)
        bubble.add(contentArea, BorderLayout.CENTER)
        if (toolsPanel.componentCount > 0) {
            bubble.add(toolsPanel, BorderLayout.SOUTH)
        }

        // Wrap in a panel that constrains width
        val wrapper = JPanel(BorderLayout())
        wrapper.maximumSize = Dimension(Int.MAX_VALUE, Int.MAX_VALUE)
        wrapper.add(bubble, if (isUser) BorderLayout.EAST else BorderLayout.WEST)

        return wrapper
    }

    private fun updateProcessingState(processing: Boolean) {
        ApplicationManager.getApplication().invokeLater {
            sendButton.isEnabled = !processing
            inputArea.isEnabled = !processing
            sendButton.text = if (processing) "Processing..." else "Send"
        }
    }

    private fun updateConnectionState(connected: Boolean) {
        ApplicationManager.getApplication().invokeLater {
            statusLabel.text = if (connected) "Connected to ${settings.apiEndpoint}" else "Disconnected"
            statusLabel.icon = if (connected) AllIcons.General.InspectionsOK else AllIcons.General.Error
        }
    }

    private fun refreshConnection() {
        ApplicationManager.getApplication().executeOnPooledThread {
            appService.refreshConnection()
        }
    }

    // Toolbar actions

    private inner class RefreshAction : AnAction("Refresh", "Refresh connection", AllIcons.Actions.Refresh) {
        override fun actionPerformed(e: AnActionEvent) {
            refreshConnection()
        }
    }

    private inner class ClearAction : AnAction("Clear Chat", "Clear current chat", AllIcons.Actions.GC) {
        override fun actionPerformed(e: AnActionEvent) {
            projectService.clearChat()
        }
    }

    private inner class SessionsAction : AnAction("Sessions", "Switch session", AllIcons.Vcs.History) {
        override fun actionPerformed(e: AnActionEvent) {
            showSessionPicker()
        }
    }

    private inner class SettingsAction : AnAction("Settings", "Open settings", AllIcons.General.Settings) {
        override fun actionPerformed(e: AnActionEvent) {
            com.intellij.openapi.options.ShowSettingsUtil.getInstance()
                .showSettingsDialog(project, "Composer")
        }
    }

    private fun showSessionPicker() {
        ApplicationManager.getApplication().executeOnPooledThread {
            val sessions = appService.listSessions()
            val parentWindow = WindowManager.getInstance().getFrame(project)

            if (sessions.isEmpty()) {
                ApplicationManager.getApplication().invokeLater {
                    JOptionPane.showMessageDialog(
                        parentWindow,
                        "No sessions found.",
                        "Sessions",
                        JOptionPane.INFORMATION_MESSAGE
                    )
                }
                return@executeOnPooledThread
            }

            ApplicationManager.getApplication().invokeLater {
                val options = sessions.map { "${it.title ?: it.id} (${it.messageCount} messages)" }.toTypedArray()
                val selection = JOptionPane.showInputDialog(
                    parentWindow,
                    "Select a session to resume:",
                    "Switch Session",
                    JOptionPane.QUESTION_MESSAGE,
                    null,
                    options,
                    options.firstOrNull()
                )

                if (selection != null) {
                    val index = options.indexOf(selection)
                    if (index >= 0) {
                        projectService.switchSession(sessions[index].id)
                    }
                }
            }
        }
    }
}
