import type { IncomingMessage, ServerResponse } from "node:http";
import { type Static, Type } from "@sinclair/typebox";
import { isUserMessage } from "../../agent/type-guards.js";
import type { UserMessageWithAttachments } from "../../agent/types.js";
import { getAuthSubject, requireApiAuth, requireCsrf } from "../authz.js";
import { isHostedSessionManager } from "../hosted-session-manager.js";
import { respondWithApiError, sendJson } from "../server-utils.js";
import { createWebSessionManagerForRequest } from "../session-scope.js";
import { checkSessionRateLimitAsync } from "../utils/session-rate-limit.js";
import { parseAndValidateJson } from "../validation.js";

const BranchRequestSchema = Type.Object({
	sessionId: Type.String({ minLength: 1 }),
	messageIndex: Type.Optional(Type.Integer({ minimum: 0 })),
	userMessageNumber: Type.Optional(Type.Integer({ minimum: 1 })),
});

type BranchRequestInput = Static<typeof BranchRequestSchema>;

function assertSessionId(sessionId: string): void {
	if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
		throw new Error("Invalid sessionId format");
	}
}

function summarizeContent(content: unknown, maxLen = 160): string {
	if (typeof content === "string") {
		return content.slice(0, maxLen);
	}
	if (Array.isArray(content)) {
		const text = content
			.filter(
				(c) =>
					typeof c === "object" &&
					c &&
					"type" in c &&
					(c as { type: string }).type === "text",
			)
			.map((c) => (c as { text?: string }).text || "")
			.join("\n");
		return text.slice(0, maxLen);
	}
	return "";
}

