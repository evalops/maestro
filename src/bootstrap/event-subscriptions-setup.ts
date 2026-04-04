/**
 * Event Subscriptions Setup - Turn tracking, persistence, and notifications.
 *
 * Extracts event subscription wiring from main.ts Phase 14.5:
 * turn tracker creation + MCP context updates, message persistence +
 * session initialization, and notification hook subscription.
 *
 * @module bootstrap/event-subscriptions-setup
 */

import chalk from "chalk";
import type { Agent } from "../agent/index.js";
import type { AppMessage } from "../agent/types.js";
import {
	createNotificationFromAgentEvent,
	isNotificationEnabled,
	sendNotification,
} from "../hooks/notification-hooks.js";
import { mcpManager } from "../mcp/manager.js";
import type { RegisteredModel } from "../models/registry.js";
import { checkSessionLimits } from "../safety/policy.js";
import {
	type SessionManager,
	toSessionModelMetadata,
} from "../session/manager.js";
import { createRuntimeSessionSummaryUpdater } from "../session/runtime-summary-updater.js";
import {
	type TurnTracker,
	createTurnTracker,
} from "../telemetry/turn-tracker.js";
import type { CanonicalTurnEvent } from "../telemetry/wide-events.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("event-subscriptions");

export interface EventSubscriptionsResult {
	turnTracker: TurnTracker;
}

/**
 * Wire up all agent event subscriptions: turn tracking, message persistence,
 * session initialization, and notification hooks.
 */
export function setupEventSubscriptions(params: {
	agent: Agent;
	sessionManager: SessionManager;
	approvalMode: "auto" | "prompt" | "fail";
	sandboxMode: string | undefined;
	tsHookCount: number;
	cwd: string;
	enterpriseContext: {
		isEnterprise: () => boolean;
		startSession: (sessionId: string, modelId?: string) => void;
		getSession: () => { sessionId: string; startedAt: Date } | null;
	};
	/** Optional callback invoked on every turn completion (for perf aggregation). */
	onTurnComplete?: (event: CanonicalTurnEvent) => void;
}): EventSubscriptionsResult {
	const {
		agent,
		sessionManager,
		approvalMode,
		sandboxMode,
		tsHookCount,
		cwd,
		enterpriseContext,
	} = params;
	const updateSessionSummary =
		createRuntimeSessionSummaryUpdater(sessionManager);

	// ── Turn Tracker ─────────────────────────────────────────────────────────

	const turnTracker = createTurnTracker(agent, {
		sessionId: sessionManager.getSessionId(),
		onTurnComplete: (event) => {
			if (event.sampled) {
				logger.debug("Wide event emitted", {
					turnId: event.turnId,
					status: event.status,
					toolCount: event.toolCount,
					durationMs: event.totalDurationMs,
					sampleReason: event.sampleReason,
				});
			}
			params.onTurnComplete?.(event);
		},
	});

	const trackerSandboxMode =
		sandboxMode === "docker"
			? "docker"
			: sandboxMode === "local" || sandboxMode === "native"
				? "local"
				: "none";
	turnTracker.updateContext({
		sandboxMode: trackerSandboxMode,
		approvalMode,
		mcpServers: mcpManager
			.getStatus()
			.servers.filter((s) => s.connected)
			.map((s) => s.name),
		contextSourceCount: 5,
		features: {
			safeMode: Boolean(process.env.MAESTRO_SAFE_MODE),
			guardianEnabled: process.env.MAESTRO_GUARDIAN !== "0",
			compactionEnabled: true,
			hookCount: tsHookCount,
		},
	});

	mcpManager.on("connected", () => {
		turnTracker.updateContext({
			mcpServers: mcpManager
				.getStatus()
				.servers.filter((s) => s.connected)
				.map((s) => s.name),
		});
	});
	mcpManager.on("disconnected", () => {
		turnTracker.updateContext({
			mcpServers: mcpManager
				.getStatus()
				.servers.filter((s) => s.connected)
				.map((s) => s.name),
		});
	});

	// ── Agent event subscription ─────────────────────────────────────────────

	agent.subscribe(async (event) => {
		updateSessionSummary(event);

		// Handle context overflow with auto-compaction and retry
		if (
			event.type === "agent_end" &&
			event.stopReason === "length" &&
			!event.aborted
		) {
			console.error(
				chalk.yellow("[auto-compact] Context overflow detected, compacting..."),
			);

			try {
				const result = await performCompaction({
					agent,
					sessionManager,
					auto: true,
					renderSummaryText: (summary: AssistantMessage) => {
						const renderable = createRenderableMessage(summary as AppMessage);
						return renderable
							? renderMessageToPlainText(renderable).trim()
							: "";
					},
				});

				if (!result.success) {
					console.error(chalk.red(`[auto-compact] Failed: ${result.error}`));
					return;
				}

				console.error(
					chalk.green("[auto-compact] Compaction complete, continuing..."),
				);
				void agent.continue();
			} catch (error) {
				console.error(
					chalk.red(
						`[auto-compact] Failed: ${error instanceof Error ? error.message : String(error)}`,
					),
				);
			}
			return;
		}
		// Save messages on completion
		if (event.type === "message_end") {
			sessionManager.saveMessage(event.message);

			// Check if we should initialize session now (after first user message)
			if (sessionManager.shouldInitializeSession(agent.state.messages)) {
				let activeCount: number | undefined;
				try {
					const sessions = sessionManager.loadAllSessions();
					activeCount = sessions.filter(
						(s) => Date.now() - s.modified.getTime() < 60 * 60 * 1000,
					).length;
				} catch (error) {
					console.error(
						chalk.yellow(
							`[Policy] Failed to count active sessions: ${error instanceof Error ? error.message : String(error)}`,
						),
					);
				}

				const limitCheck = checkSessionLimits(
					{ startedAt: new Date() },
					activeCount !== undefined
						? { activeSessionCount: activeCount + 1 }
						: undefined,
				);

				if (!limitCheck.allowed) {
					const msg = `\n[Policy] ${limitCheck.reason}`;
					console.error(chalk.red(msg));
					process.exit(1);
				}

				sessionManager.startSession(agent.state);

				if (enterpriseContext.isEnterprise()) {
					enterpriseContext.startSession(
						sessionManager.getSessionId(),
						(agent.state.model as RegisteredModel)?.id,
					);
					const session = enterpriseContext.getSession();
					if (session) {
						agent.setSession({
							id: session.sessionId,
							startedAt: session.startedAt,
						});
					}
				}
			}
		}

		const modelMetadata = toSessionModelMetadata(
			agent.state.model as RegisteredModel,
		);
		sessionManager.updateSnapshot(agent.state, modelMetadata);
	});

	// ── Notification hooks ───────────────────────────────────────────────────

	if (
		isNotificationEnabled("turn-complete") ||
		isNotificationEnabled("session-start") ||
		isNotificationEnabled("session-end") ||
		isNotificationEnabled("tool-execution") ||
		isNotificationEnabled("error")
	) {
		agent.subscribe((event) => {
			const payload = createNotificationFromAgentEvent(event, {
				cwd,
				sessionId: sessionManager.getSessionId(),
				messages: agent.state.messages,
			});
			if (payload) {
				void sendNotification(payload);
			}
		});
	}

	return { turnTracker };
}
