import chalk from "chalk";
import type { TelemetryStatus } from "../telemetry.js";
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
	return `${chalk.bold("Bug report info")}
Session ID: ${info.sessionId ?? "unknown"}
Session file: ${info.sessionFile}
Model: ${info.modelLabel}
Messages: ${info.messageCount}
Tools: ${info.toolNames.length ? info.toolNames.join(", ") : "none"}

${chalk.bold("Send these files:")}
${info.filesToShare || chalk.dim("(session file will appear once persisted)")}

Attach them in the bug report so we can replay the session.`;
}

export function buildStatusSnapshot(info: StatusSnapshotInfo): string {
	const telemetryLine = info.telemetry.enabled
		? `on · ${info.telemetry.reason}${
				info.telemetry.endpoint ? ` → ${info.telemetry.endpoint}` : ""
			}`
		: `off · ${info.telemetry.reason}`;
	const toolLine =
		info.health.toolFailures > 0
			? `${info.health.toolFailures} logged${
					info.health.toolFailurePath ? ` · ${info.health.toolFailurePath}` : ""
				}`
			: "none logged";
	const planLine =
		(info.health.planGoals ?? 0) > 0
			? `${info.health.planGoals} goal${info.health.planGoals === 1 ? "" : "s"} · ${info.health.planPendingTasks ?? 0} pending`
			: "no saved plans";
	const gitLine = info.health.gitStatus ?? "unknown (git unavailable)";
	const sessionLine = info.sessionId
		? `${info.sessionId}\n${info.sessionFile}`
		: "No persisted session yet.";

	return `${chalk.bold("Status snapshot")} ${chalk.dim(`v${info.version}`)}
${chalk.dim("Model")}: ${info.modelLabel}
${chalk.dim("Thinking")}: ${info.thinkingLevel}
${chalk.dim("Telemetry")}: ${telemetryLine}
${chalk.dim("Git")}: ${gitLine}
${chalk.dim("Plans")}: ${planLine}
${chalk.dim("Tool failures")}: ${toolLine}
${chalk.dim("Session")}: ${sessionLine}

Use /diag for a full diagnostic report.`;
}

export function buildFeedbackTemplate(info: FeedbackTemplateInfo): string {
	return `Composer feedback
Version: ${info.version}
Session: ${info.sessionId ?? "unknown"}
Session file: ${info.sessionFile}
Model: ${info.modelLabel}
Git: ${info.health.gitStatus ?? "unknown"}
Tool failures: ${info.health.toolFailures}
Plans pending: ${info.health.planPendingTasks ?? 0}

What happened?

What did you expect instead?

Anything else we should know?`;
}
