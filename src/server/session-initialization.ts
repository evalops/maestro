import type { EnterpriseSession } from "../enterprise/context.js";
import { checkSessionLimits } from "../safety/policy.js";
import { recordMaestroSessionEvent } from "../telemetry/maestro-event-bus.js";
import { sanitizeWithStaticMask } from "../utils/secret-redactor.js";
import { webSessionEventEnv } from "./session-event-env.js";

export interface SessionInitializationManager<State = AgentSessionState> {
	loadAllSessions(): Array<{ modified: Date }>;
	countActiveSessions?(since: Date): Promise<number>;
	startSession(state: State, options?: { subject?: string }): void;
	getSessionId(): string;
}

export type AgentSessionState = {
	messages: unknown[];
	model: unknown;
	thinkingLevel: unknown;
	systemPrompt: string;
	promptMetadata?: unknown;
	promptContextManifest?: unknown;
	systemPromptSourcePaths?: string[];
	tools: Array<{
		name: string;
		label?: string;
		description?: string;
	}>;
};

export interface SessionInitializationAgent {
	state: AgentSessionState;
	setSession(session: { id: string; startedAt: Date }): void;
}

export interface SessionInitializationEnterpriseContext {
	isEnterprise(): boolean;
	startSession(sessionId: string, modelId: string): void;
	getSession(): EnterpriseSession | null;
}

export interface SessionInitializationLogger {
	warn(message: string, context: Record<string, unknown>): void;
}

export async function startSessionStateWithPolicy<State>(params: {
	enterpriseContext: SessionInitializationEnterpriseContext;
	logger: SessionInitializationLogger;
	modelId: string;
	onEnterpriseSession?: (session: EnterpriseSession) => void;
	onSessionReady: (sessionId: string) => void;
	sessionManager: SessionInitializationManager<State>;
	state: State;
	subject?: string;
}): Promise<string | null> {
	const {
		enterpriseContext,
		logger,
		modelId,
		onEnterpriseSession,
		onSessionReady,
		sessionManager,
		state,
		subject,
	} = params;

	let activeCount: number | undefined;
	try {
		const activeSince = new Date(Date.now() - 60 * 60 * 1000);
		if (sessionManager.countActiveSessions) {
			activeCount = await sessionManager.countActiveSessions(activeSince);
		} else {
			const sessions = sessionManager.loadAllSessions();
			activeCount = sessions.filter(
				(session) => session.modified.getTime() >= activeSince.getTime(),
			).length;
		}
	} catch (error) {
		logger.warn("Failed to count active sessions", {
			error: sanitizeWithStaticMask(
				error instanceof Error ? error.message : String(error),
			),
		});
	}

	const limitCheck = checkSessionLimits(
		{ startedAt: new Date() },
		activeCount !== undefined
			? { activeSessionCount: activeCount + 1 }
			: undefined,
	);
	if (!limitCheck.allowed) {
		return limitCheck.reason ?? "Session policy blocked chat request";
	}

	sessionManager.startSession(state, { subject });
	const sessionId = sessionManager.getSessionId();
	recordMaestroSessionEvent("MAESTRO_SESSION_STATE_STARTED", {
		sessionId,
		env: webSessionEventEnv(),
		metadata: {
			model: modelId,
			...(subject ? { subject } : {}),
		},
	});
	if (enterpriseContext.isEnterprise()) {
		enterpriseContext.startSession(sessionId, modelId);
		const session = enterpriseContext.getSession();
		if (session) {
			onEnterpriseSession?.(session);
		}
	}

	onSessionReady(sessionId);
	return null;
}

export async function startSessionWithPolicy(params: {
	agent: SessionInitializationAgent;
	enterpriseContext: SessionInitializationEnterpriseContext;
	logger: SessionInitializationLogger;
	modelId: string;
	onSessionReady: (sessionId: string) => void;
	sessionManager: SessionInitializationManager;
	subject?: string;
}): Promise<string | null> {
	const {
		agent,
		enterpriseContext,
		logger,
		modelId,
		onSessionReady,
		sessionManager,
		subject,
	} = params;

	return startSessionStateWithPolicy({
		enterpriseContext,
		logger,
		modelId,
		onEnterpriseSession: (session) => {
			agent.setSession({
				id: session.sessionId,
				startedAt: session.startedAt,
			});
		},
		onSessionReady,
		sessionManager,
		state: agent.state,
		subject,
	});
}
