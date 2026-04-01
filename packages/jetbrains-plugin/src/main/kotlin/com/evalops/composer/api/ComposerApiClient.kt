package com.evalops.composer.api

import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.JsonParser
import com.intellij.openapi.diagnostic.Logger
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * HTTP/SSE client for communicating with Composer backend.
 */
class ComposerApiClient(
    private val baseUrl: String,
    private val timeoutSeconds: Long
) {

    private val logger = Logger.getInstance(ComposerApiClient::class.java)

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(timeoutSeconds, TimeUnit.SECONDS)
        .readTimeout(timeoutSeconds, TimeUnit.SECONDS)
        .writeTimeout(timeoutSeconds, TimeUnit.SECONDS)
        .callTimeout(timeoutSeconds, TimeUnit.SECONDS)
        .build()

    private val sseClient = httpClient.newBuilder()
        .readTimeout(0, TimeUnit.SECONDS) // SSE streams indefinitely
        .callTimeout(0, TimeUnit.SECONDS) // No overall timeout for streaming
        .build()

    private val gson: Gson = GsonBuilder()
        .setLenient()
        .create()

    private val jsonMediaType = "application/json".toMediaType()

    companion object {
        private const val CLIENT_HEADER = "X-Composer-Client"
        private const val CLIENT_VERSION_HEADER = "X-Composer-Client-Version"
        private const val CLIENT_TOOLS_HEADER = "X-Composer-Client-Tools"
        private const val SLIM_EVENTS_HEADER = "X-Composer-Slim-Events"
        private const val MAESTRO_CLIENT_HEADER = "X-Maestro-Client"
        private const val MAESTRO_CLIENT_TOOLS_HEADER = "X-Maestro-Client-Tools"
        private const val MAESTRO_SLIM_EVENTS_HEADER = "X-Maestro-Slim-Events"
        private const val CLIENT_NAME = "jetbrains"
        private const val CLIENT_VERSION = "0.10.0"

        @JvmStatic
        internal fun applyClientHeaders(
            builder: Request.Builder,
            includeClientTools: Boolean = false,
            includeSlimEvents: Boolean = false
        ): Request.Builder {
            builder
                .header(CLIENT_HEADER, CLIENT_NAME)
                .header(MAESTRO_CLIENT_HEADER, CLIENT_NAME)
                .header(CLIENT_VERSION_HEADER, CLIENT_VERSION)

            if (includeClientTools) {
                builder
                    .header(CLIENT_TOOLS_HEADER, "1")
                    .header(MAESTRO_CLIENT_TOOLS_HEADER, "1")
            }

            if (includeSlimEvents) {
                builder
                    .header(SLIM_EVENTS_HEADER, "1")
                    .header(MAESTRO_SLIM_EVENTS_HEADER, "1")
            }

            return builder
        }
    }

    /**
     * Create a new session.
     */
    fun createSession(title: String? = null): Session {
        val body = gson.toJson(mapOf("title" to title)).toRequestBody(jsonMediaType)
        val request = applyClientHeaders(
            Request.Builder()
            .url("$baseUrl/api/sessions")
        )
            .post(body)
            .build()

        httpClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw IOException("Failed to create session: ${response.code} ${response.message}")
            }
            val bodyString = response.body?.string() ?: throw IOException("Empty response body")
            return gson.fromJson(bodyString, Session::class.java)
        }
    }

    /**
     * List all sessions.
     */
    fun listSessions(): List<SessionSummary> {
        val request = applyClientHeaders(
            Request.Builder()
            .url("$baseUrl/api/sessions")
        )
            .get()
            .build()

        httpClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw IOException("Failed to list sessions: ${response.code} ${response.message}")
            }
            val bodyString = response.body?.string()
            if (bodyString.isNullOrBlank()) return emptyList()
            val json = JsonParser.parseString(bodyString).asJsonObject
            val sessions = json.getAsJsonArray("sessions") ?: return emptyList()
            return sessions.map { gson.fromJson(it, SessionSummary::class.java) }
        }
    }

    /**
     * Get a specific session by ID.
     */
    fun getSession(sessionId: String): Session {
        val request = applyClientHeaders(
            Request.Builder()
            .url("$baseUrl/api/sessions/$sessionId")
        )
            .get()
            .build()

        httpClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw IOException("Failed to get session: ${response.code} ${response.message}")
            }
            val bodyString = response.body?.string() ?: throw IOException("Empty response body")
            return gson.fromJson(bodyString, Session::class.java)
        }
    }

    /**
     * Get available models.
     */
    fun getModels(): List<Model> {
        val request = applyClientHeaders(
            Request.Builder()
            .url("$baseUrl/api/models")
        )
            .get()
            .build()

        httpClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw IOException("Failed to get models: ${response.code} ${response.message}")
            }
            val bodyString = response.body?.string()
            if (bodyString.isNullOrBlank()) return emptyList()
            val json = JsonParser.parseString(bodyString).asJsonObject
            val models = json.getAsJsonArray("models") ?: return emptyList()
            return models.map { gson.fromJson(it, Model::class.java) }
        }
    }

    /**
     * Send a chat message and stream events via SSE.
     */
    fun chatWithEvents(
        request: ChatRequest,
        onEvent: (AgentEvent) -> Unit,
        onError: (Throwable) -> Unit,
        onComplete: () -> Unit
    ): EventSource {
        val body = gson.toJson(request.copy(stream = true)).toRequestBody(jsonMediaType)
        val httpRequest = applyClientHeaders(
            Request.Builder()
            .url("$baseUrl/api/chat")
            .header("Accept", "text/event-stream"),
            includeClientTools = true,
            includeSlimEvents = true
        )
            .post(body)
            .build()

        val factory = EventSources.createFactory(sseClient)

        return factory.newEventSource(httpRequest, object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) {
                logger.debug("SSE connection opened")
            }

            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                if (data.isBlank() || data == "[DONE]") return

                try {
                    val event = parseAgentEvent(data)
                    onEvent(event)
                } catch (e: Exception) {
                    logger.warn("Failed to parse SSE event: $data", e)
                    onEvent(AgentEvent.Unknown("parse_error", data))
                }
            }

            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                val error = t ?: IOException("SSE connection failed: ${response?.code} ${response?.message}")
                logger.warn("SSE connection failed", error)
                onError(error)
            }

            override fun onClosed(eventSource: EventSource) {
                logger.debug("SSE connection closed")
                onComplete()
            }
        })
    }

    /**
     * Submit client tool result back to server.
     */
    fun submitClientToolResult(toolCallId: String, content: List<Map<String, Any?>>, isError: Boolean) {
        val result = ClientToolResult(toolCallId, content, isError)
        val body = gson.toJson(result).toRequestBody(jsonMediaType)
        val request = applyClientHeaders(
            Request.Builder()
            .url("$baseUrl/api/chat/client-tool-result")
        )
            .post(body)
            .build()

        httpClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw IOException("Failed to submit client tool result: ${response.code} ${response.message}")
            }
        }
    }

    /**
     * Submit approval decision for an action.
     */
    fun submitApproval(requestId: String, decision: String) {
        val approval = ApprovalDecision(requestId, decision)
        val body = gson.toJson(approval).toRequestBody(jsonMediaType)
        val request = applyClientHeaders(
            Request.Builder()
            .url("$baseUrl/api/chat/approval")
        )
            .post(body)
            .build()

        httpClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw IOException("Failed to submit approval: ${response.code} ${response.message}")
            }
        }
    }

    /**
     * Check if the server is reachable.
     */
    fun healthCheck(): Boolean {
        return try {
            val request = applyClientHeaders(
                Request.Builder()
                .url("$baseUrl/api/health")
            )
                .get()
                .build()

        httpClient.newCall(request).execute().use { response ->
                response.isSuccessful
            }
        } catch (e: Exception) {
            logger.debug("Health check failed", e)
            false
        }
    }

    /**
     * Parse an SSE data payload into an AgentEvent.
     */
    private fun parseAgentEvent(data: String): AgentEvent {
        val json = JsonParser.parseString(data).asJsonObject
        val type = json.get("type")?.asString ?: return AgentEvent.Unknown("unknown", data)

        return when (type) {
            "agent_start" -> AgentEvent.AgentStart()
            "agent_end" -> gson.fromJson(data, AgentEvent.AgentEnd::class.java)
            "message_start" -> gson.fromJson(data, AgentEvent.MessageStart::class.java)
            "message_update" -> gson.fromJson(data, AgentEvent.MessageUpdate::class.java)
            "message_end" -> gson.fromJson(data, AgentEvent.MessageEnd::class.java)
            "tool_execution_start" -> gson.fromJson(data, AgentEvent.ToolExecutionStart::class.java)
            "tool_execution_end" -> gson.fromJson(data, AgentEvent.ToolExecutionEnd::class.java)
            "client_tool_request" -> gson.fromJson(data, AgentEvent.ClientToolRequest::class.java)
            "action_approval_required" -> gson.fromJson(data, AgentEvent.ActionApprovalRequired::class.java)
            "action_approval_resolved" -> gson.fromJson(data, AgentEvent.ActionApprovalResolved::class.java)
            "error" -> gson.fromJson(data, AgentEvent.Error::class.java)
            "heartbeat" -> AgentEvent.Heartbeat()
            "aborted" -> AgentEvent.Aborted()
            else -> AgentEvent.Unknown(type, data)
        }
    }

    /**
     * Close the client and release resources.
     */
    fun close() {
        httpClient.dispatcher.executorService.shutdown()
        httpClient.connectionPool.evictAll()
        sseClient.dispatcher.executorService.shutdown()
        sseClient.connectionPool.evictAll()
    }
}
