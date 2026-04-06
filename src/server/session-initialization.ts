import type { EnterpriseSession } from "../enterprise/context.js";
import { checkSessionLimits } from "../safety/policy.js";
import type { SessionManager } from "../session/manager.js";

type SessionState = Parameters<SessionManager["startSession"]>[0];

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

export function startSessionWithPolicy(params: {
	agent: SessionInitializationAgent;
	enterpriseContext: SessionInitializationEnterpriseContext;
	logger: SessionInitializationLogger;
	modelId: string;
	onSessionReady: (sessionId: string) => void;
	sessionManager: SessionManager;
	subject?: string;
}): string | null {
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
		const sessions = sessionManager.loadAllSessions();
		activeCount = sessions.filter(
			(session) => Date.now() - session.modified.getTime() < 60 * 60 * 1000,
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
		return limitCheck.reason ?? "Session policy blocked chat request";
	}

	sessionManager.startSession(agent.state, { subject });
	if (enterpriseContext.isEnterprise()) {
		enterpriseContext.startSession(sessionManager.getSessionId(), modelId);
		const session = enterpriseContext.getSession();
		if (session) {
			agent.setSession({
				id: session.sessionId,
				startedAt: session.startedAt,
			});
		}
	}

	onSessionReady(sessionManager.getSessionId());
	return null;
}
