/**
 * AgentEventBridge - Routes agent events through the TUI orchestration layer.
 *
 * Keeps agent lifecycle handling out of TuiRenderer while preserving behavior.
 */

import type {
	ActionApprovalDecision,
	ActionApprovalRequest,
} from "../../agent/action-approval.js";
import type { Agent } from "../../agent/agent.js";
import type { AutoRetryController } from "../../agent/auto-retry.js";
import type { SessionRecoveryManager } from "../../agent/session-recovery.js";
import { isAssistantMessage } from "../../agent/type-guards.js";
import type { AgentEvent, AgentState } from "../../agent/types.js";
import type { RegisteredModel } from "../../models/registry.js";
import {
	type SessionManager,
	type SessionModelMetadata,
	toSessionModelMetadata,
} from "../../session/manager.js";
import { recordSessionStart, recordTokenUsage } from "../../telemetry.js";
import type { AgentEventRouter } from "../agent-event-router.js";
import type { FooterComponent } from "../footer.js";
import type { InterruptController } from "../interrupt-controller.js";
import {
	type FooterStats,
	calculateFooterStats,
} from "../utils/footer-utils.js";

export interface AgentEventBridgeDeps {
	agent: Agent;
	sessionManager: SessionManager;
	sessionRecoveryManager: SessionRecoveryManager;
	autoRetryController: AutoRetryController;
	interruptController: InterruptController;
	footer: FooterComponent;
	agentEventRouter: AgentEventRouter;
}

export interface AgentEventBridgeCallbacks {
	ensureInitialized: () => Promise<void>;
	handleApprovalRequired: (request: ActionApprovalRequest) => void;
	handleApprovalResolved: (
		request: ActionApprovalRequest,
		decision: ActionApprovalDecision,
	) => void;
	setAgentRunning: (running: boolean) => void;
	maybeShowContextWarning: (stats: FooterStats) => void;
	setCurrentModelMetadata: (metadata?: SessionModelMetadata) => void;
}

export interface AgentEventBridgeOptions {
	deps: AgentEventBridgeDeps;
	callbacks: AgentEventBridgeCallbacks;
}

export class AgentEventBridge {
	private readonly deps: AgentEventBridgeDeps;
	private readonly callbacks: AgentEventBridgeCallbacks;
	private sessionStartTime: number | null = null;
	private sessionTelemetryRecorded = false;

	constructor(options: AgentEventBridgeOptions) {
		this.deps = options.deps;
		this.callbacks = options.callbacks;
	}

	async handleEvent(event: AgentEvent, state: AgentState): Promise<void> {
		await this.callbacks.ensureInitialized();

		if (event.type === "action_approval_required") {
			this.callbacks.handleApprovalRequired(event.request);
			return;
		}
		if (event.type === "action_approval_resolved") {
			this.callbacks.handleApprovalResolved(event.request, event.decision);
			return;
		}

		if (event.type === "agent_start") {
			this.callbacks.setAgentRunning(true);
			if (!this.deps.sessionRecoveryManager.getCurrentBackup()) {
				this.deps.sessionRecoveryManager.startSession({
					sessionId: this.deps.sessionManager.getSessionId(),
					systemPrompt: state.systemPrompt,
					modelId: state.model
						? `${state.model.provider}/${state.model.id}`
						: undefined,
					cwd: process.cwd(),
				});
			}
			if (!this.sessionTelemetryRecorded) {
				this.sessionStartTime = Date.now();
				this.sessionTelemetryRecorded = true;
				recordSessionStart(this.deps.sessionManager.getSessionId(), {
					model: state.model
						? `${state.model.provider}/${state.model.id}`
						: undefined,
					provider: state.model?.provider,
				});
			}
		} else if (event.type === "agent_end") {
			this.callbacks.setAgentRunning(false);
			this.deps.interruptController.clear();
			this.deps.sessionRecoveryManager.updateMessages([...state.messages]);
			this.recordTokenUsageFromMessages(state);
			const contextWindow = state.model?.contextWindow;
			this.deps.autoRetryController.checkAndRetry(
				this.deps.agent,
				contextWindow,
			);
		}

		this.deps.footer.updateState(state);
		const stats = calculateFooterStats(state);
		this.callbacks.maybeShowContextWarning(stats);
		const metadata = state.model
			? toSessionModelMetadata(state.model as RegisteredModel)
			: undefined;
		this.callbacks.setCurrentModelMetadata(metadata);
		this.deps.agentEventRouter.handle(event);
	}

	private recordTokenUsageFromMessages(state: AgentState): void {
		for (let i = state.messages.length - 1; i >= 0; i--) {
			const message = state.messages[i];
			if (!message) continue;
			if (isAssistantMessage(message)) {
				recordTokenUsage(
					this.deps.sessionManager.getSessionId(),
					{
						input: message.usage.input,
						output: message.usage.output,
						cacheRead: message.usage.cacheRead,
						cacheWrite: message.usage.cacheWrite,
					},
					{
						model: state.model
							? `${state.model.provider}/${state.model.id}`
							: undefined,
						provider: state.model?.provider,
					},
				);
				break;
			}
		}
	}
}

export function createAgentEventBridge(
	options: AgentEventBridgeOptions,
): AgentEventBridge {
	return new AgentEventBridge(options);
}
