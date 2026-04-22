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
import { runUserPromptWithRecovery } from "../../agent/user-prompt-runtime.js";
import { dispatchAgentNotification } from "../../hooks/notification-hooks.js";
import { createSessionHookService } from "../../hooks/session-integration.js";
import { withMcpPostKeepMessages } from "../../mcp/prompt-recovery.js";
import {
	createAutomaticMemoryConsolidationCoordinator,
	getMemoryConsolidationSystemPrompt,
} from "../../memory/auto-consolidation.js";
import { createAutomaticMemoryExtractionCoordinator } from "../../memory/auto-extraction.js";
import type { RegisteredModel } from "../../models/registry.js";
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

import { toSessionModelMetadata } from "../../session/manager.js";
import { createRuntimeSessionSummaryUpdater } from "../../session/runtime-summary-updater.js";
import { recordSseSkip } from "../../telemetry.js";
import type { WebServerContext } from "../app-context.js";
import {
	normalizeApprovalMode,
	resolveApprovalModeForRequest,
} from "../approval-mode-store.js";
import { WebActionApprovalService } from "../approval-service.js";
import { publishArtifactUpdate } from "../artifacts-live-reload.js";
import { getAuthSubject } from "../authz.js";
import { getAgentCircuitBreaker } from "../circuit-breaker.js";
import { clientToolService } from "../client-tools-service.js";
import { isHostedSessionManager } from "../hosted-session-manager.js";
import { serverRequestManager } from "../server-request-manager.js";
import {
	ApiError,
	getRequestHeader,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";
import { startSessionWithPolicy } from "../session-initialization.js";
import { createWebSessionManagerForRequest } from "../session-scope.js";
import { convertComposerMessagesToApp } from "../session-serialization.js";
import { SseSession, sendSSE, sendSessionUpdate } from "../sse-session.js";
import { ServerRequestToolRetryService } from "../tool-retry-service.js";
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
		createBackgroundAgent,
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
				const id = typeof item.id === "string" ? item.id : "";
				const type =
					item.type === "image" || item.type === "document" ? item.type : null;
				const fileName =
					typeof item.fileName === "string" ? item.fileName : "attachment";
				const mimeType =
					typeof item.mimeType === "string"
						? item.mimeType
						: "application/octet-stream";
				const size =
					typeof item.size === "number" && Number.isFinite(item.size)
						? item.size
						: 0;
				const content = typeof item.content === "string" ? item.content : "";
				const extractedText =
					typeof item.extractedText === "string"
						? item.extractedText
						: undefined;
				const preview =
					typeof item.preview === "string" ? item.preview : undefined;

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
		const sessionManager = createWebSessionManagerForRequest(req, false);
		const subject = getAuthSubject(req);

		// Resume existing session if sessionId provided
		let existingSessionLoaded = false;
		if (chatReq.sessionId) {
			if (isHostedSessionManager(sessionManager)) {
				existingSessionLoaded = await sessionManager.resumeSession(
					chatReq.sessionId,
				);
			} else {
				const sessionFile = sessionManager.getSessionFileById(
					chatReq.sessionId,
				);
				if (sessionFile) {
					sessionManager.setSessionFile(sessionFile);
					existingSessionLoaded = true;
				}
			}
		}

		// Resolve model from registry
		const registeredModel = await getRegisteredModel(chatReq.model);

		// Parse approval mode from request header (allows per-request override)
		const headerApproval = normalizeApprovalMode(
			getRequestHeader(
				req,
				"x-composer-approval-mode",
				"x-maestro-approval-mode",
			) ?? undefined,
		);

		const effectiveApproval = resolveApprovalModeForRequest({
			sessionId: chatReq.sessionId,
			subject,
			headerApprovalMode: headerApproval,
			defaultApprovalMode,
		});

		// Create the agent with the resolved configuration
		const clientToolsHeader =
			getRequestHeader(
				req,
				"x-composer-client-tools",
				"x-maestro-client-tools",
			) === "1";

		const clientHeader = getRequestHeader(
			req,
			"x-composer-client",
			"x-maestro-client",
		)?.toLowerCase();
		const sessionIdProvider = () => sessionManager.getSessionId() ?? undefined;
		const requestApprovalService = new WebActionApprovalService(
			effectiveApproval,
			sessionIdProvider,
		);
		const toolRetryService = new ServerRequestToolRetryService(
			"prompt",
			sessionIdProvider,
		);

		const agent = await createAgent(
			registeredModel,
			chatReq.thinkingLevel || "off",
			effectiveApproval,
			{
				approvalService: requestApprovalService,
				toolRetryService,
				...(clientToolsHeader
					? {
							enableClientTools: true,
							clientToolService:
								clientToolService.forSession(sessionIdProvider),
							includeVscodeTools: clientHeader === "vscode",
							includeJetBrainsTools: clientHeader === "jetbrains",
							includeConductorTools: clientHeader === "conductor",
						}
					: {}),
			},
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

		const initializeSessionIfNeeded = async (): Promise<string | null> => {
			if (existingSessionLoaded || sessionManager.isInitialized()) {
				return null;
			}
			const initializationError = await startSessionWithPolicy({
				agent,
				enterpriseContext,
				logger,
				modelId: registeredModel.id,
				onSessionReady: (sessionId) => {
					sendSessionUpdate(sseSession, sessionId);
					sseSession.setContext({ sessionId });
				},
				sessionManager,
				subject,
			});
			if (initializationError) {
				return initializationError;
			}
			existingSessionLoaded = true;
			return null;
		};

		const initializationError = await initializeSessionIfNeeded();
		if (initializationError) {
			sendSSE(sseSession, {
				type: "error",
				message: `[Policy] ${initializationError}`,
			});
			sseSession.end();
			if (sseLease && releaseSse) {
				releaseSse(sseLease);
				sseLease = null;
			}
			return;
		}

		const toolArgsByCallId = new Map<string, Record<string, unknown>>();
		const storeToolArgs = (toolCallId: string, args: unknown) => {
			toolArgsByCallId.set(
				toolCallId,
				(args && typeof args === "object" && !Array.isArray(args)
					? (args as Record<string, unknown>)
					: {}) as Record<string, unknown>,
			);
		};
		const slimValue = getRequestHeader(
			req,
			"x-composer-slim-events",
			"x-maestro-slim-events",
		);
		const slimEvents = slimValue === "1" || slimValue === "true";
		const slimToolCallArgsLimit = (() => {
			const raw = process.env.MAESTRO_SLIM_TOOLCALL_ARGS_MAX_BYTES;
			if (!raw) return 4096;
			const parsed = Number(raw);
			if (!Number.isFinite(parsed) || parsed <= 0) return 4096;
			return Math.min(parsed, 1024 * 1024);
		})();
		const extractToolCallInfo = (assistantEvent: {
			contentIndex?: number;
			partial?: { content?: unknown[] };
		}): {
			toolCallId?: string;
			toolCallName?: string;
			toolCallArgs?: Record<string, unknown>;
			toolCallArgsTruncated?: boolean;
		} => {
			const assistantMessageEvent = assistantEvent.partial;
			const contentIndex = assistantEvent.contentIndex;
			if (
				!assistantMessageEvent ||
				typeof contentIndex !== "number" ||
				!Array.isArray(assistantMessageEvent.content)
			) {
				return {};
			}
			const block = assistantMessageEvent.content[contentIndex];
			if (!block || typeof block !== "object") {
				return {};
			}
			const maybeToolCall = block as {
				type?: string;
				id?: string;
				name?: string;
				arguments?: Record<string, unknown>;
			};
			if (maybeToolCall.type !== "toolCall") {
				return {};
			}
			const maybeArgs = maybeToolCall.arguments;
			const toolCallArgs =
				maybeArgs && typeof maybeArgs === "object" && !Array.isArray(maybeArgs)
					? maybeArgs
					: undefined;
			if (toolCallArgs) {
				try {
					const size = Buffer.byteLength(JSON.stringify(toolCallArgs), "utf8");
					if (size > slimToolCallArgsLimit) {
						return {
							toolCallId: maybeToolCall.id,
							toolCallName: maybeToolCall.name,
							toolCallArgsTruncated: true,
						};
					}
				} catch {
					return {
						toolCallId: maybeToolCall.id,
						toolCallName: maybeToolCall.name,
						toolCallArgsTruncated: true,
					};
				}
			}
			return {
				toolCallId: maybeToolCall.id,
				toolCallName: maybeToolCall.name,
				toolCallArgs,
			};
		};
		const maybeSlimEvent = (event: AgentEvent): AgentEvent => {
			if (!slimEvents || event.type !== "message_update") {
				return event;
			}

			const assistantEvent = event.assistantMessageEvent;
			const slimEvent: Record<string, unknown> = { ...event };
			delete slimEvent.message;

			if (!assistantEvent) {
				return slimEvent as AgentEvent;
			}

			if (
				assistantEvent.type === "text_delta" ||
				assistantEvent.type === "thinking_delta"
			) {
				const { partial, ...assistantWithoutPartial } = assistantEvent as {
					partial?: unknown;
					[key: string]: unknown;
				};

				slimEvent.assistantMessageEvent = assistantWithoutPartial;
				return slimEvent as AgentEvent;
			}

			if (
				assistantEvent.type === "toolcall_start" ||
				assistantEvent.type === "toolcall_delta" ||
				assistantEvent.type === "toolcall_end"
			) {
				const { partial, ...assistantWithoutPartial } = assistantEvent as {
					partial?: unknown;
					[key: string]: unknown;
				};
				const toolCallInfo =
					assistantEvent.type === "toolcall_end"
						? {}
						: extractToolCallInfo(assistantEvent);

				slimEvent.assistantMessageEvent = {
					...assistantWithoutPartial,
					...toolCallInfo,
				};
				return slimEvent as AgentEvent;
			}

			slimEvent.assistantMessageEvent = assistantEvent;
			return slimEvent as AgentEvent;
		};
		const updateSessionSummary =
			createRuntimeSessionSummaryUpdater(sessionManager);
		const automaticMemoryConsolidation =
			createAutomaticMemoryConsolidationCoordinator({
				createAgent: async () =>
					createBackgroundAgent(agent.state.model as RegisteredModel, {
						systemPrompt: getMemoryConsolidationSystemPrompt(),
					}),
				getModel: () => agent.state.model,
			});
		const automaticMemoryExtraction =
			createAutomaticMemoryExtractionCoordinator({
				createAgent: async () =>
					createBackgroundAgent(agent.state.model as RegisteredModel),
				getModel: () => agent.state.model,
				onProcessed: () => automaticMemoryConsolidation.schedule(),
				sessionManager,
			});
		const sessionHookService = createSessionHookService({
			cwd: process.cwd(),
			sessionId: sessionManager.getSessionId(),
		});
		const unsubscribeMcpElicitationBridge = serverRequestManager.subscribe(
			(event) => {
				const activeSessionId = sessionIdProvider();
				if (!activeSessionId || event.request.sessionId !== activeSessionId) {
					return;
				}
				if (event.request.kind !== "mcp_elicitation") {
					return;
				}
				if (event.type === "registered") {
					sendSSE(sseSession, {
						type: "client_tool_request",
						toolCallId: event.request.callId,
						toolName: event.request.toolName,
						args: event.request.args,
					});
					storeToolArgs(event.request.callId, event.request.args);
					return;
				}
				toolArgsByCallId.delete(event.request.callId);
			},
		);

		const unsubscribe = agent.subscribe((event: AgentEvent) => {
			updateSessionSummary(event);

			// Forward event to client
			sendSSE(sseSession, maybeSlimEvent(event));

			// Track tool args for later event correlation (used by artifact live reload)
			if (event.type === "tool_execution_start") {
				storeToolArgs(event.toolCallId, event.args);
			}
			if (event.type === "client_tool_request") {
				storeToolArgs(event.toolCallId, event.args);
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
				if (event.message.role === "assistant") {
					automaticMemoryExtraction.schedule(sessionManager.getSessionFile());
				}
				// Auto-initialize session on first user message
				if (sessionManager.shouldInitializeSession(agent.state.messages)) {
					void initializeSessionIfNeeded()
						.then((initializationError) => {
							if (initializationError) {
								sendSSE(sseSession, {
									type: "error",
									message: `[Policy] ${initializationError}`,
								});
								sseSession.end();
							}
						})
						.catch((error) => {
							logger.warn("Failed to initialize session", {
								error: error instanceof Error ? error.message : String(error),
							});
							sendSSE(sseSession, {
								type: "error",
								message: "[Policy] Failed to initialize session",
							});
							sseSession.end();
						});
				}

				// Update session snapshot on every event
				sessionManager.updateSnapshot(
					agent.state,
					toSessionModelMetadata(registeredModel),
				);
				dispatchAgentNotification(
					event,
					{
						cwd: process.cwd(),
						sessionId: sessionManager.getSessionId(),
						messages: agent.state.messages,
					},
					{
						sessionHookService,
						logger,
					},
				);

				return;
			}

			// Update session snapshot on every event
			sessionManager.updateSnapshot(
				agent.state,
				toSessionModelMetadata(registeredModel),
			);
			dispatchAgentNotification(
				event,
				{
					cwd: process.cwd(),
					sessionId: sessionManager.getSessionId(),
					messages: agent.state.messages,
				},
				{
					sessionHookService,
					logger,
				},
			);
		});

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
			unsubscribeMcpElicitationBridge();

			await automaticMemoryExtraction.flush();
			await automaticMemoryConsolidation.flush();
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
			await runUserPromptWithRecovery({
				agent,
				sessionManager,
				cwd: process.cwd(),
				prompt: userInput,
				attachmentCount: attachmentsToSend?.length ?? 0,
				attachmentNames: attachmentsToSend?.map(
					(attachment) => attachment.fileName,
				),
				execute: () =>
					breaker.execute(() => agent.prompt(userInput, attachmentsToSend)),
				getPostKeepMessages: withMcpPostKeepMessages(),
			});

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
