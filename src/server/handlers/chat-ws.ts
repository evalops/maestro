/**
 * WebSocket chat handler for agent conversations.
 *
 * Mirrors the SSE chat flow but streams AgentEvent payloads over WebSocket.
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type {
	ComposerChatRequest,
	ComposerMessage,
	RoutingReceipt,
} from "@evalops/contracts";
import type { RawData, WebSocket } from "ws";
import { assignConfiguredOraclePolicyExperiment } from "../../agent/oracle-policy-experiment.js";
import {
	createRoutingReceipt,
	resolveAgentProfileSelection,
} from "../../agent/routing-receipt.js";
import { isAssistantMessage } from "../../agent/type-guards.js";
import type {
	Attachment as AgentAttachment,
	AgentEvent,
	ThinkingLevel,
} from "../../agent/types.js";
import type { RegisteredModel } from "../../models/registry.js";
import {
	resolveIntelligentRouterProfileHint,
	selectIntelligentRouterModel,
} from "../../services/intelligent-router/recorder.js";
import { evaluateModelPolicy } from "../../services/workspace-config/policy.js";
import type { WorkspaceConfigRequestContext } from "../../services/workspace-config/types.js";
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
import {
	type RequestContext,
	getWorkspaceConfigContext,
	parseTraceParent,
	requestContextStorage,
} from "../request-context.js";
import { ApiError, getRequestHeader } from "../server-utils.js";
import { startSessionStateWithPolicy } from "../session-initialization.js";
import { createWebSessionManagerForRequest } from "../session-scope.js";
import type { SseContext, SseSkipListener } from "../sse-session.js";
import {
	type ChatRequestInput,
	ChatRequestSchema,
	validatePayload,
} from "../validation.js";
import { ensureComposerSessionForNative } from "../web-composer-registry.js";
import {
	composerHistoryForNative,
	getComposerTextContent,
	runNativeWebChatTurn,
} from "../web-native-chat.js";
import { verifySessionOwnership } from "./sessions.js";

const logger = createLogger("web:chat-ws");
class WsSession {
	private closed = false;
	private skippedWrites = 0;
	private sentWrites = 0;
	private lastError?: unknown;
	private context: SseContext = {};

	constructor(
		private readonly ws: WebSocket,
		private readonly onSkip?: SseSkipListener,
		context?: SseContext,
	) {
		if (context) {
			this.context = context;
		}
	}

	private canWrite(): boolean {
		return this.ws.readyState === 1;
	}

	private write(payload: string): boolean {
		if (!this.canWrite()) {
			this.skippedWrites++;
			this.notifySkip();
			return false;
		}
		try {
			this.ws.send(payload);
			this.sentWrites++;
			return true;
		} catch (error) {
			this.skippedWrites++;
			this.lastError = error;
			this.notifySkip();
			return false;
		}
	}

	sendEvent(event: AgentEvent): void {
		this.write(JSON.stringify(event));
	}

	sendSessionUpdate(sessionId: string): void {
		this.write(JSON.stringify({ type: "session_update", sessionId }));
	}

	sendRoutingReceipt(receipt: RoutingReceipt): void {
		this.write(JSON.stringify({ type: "routing_receipt", receipt }));
	}

	sendHeartbeat(): void {
		this.write(JSON.stringify({ type: "heartbeat" }));
	}

	sendAborted(): void {
		this.write(JSON.stringify({ type: "aborted" }));
	}

	sendDone(): void {
		this.write(JSON.stringify({ type: "done" }));
	}

	end(): void {
		if (this.closed) return;
		this.closed = true;
		if (!this.canWrite()) return;
		try {
			this.ws.close();
		} catch (error) {
			this.skippedWrites++;
			this.lastError = error;
			this.notifySkip();
		}
	}

	getMetrics(): { sent: number; skipped: number; lastError?: unknown } {
		return {
			sent: this.sentWrites,
			skipped: this.skippedWrites,
			lastError: this.lastError,
		};
	}

	setContext(context: SseContext): void {
		this.context = { ...this.context, ...context };
	}

	private notifySkip(): void {
		if (this.skippedWrites <= 1) return;
		if (this.onSkip) {
			this.onSkip({
				sent: this.sentWrites,
				skipped: this.skippedWrites,
				lastError: this.lastError,
				context: this.context,
			});
		}
	}
}

function parseBoolean(input?: string | null): boolean | undefined {
	if (!input) return undefined;
	const normalized = input.toLowerCase().trim();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return undefined;
}

function getRawDataSize(data: RawData): number {
	if (typeof data === "string") {
		return Buffer.byteLength(data, "utf8");
	}
	if (Buffer.isBuffer(data)) {
		return data.length;
	}
	if (data instanceof ArrayBuffer) {
		return data.byteLength;
	}
	if (Array.isArray(data)) {
		return data.reduce((total, chunk) => total + chunk.length, 0);
	}
	return 0;
}

function rawDataToString(data: RawData, maxPayload: number): string {
	const size = getRawDataSize(data);
	if (size > maxPayload) {
		throw new Error("Payload too large");
	}
	if (typeof data === "string") {
		return data;
	}
	if (Buffer.isBuffer(data)) {
		return data.toString("utf8");
	}
	if (Array.isArray(data)) {
		return Buffer.concat(data).toString("utf8");
	}
	if (data instanceof ArrayBuffer) {
		return Buffer.from(data).toString("utf8");
	}
	return "";
}

export function handleChatWebSocket(
	ws: WebSocket,
	req: IncomingMessage,
	context: WebServerContext,
	workspaceConfig?: WorkspaceConfigRequestContext,
) {
	const {
		getRegisteredModel,
		defaultApprovalMode,
		defaultProvider,
		defaultModelId,
		acquireSse,
		releaseSse,
	} = context;

	let sseLease: symbol | null = null;
	const cleanedUp = false;
	const cleanupPromise: Promise<void> | null = null;
	const boundComposerSessionId: string | null = null;
	let requestHandled = false;

	const url = new URL(
		req.url || "/api/chat/ws",
		`http://${req.headers.host || "localhost"}`,
	);

	const clientToolsFromQuery = parseBoolean(
		url.searchParams.get("clientTools"),
	);
	const clientToolsRequested =
		clientToolsFromQuery === true ||
		parseBoolean(
			getRequestHeader(
				req,
				"x-composer-client-tools",
				"x-maestro-client-tools",
			),
		) === true;
	const slimFromQuery = parseBoolean(url.searchParams.get("slim"));
	const clientHeaderFromQuery = url.searchParams.get("client")?.trim();
	const websocketRequestContext: RequestContext | undefined = workspaceConfig
		? {
				requestId: randomUUID(),
				traceId: parseTraceParent(req.headers.traceparent).traceId,
				spanId: randomBytes(8).toString("hex"),
				startTime: performance.now(),
				method: req.method || "GET",
				url: url.pathname,
				workspaceConfig,
			}
		: undefined;

	const sendErrorAndClose = (message: string) => {
		try {
			const session = new WsSession(ws);
			session.sendEvent({ type: "error", message });
			session.sendDone();
			session.end();
		} catch {
			ws.close();
		}
	};

	const maxPayload =
		Number.parseInt(process.env.MAESTRO_WS_MAX_PAYLOAD || "1048576", 10) ||
		1048576;
	const parseRequest = (data: RawData): ComposerChatRequest => {
		const raw = rawDataToString(data, maxPayload);
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new Error("Invalid JSON payload");
		}
		return validatePayload<ChatRequestInput>(parsed, ChatRequestSchema);
	};

	const handleMessage = async (data: RawData) => {
		if (requestHandled) {
			try {
				const size = getRawDataSize(data);
				if (size > maxPayload) {
					return;
				}
				const raw = rawDataToString(data, maxPayload);
				const parsed = JSON.parse(raw);
				if (parsed && typeof parsed === "object" && parsed.type === "abort") {
					ws.close();
				}
			} catch {
				// ignore
			}
			return;
		}
		requestHandled = true;
		try {
			let chatReq: ComposerChatRequest;
			try {
				chatReq = parseRequest(data);
			} catch (error) {
				sendErrorAndClose(
					error instanceof Error ? error.message : "Invalid chat request",
				);
				return;
			}
			if (clientToolsRequested) {
				sendErrorAndClose(
					"Native web chat does not yet support client-side tools",
				);
				return;
			}

			const incomingMessages = Array.isArray(chatReq.messages)
				? (chatReq.messages as ComposerMessage[])
				: [];
			if (incomingMessages.length === 0) {
				sendErrorAndClose("No messages supplied");
				return;
			}

			const latestMessage = incomingMessages[incomingMessages.length - 1];
			if (!latestMessage || latestMessage.role !== "user") {
				sendErrorAndClose("Last message must be a user message");
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
						item.type === "image" || item.type === "document"
							? item.type
							: null;
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
						continue;
					}

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
				sendErrorAndClose(attachmentError);
				return;
			}

			const userInput = getComposerTextContent(latestMessage.content).trim();
			if (!userInput && !attachmentsToSend) {
				sendErrorAndClose("User message cannot be empty");
				return;
			}

			if (acquireSse) {
				sseLease = acquireSse();
				if (!sseLease) {
					sendErrorAndClose("Too many active streaming connections");
					return;
				}
			}

			const sessionManager = createWebSessionManagerForRequest(req, false);
			const subject = getAuthSubject(req);
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
						{ messagesView: "notLoaded" },
					);
					if (
						!resumedSession ||
						!verifySessionOwnership(resumedSession, subject)
					) {
						sendErrorAndClose("Session not found");
						if (sseLease && releaseSse) {
							releaseSse(sseLease);
							sseLease = null;
						}
						return;
					}
				}
			}

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
			for (const [
				index,
				modelInput,
			] of routingSelection.modelInputs.entries()) {
				try {
					const candidateModel = await getRegisteredModel(modelInput);
					const violation = evaluateModelPolicy(
						workspaceConfig?.config ?? getWorkspaceConfigContext()?.config,
						{
							provider: candidateModel.provider,
							modelId: candidateModel.id,
						},
					);
					if (violation) {
						if (index === 0) selectedModelPolicyViolation = violation;
						continue;
					}
					registeredModel = candidateModel;
					selectedModelInputIndex = index;
					break;
				} catch (error) {
					lastModelError = error;
					if (index === 0) selectedModelError = error;
				}
			}
			if (!registeredModel && selectedModelPolicyViolation) {
				sendErrorAndClose(selectedModelPolicyViolation.message);
				if (sseLease && releaseSse) {
					releaseSse(sseLease);
					sseLease = null;
				}
				return;
			}
			if (!registeredModel) throw selectedModelError ?? lastModelError;
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
					...(usedFallback ||
					routingSelection.decision.reason !== "highest_score"
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

			const headerApproval = (() => {
				const headerMode = normalizeApprovalMode(
					getRequestHeader(
						req,
						"x-composer-approval-mode",
						"x-maestro-approval-mode",
					) ?? undefined,
				);
				if (headerMode) {
					return headerMode;
				}
				const approvalParam = url.searchParams.get("approval");
				return normalizeApprovalMode(approvalParam);
			})();

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
				ws.on("close", onNativeClose);

				const nativeWsSession = { current: null as WsSession | null };
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
							nativeWsSession.current = new WsSession(ws, undefined, {
								requestId,
								modelKey,
							});
							nativeWsSession.current.sendRoutingReceipt(routingReceipt);
							if (createdSessionId) {
								nativeWsSession.current.sendSessionUpdate(createdSessionId);
							}
						},
						onEvent: (event) => {
							if (!nativeWsSession.current) return;
							nativeWsSession.current.sendEvent(event);
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
						if (nativeWsSession.current) {
							nativeWsSession.current.sendDone();
							nativeWsSession.current.end();
						}
						try {
							await sessionManager.flush();
						} catch {
							// best-effort
						}
						if (sseLease && releaseSse) {
							releaseSse(sseLease);
							sseLease = null;
						}
						return;
					}

					// Failure: send error and return.
					if (nativeResult.error instanceof ApiError) {
						logger.warn("Native websocket chat request rejected", {
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
					if (nativeWsSession.current) {
						nativeWsSession.current.sendEvent({
							type: "error",
							message: nativeResult.error.message,
						});
						nativeWsSession.current.sendDone();
						nativeWsSession.current.end();
					} else {
						sendErrorAndClose(nativeResult.error.message);
					}
					if (sseLease && releaseSse) {
						releaseSse(sseLease);
						sseLease = null;
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
					if (nativeWsSession.current) {
						nativeWsSession.current.sendEvent({
							type: "error",
							message,
						});
						nativeWsSession.current.sendDone();
						nativeWsSession.current.end();
					} else {
						sendErrorAndClose(message);
					}
					if (sseLease && releaseSse) {
						releaseSse(sseLease);
						sseLease = null;
					}
					return;
				} finally {
					ws.off("close", onNativeClose);
				}
			}
		} catch (error) {
			logger.error(
				"Chat websocket error",
				error instanceof Error ? error : undefined,
			);
			sendErrorAndClose(
				error instanceof Error ? error.message : "Chat websocket error",
			);
			if (sseLease && releaseSse) {
				releaseSse(sseLease);
				sseLease = null;
			}
		}
	};

	ws.on("message", (data) => {
		if (websocketRequestContext) {
			return requestContextStorage.run(websocketRequestContext, () =>
				handleMessage(data),
			);
		}
		return handleMessage(data);
	});
}
