import type { ApprovalMode } from "../../agent/action-approval.js";
import type { ThinkingLevel } from "../../agent/types.js";
import { composerManager } from "../../composers/index.js";
import { mcpManager } from "../../mcp/index.js";
import { isSafeModeEnabled } from "../../safety/safe-mode.js";
import { backgroundTaskManager } from "../../tools/background-tasks.js";
import {
	isDockerEnv,
	isFlatpakEnv,
	isJetBrainsTerminal,
	isMuslEnv,
	isWslEnv,
} from "./env-detect.js";

export interface RuntimeBadgeParams {
	approvalMode: ApprovalMode | null | undefined;
	promptQueueMode: "all" | "one";
	queuedPromptCount: number;
	hasPromptQueue: boolean;
	thinkingLevel?: ThinkingLevel | null;
	sandboxMode?: string | null;
	isSafeMode?: boolean;
	sandboxRequestedButMissing?: boolean;
	alertCount?: number;
	reducedMotion?: boolean;
	compactForced?: boolean;
}

export function buildRuntimeBadges(params: RuntimeBadgeParams): string[] {
	const badges: string[] = [];

	const safeMode = params.isSafeMode ?? isSafeModeEnabled();
	if (safeMode) {
		badges.push("safe:on");
	}

	if (process.env.COMPOSER_PLAN_MODE === "1") {
		badges.push("plan:on");
	}

	if (params.approvalMode) {
		badges.push(`approvals:${params.approvalMode}`);
	}

	if (params.sandboxMode) {
		badges.push(`sandbox:${params.sandboxMode}`);
	} else if (params.sandboxRequestedButMissing) {
		badges.push("sandbox:off");
	}

	if (params.hasPromptQueue) {
		const queueLabel = `queue:${params.promptQueueMode}`;
		if (params.queuedPromptCount > 0) {
			badges.push(`${queueLabel}(${params.queuedPromptCount})`);
		} else {
			badges.push(queueLabel);
		}
	}

	if (params.alertCount && params.alertCount > 0) {
		badges.push(`alerts:${params.alertCount}`);
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

	if (params.reducedMotion) {
		badges.push("motion:reduced");
	}
	if (params.compactForced) {
		badges.push("compact:auto");
	}

	// Environment hints
	if (isDockerEnv()) {
		badges.push("env:docker");
	} else if (isWslEnv()) {
		badges.push("env:wsl");
	}
	if (isFlatpakEnv()) {
		badges.push("env:flatpak");
	}
	if (isMuslEnv()) {
		badges.push("env:musl");
	}
	if (isJetBrainsTerminal()) {
		badges.push("term:jetbrains");
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
