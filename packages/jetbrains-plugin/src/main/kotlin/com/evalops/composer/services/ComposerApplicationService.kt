package com.evalops.composer.services

import com.evalops.composer.api.ComposerApiClient
import com.evalops.composer.api.Model
import com.evalops.composer.api.SessionSummary
import com.evalops.composer.settings.ComposerSettings
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Application-level service for Composer.
 * Manages global state like API client and available models.
 */
class ComposerApplicationService : Disposable {

    private val logger = Logger.getInstance(ComposerApplicationService::class.java)
    private val settings = ComposerSettings.getInstance()

    private var _apiClient: ComposerApiClient? = null
    private var _availableModels: List<Model> = emptyList()
    private var _isConnected: Boolean = false

    private val connectionListeners = CopyOnWriteArrayList<(Boolean) -> Unit>()

    /**
     * Get the API client, creating it if necessary.
     */
    val apiClient: ComposerApiClient
        get() {
            if (_apiClient == null) {
                _apiClient = ComposerApiClient(
                    settings.apiEndpoint,
                    settings.connectionTimeout.toLong().coerceAtLeast(1)
                )
            }
            return _apiClient!!
        }

    /**
     * Whether the server is connected.
     */
    val isConnected: Boolean
        get() = _isConnected

    /**
     * Available models from the server.
     */
    val availableModels: List<Model>
        get() = _availableModels

    /**
     * Add a listener for connection state changes.
     */
    fun addConnectionListener(listener: (Boolean) -> Unit) {
        connectionListeners.add(listener)
    }

    /**
     * Remove a connection listener.
     */
    fun removeConnectionListener(listener: (Boolean) -> Unit) {
        connectionListeners.remove(listener)
    }

    /**
     * Refresh connection status and available models.
     */
    fun refreshConnection(): Boolean {
        return try {
            // Recreate client if endpoint changed
            if (_apiClient != null) {
                _apiClient?.close()
                _apiClient = ComposerApiClient(
                    settings.apiEndpoint,
                    settings.connectionTimeout.toLong().coerceAtLeast(1)
                )
            }

            val connected = apiClient.healthCheck()
            if (connected != _isConnected) {
                _isConnected = connected
                notifyConnectionListeners(connected)
            }

            if (connected) {
                try {
                    _availableModels = apiClient.getModels()
                    logger.info("Loaded ${_availableModels.size} models from Maestro server")
                } catch (e: Exception) {
                    logger.warn("Failed to load models", e)
                }
            }

            connected
        } catch (e: Exception) {
            logger.warn("Connection check failed", e)
            if (_isConnected) {
                _isConnected = false
                notifyConnectionListeners(false)
            }
            false
        }
    }

    /**
     * List available sessions.
     */
    fun listSessions(): List<SessionSummary> {
        return try {
            apiClient.listSessions()
        } catch (e: Exception) {
            logger.warn("Failed to list sessions", e)
            emptyList()
        }
    }

    private fun notifyConnectionListeners(connected: Boolean) {
        connectionListeners.forEach { listener ->
            try {
                listener(connected)
            } catch (e: Exception) {
                logger.warn("Connection listener threw exception", e)
            }
        }
    }

    override fun dispose() {
        _apiClient?.close()
        _apiClient = null
        connectionListeners.clear()
    }

    companion object {
        fun getInstance(): ComposerApplicationService {
            return ApplicationManager.getApplication().getService(ComposerApplicationService::class.java)
        }
    }
}
