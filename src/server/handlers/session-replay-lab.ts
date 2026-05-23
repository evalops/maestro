import type { IncomingMessage, ServerResponse } from "node:http";
import type { ComposerRunTimelineResponse } from "@evalops/contracts";
import { tryListMaestroTimelineWithPlatform } from "../../platform/maestro-timeline-client.js";
import {
	type AgentTrajectoryReplayLabReport,
	buildAgentTrajectoryReplayLab,
} from "../agent-trajectory-replay-lab.js";
import type { HostedRunnerContext } from "../app-context.js";
import { getAuthSubject } from "../authz.js";
import { getPendingComposerRequests } from "../pending-request-payload.js";
import { ApiError, respondWithApiError, sendJson } from "../server-utils.js";
import { createWebSessionManagerForRequest } from "../session-scope.js";
import { buildComposerRunTimeline } from "../session-timeline.js";
import { sessionIdPattern, verifySessionOwnership } from "./sessions.js";

interface SessionReplayLabParams {
	id?: string;
}

interface SessionReplayLabOptions {
	hostedRunner?: HostedRunnerContext;
}

function requireSessionId(params: SessionReplayLabParams): string {
	const sessionId = params.id?.trim();
	if (!sessionId || !sessionIdPattern.test(sessionId)) {
		throw new ApiError(400, "Invalid session id");
	}
	return sessionId;
}

function hostedRunnerMatchesSession(
	hostedRunner: HostedRunnerContext | undefined,
	sessionId: string,
): boolean {
	if (!hostedRunner?.enabled) {
		return false;
	}
	const activeSessionId =
		hostedRunner.activeMaestroSessionId ??
		hostedRunner.configuredMaestroSessionId;
	return activeSessionId === sessionId;
}

async function tryBuildPlatformTimeline(
	sessionId: string,
	pendingRequestCount: number,
	options: SessionReplayLabOptions | undefined,
): Promise<ComposerRunTimelineResponse | null> {
	const hostedRunner = options?.hostedRunner;
	if (!hostedRunnerMatchesSession(hostedRunner, sessionId)) {
		return null;
	}
	const agentRunId = hostedRunner?.agentRunId;
	const remoteRunnerSessionId = hostedRunner?.runnerSessionId;
	if (!agentRunId && !remoteRunnerSessionId) {
		return null;
	}
	return await tryListMaestroTimelineWithPlatform({
		sessionId,
		agentRunId,
		remoteRunnerSessionId,
		workspaceId: hostedRunner?.workspaceId,
		pendingRequestCount,
	});
}

export async function buildSessionReplayLabForRequest(
	req: IncomingMessage,
	params: SessionReplayLabParams,
	options?: SessionReplayLabOptions,
): Promise<AgentTrajectoryReplayLabReport> {
	const sessionId = requireSessionId(params);
	const sessionManager = createWebSessionManagerForRequest(req, true);
	const session = await sessionManager.loadSession(sessionId);
	if (!session) {
		throw new ApiError(404, "Session not found");
	}

	const subject = getAuthSubject(req);
	if (!verifySessionOwnership(session, subject)) {
		throw new ApiError(403, "Access denied: session belongs to another user");
	}

	const entries = (await sessionManager.loadEntries(sessionId)) ?? [];
	const pendingRequests = getPendingComposerRequests(session.id);
	const timeline =
		(await tryBuildPlatformTimeline(
			session.id,
			pendingRequests.length,
			options,
		)) ??
		buildComposerRunTimeline({
			sessionId: session.id,
			entries,
			messages: session.messages || [],
			pendingRequests,
		});
	return buildAgentTrajectoryReplayLab(timeline);
}

export async function handleSessionReplayLab(
	req: IncomingMessage,
	res: ServerResponse,
	params: SessionReplayLabParams,
	cors: Record<string, string>,
	options?: SessionReplayLabOptions,
): Promise<void> {
	try {
		if (req.method !== "GET") {
			res.writeHead(405, cors);
			res.end();
			return;
		}
		const responseBody = await buildSessionReplayLabForRequest(
			req,
			params,
			options,
		);
		sendJson(res, 200, responseBody, cors, req);
	} catch (error) {
		if (!respondWithApiError(res, error, 500, cors, req)) {
			sendJson(
				res,
				500,
				{ error: "Failed to load session replay lab" },
				cors,
				req,
			);
		}
	}
}
