/**
 * Chat Handler - Main WebSocket/SSE Endpoint for Agent Conversations
 *
 * This module implements the primary chat endpoint for the web server.
 * It handles incoming chat requests, manages agent execution, and streams
 * responses back to clients via Server-Sent Events (SSE).
 *
 * Request flow:
 * 1. Parse and validate incoming JSON request
 * 2. Acquire SSE connection slot (rate limited)
 * 3. Create or resume session based on sessionId
 * 4. Initialize agent with model and approval settings
 * 5. Hydrate conversation history from request
 * 6. Stream agent events to client via SSE
 * 7. Persist session state on completion
 *
 * Key features:
 * - Circuit breaker protection for agent calls
 * - Graceful handling of client disconnects
 * - Session persistence with auto-initialization
 * - Approval mode configuration via headers
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ComposerChatRequest, ComposerMessage } from "@evalops/contracts";
import type {
	Attachment as AgentAttachment,
	AgentEvent,
} from "../../agent/types.js";
import {
	createNotificationFromAgentEvent,
	isNotificationEnabled,
	sendNotification,
} from "../../hooks/notification-hooks.js";
import { checkSessionLimits } from "../../safety/policy.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("web:chat");

function getComposerTextContent(content: ComposerMessage["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

// SessionManager type import for annotations, value import for instantiation
import type { SessionManager } from "../../session/manager.js";
import {
	SessionManager as SessionManagerImpl,
	toSessionModelMetadata,
} from "../../session/manager.js";
import { recordSseSkip } from "../../telemetry.js";
import type { WebServerContext } from "../app-context.js";
import { publishArtifactUpdate } from "../artifacts-live-reload.js";
import { getAgentCircuitBreaker } from "../circuit-breaker.js";
import { ApiError, respondWithApiError, sendJson } from "../server-utils.js";
import { convertComposerMessagesToApp } from "../session-serialization.js";
import { SseSession, sendSSE, sendSessionUpdate } from "../sse-session.js";
import {
	type ChatRequestInput,
	ChatRequestSchema,
	parseAndValidateJson,
} from "../validation.js";

/**
 * Handle an incoming chat request.
 *
 * This is the main entry point for chat interactions. It:
 * 1. Validates the request format
 * 2. Sets up SSE streaming
 * 3. Runs the agent with the user's message
 * 4. Streams events back to the client
 * 5. Persists the session state
 *
 * @param req - The incoming HTTP request
 * @param res - The HTTP response (will be converted to SSE stream)
 * @param context - Server context with agent factory and configuration
 */
