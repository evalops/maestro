import type { ApprovalMode } from "../../agent/action-approval.js";
import type { ThinkingLevel } from "../../agent/types.js";
import { composerManager } from "../../composers/index.js";
import { mcpManager } from "../../mcp/index.js";
import { isSafeModeEnabled } from "../../safety/safe-mode.js";
import { backgroundTaskManager } from "../../tools/background-tasks.js";

export interface RuntimeBadgeParams {
	approvalMode: ApprovalMode | null | undefined;
	promptQueueMode: "all" | "one";
	queuedPromptCount: number;
	hasPromptQueue: boolean;
	thinkingLevel?: ThinkingLevel | null;
}

export function buildRuntimeBadges(params: RuntimeBadgeParams): string[] {
	const badges: string[] = [];

	if (isSafeModeEnabled()) {
		badges.push("safe:on");
	}

	if (process.env.COMPOSER_PLAN_MODE === "1") {
		badges.push("plan:on");
	}

	if (params.approvalMode && params.approvalMode !== "auto") {
		badges.push(`approvals:${params.approvalMode}`);
	}

	if (params.hasPromptQueue) {
		const queueLabel = `queue:${params.promptQueueMode}`;
		if (params.queuedPromptCount > 0) {
			badges.push(`${queueLabel}(${params.queuedPromptCount})`);
		} else {
			badges.push(queueLabel);
		}
	}

	const thinkingLevel = params.thinkingLevel;
	if (thinkingLevel && thinkingLevel !== "off") {
		badges.push(`think:${thinkingLevel}`);
	}

	// MCP servers status
	const mcpStatus = mcpManager.getStatus();
	const connectedMcp = mcpStatus.servers.filter((s) => s.connected).length;
	if (connectedMcp > 0) {
		const totalTools = mcpStatus.servers.reduce(
			(sum, s) => sum + s.tools.length,
			0,
		);
		badges.push(`mcp:${connectedMcp}(${totalTools})`);
	}

	const backgroundCounts = getBackgroundTaskCounts();
	if (backgroundCounts.running > 0 || backgroundCounts.failed > 0) {
		const failureSuffix =
			backgroundCounts.failed > 0 ? `!${backgroundCounts.failed}` : "";
		badges.push(`bg:${backgroundCounts.running}${failureSuffix}`);
	}

	// Active composer
	const composerState = composerManager.getState();
	if (composerState.active) {
		badges.push(`composer:${composerState.active.name}`);
	}

	return badges;
}

function getBackgroundTaskCounts(): { running: number; failed: number } {
	const tasks = backgroundTaskManager.getTasks();
	let running = 0;
	let failed = 0;
	for (const task of tasks) {
		if (task.status === "running" || task.status === "restarting") {
			running++;
		}
		if (task.status === "failed") {
			failed++;
		}
	}
	return { running, failed };
}
