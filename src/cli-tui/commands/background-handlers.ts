import { existsSync } from "node:fs";
import chalk from "chalk";
import {
	type BackgroundTaskSettings,
	getBackgroundSettingsPath,
	updateBackgroundTaskSettings,
} from "../../runtime/background-settings.js";
import { backgroundTaskManager } from "../../tools/background-tasks.js";

export interface BackgroundRenderContext {
	argumentText: string;
	addContent(content: string): void;
	showInfo(message: string): void;
	showError(message: string): void;
	renderHelp(): void;
	requestRender(): void;
}

export function parseToggle(value?: string): boolean | null {
	if (!value) {
		return null;
	}
	const normalized = value.toLowerCase();
	if (["on", "true", "enable", "enabled", "yes"].includes(normalized)) {
		return true;
	}
	if (["off", "false", "disable", "disabled", "no"].includes(normalized)) {
		return false;
	}
	return null;
}

export function handleBackgroundCommand(
	settings: BackgroundTaskSettings,
	renderCtx: BackgroundRenderContext,
): void {
	const tokens = renderCtx.argumentText
		.trim()
		.split(/\s+/)
		.filter((token) => token.length > 0);
	const action = tokens[0]?.toLowerCase() ?? "status";

	if (action === "status") {
		renderBackgroundStatus(settings, renderCtx);
		return;
	}

	if (action === "notify" || action === "details") {
		const toggle = parseToggle(tokens[1]);
		if (toggle === null) {
			renderCtx.showError("Provide 'on' or 'off'.");
			return;
		}
		updateBackgroundTaskSettings(
			action === "notify"
				? { notificationsEnabled: toggle }
				: { statusDetailsEnabled: toggle },
		);
		renderCtx.showInfo(
			action === "notify"
				? `Background task notifications ${toggle ? "enabled" : "disabled"}.`
				: `Background task details ${toggle ? "enabled" : "disabled"}.`,
		);
		return;
	}

	if (action === "history") {
		const limitArg = tokens[1] ? Number.parseInt(tokens[1], 10) : 10;
		const limit = Number.isFinite(limitArg)
			? Math.min(Math.max(limitArg, 1), 50)
			: 10;
		renderBackgroundHistory(limit, settings, renderCtx);
		return;
	}

	if (action === "path") {
		const path = getBackgroundSettingsPath();
		const exists = existsSync(path);
		renderCtx.showInfo(
			[
				`Background settings file: ${path}`,
				exists
					? "File exists and will be hot-reloaded on change."
					: "File not found yet (it will be created on first toggle).",
				process.env.MAESTRO_BACKGROUND_SETTINGS
					? "Overridden via MAESTRO_BACKGROUND_SETTINGS."
					: "Using default location under ~/.maestro/agent/.",
			].join("\n"),
		);
		return;
	}

	renderCtx.renderHelp();
}

export function renderBackgroundStatus(
	settings: BackgroundTaskSettings,
	renderCtx: BackgroundRenderContext,
): void {
	const snapshot = backgroundTaskManager.getHealthSnapshot({
		maxEntries: 1,
		logLines: 1,
		historyLimit: 3,
	});
	const lines = [chalk.bold("Background tasks")];
	lines.push(
		`Notifications: ${settings.notificationsEnabled ? chalk.green("on") : chalk.red("off")}`,
		`Status details: ${settings.statusDetailsEnabled ? chalk.green("on") : chalk.red("off")}`,
	);
	if (snapshot) {
		lines.push(
			`Running: ${snapshot.running}/${snapshot.total} · Failed: ${snapshot.failed}`,
			`Details: ${snapshot.detailsRedacted ? "redacted" : "visible"}`,
		);
	} else {
		lines.push("No recent background activity.");
	}
	lines.push(
		"Use /background notify <on|off> or /background details <on|off>.",
	);

	renderCtx.addContent(lines.join("\n"));
	renderCtx.requestRender();
}

export function renderBackgroundHistory(
	limit: number,
	settings: BackgroundTaskSettings,
	renderCtx: BackgroundRenderContext,
): void {
	if (!settings.statusDetailsEnabled) {
		renderCtx.showInfo(
			"Enable /background details on to inspect task history.",
		);
		return;
	}
	const snapshot = backgroundTaskManager.getHealthSnapshot({
		maxEntries: 1,
		logLines: 1,
		historyLimit: limit,
	});
	const history = snapshot?.history ?? [];

	if (history.length === 0) {
		renderCtx.addContent("No background task history found.");
		renderCtx.requestRender();
		return;
	}

	const lines = history.map((entry) => {
		const stamp = new Date(entry.timestamp).toLocaleTimeString();
		const reason = entry.failureReason
			? ` ${chalk.dim(entry.failureReason)}`
			: entry.limitBreach
				? ` ${chalk.dim(`limit ${entry.limitBreach.kind}`)}`
				: "";
		return `${stamp} ${entry.event} ${entry.taskId} – ${entry.command}${reason}`;
	});
	if (snapshot?.historyTruncated) {
		lines.push(
			chalk.dim(
				"…additional events hidden; pass /background history <n> for more.",
			),
		);
	}

	renderCtx.addContent(lines.join("\n"));
	renderCtx.requestRender();
}
