import { badge, heading, labeledValue, muted } from "../../style/theme.js";
import type { TelemetryStatus } from "../../telemetry.js";
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
		labeledValue("Plans", planLine),
		labeledValue("Tool failures", toolLine),
		labeledValue("Session", sessionLine),
	];

	return `${heading("Status snapshot")}
${rows.join("\n")}

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
