import type { Agent } from "../agent/agent.js";
import type { AgentTool } from "../agent/types.js";
import { ComposerManager } from "../composers/manager.js";

function composerSessionKey(subject: string, sessionId: string): string {
	return `${subject}\0${sessionId}`;
}

/**
 * Per-subject/session composer managers for the web server.
 *
 * Two layers:
 *
 * 1. **Agent-bound (TypeScript `createAgent` path)** — `initializeAgent` +
 *    `bindAgentSession` / `unbindAgentSession`. Requires a live TS `Agent` so
 *    activate/deactivate can mutate system prompt and tools. `bindAgentSession`
 *    returns `false` when the agent was never initialized or an active composer
 *    cannot be restored — that is a hard failure for the TS chat path, not a
 *    silent no-op.
 *
 * 2. **Session-scoped (HTTP `/api/composer` + native hygiene)** — `get` /
 *    `getOrCreate` / `getLatestForSubject` / `ensureSession`. Managers may exist
 *    without an Agent; `ComposerManager.activate` then stores UI state only.
 *
 * Native web chat (`runNativeWebChatTurn`) has no TS Agent, so handlers must
 * **not** call `bindAgentSession` (would return false and fail the turn). They
 * may call `ensureSession` when a real session id is known so `/api/composer`
 * can resolve the session. Web-session prompt/tool effects are **not** applied to
 * native headless processes (known gap; see `web-native-chat.ts`).
 */
export class WebComposerManagerRegistry {
	private readonly managersBySession = new Map<string, ComposerManager>();
	private readonly managersByAgent = new WeakMap<Agent, ComposerManager>();
	private readonly boundAgentBySession = new Map<string, Agent>();
	private readonly latestSessionBySubject = new Map<string, string>();

	initializeAgent(
		agent: Agent,
		baseSystemPrompt: string,
		baseTools: AgentTool[],
		projectRoot?: string,
	): ComposerManager {
		const manager = new ComposerManager();
		manager.initialize(agent, baseSystemPrompt, baseTools, projectRoot);
		this.managersByAgent.set(agent, manager);
		return manager;
	}

	/**
	 * Bind a TS Agent's composer manager to a subject+session.
	 * @returns false if the agent has no manager, another agent is mid-stream on
	 *   this session, or an existing active composer cannot be re-activated.
	 */
	bindAgentSession(agent: Agent, subject: string, sessionId: string): boolean {
		const manager = this.managersByAgent.get(agent);
		if (!manager) {
			return false;
		}
		const sessionKey = composerSessionKey(subject, sessionId);
		const existing = this.managersBySession.get(sessionKey);
		const boundAgent = this.boundAgentBySession.get(sessionKey);
		if (boundAgent && boundAgent !== agent) {
			if (boundAgent.state.isStreaming) {
				return false;
			}
		}
		const activeName = existing?.getState().active?.name;
		if (activeName) {
			// ComposerManager emits "error" before returning false for missing names.
			const ignoreActivationError = () => {};
			manager.once("error", ignoreActivationError);
			try {
				if (!manager.activate(activeName)) {
					return false;
				}
			} finally {
				manager.off("error", ignoreActivationError);
			}
		}
		if (boundAgent && boundAgent !== agent) {
			existing?.detachAgent();
		}
		this.managersBySession.set(sessionKey, manager);
		this.boundAgentBySession.set(sessionKey, agent);
		this.latestSessionBySubject.set(subject, sessionId);
		return true;
	}

	unbindAgentSession(agent: Agent, subject: string, sessionId: string): void {
		const sessionKey = composerSessionKey(subject, sessionId);
		if (this.boundAgentBySession.get(sessionKey) !== agent) {
			return;
		}
		this.boundAgentBySession.delete(sessionKey);
		this.managersBySession.get(sessionKey)?.detachAgent();
	}

	get(subject: string, sessionId: string): ComposerManager | undefined {
		return this.managersBySession.get(composerSessionKey(subject, sessionId));
	}

	getOrCreate(subject: string, sessionId: string): ComposerManager {
		const sessionKey = composerSessionKey(subject, sessionId);
		let manager = this.managersBySession.get(sessionKey);
		if (!manager) {
			manager = new ComposerManager();
			manager.reload(process.cwd());
			this.managersBySession.set(sessionKey, manager);
		}
		this.latestSessionBySubject.set(subject, sessionId);
		return manager;
	}

	/**
	 * Register session-scoped composer state without a TS Agent.
	 * Safe for native chat: updates latest-for-subject and returns a manager that
	 * can hold activate/deactivate UI state only.
	 */
	ensureSession(subject: string, sessionId: string): ComposerManager {
		return this.getOrCreate(subject, sessionId);
	}

	getLatestForSubject(
		subject: string,
	): { sessionId: string; manager: ComposerManager } | undefined {
		const sessionId = this.latestSessionBySubject.get(subject);
		if (!sessionId) {
			return undefined;
		}
		const manager = this.get(subject, sessionId);
		return manager ? { sessionId, manager } : undefined;
	}

	clear(): void {
		this.boundAgentBySession.clear();
		this.managersBySession.clear();
		this.latestSessionBySubject.clear();
	}
}

export const webComposerManagers = new WebComposerManagerRegistry();

/**
 * Session-only composer registry touch for the native web chat path.
 * No-ops when there is no session id or no registry. Never calls bindAgentSession.
 */
export function ensureComposerSessionForNative(
	composerManagers:
		| {
				ensureSession?: (subject: string, sessionId: string) => ComposerManager;
				getOrCreate?: (subject: string, sessionId: string) => ComposerManager;
		  }
		| undefined,
	subject: string,
	sessionId: string | null | undefined,
): void {
	if (!composerManagers || !sessionId) {
		return;
	}
	if (composerManagers.ensureSession) {
		composerManagers.ensureSession(subject, sessionId);
		return;
	}
	composerManagers.getOrCreate?.(subject, sessionId);
}
