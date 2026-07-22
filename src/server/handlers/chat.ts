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
import { assignConfiguredOraclePolicyExperiment } from "../../agent/oracle-policy-experiment.js";
import {
	createRoutingReceipt,
	resolveAgentProfileSelection,
} from "../../agent/routing-receipt.js";
import { isAssistantMessage } from "../../agent/type-guards.js";
import type {
	Attachment as AgentAttachment,
	ThinkingLevel,
} from "../../agent/types.js";
import type { RegisteredModel } from "../../models/registry.js";
import {
	resolveIntelligentRouterProfileHint,
	selectIntelligentRouterModel,
} from "../../services/intelligent-router/recorder.js";
import { evaluateModelPolicy } from "../../services/workspace-config/policy.js";
import { recordSseSkip } from "../../telemetry.js";
import { recordOraclePolicyExperimentAssignment } from "../../telemetry/oracle-policy.js";
import { createLogger } from "../../utils/logger.js";
import type { WebServerContext } from "../app-context.js";
import {
	normalizeApprovalMode,
	resolveApprovalModeForRequest,
} from "../approval-mode-store.js";
import { getAuthSubject } from "../authz.js";
import { isHostedSessionManager } from "../hosted-session-manager.js";
import { resolveModelInputForRouting } from "../model-selection.js";
import { createNativeMemoryCoordinators } from "../native-memory.js";
import { getWorkspaceConfigContext } from "../request-context.js";
import {
	ApiError,
	getRequestHeader,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";
import { startSessionStateWithPolicy } from "../session-initialization.js";
import { createWebSessionManagerForRequest } from "../session-scope.js";
import { SseSession, sendSSE } from "../sse-session.js";
import {
	type ChatRequestInput,
	ChatRequestSchema,
	parseAndValidateJson,
} from "../validation.js";
import { ensureComposerSessionForNative } from "../web-composer-registry.js";
import {
	composerHistoryForNative,
	getComposerTextContent,
	runNativeWebChatTurn,
} from "../web-native-chat.js";
import { verifySessionOwnership } from "./sessions.js";

const logger = createLogger("web:chat");

function requestsClientTools(req: IncomingMessage): boolean {
	const value = getRequestHeader(
		req,
		"x-composer-client-tools",
		"x-maestro-client-tools",
	);
	return value
		? ["1", "true", "yes", "on"].includes(value.trim().toLowerCase())
		: false;
}

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
		getRegisteredModel,
		defaultApprovalMode,
		defaultProvider,
		defaultModelId,
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
		if (requestsClientTools(req)) {
			sendJson(
				res,
				400,
				{ error: "Native web chat does not yet support client-side tools" },
				cors,
				req,
			);
			return;
		}

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
			if (existingSessionLoaded) {
				const resumedSession = await sessionManager.loadSession(
					chatReq.sessionId,
					{
						messagesView: "notLoaded",
					},
				);
				if (
					!resumedSession ||
					!verifySessionOwnership(resumedSession, subject)
				) {
					sendJson(res, 404, { error: "Session not found" }, cors, req);
					return;
				}
			}
		}

		// Resolve model from registry through the intelligent router. With no history,
		// this preserves the caller's requested model; with enough data or overrides,
		// it can select a better-scoring model and expose explicit fallbacks.
		const profileSelection = resolveAgentProfileSelection({
			requestedProfile: resolveIntelligentRouterProfileHint(req, chatReq),
			sessionPin: sessionManager.getHeader()?.agentProfilePin,
			compatibilityProfile: "medium",
		});
		if (chatReq.persistProfile && profileSelection.source === "request") {
			sessionManager.updateAgentProfilePin({
				profile: profileSelection.requestedProfile,
				updatedAt: new Date().toISOString(),
			});
		}
		const routingSelection = selectIntelligentRouterModel({
			req,
			requestedModel: resolveModelInputForRouting(
				chatReq.model,
				defaultProvider,
				defaultModelId,
			),
			body: { ...chatReq, profile: profileSelection.requestedProfile },
		});
		const oracleExperimentAssignment = assignConfiguredOraclePolicyExperiment(
			sessionManager.getSessionId(),
		);
		if (oracleExperimentAssignment) {
			recordOraclePolicyExperimentAssignment({
				assignment: oracleExperimentAssignment,
				sessionId: sessionManager.getSessionId(),
			});
		}
		const routedDecision = oracleExperimentAssignment
			? {
					...routingSelection.decision,
					oracleConsultation: routingSelection.decision.oracleConsultation
						? {
								...routingSelection.decision.oracleConsultation,
								policyVersion: oracleExperimentAssignment.policyVersion,
							}
						: undefined,
				}
			: routingSelection.decision;
		let registeredModel: RegisteredModel | undefined;
		let selectedModelInputIndex = -1;
		let lastModelError: unknown;
		let selectedModelError: unknown;
		let selectedModelPolicyViolation: ReturnType<
			typeof evaluateModelPolicy
		> | null = null;
		for (const [index, modelInput] of routingSelection.modelInputs.entries()) {
			try {
				const candidateModel = await getRegisteredModel(modelInput);
				const violation = evaluateModelPolicy(
					getWorkspaceConfigContext()?.config,
					{
						provider: candidateModel.provider,
						modelId: candidateModel.id,
					},
				);
				if (violation) {
					if (index === 0) {
						selectedModelPolicyViolation = violation;
					}
					continue;
				}
				registeredModel = candidateModel;
				selectedModelInputIndex = index;
				break;
			} catch (error) {
				lastModelError = error;
				if (index === 0) {
					selectedModelError = error;
				}
			}
		}
		if (!registeredModel && selectedModelPolicyViolation) {
			sendJson(
				res,
				403,
				{
					error: selectedModelPolicyViolation.message,
					code: selectedModelPolicyViolation.code,
					workspaceId: selectedModelPolicyViolation.workspaceId,
				},
				cors,
				req,
			);
			return;
		}
		if (!registeredModel) {
			throw selectedModelError ?? lastModelError;
		}
		const usedFallback = selectedModelInputIndex > 0;
		const routingReceipt = createRoutingReceipt(
			{
				...routedDecision,
				selectedModel: {
					provider: registeredModel.provider,
					model: registeredModel.id,
				},
			},
			{
				...profileSelection,
				...(oracleExperimentAssignment
					? {
							experiment: {
								experimentId: oracleExperimentAssignment.experimentId,
								arm: oracleExperimentAssignment.arm,
								policyVersion: oracleExperimentAssignment.policyVersion,
							},
						}
					: {}),
				...(usedFallback || routingSelection.decision.reason !== "highest_score"
					? {
							fallbackReason: usedFallback
								? "selected_model_unavailable_or_disallowed"
								: routingSelection.decision.reason,
							fallbackModel: usedFallback
								? {
										provider: registeredModel.provider,
										model: registeredModel.id,
									}
								: undefined,
						}
					: {}),
			},
		);
		const routeStartedAt = Date.now();

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

		// Web chat is native-only and never falls through to an in-process agent.
		//
		// Native web chat: no TS Agent → do not call bindAgentSession (would hard-fail).
		// When a real session is known, ensureSession registers session-scoped UI
		// state only; active composers do not affect native headless turns.
		{
			const nativeComposerSessionId =
				existingSessionLoaded || sessionManager.isInitialized()
					? sessionManager.getSessionId()
					: null;
			ensureComposerSessionForNative(
				context.composerManagers,
				subject,
				nativeComposerSessionId,
			);

			const abortController = new AbortController();
			const onNativeClose = () => abortController.abort();
			req.on("close", onNativeClose);
			res.on("close", onNativeClose);

			const nativeSseSession = { current: null as SseSession | null };
			let createdSessionId: string | undefined;
			const requestId = Math.random().toString(36).slice(2);
			const modelKey = `${registeredModel.provider}/${registeredModel.id}`;
			const nativeHistory = composerHistoryForNative(incomingMessages);
			// Non-blocking durable memory via native one-shots.
			const nativeMemory = createNativeMemoryCoordinators({
				sessionManager,
				model: {
					id: registeredModel.id,
					provider: registeredModel.provider,
				},
				cwd: process.cwd(),
			});

			try {
				const nativeResult = await runNativeWebChatTurn({
					prompt: userInput,
					attachments: attachmentsToSend,
					cwd: process.cwd(),
					profileName: context.profileName,
					cliOverrides: context.cliOverrides,
					modelId: registeredModel.id,
					provider: registeredModel.provider,
					thinkingLevel: chatReq.thinkingLevel || "off",
					approvalMode: effectiveApproval,
					history: nativeHistory,
					signal: abortController.signal,
					onBeforePrompt: async ({
						systemPrompt,
						promptMetadata,
						promptContextManifest,
						systemPromptSourcePaths,
					}) => {
						if (!existingSessionLoaded && !sessionManager.isInitialized()) {
							const { enterpriseContext } = await import(
								"../../enterprise/context.js"
							);
							const initializationError = await startSessionStateWithPolicy({
								enterpriseContext,
								logger,
								modelId: registeredModel.id,
								onSessionReady: (sessionId) => {
									createdSessionId = sessionId;
								},
								sessionManager,
								state: {
									model: registeredModel,
									thinkingLevel: (chatReq.thinkingLevel ||
										"off") as ThinkingLevel,
									systemPrompt,
									promptMetadata,
									promptContextManifest,
									systemPromptSourcePaths,
									tools: [],
								},
								subject,
							});
							if (initializationError) {
								throw new ApiError(403, `[Policy] ${initializationError}`);
							}
							existingSessionLoaded = true;
						}
					},
					onStarted: async () => {
						// Persist only after the native child accepted the prompt.
						try {
							sessionManager.saveMessage({
								role: "user",
								content: userInput,
								...(attachmentsToSend?.length
									? { attachments: attachmentsToSend }
									: {}),
								timestamp: Date.now(),
							});
						} catch (persistError) {
							logger.warn(
								"Native web chat: failed to persist user message (best-effort)",
								{
									error:
										persistError instanceof Error
											? persistError.message
											: String(persistError),
								},
							);
						}
						res.writeHead(200, {
							"Content-Type": "text/event-stream",
							"Cache-Control": "no-cache",
							Connection: "keep-alive",
							...cors,
						});
						nativeSseSession.current = new SseSession(
							res,
							(metrics) => {
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
						nativeSseSession.current.sendRoutingReceipt(routingReceipt);
						if (createdSessionId) {
							nativeSseSession.current.sendSessionUpdate(createdSessionId);
						}
						nativeSseSession.current.startHeartbeat();
					},
					onEvent: (event) => {
						if (!nativeSseSession.current) return;
						sendSSE(nativeSseSession.current, event);
						// Best-effort session persistence (known gap if save fails).
						if (event.type === "message_end") {
							try {
								const persistedMessage = isAssistantMessage(event.message)
									? { ...event.message, routingReceipt }
									: event.message;
								sessionManager.saveMessage(persistedMessage);
								if (isAssistantMessage(event.message)) {
									// Debounced; never blocks the stream.
									nativeMemory.extraction.schedule(
										sessionManager.getSessionFile(),
									);
								}
							} catch (persistError) {
								logger.warn(
									"Native web chat: failed to persist message_end (best-effort)",
									{
										error:
											persistError instanceof Error
												? persistError.message
												: String(persistError),
									},
								);
							}
						}
					},
				});

				if (nativeResult.ok) {
					if (nativeSseSession.current) {
						nativeSseSession.current.stopHeartbeat();
						if (!res.writableEnded) {
							nativeSseSession.current.sendDone();
							nativeSseSession.current.end();
						}
					}
					try {
						await sessionManager.flush();
					} catch {
						// best-effort
					}
					return;
				}

				// Failure: send error and return.
				if (nativeResult.error instanceof ApiError) {
					logger.warn("Native web chat request rejected", {
						message: nativeResult.error.message,
						statusCode: nativeResult.error.statusCode,
					});
				} else {
					logger.error(
						nativeResult.phase === "start"
							? "Native web chat path failed to start"
							: "Native web chat turn failed after start",
						nativeResult.error,
					);
				}
				if (!res.headersSent) {
					if (nativeResult.error instanceof ApiError) {
						respondWithApiError(res, nativeResult.error, 500, cors, req);
					} else {
						sendJson(
							res,
							500,
							{ error: nativeResult.error.message },
							cors,
							req,
						);
					}
				} else if (nativeSseSession.current && !res.writableEnded) {
					sendSSE(nativeSseSession.current, {
						type: "error",
						message: nativeResult.error.message,
					});
					nativeSseSession.current.stopHeartbeat();
					nativeSseSession.current.end();
				}
				return;
			} catch (nativeError) {
				logger.error(
					"Native web chat path threw",
					nativeError instanceof Error ? nativeError : undefined,
				);
				const message =
					nativeError instanceof Error
						? nativeError.message
						: String(nativeError);
				if (!res.headersSent) {
					sendJson(res, 500, { error: message }, cors, req);
				} else if (nativeSseSession.current && !res.writableEnded) {
					sendSSE(nativeSseSession.current, {
						type: "error",
						message,
					});
					nativeSseSession.current.stopHeartbeat();
					nativeSseSession.current.end();
				}
				return;
			} finally {
				req.off("close", onNativeClose);
				res.off("close", onNativeClose);
				if (nativeSseSession.current) {
					nativeSseSession.current.stopHeartbeat();
				}
			}
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
