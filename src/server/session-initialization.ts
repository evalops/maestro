import type { EnterpriseSession } from "../enterprise/context.js";
import { checkSessionLimits } from "../safety/policy.js";
import { recordMaestroSessionEvent } from "../telemetry/maestro-event-bus.js";

type SessionState = Parameters<SessionInitializationManager["startSession"]>[0];

export interface SessionInitializationManager {
	loadAllSessions(): Array<{ modified: Date }>;
	countActiveSessions?(since: Date): Promise<number>;
	startSession(state: AgentSessionState, options?: { subject?: string }): void;
	getSessionId(): string;
}

type AgentSessionState = {
	messages: unknown[];
	model: unknown;
	thinkingLevel: unknown;
	systemPrompt: string;
	promptMetadata?: unknown;
	tools: Array<{
		name: string;
		label?: string;
		description?: string;
	}>;
};

export interface SessionInitializationAgent {
	state: SessionState;
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

function webSessionEventEnv(
	env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	return {
		...env,
		MAESTRO_EVENT_BUS_SOURCE: env.MAESTRO_EVENT_BUS_SOURCE ?? "maestro.web",
		MAESTRO_SURFACE: env.MAESTRO_SURFACE ?? "web",
	};
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
		return limitCheck.reason ?? "Session policy blocked chat request";
	}

	sessionManager.startSession(agent.state, { subject });
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
			agent.setSession({
				id: session.sessionId,
				startedAt: session.startedAt,
			});
		}
	}

	onSessionReady(sessionId);
	return null;
}
