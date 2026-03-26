/**
 * WebSocket chat handler for agent conversations.
 *
 * Mirrors the SSE chat flow but streams AgentEvent payloads over WebSocket.
 */

import type { IncomingMessage } from "node:http";
import type { ComposerChatRequest, ComposerMessage } from "@evalops/contracts";
import type { RawData, WebSocket } from "ws";
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
import { toSessionModelMetadata } from "../../session/manager.js";
import { createLogger } from "../../utils/logger.js";
import type { WebServerContext } from "../app-context.js";
import {
	normalizeApprovalMode,
	resolveApprovalModeForRequest,
} from "../approval-mode-store.js";
import { publishArtifactUpdate } from "../artifacts-live-reload.js";
import { getAuthSubject } from "../authz.js";
import { getAgentCircuitBreaker } from "../circuit-breaker.js";
import { createSessionManagerForRequest } from "../session-scope.js";
import { convertComposerMessagesToApp } from "../session-serialization.js";
import type { SseContext, SseSkipListener } from "../sse-session.js";
import {
	type ChatRequestInput,
	ChatRequestSchema,
	validatePayload,
} from "../validation.js";

const logger = createLogger("web:chat-ws");

function getComposerTextContent(content: ComposerMessage["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

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
) {
	const {
		createAgent,
		getRegisteredModel,
		defaultApprovalMode,
		acquireSse,
		releaseSse,
	} = context;

	let sseLease: symbol | null = null;
	let cleanedUp = false;
	let requestHandled = false;

	const url = new URL(
		req.url || "/api/chat/ws",
		`http://${req.headers.host || "localhost"}`,
	);

	const clientToolsFromQuery = parseBoolean(
		url.searchParams.get("clientTools"),
	);
	const slimFromQuery = parseBoolean(url.searchParams.get("slim"));
	const clientHeaderFromQuery = url.searchParams.get("client")?.trim();

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

	ws.on("message", async (data) => {
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

			const sessionManager = createSessionManagerForRequest(req, false);
			const subject = getAuthSubject(req);
			if (chatReq.sessionId) {
				const sessionFile = sessionManager.getSessionFileById(
					chatReq.sessionId,
				);
				if (sessionFile) {
					sessionManager.setSessionFile(sessionFile);
				}
			}

			const registeredModel = await getRegisteredModel(chatReq.model);

			const headerApproval = (() => {
				const header = req.headers["x-composer-approval-mode"];
				const headerMode = normalizeApprovalMode(
					Array.isArray(header) ? header[0] : header,
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

			const clientToolsHeader = (() => {
				if (typeof clientToolsFromQuery === "boolean") {
					return clientToolsFromQuery;
				}
				const header = req.headers["x-composer-client-tools"];
				const raw = Array.isArray(header) ? header[0] : header;
				return raw?.trim() === "1";
			})();

			const clientHeader = (() => {
				if (clientHeaderFromQuery) return clientHeaderFromQuery.toLowerCase();
				const header = req.headers["x-composer-client"];
				const raw = Array.isArray(header) ? header[0] : header;
				return raw?.trim().toLowerCase();
			})();

			const agent = await createAgent(
				registeredModel,
				chatReq.thinkingLevel || "off",
				effectiveApproval,
				clientToolsHeader
					? {
							enableClientTools: true,
							includeVscodeTools: clientHeader === "vscode",
							includeJetBrainsTools: clientHeader === "jetbrains",
							includeConductorTools: clientHeader === "conductor",
						}
					: undefined,
			);

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

			const requestId = Math.random().toString(36).slice(2);
			const modelKey = `${registeredModel.provider}/${registeredModel.id}`;
			const wsSession = new WsSession(ws, undefined, { requestId, modelKey });
			const { enterpriseContext } = await import("../../enterprise/context.js");

			const toolArgsByCallId = new Map<string, Record<string, unknown>>();
			const slimHeader = req.headers["x-composer-slim-events"];
			const slimValue = Array.isArray(slimHeader) ? slimHeader[0] : slimHeader;
			const slimEvents =
				typeof slimFromQuery === "boolean" ? slimFromQuery : slimValue === "1";
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
					maybeArgs &&
					typeof maybeArgs === "object" &&
					!Array.isArray(maybeArgs)
						? maybeArgs
						: undefined;
				if (toolCallArgs) {
					try {
						const size = Buffer.byteLength(
							JSON.stringify(toolCallArgs),
							"utf8",
						);
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

			const unsubscribe = agent.subscribe((event: AgentEvent) => {
				wsSession.sendEvent(maybeSlimEvent(event));

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

				if (event.type === "message_end") {
					sessionManager.saveMessage(event.message);

					if (sessionManager.shouldInitializeSession(agent.state.messages)) {
						let activeCount: number | undefined;
						try {
							const sessions = sessionManager.loadAllSessions();
							activeCount = sessions.filter(
								(s) => Date.now() - s.modified.getTime() < 60 * 60 * 1000,
							).length;
						} catch (error) {
							logger.warn("Failed to count active sessions", {
								error: error instanceof Error ? error.message : String(error),
							});
						}

						const limitCheck = checkSessionLimits(
							{ startedAt: new Date() },
							activeCount !== undefined
								? { activeSessionCount: activeCount + 1 }
								: undefined,
						);

						if (!limitCheck.allowed) {
							wsSession.sendEvent({
								type: "error",
								message: `[Policy] ${limitCheck.reason}`,
							});
							wsSession.end();
							return;
						}

						sessionManager.startSession(agent.state, { subject });

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
						wsSession.sendSessionUpdate(sessionId);
						wsSession.setContext({ sessionId });
					}
				}

				sessionManager.updateSnapshot(
					agent.state,
					toSessionModelMetadata(registeredModel),
				);
			});

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

			const cleanup = async (aborted = false) => {
				if (cleanedUp) return;
				cleanedUp = true;
				unsubscribe();
				await sessionManager.flush();
				if (aborted) {
					wsSession.sendAborted();
				}
				wsSession.end();
			};

			ws.on("close", () => {
				agent.abort();
				void cleanup(true);
			});

			try {
				const breaker = getAgentCircuitBreaker(registeredModel.provider);
				await breaker.execute(() => agent.prompt(userInput, attachmentsToSend));
				wsSession.sendDone();
			} catch (error) {
				logger.error(
					"Agent prompt error",
					error instanceof Error ? error : undefined,
					{ sessionId: sessionManager.getSessionId?.() },
				);
				wsSession.sendEvent({
					type: "error",
					message: error instanceof Error ? error.message : "Unknown error",
				});
			} finally {
				await cleanup(false);
				if (sseLease && releaseSse) {
					releaseSse(sseLease);
					sseLease = null;
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
	});
}
