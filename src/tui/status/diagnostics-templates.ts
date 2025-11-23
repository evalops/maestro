import { badge, heading, labeledValue, muted } from "../../style/theme.js";
import type { TelemetryStatus } from "../../telemetry.js";
import type {
	BackgroundTaskHealth,
	BackgroundTaskHealthEntry,
} from "../../tools/background-tasks.js";
import type { HealthSnapshot } from "./health-snapshot.js";

export interface BugReportInfo {
	sessionId: string | null;
	sessionFile: string;
	modelLabel: string;
	messageCount: number;
	toolNames: string[];
	filesToShare: string;
}

export interface StatusSnapshotInfo {
	version: string;
	modelLabel: string;
	thinkingLevel: string;
	telemetry: TelemetryStatus;
	health: HealthSnapshot;
	sessionId: string | null;
	sessionFile: string;
}

export interface FeedbackTemplateInfo {
	version: string;
	modelLabel: string;
	sessionId: string | null;
	sessionFile: string;
	health: HealthSnapshot;
}

export function buildBugReport(info: BugReportInfo): string {
	const files =
		info.filesToShare || muted("(session file will appear once persisted)");
	return `${heading("Bug report info")}
${labeledValue("Session ID", info.sessionId ?? muted("unknown"))}
${labeledValue("Session file", info.sessionFile)}
${labeledValue("Model", info.modelLabel)}
${labeledValue("Messages", info.messageCount.toString())}
${labeledValue("Tools", info.toolNames.length ? info.toolNames.join(", ") : "none")}

${heading("Send these files")}
${files}

${muted("Attach them so we can replay the session.")}`;
}

export function buildStatusSnapshot(info: StatusSnapshotInfo): string {
	const telemetryBadge = info.telemetry.enabled
		? badge("Telemetry", info.telemetry.reason, "success")
		: badge("Telemetry", info.telemetry.reason, "warn");
	const telemetryRoute = info.telemetry.endpoint
		? muted(`endpoint ${info.telemetry.endpoint}`)
		: info.telemetry.filePath
			? muted(`file ${info.telemetry.filePath}`)
			: "";
	const overrideDetails = info.telemetry.runtimeOverride
		? muted(
				`override ${info.telemetry.runtimeOverride}${info.telemetry.overrideReason ? ` (${info.telemetry.overrideReason})` : ""}`,
			)
		: "";
	const telemetryLine = [
		labeledValue("Telemetry", telemetryBadge),
		telemetryRoute,
		overrideDetails,
	]
		.filter(Boolean)
		.join(" ");
	const toolLine =
		info.health.toolFailures > 0
			? `${badge("logged", `${info.health.toolFailures}`, "danger")} ${info.health.toolFailurePath ? muted(info.health.toolFailurePath) : ""}`.trim()
			: muted("none logged");
	const planGoals = info.health.planGoals ?? 0;
	const planPending = info.health.planPendingTasks ?? 0;
	const planLine =
		planGoals > 0
			? `${badge("goals", `${planGoals}`, "info")} ${badge("pending", `${planPending}`, "warn")}`
			: muted("no saved plans");
	const gitLine = info.health.gitStatus ?? muted("git unavailable");
	const sessionLine = info.sessionId
		? `${info.sessionId}\n${muted(info.sessionFile)}`
		: muted("No persisted session yet.");

	const rows = [
		`${labeledValue("Model", info.modelLabel)} ${badge("v", info.version, "info")}`,
		labeledValue("Thinking", info.thinkingLevel),
		telemetryLine,
		labeledValue("Git", gitLine),
		labeledValue(
			"Background tasks",
			formatBackgroundTaskOverview(info.health.backgroundTasks),
		),
		labeledValue("Plans", planLine),
		labeledValue("Tool failures", toolLine),
		labeledValue("Session", sessionLine),
	];

	const backgroundDetails = formatBackgroundTaskDetails(
		info.health.backgroundTasks,
	);
	const detailSection = backgroundDetails
		? `\n${heading("Background task details")}\n${backgroundDetails}\n`
		: "";
	const historySection = formatBackgroundTaskHistory(
		info.health.backgroundTasks,
	);
	const historyBlock = historySection
		? `\n${heading("Background task history")}\n${historySection}\n`
		: "";

	return `${heading("Status snapshot")}
${rows.join("\n")}${detailSection}${historyBlock}
${muted("Use /diag for a full diagnostic report.")}`;
}

export function buildFeedbackTemplate(info: FeedbackTemplateInfo): string {
	return `${heading("Composer feedback")}
${labeledValue("Version", info.version)}
${labeledValue("Session", info.sessionId ?? muted("unknown"))}
${labeledValue("Session file", info.sessionFile)}
${labeledValue("Model", info.modelLabel)}
${labeledValue("Git", info.health.gitStatus ?? "unknown")}
${labeledValue("Tool failures", String(info.health.toolFailures))}
${labeledValue("Plans pending", String(info.health.planPendingTasks ?? 0))}

${muted("What happened?")}

${muted("What did you expect instead?")}

${muted("Anything else we should know?")}`;
}

function formatBackgroundTaskOverview(
	state?: BackgroundTaskHealth | null,
): string {
	if (!state) {
		return muted("none running");
	}
	const parts = [badge("total", `${state.total}`, "info")];
	parts.push(
		badge(
			"running",
			`${state.running}`,
			state.running > 0 ? "success" : "info",
		),
	);
	if (state.restarting > 0) {
		parts.push(badge("restarting", `${state.restarting}`, "warn"));
	}
	if (state.failed > 0) {
		parts.push(badge("failed", `${state.failed}`, "danger"));
	}
	if (state.truncated) {
		parts.push(muted("showing latest"));
	}
	if (state.detailsRedacted) {
		parts.push(muted("details off"));
	}
	return parts.join(" ");
}

function formatBackgroundTaskDetails(
	state?: BackgroundTaskHealth | null,
): string | null {
	if (!state) {
		return null;
	}
	if (state.detailsRedacted) {
		return muted(
			"Background task details disabled. Enable with /background details on.",
		);
	}
	if (state.entries.length === 0) {
		return null;
	}
	const lines = state.entries.map((entry) => formatBackgroundTaskDetail(entry));
	if (state.truncated) {
		lines.push(muted("…additional tasks hidden"));
	}
	return lines.join("\n");
}

function formatBackgroundTaskDetail(entry: BackgroundTaskHealthEntry): string {
	const issues = entry.issues.length
		? ` ${muted(entry.issues.join("; "))}`
		: "";
	const logLine = entry.lastLogLine ? `\n  ${muted(entry.lastLogLine)}` : "";
	const restartLine = entry.restarts
		? ` ${muted(`restarts ${entry.restarts}`)}`
		: "";
	return `- ${entry.summary}${restartLine}${issues}${logLine}`;
}

function formatBackgroundTaskHistory(
	state?: BackgroundTaskHealth | null,
): string | null {
	if (!state || state.detailsRedacted || state.history.length === 0) {
		return null;
	}
	const lines = state.history.map((entry) => {
		const timestamp = new Date(entry.timestamp).toLocaleTimeString();
		const reason = entry.failureReason
			? ` ${muted(entry.failureReason)}`
			: entry.limitBreach
				? ` ${muted(`limit ${entry.limitBreach.kind}`)}`
				: "";
		return `- ${timestamp} [${entry.event}] ${entry.taskId} – ${entry.command}${reason}`;
	});
	if (state.historyTruncated) {
		lines.push(muted("…additional events hidden"));
	}
	return lines.join("\n");
}