export async function handleBranch(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method === "GET") {
		if (!(await requireApiAuth(req, res, corsHeaders))) return;
		const url = new URL(
			req.url || "/api/branch",
			`http://${req.headers.host || "localhost"}`,
		);
		const action = url.searchParams.get("action") || "list";
		const sessionId = url.searchParams.get("sessionId");

		try {
			if (action === "list") {
				if (!sessionId) {
					sendJson(
						res,
						400,
						{ error: "sessionId query parameter is required" },
						corsHeaders,
					);
					return;
				}

				assertSessionId(sessionId);
				const subject = getAuthSubject(req);
				const sessionKey = `${subject}:${sessionId}`;
				const rate = await checkSessionRateLimitAsync(sessionKey);
				if (!rate.allowed) {
					sendJson(
						res,
						429,
						{ error: "Too many branch requests" },
						corsHeaders,
					);
					return;
				}

				const sessionManager = createWebSessionManagerForRequest(req, false);
				const session = await sessionManager.loadSession(sessionId);
				if (!session) {
					sendJson(
						res,
						404,
						{ error: `Session not found: ${sessionId}` },
						corsHeaders,
					);
					return;
				}

				const userMessages = session.messages
					.map((msg, index) => ({ msg, index }))
					.filter(
						(
							entry,
						): entry is { msg: UserMessageWithAttachments; index: number } =>
							isUserMessage(entry.msg),
					);

				sendJson(
					res,
					200,
					{
						userMessages: userMessages.map(({ msg, index }, i) => ({
							number: i + 1,
							index,
							snippet: summarizeContent(msg.content),
						})),
					},
					corsHeaders,
				);
			} else {
				sendJson(res, 400, { error: "Invalid action. Use list." }, corsHeaders);
			}
		} catch (error) {
			respondWithApiError(res, error, 500, corsHeaders, req);
		}
		return;
	}

	if (req.method === "POST") {
		if (!(await requireApiAuth(req, res, corsHeaders))) return;
		if (!requireCsrf(req, res, corsHeaders)) return;
		try {
			const data = await parseAndValidateJson<BranchRequestInput>(
				req,
				BranchRequestSchema,
			);
			assertSessionId(data.sessionId);
			const subject = getAuthSubject(req);
			const sessionKey = `${subject}:${data.sessionId}`;
			const rate = await checkSessionRateLimitAsync(sessionKey);
			if (!rate.allowed) {
				sendJson(res, 429, { error: "Too many branch requests" }, corsHeaders);
				return;
			}

			const sessionManager = createWebSessionManagerForRequest(req, false);
			const session = await sessionManager.loadSession(data.sessionId);
			if (!session) {
				sendJson(
					res,
					404,
					{ error: `Session not found: ${data.sessionId}` },
					corsHeaders,
				);
				return;
			}

			const userMessages = session.messages
				.map((msg, index) => ({ msg, index }))
				.filter(
					(
						entry,
					): entry is { msg: UserMessageWithAttachments; index: number } =>
						isUserMessage(entry.msg),
				);

			let targetIndex: number;
			if (data.userMessageNumber !== undefined) {
				if (
					data.userMessageNumber < 1 ||
					data.userMessageNumber > userMessages.length
				) {
					sendJson(
						res,
						400,
						{
							error: `Invalid user message number: ${data.userMessageNumber}. Available: 1-${userMessages.length}`,
						},
						corsHeaders,
					);
					return;
				}
				const targetUserMessage = userMessages[data.userMessageNumber - 1];
				if (!targetUserMessage) {
					sendJson(
						res,
						400,
						{
							error: `User message not found at index ${data.userMessageNumber}`,
						},
						corsHeaders,
					);
					return;
				}
				targetIndex = targetUserMessage.index;
			} else if (data.messageIndex !== undefined) {
				if (
					data.messageIndex < 0 ||
					data.messageIndex >= session.messages.length
				) {
					sendJson(
						res,
						400,
						{
							error: `Invalid message index: ${data.messageIndex}. Available: 0-${session.messages.length - 1}`,
						},
						corsHeaders,
					);
					return;
				}
				targetIndex = data.messageIndex;
			} else {
				sendJson(
					res,
					400,
					{
						error: "Either messageIndex or userMessageNumber must be provided",
					},
					corsHeaders,
				);
				return;
			}

			if (isHostedSessionManager(sessionManager)) {
				await sessionManager.resumeSession(data.sessionId);
			} else {
				const sessionFile = sessionManager.getSessionFileById(data.sessionId);
				if (!sessionFile) {
					sendJson(
						res,
						404,
						{ error: `Session not found: ${data.sessionId}` },
						corsHeaders,
					);
					return;
				}
				sessionManager.setSessionFile(sessionFile);
			}
			const modelKey = sessionManager.loadModel();
			const thinkingLevel = sessionManager.loadThinkingLevel();
			const messages = session.messages.slice(0, targetIndex);

			// Create minimal agent state for branching
			const { getRegisteredModels } = await import("../../models/registry.js");
			const registeredModels = getRegisteredModels();
			const registeredModel = modelKey
				? (registeredModels.find(
						(m) => `${m.provider}/${m.id}` === modelKey || m.id === modelKey,
					) ?? registeredModels[0])
				: registeredModels[0];

			if (!registeredModel) {
				sendJson(
					res,
					500,
					{ error: "No registered models available" },
					corsHeaders,
				);
				return;
			}

			// Create minimal AgentState for createBranchedSession
			// createBranchedSession only uses: messages, model, thinkingLevel
			const agentState = {
				messages,
				model: registeredModel,
				thinkingLevel: (thinkingLevel as "off" | "low" | "high") ?? "off",
				systemPrompt: "",
				tools: [],
				steeringMode: "all" as const,
				followUpMode: "all" as const,
				queueMode: "all" as const,
				isStreaming: false,
				streamMessage: null,
				pendingToolCalls: new Map<string, { toolName: string }>(),
			} as {
				messages: typeof messages;
				model: typeof registeredModel;
				thinkingLevel: "off" | "low" | "high";
				systemPrompt: string;
				tools: never[];
				steeringMode: "all";
				followUpMode: "all";
				queueMode: "all";
				isStreaming: boolean;
				streamMessage: null;
				pendingToolCalls: Map<string, { toolName: string }>;
			};

			let newSessionId: string;
			let newSessionFile: string;
			if (isHostedSessionManager(sessionManager)) {
				newSessionId = await sessionManager.createBranchedSessionFromState(
					agentState,
					targetIndex,
				);
				newSessionFile = `db:${newSessionId}`;
			} else {
				newSessionFile = sessionManager.createBranchedSession(
					agentState,
					targetIndex,
				);
				const sessionManager2 = createWebSessionManagerForRequest(req, false);
				sessionManager2.setSessionFile(newSessionFile);
				newSessionId = sessionManager2.getSessionId();
			}

			sendJson(
				res,
				200,
				{
					success: true,
					newSessionId,
					newSessionFile,
					message: `Created branch from message index ${targetIndex}`,
				},
				corsHeaders,
			);
		} catch (error) {
			respondWithApiError(res, error, 500, corsHeaders, req);
		}
		return;
	}

	sendJson(res, 405, { error: "Method not allowed" }, corsHeaders);
}