export async function handleChat(
	req: IncomingMessage,
	res: ServerResponse,
	context: WebServerContext,
) {
	// Destructure context for cleaner code
	const {
		createAgent,
		getRegisteredModel,
		defaultApprovalMode,
		acquireSse,
		releaseSse,
		corsHeaders: cors,
	} = context;

	// Track SSE lease for cleanup in finally block
	let sseLease: symbol | null = null;

	try {
		// ===== Phase 1: Request Validation =====
		const chatReq = (await parseAndValidateJson<ChatRequestInput>(
			req,
			ChatRequestSchema,
		)) as ComposerChatRequest;

		// Validate message array exists and is non-empty
		const incomingMessages = Array.isArray(chatReq.messages)
			? (chatReq.messages as ComposerMessage[])
			: [];
		if (incomingMessages.length === 0) {
			sendJson(res, 400, { error: "No messages supplied" }, cors, req);
			return;
		}

		// The last message must be the user's current input
		const latestMessage = incomingMessages[incomingMessages.length - 1];
		if (!latestMessage || latestMessage.role !== "user") {
			sendJson(
				res,
				400,
				{ error: "Last message must be a user message" },
				cors,
				req,
			);
			return;
		}

		const { attachmentsToSend, attachmentError } = (() => {
			const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
			const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

			const raw = latestMessage.attachments;
			if (!Array.isArray(raw) || raw.length === 0) {
				return {
					attachmentsToSend: undefined as AgentAttachment[] | undefined,
					attachmentError: null as string | null,
				};
			}

			const attachments: AgentAttachment[] = [];
			let totalBytes = 0;

			for (const item of raw) {
				if (!item || typeof item !== "object") continue;
				const a = item as unknown as Record<string, unknown>;

				const id = typeof a.id === "string" ? a.id : "";
				const type =
					a.type === "image" || a.type === "document" ? a.type : null;
				const fileName =
					typeof a.fileName === "string" ? a.fileName : "attachment";
				const mimeType =
					typeof a.mimeType === "string"
						? a.mimeType
						: "application/octet-stream";
				const size =
					typeof a.size === "number" && Number.isFinite(a.size) ? a.size : 0;
				const content = typeof a.content === "string" ? a.content : "";
				const extractedText =
					typeof a.extractedText === "string" ? a.extractedText : undefined;
				const preview = typeof a.preview === "string" ? a.preview : undefined;

				if (!id || !type) continue;
				if (!content) {
					// Content omitted (e.g., session fetch); keep metadata for UI but do not send to model.
					continue;
				}

				// Base64 -> bytes (approx). Prefer validating against actual content length.
				const approxBytes = Math.floor((content.length * 3) / 4);
				const bytes = approxBytes > 0 ? approxBytes : size;

				if (bytes > MAX_ATTACHMENT_BYTES) {
					return {
						attachmentsToSend: undefined,
						attachmentError: `Attachment too large: ${fileName} (${Math.ceil(bytes / 1024 / 1024)}MB). Max per file is ${Math.ceil(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB.`,
					};
				}

				totalBytes += bytes;
				if (totalBytes > MAX_TOTAL_BYTES) {
					return {
						attachmentsToSend: undefined,
						attachmentError: `Attachments too large: total exceeds ${Math.ceil(MAX_TOTAL_BYTES / 1024 / 1024)}MB.`,
					};
				}

				attachments.push({
					id,
					type,
					fileName,
					mimeType,
					size: size || bytes,
					content,
					extractedText,
					preview,
				});
			}

			return {
				attachmentsToSend: attachments.length ? attachments : undefined,
				attachmentError: null,
			};
		})();

		if (attachmentError) {
			sendJson(res, 413, { error: attachmentError }, cors, req);
			return;
		}

		const userInput = getComposerTextContent(latestMessage.content).trim();
		if (!userInput && !attachmentsToSend) {
			sendJson(res, 400, { error: "User message cannot be empty" }, cors, req);
			return;
		}

		// ===== Phase 2: SSE Connection Management =====
		// Acquire a lease to limit concurrent SSE connections
		if (acquireSse) {
			sseLease = acquireSse();
			if (!sseLease) {
				sendJson(
					res,
					429,
					{ error: "Too many active SSE connections" },
					cors,
					req,
				);
				return;
			}
		}

		// ===== Phase 3: Session and Agent Setup =====
		// Create session manager (false = don't auto-initialize from disk)
		const sessionManager = new SessionManagerImpl(false);

		// Resume existing session if sessionId provided
		if (chatReq.sessionId) {
			const sessionFile = sessionManager.getSessionFileById(chatReq.sessionId);
			if (sessionFile) {
				sessionManager.setSessionFile(sessionFile);
			}
		}

		// Resolve model from registry
		const registeredModel = await getRegisteredModel(chatReq.model);

		// Parse approval mode from request header (allows per-request override)
		const headerApproval = (() => {
			const header = req.headers["x-composer-approval-mode"];
			const raw = Array.isArray(header) ? header[0] : header;
			const normalized = raw?.trim().toLowerCase();
			if (
				normalized === "auto" ||
				normalized === "prompt" ||
				normalized === "fail"
			) {
				return normalized as "auto" | "prompt" | "fail";
			}
			return undefined;
		})();

		// Use header approval if specified, otherwise fall back to server default
		const effectiveApproval =
			headerApproval && headerApproval !== "auto"
				? headerApproval
				: (defaultApprovalMode as "auto" | "prompt" | "fail");

		// Create the agent with the resolved configuration
		const clientToolsHeader = (() => {
			const header = req.headers["x-composer-client-tools"];
			const raw = Array.isArray(header) ? header[0] : header;
			return raw?.trim() === "1";
		})();

		const agent = await createAgent(
			registeredModel,
			chatReq.thinkingLevel || "off",
			effectiveApproval,
			clientToolsHeader ? { enableClientTools: true } : undefined,
		);

		// Hydrate conversation history (all messages except the current user input)
		const historyMessages = incomingMessages.slice(0, -1);
		const hydratedHistory = convertComposerMessagesToApp(
			historyMessages,
			registeredModel,
		);
		if (hydratedHistory.length > 0) {
			agent.replaceMessages(hydratedHistory);
		} else {
			agent.clearMessages();
		}

		// ===== Phase 4: SSE Stream Setup =====
		// Initialize the SSE response headers
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			...cors,
		});

		// Create SSE session with telemetry callback for skip tracking
		const requestId = Math.random().toString(36).slice(2);
		const modelKey = `${registeredModel.provider}/${registeredModel.id}`;
		const sseSession = new SseSession(
			res,
			(metrics) => {
				// Record telemetry when SSE writes are skipped (client disconnected)
				recordSseSkip(metrics.sent, metrics.skipped, {
					requestId: metrics.context?.requestId,
					modelKey: metrics.context?.modelKey,
					sessionId: metrics.context?.sessionId,
					lastError:
						metrics.lastError instanceof Error
							? metrics.lastError.message
							: metrics.lastError,
				});
			},
			{ requestId, modelKey },
		);
		sseSession.startHeartbeat(); // Keep connection alive during idle periods

		// Track cleanup state to prevent double-cleanup
		let cleanedUp = false;

		// ===== Phase 5: Agent Event Subscription =====
		// Subscribe to agent events and forward them to the SSE stream
		// Pre-load enterprise context for session tracking
		const { enterpriseContext } = await import("../../enterprise/context.js");

		const toolArgsByCallId = new Map<string, Record<string, unknown>>();

		const unsubscribe = agent.subscribe((event: AgentEvent) => {
			// Forward event to client
			sendSSE(sseSession, event);

			// Track tool args for later event correlation (used by artifact live reload)
			if (event.type === "tool_execution_start") {
				toolArgsByCallId.set(
					event.toolCallId,
					(event.args && typeof event.args === "object"
						? (event.args as Record<string, unknown>)
						: {}) as Record<string, unknown>,
				);
			}
			if (event.type === "client_tool_request") {
				toolArgsByCallId.set(
					event.toolCallId,
					(event.args && typeof event.args === "object"
						? (event.args as Record<string, unknown>)
						: {}) as Record<string, unknown>,
				);
			}
			if (event.type === "tool_execution_end") {
				if (event.toolName === "artifacts" && !event.isError) {
					const sessionId = sessionManager.getSessionId();
					const args = toolArgsByCallId.get(event.toolCallId) ?? {};
					const filename =
						typeof args.filename === "string" ? args.filename : null;
					const command =
						typeof args.command === "string" ? args.command : null;
					if (
						sessionId &&
						filename &&
						(command === "create" ||
							command === "update" ||
							command === "rewrite" ||
							command === "delete")
					) {
						publishArtifactUpdate(sessionId, filename);
					}
				}
				toolArgsByCallId.delete(event.toolCallId);
			}

			// Handle message completion - persist to session
			if (event.type === "message_end") {
				sessionManager.saveMessage(event.message);

				// Auto-initialize session on first assistant message
				if (sessionManager.shouldInitializeSession(agent.state.messages)) {
					// Check concurrent session limit before starting
					// We define "active" as updated in the last hour
					let activeCount: number | undefined;
					try {
						const sessions = sessionManager.loadAllSessions();
						activeCount = sessions.filter(
							(s) => Date.now() - s.modified.getTime() < 60 * 60 * 1000,
						).length;
					} catch (error) {
						// Fallback to undefined to let checkSessionLimits decide (it will fail-closed if limit exists)
						logger.warn("Failed to count active sessions", {
							error: error instanceof Error ? error.message : String(error),
						});
					}

					// Check against policy (+1 for the session we are about to create)
					const limitCheck = checkSessionLimits(
						{ startedAt: new Date() },
						// If loadAllSessions failed (activeCount undefined), we pass undefined to trigger fail-closed
						// If successful (activeCount number), we pass count + 1
						activeCount !== undefined
							? { activeSessionCount: activeCount + 1 }
							: undefined,
					);

					if (!limitCheck.allowed) {
						// Send error to client via SSE
						sendSSE(sseSession, {
							type: "error",
							message: `[Policy] ${limitCheck.reason}`,
						});
						sseSession.end();
						return;
					}

					sessionManager.startSession(agent.state);

					// Record session start in enterprise context for audit logging
					if (enterpriseContext.isEnterprise()) {
						enterpriseContext.startSession(
							sessionManager.getSessionId(),
							registeredModel.id,
						);
						const session = enterpriseContext.getSession();
						if (session) {
							agent.setSession({
								id: session.sessionId,
								startedAt: session.startedAt,
							});
						}
					}

					const sessionId = sessionManager.getSessionId();
					sendSessionUpdate(sseSession, sessionId);
					sseSession.setContext({ sessionId });
				}
			}

			// Update session snapshot on every event
			sessionManager.updateSnapshot(
				agent.state,
				toSessionModelMetadata(registeredModel),
			);
		});

		// Subscribe to agent events for notification hooks (if configured)
		if (
			isNotificationEnabled("turn-complete") ||
			isNotificationEnabled("session-start") ||
			isNotificationEnabled("session-end") ||
			isNotificationEnabled("tool-execution") ||
			isNotificationEnabled("error")
		) {
			agent.subscribe((event) => {
				const payload = createNotificationFromAgentEvent(event, {
					cwd: process.cwd(),
					sessionId: sessionManager.getSessionId(),
					messages: agent.state.messages,
				});
				if (payload) {
					void sendNotification(payload);
				}
			});
		}

		// ===== Phase 6: Connection Close Handling =====
		// Abort agent and cleanup when client disconnects
		const handleConnectionClose = () => {
			agent.abort();
			void cleanup(true);
		};

		req.on("close", handleConnectionClose);
		res.on("close", handleConnectionClose);

		/**
		 * Cleanup resources after request completion or abort.
		 * Idempotent - safe to call multiple times.
		 */
		const cleanup = async (aborted = false) => {
			if (cleanedUp) {
				return;
			}
			cleanedUp = true;

			// Stop keepalive and remove event listeners
			sseSession.stopHeartbeat();
			req.off("close", handleConnectionClose);
			res.off("close", handleConnectionClose);
			unsubscribe();

			// Flush any pending session writes
			await sessionManager.flush();

			// Send final SSE events if connection is still open
			if (!res.writableEnded) {
				if (aborted) {
					sseSession.sendAborted();
				}
				sseSession.end();
			}

			// Log if we had to skip writes due to client disconnect
			const metrics = sseSession.getMetrics();
			if (metrics.skipped > 0) {
				console.debug("SSE writes skipped after disconnect", metrics);
			}
		};

		// ===== Phase 7: Agent Execution =====
		try {
			// Use circuit breaker to protect against cascading failures
			// If the provider is having issues, we'll fail fast
			const breaker = getAgentCircuitBreaker(registeredModel.provider);

			// Execute the agent with the user's input
			await breaker.execute(() => agent.prompt(userInput, attachmentsToSend));

			// Send completion signal if connection is still open
			if (!res.writableEnded) {
				sseSession.sendDone();
			}
		} catch (error) {
			// Log and forward errors to client
			logger.error(
				"Agent prompt error",
				error instanceof Error ? error : undefined,
				{ sessionId: sessionManager.getSessionId?.() },
			);
			sendSSE(sseSession, {
				type: "error",
				message: error instanceof Error ? error.message : "Unknown error",
			});
		} finally {
			// Always cleanup, even on error
			await cleanup(false);
		}
	} catch (error) {
		// Handle errors during setup (before SSE stream is established)
		logger.error(
			"Chat handler error",
			error instanceof Error ? error : undefined,
		);
		respondWithApiError(res, error, 500, cors, req);
	} finally {
		// Release SSE connection slot
		if (sseLease && releaseSse) {
			releaseSse(sseLease);
		}
	}
}
