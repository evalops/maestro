package com.evalops.composer.services

import com.evalops.composer.api.*
import com.evalops.composer.settings.ComposerSettings
import com.evalops.composer.tools.ClientToolExecutor
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectRootManager
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import kotlinx.coroutines.*
import okhttp3.sse.EventSource
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Project-level service for Composer.
 * Manages chat state, sessions, and pinned files for a specific project.
 */
@Service(Service.Level.PROJECT)
class ComposerProjectService(private val project: Project) : Disposable {

    private val logger = Logger.getInstance(ComposerProjectService::class.java)
    private val settings = ComposerSettings.getInstance()
    private val appService = ComposerApplicationService.getInstance()
    private val toolExecutor = ClientToolExecutor(project)

    private val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())

    private var _currentSessionId: String? = null
    private val messagesLock = Any()
    private var _messages: MutableList<ComposerMessage> = mutableListOf()
    private var _pinnedFiles: MutableSet<String> = CopyOnWriteArraySet()
    private val isProcessingFlag = AtomicBoolean(false)
    private var _currentEventSource: EventSource? = null

    private val messageListeners = CopyOnWriteArrayList<(List<ComposerMessage>) -> Unit>()
    private val processingListeners = CopyOnWriteArrayList<(Boolean) -> Unit>()
    private val eventListeners = CopyOnWriteArrayList<(AgentEvent) -> Unit>()

    /**
     * Current session ID.
     */
    val currentSessionId: String?
        get() = _currentSessionId

    /**
     * All messages in the current session.
     */
    val messages: List<ComposerMessage>
        get() = synchronized(messagesLock) {
            _messages.toList()
        }

    /**
     * Currently pinned file paths.
     */
    val pinnedFiles: Set<String>
        get() = _pinnedFiles.toSet()

    /**
     * Whether a request is currently being processed.
     */
    val isProcessing: Boolean
        get() = isProcessingFlag.get()

    /**
     * Add a listener for message updates.
     */
    fun addMessageListener(listener: (List<ComposerMessage>) -> Unit) {
        messageListeners.add(listener)
    }

    /**
     * Remove a message listener.
     */
    fun removeMessageListener(listener: (List<ComposerMessage>) -> Unit) {
        messageListeners.remove(listener)
    }

    /**
     * Add a listener for processing state changes.
     */
    fun addProcessingListener(listener: (Boolean) -> Unit) {
        processingListeners.add(listener)
    }

    /**
     * Remove a processing listener.
     */
    fun removeProcessingListener(listener: (Boolean) -> Unit) {
        processingListeners.remove(listener)
    }

    /**
     * Add a listener for agent events.
     */
    fun addEventListener(listener: (AgentEvent) -> Unit) {
        eventListeners.add(listener)
    }

    /**
     * Remove an event listener.
     */
    fun removeEventListener(listener: (AgentEvent) -> Unit) {
        eventListeners.remove(listener)
    }

    /**
     * Send a user message and stream the response.
     */
    fun sendMessage(text: String, activeFile: VirtualFile? = null) {
        if (!tryStartProcessing()) {
            logger.warn("Cannot send message while processing")
            return
        }

        scope.launch {
            var eventSourceStarted = false
            try {
                // Ensure we have a session
                if (_currentSessionId == null) {
                    val session = appService.apiClient.createSession("JetBrains Chat")
                    _currentSessionId = session.id
                }

                // Build context for first message
                val isFirstMessage = synchronized(messagesLock) { _messages.isEmpty() }
                val content = if (isFirstMessage) {
                    buildContextualMessage(text, activeFile)
                } else {
                    text
                }

                // Add user message
                val userMessage = ComposerMessage(
                    role = MessageRole.USER,
                    content = content,
                    timestamp = java.time.Instant.now().toString()
                )
                synchronized(messagesLock) {
                    _messages.add(userMessage)
                }
                notifyMessageListeners()

                // Prepare assistant message placeholder
                val assistantMessage = ComposerMessage(
                    role = MessageRole.ASSISTANT,
                    content = "",
                    timestamp = java.time.Instant.now().toString()
                )
                synchronized(messagesLock) {
                    _messages.add(assistantMessage)
                }
                notifyMessageListeners()

                // Send request
                val thinkingLevel = try {
                    ThinkingLevel.valueOf(settings.defaultThinkingLevel.uppercase())
                } catch (e: IllegalArgumentException) {
                    logger.warn("Invalid thinking level: ${settings.defaultThinkingLevel}, defaulting to OFF")
                    ThinkingLevel.OFF
                }

                val requestMessages = synchronized(messagesLock) {
                    _messages.dropLast(1)
                }
                val request = ChatRequest(
                    messages = requestMessages, // Exclude placeholder
                    model = settings.defaultModel,
                    thinkingLevel = thinkingLevel,
                    sessionId = _currentSessionId,
                    stream = true
                )

                _currentEventSource = appService.apiClient.chatWithEvents(
                    request = request,
                    onEvent = { event -> handleEvent(event) },
                    onError = { error -> handleError(error) },
                    onComplete = { handleComplete() }
                )
                eventSourceStarted = true

            } catch (e: CancellationException) {
                if (!eventSourceStarted) {
                    setProcessing(false)
                }
                throw e
            } catch (e: Exception) {
                logger.error("Failed to send message", e)
                handleError(e)
            }
        }
    }

    /**
     * Cancel the current request.
     */
    fun cancelRequest() {
        _currentEventSource?.cancel()
        _currentEventSource = null
        setProcessing(false)
    }

    /**
     * Clear the current chat session.
     */
    fun clearChat() {
        cancelRequest()
        synchronized(messagesLock) {
            _messages.clear()
        }
        _currentSessionId = null
        notifyMessageListeners()
    }

    /**
     * Switch to a different session.
     */
    fun switchSession(sessionId: String) {
        scope.launch {
            try {
                cancelRequest()
                val session = appService.apiClient.getSession(sessionId)
                _currentSessionId = session.id
                synchronized(messagesLock) {
                    _messages.clear()
                    _messages.addAll(session.messages)
                }
                notifyMessageListeners()
            } catch (e: Exception) {
                logger.error("Failed to switch session", e)
            }
        }
    }

    /**
     * Add a file to the pinned context.
     */
    fun pinFile(path: String) {
        _pinnedFiles.add(path)
    }

    /**
     * Remove a file from the pinned context.
     */
    fun unpinFile(path: String) {
        _pinnedFiles.remove(path)
    }

    /**
     * Clear all pinned files.
     */
    fun clearPinnedFiles() {
        _pinnedFiles.clear()
    }

    private fun buildContextualMessage(text: String, activeFile: VirtualFile?): String {
        val contextBuilder = StringBuilder()
        var currentSize = 0
        val maxSize = settings.maxContextSize

        // Add pinned files
        if (_pinnedFiles.isNotEmpty()) {
            contextBuilder.append("=== USER PROVIDED CONTEXT ===\nPinned Files:\n")
            val fileIndex = ProjectRootManager.getInstance(project).fileIndex
            val localFileSystem = LocalFileSystem.getInstance()
            for (path in _pinnedFiles) {
                try {
                    val file = java.io.File(path).canonicalFile
                    if (!file.exists() || !file.isFile) {
                        logger.warn("Skipping non-existent or non-file: $path")
                        continue
                    }
                    val vf = localFileSystem.findFileByIoFile(file)
                    if (vf == null || !fileIndex.isInContent(vf)) {
                        logger.warn("Skipping file outside project: $path")
                        continue
                    }
                    val content = file.readText()
                    if (currentSize + content.length > maxSize) {
                        contextBuilder.append("File: $path\n(truncated - file too large)\n\n")
                        continue
                    }
                    currentSize += content.length
                    val ext = path.substringAfterLast('.', "txt")
                    contextBuilder.append("File: $path\n```$ext\n$content\n```\n\n")
                } catch (e: Exception) {
                    logger.warn("Failed to read pinned file: $path", e)
                }
            }
        }

        // Add active file if not already pinned
        if (settings.autoInjectActiveFile && activeFile != null && !_pinnedFiles.contains(activeFile.path)) {
            try {
                val content = String(activeFile.contentsToByteArray())
                if (currentSize + content.length <= maxSize) {
                    if (contextBuilder.isEmpty()) {
                        contextBuilder.append("=== USER PROVIDED CONTEXT ===\n")
                    }
                    val ext = activeFile.extension ?: "txt"
                    contextBuilder.append("Active File: ${activeFile.path}\n```$ext\n$content\n```\n\n")
                } else {
                    if (contextBuilder.isEmpty()) {
                        contextBuilder.append("=== USER PROVIDED CONTEXT ===\n")
                    }
                    contextBuilder.append("Active File: ${activeFile.path}\n(truncated - file too large)\n\n")
                }
            } catch (e: Exception) {
                logger.warn("Failed to read active file", e)
            }
        }

        return if (contextBuilder.isNotEmpty()) {
            contextBuilder.append("=== END CONTEXT ===\n\n")
            "$contextBuilder<<< USER_MESSAGE_START >>>\n$text"
        } else {
            text
        }
    }

    private fun handleEvent(event: AgentEvent) {
        notifyEventListeners(event)

        when (event) {
            is AgentEvent.MessageUpdate -> {
                // Update the last assistant message
                val updated = synchronized(messagesLock) {
                    if (_messages.isNotEmpty() && _messages.last().role == MessageRole.ASSISTANT) {
                        _messages[_messages.lastIndex] = event.message
                        true
                    } else {
                        false
                    }
                }
                if (updated) {
                    notifyMessageListeners()
                }
            }

            is AgentEvent.MessageEnd -> {
                // Finalize the assistant message
                val updated = synchronized(messagesLock) {
                    if (_messages.isNotEmpty() && _messages.last().role == MessageRole.ASSISTANT) {
                        _messages[_messages.lastIndex] = event.message
                        true
                    } else {
                        false
                    }
                }
                if (updated) {
                    notifyMessageListeners()
                }
            }

            is AgentEvent.ToolExecutionStart,
            is AgentEvent.ToolExecutionEnd -> {
                val updated = synchronized(messagesLock) {
                    val nextMessages = applyLiveToolEvent(_messages, event)
                    if (nextMessages == _messages) {
                        false
                    } else {
                        _messages = nextMessages.toMutableList()
                        true
                    }
                }
                if (updated) {
                    notifyMessageListeners()
                }
            }

            is AgentEvent.ClientToolRequest -> {
                // Execute client tool
                scope.launch {
                    try {
                        val result = toolExecutor.execute(event.toolName, event.args ?: emptyMap())
                        appService.apiClient.submitClientToolResult(
                            event.toolCallId,
                            listOf(mapOf("type" to "text", "text" to result)),
                            false
                        )
                    } catch (e: Exception) {
                        logger.error("Client tool execution failed", e)
                        try {
                            appService.apiClient.submitClientToolResult(
                                event.toolCallId,
                                listOf(mapOf("type" to "text", "text" to (e.message ?: "Unknown error"))),
                                true
                            )
                        } catch (submitError: Exception) {
                            logger.error("Failed to submit error result for tool ${event.toolName}", submitError)
                        }
                    }
                }
            }

            is AgentEvent.Error -> {
                logger.error("Agent error: ${event.message}")
            }

            is AgentEvent.Aborted -> {
                logger.info("Request aborted")
            }

            else -> {
                // Handle other events as needed
            }
        }
    }

    private fun handleError(error: Throwable) {
        logger.error("Stream error", error)
        setProcessing(false)
    }

    private fun handleComplete() {
        setProcessing(false)
    }

    private fun tryStartProcessing(): Boolean {
        if (!isProcessingFlag.compareAndSet(false, true)) {
            return false
        }
        notifyProcessingListeners(true)
        return true
    }

    private fun setProcessing(processing: Boolean) {
        val previous = isProcessingFlag.getAndSet(processing)
        if (previous == processing) {
            return
        }
        notifyProcessingListeners(processing)
    }

    private fun notifyProcessingListeners(processing: Boolean) {
        processingListeners.forEach { listener ->
            try {
                listener(processing)
            } catch (e: Exception) {
                logger.warn("Processing listener threw exception", e)
            }
        }
    }

    private fun notifyMessageListeners() {
        val messagesCopy = synchronized(messagesLock) {
            _messages.toList()
        }
        messageListeners.forEach { listener ->
            try {
                listener(messagesCopy)
            } catch (e: Exception) {
                logger.warn("Message listener threw exception", e)
            }
        }
    }

    private fun notifyEventListeners(event: AgentEvent) {
        eventListeners.forEach { listener ->
            try {
                listener(event)
            } catch (e: Exception) {
                logger.warn("Event listener threw exception", e)
            }
        }
    }

    override fun dispose() {
        cancelRequest()
        scope.cancel()
        messageListeners.clear()
        processingListeners.clear()
        eventListeners.clear()
    }

    companion object {
        fun getInstance(project: Project): ComposerProjectService {
            return project.getService(ComposerProjectService::class.java)
        }
    }
}
