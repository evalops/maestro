import type { Agent } from "../agent/agent.js";
import type { AgentTool } from "../agent/types.js";
import { ComposerManager } from "../composers/manager.js";

function composerSessionKey(subject: string, sessionId: string): string {
	return `${subject}\0${sessionId}`;
}

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
