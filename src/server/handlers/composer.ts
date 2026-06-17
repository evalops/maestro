import type { IncomingMessage, ServerResponse } from "node:http";
import { loadComposers } from "../../composers/index.js";
import type { ComposerManager } from "../../composers/manager.js";
import type { WebServerContext } from "../app-context.js";
import { getAuthSubject } from "../authz.js";
import {
	readJsonBody,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";
import { createWebSessionManagerForRequest } from "../session-scope.js";
import { sessionIdPattern, verifySessionOwnership } from "./sessions.js";

async function resolveComposerManagerForSession(
	req: IncomingMessage,
	res: ServerResponse,
	context: WebServerContext,
	sessionId: string | null,
	options: {
		allowLatestSessionFallback: boolean;
		requireActiveManager: boolean;
	},
): Promise<ComposerManager | null> {
	const subject = getAuthSubject(req);
	let targetSessionId = sessionId;
	let fallbackManager: ComposerManager | undefined;
	if (!targetSessionId) {
		const latest = options.allowLatestSessionFallback
			? context.composerManagers?.getLatestForSubject?.(subject)
			: undefined;
		if (!latest) {
			if (!options.requireActiveManager) {
				return null;
			}
			sendJson(
				res,
				400,
				{ error: "sessionId is required" },
				context.corsHeaders,
				req,
			);
			return null;
		}
		targetSessionId = latest.sessionId;
		fallbackManager = latest.manager;
	}
	if (!sessionIdPattern.test(targetSessionId)) {
		sendJson(
			res,
			400,
			{ error: "Invalid sessionId format" },
			context.corsHeaders,
			req,
		);
		return null;
	}

	const sessionManager = createWebSessionManagerForRequest(req, false);
	const session = await sessionManager.loadSession(targetSessionId);
	if (!session) {
		sendJson(
			res,
			404,
			{ error: "Session not found" },
			context.corsHeaders,
			req,
		);
		return null;
	}

	if (!verifySessionOwnership(session, subject)) {
		sendJson(
			res,
			404,
			{ error: "Session not found" },
			context.corsHeaders,
			req,
		);
		return null;
	}

	const manager =
		context.composerManagers?.get(subject, targetSessionId) ??
		fallbackManager ??
		(options.requireActiveManager
			? context.composerManagers?.getOrCreate?.(subject, targetSessionId)
			: undefined) ??
		null;
	if (!manager && options.requireActiveManager) {
		sendJson(
			res,
			404,
			{ error: "No active composer context for session" },
			context.corsHeaders,
			req,
		);
		return null;
	}
	return manager;
}

export async function handleComposer(
	req: IncomingMessage,
	res: ServerResponse,
	context: WebServerContext,
) {
	const { corsHeaders } = context;

	if (req.method === "GET") {
		const url = new URL(
			req.url || "/api/composer",
			`http://${req.headers.host || "localhost"}`,
		);
		const name = url.searchParams.get("name");
		const sessionId = url.searchParams.get("sessionId");

		try {
			const manager = await resolveComposerManagerForSession(
				req,
				res,
				context,
				sessionId,
				{
					allowLatestSessionFallback: true,
					requireActiveManager: false,
				},
			);
			if (!manager && res.writableEnded) {
				return;
			}
			const state = manager?.getState() ?? {
				active: null,
				available: loadComposers(process.cwd()),
			};
			const composers = state.available;

			if (name) {
				const composer = composers.find((c) => c.name === name);
				if (!composer) {
					sendJson(
						res,
						404,
						{ error: `Composer not found: ${name}` },
						corsHeaders,
					);
					return;
				}
				sendJson(
					res,
					200,
					{
						composer,
						active: state.active?.name === name,
					},
					corsHeaders,
				);
			} else {
				sendJson(
					res,
					200,
					{
						composers,
						active: state.active,
					},
					corsHeaders,
				);
			}
		} catch (error) {
			respondWithApiError(res, error, 500, corsHeaders, req);
		}
		return;
	}

	if (req.method === "POST") {
		try {
			const url = new URL(
				req.url || "/api/composer",
				`http://${req.headers.host || "localhost"}`,
			);
			const data = await readJsonBody<{
				action: string;
				name?: string;
				sessionId?: string;
			}>(req);
			const { action, name } = data;
			const sessionId = data.sessionId ?? url.searchParams.get("sessionId");
			const manager = await resolveComposerManagerForSession(
				req,
				res,
				context,
				sessionId ?? null,
				{
					allowLatestSessionFallback: true,
					requireActiveManager: true,
				},
			);
			if (!manager) {
				return;
			}

			if (action === "activate" && name) {
				const success = manager.activate(name);
				if (success) {
					const newState = manager.getState();
					sendJson(
						res,
						200,
						{
							success: true,
							message: `Activated composer: ${name}`,
							active: newState.active,
						},
						corsHeaders,
					);
				} else {
					sendJson(
						res,
						400,
						{ error: `Failed to activate composer '${name}'` },
						corsHeaders,
					);
				}
			} else if (action === "deactivate") {
				const wasActive = manager.getState().active;
				manager.deactivate();
				sendJson(
					res,
					200,
					{
						success: true,
						message: wasActive
							? `Deactivated composer: ${wasActive.name}`
							: "No composer was active",
					},
					corsHeaders,
				);
			} else {
				sendJson(
					res,
					400,
					{ error: "Invalid action. Use activate or deactivate." },
					corsHeaders,
				);
			}
		} catch (error) {
			respondWithApiError(res, error, 500, corsHeaders, req);
		}
		return;
	}

	sendJson(res, 405, { error: "Method not allowed" }, corsHeaders);
}
