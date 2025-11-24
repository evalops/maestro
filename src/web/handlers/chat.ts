import type { IncomingMessage, ServerResponse } from "node:http";
import type { ComposerChatRequest, ComposerMessage } from "@evalops/contracts";
import type { AgentState } from "../../agent/types.js";
import type { RegisteredModel } from "../../models/registry.js";
import {
	SessionManager,
	toSessionModelMetadata,
} from "../../session/manager.js";
import { recordSseSkip } from "../../telemetry.js";
import {
	readJsonBody,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";
import { convertComposerMessagesToApp } from "../session-serialization.js";
import { SseSession, sendSSE, sendSessionUpdate } from "../sse-session.js";

export interface ChatDeps {
	createAgent: (
		registeredModel: RegisteredModel,
		thinkingLevel: string,
		approvalMode: string,
	) => Promise<{
		subscribe: (fn: (event: any) => void) => () => void;
		replaceMessages: (msgs: any[]) => void;
		clearMessages: () => void;
		prompt: (input: string) => Promise<void>;
		abort: () => void;
		state: AgentState;
	}>;
	getRegisteredModel: (
		input: string | null | undefined,
	) => Promise<RegisteredModel>;
	defaultApprovalMode: string;
	defaultProvider: string;
	defaultModelId: string;
}

export async function handleChat(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
	{ createAgent, getRegisteredModel, defaultApprovalMode }: ChatDeps,
) {
	try {
		const chatReq = await readJsonBody<ComposerChatRequest>(req);

		const incomingMessages = Array.isArray(chatReq.messages)
			? (chatReq.messages as ComposerMessage[])
			: [];
		if (incomingMessages.length === 0) {
			sendJson(res, 400, { error: "No messages supplied" }, cors);
			return;
		}

		const latestMessage = incomingMessages[incomingMessages.length - 1];
		if (!latestMessage || latestMessage.role !== "user") {
			sendJson(
				res,
				400,
				{ error: "Last message must be a user message" },
				cors,
			);
			return;
		}

		const userInput = (latestMessage.content ?? "").trim();
		if (!userInput) {
			sendJson(res, 400, { error: "User message cannot be empty" }, cors);
			return;
		}

		const sessionManager = new SessionManager(false);
		if (chatReq.sessionId) {
			const sessionFile = sessionManager.getSessionFileById(chatReq.sessionId);
			if (sessionFile) {
				sessionManager.setSessionFile(sessionFile);
			}
		}

		const registeredModel = await getRegisteredModel(chatReq.model);
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
		const effectiveApproval =
			headerApproval && headerApproval !== "auto"
				? headerApproval
				: (defaultApprovalMode as "auto" | "prompt" | "fail");
		const agent = await createAgent(
			registeredModel,
			chatReq.thinkingLevel || "off",
			effectiveApproval,
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

		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			...cors,
		});

		const requestId = Math.random().toString(36).slice(2);
		const modelKey = `${registeredModel.provider}/${registeredModel.id}`;
		const sseSession = new SseSession(
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
		sseSession.startHeartbeat();
		let cleanedUp = false;

		const unsubscribe = agent.subscribe((event: any) => {
			sendSSE(sseSession, event);

			if (event.type === "message_end") {
				sessionManager.saveMessage(event.message);
				if (sessionManager.shouldInitializeSession(agent.state.messages)) {
					sessionManager.startSession(agent.state);
					const sessionId = sessionManager.getSessionId();
					sendSessionUpdate(sseSession, sessionId);
					sseSession.setContext({ sessionId });
				}
			}

			sessionManager.updateSnapshot(
				agent.state,
				toSessionModelMetadata(registeredModel),
			);
		});

		const handleConnectionClose = () => {
			agent.abort();
			void cleanup(true);
		};

		req.on("close", handleConnectionClose);
		res.on("close", handleConnectionClose);

		const cleanup = async (aborted = false) => {
			if (cleanedUp) {
				return;
			}
			cleanedUp = true;
			sseSession.stopHeartbeat();
			req.off("close", handleConnectionClose);
			res.off("close", handleConnectionClose);
			unsubscribe();
			await sessionManager.flush();
			if (!res.writableEnded) {
				if (aborted) {
					sseSession.sendAborted();
				}
				sseSession.end();
			}
			const metrics = sseSession.getMetrics();
			if (metrics.skipped > 0) {
				console.debug("SSE writes skipped after disconnect", metrics);
			}
		};

		try {
			await agent.prompt(userInput);
			if (!res.writableEnded) {
				sseSession.sendDone();
			}
		} catch (error) {
			console.error("Agent prompt error:", error);
			sendSSE(sseSession, {
				type: "error",
				message: error instanceof Error ? error.message : "Unknown error",
			});
		} finally {
			await cleanup(false);
		}
	} catch (error) {
		console.error("Chat error:", error);
		respondWithApiError(res, error, 500, cors);
	}
}
