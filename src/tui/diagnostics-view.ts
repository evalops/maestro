import { existsSync } from "node:fs";
import chalk from "chalk";
import clipboard from "clipboardy";
import type { Agent } from "../agent/agent.js";
import type { ApiKeyLookupResult } from "../providers/api-keys.js";
import { lookupApiKey } from "../providers/api-keys.js";
import type { SessionManager } from "../session-manager.js";
import type { SessionModelMetadata } from "../session-manager.js";
import type { TelemetryStatus } from "../telemetry.js";
import type { Container, TUI } from "../tui-lib/index.js";
import { Spacer, Text } from "../tui-lib/index.js";
import { formatDiagnosticsReport } from "./diagnostics.js";
import type { GitView } from "./git-view.js";
import { loadTodoStore } from "./plan-view.js";
import type { ToolExecutionComponent } from "./tool-execution.js";
import {
	TOOL_FAILURE_LOG_PATH,
	type ToolStatusView,
} from "./tool-status-view.js";

interface HealthSnapshot {
	toolFailures: number;
	toolFailurePath?: string;
	gitStatus?: string;
	planGoals?: number;
	planPendingTasks?: number;
}

interface DiagnosticsViewOptions {
	agent: Agent;
	sessionManager: SessionManager;
	telemetryStatus: TelemetryStatus;
	version: string;
	explicitApiKey?: string;
	chatContainer: Container;
	ui: TUI;
	getCurrentModelMetadata: () => SessionModelMetadata | undefined;
	getPendingTools: () => Map<string, ToolExecutionComponent>;
	toolStatusView: ToolStatusView;
	gitView: GitView;
	todoStorePath: string;
}

export class DiagnosticsView {
	private currentApiKeyInfo?: ApiKeyLookupResult;

	constructor(private readonly options: DiagnosticsViewOptions) {
		if (options.explicitApiKey) {
			this.currentApiKeyInfo = {
				provider: options.agent.state.model.provider,
				source: "explicit",
				key: options.explicitApiKey,
				checkedEnvVars: [],
			};
		}
	}

	handleBugCommand(): void {
		const sessionFile = this.options.sessionManager.getSessionFile();
		const sessionId = this.options.sessionManager.getSessionId();
		const model = this.options.agent.state.model;
		const toolFailureTips = existsSync(TOOL_FAILURE_LOG_PATH)
			? `- ${TOOL_FAILURE_LOG_PATH}`
			: null;
		const filesToShare = [sessionFile, toolFailureTips]
			.filter((value): value is string => Boolean(value))
			.map((path) => `- ${path}`)
			.join("\n");

		const text = `${chalk.bold("Bug report info")}
Session ID: ${sessionId}
Session file: ${sessionFile}
Model: ${model ? `${model.provider}/${model.id}` : "unknown"}
Messages: ${this.options.agent.state.messages.length}
Tools: ${
			(this.options.agent.state.tools ?? [])
				.map((tool) => tool.name)
				.join(", ") || "none"
		}

${chalk.bold("Send these files:")}
${filesToShare || chalk.dim("(session file will appear once persisted)")}

Attach them in the bug report so we can replay the session.`;
		const copied = this.copyTextToClipboard(text);

		const copyNote = copied
			? chalk.dim("Bug info copied to clipboard.")
			: chalk.dim("(Could not copy bug info to clipboard.)");

		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(
			new Text(`${text}\n\n${copyNote}`, 1, 0),
		);
		this.options.ui.requestRender();
	}

	handleStatusCommand(): void {
		const snapshot = this.collectHealthSnapshot();
		const sessionId = this.options.sessionManager.getSessionId();
		const sessionFile = this.options.sessionManager.getSessionFile();
		const model = this.options.agent.state.model
			? `${this.options.agent.state.model.provider}/${this.options.agent.state.model.id}`
			: "unknown";
		const thinking = this.options.agent.state.thinkingLevel ?? "off";
		const telemetry = this.options.telemetryStatus;
		const telemetryLine = telemetry.enabled
			? `on · ${telemetry.reason}${telemetry.endpoint ? ` → ${telemetry.endpoint}` : ""}`
			: `off · ${telemetry.reason}`;
		const toolLine =
			snapshot.toolFailures > 0
				? `${snapshot.toolFailures} logged${snapshot.toolFailurePath ? ` · ${snapshot.toolFailurePath}` : ""}`
				: "none logged";
		const planLine =
			(snapshot.planGoals ?? 0) > 0
				? `${snapshot.planGoals} goal${snapshot.planGoals === 1 ? "" : "s"} · ${snapshot.planPendingTasks ?? 0} pending`
				: "no saved plans";
		const gitLine = snapshot.gitStatus ?? "unknown (git unavailable)";
		const sessionLine = sessionId
			? `${sessionId}\n${sessionFile}`
			: "No persisted session yet.";

		const text = `${chalk.bold("Status snapshot")} ${chalk.dim(`v${this.options.version}`)}
${chalk.dim("Model")}: ${model}
${chalk.dim("Thinking")}: ${thinking}
${chalk.dim("Telemetry")}: ${telemetryLine}
${chalk.dim("Git")}: ${gitLine}
${chalk.dim("Plans")}: ${planLine}
${chalk.dim("Tool failures")}: ${toolLine}
${chalk.dim("Session")}: ${sessionLine}

Use /diag for a full diagnostic report.`;
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(text, 1, 0));
		this.options.ui.requestRender();
	}

	handleFeedbackCommand(): void {
		const snapshot = this.collectHealthSnapshot();
		const sessionId = this.options.sessionManager.getSessionId();
		const sessionFile = this.options.sessionManager.getSessionFile();
		const model = this.options.agent.state.model
			? `${this.options.agent.state.model.provider}/${this.options.agent.state.model.id}`
			: "unknown";
		const plain = `Composer feedback
Version: ${this.options.version}
Session: ${sessionId}
Session file: ${sessionFile}
Model: ${model}
Git: ${snapshot.gitStatus ?? "unknown"}
Tool failures: ${snapshot.toolFailures}
Plans pending: ${snapshot.planPendingTasks ?? 0}

What happened?

What did you expect instead?

Anything else we should know?`;
		const copied = this.copyTextToClipboard(plain);
		const body = `${chalk.bold("Feedback template")}
${plain}

${copied ? chalk.dim("Copied to clipboard — paste this into Discord or GitHub.") : chalk.dim("Copy failed — select and copy manually.")}`;
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(body, 1, 0));
		this.options.ui.requestRender();
	}

	handleDiagnosticsCommand(commandText = "/diag"): void {
		if (!this.currentApiKeyInfo) {
			this.currentApiKeyInfo = this.resolveApiKey();
		}

		const health = this.collectHealthSnapshot();
		const report = formatDiagnosticsReport({
			sessionId: this.options.sessionManager.getSessionId(),
			sessionFile: this.options.sessionManager.getSessionFile(),
			state: this.options.agent.state,
			modelMetadata: this.options.getCurrentModelMetadata(),
			apiKeyLookup: this.currentApiKeyInfo,
			telemetry: this.options.telemetryStatus,
			pendingTools: Array.from(this.options.getPendingTools().entries()).map(
				([id, component]) => ({ id, name: component.getToolName() }),
			),
			explicitApiKey: this.options.explicitApiKey,
			health,
		});

		const shouldCopy = /copy|share/.test(commandText.split(/\s+/)[1] ?? "");
		let copyNote = "";
		if (shouldCopy) {
			const copied = this.copyTextToClipboard(report);
			copyNote = `\n\n${copied ? chalk.dim("Diagnostics copied to clipboard.") : chalk.dim("(Could not copy diagnostics to clipboard.)")}`;
		}
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(`${report}${copyNote}`, 1, 0));
		this.options.ui.requestRender();
	}

	private resolveApiKey(): ApiKeyLookupResult {
		const provider = this.options.agent.state.model.provider;
		return lookupApiKey(provider, this.options.explicitApiKey);
	}

	private collectHealthSnapshot(): HealthSnapshot {
		const { counts } = this.options.toolStatusView.getToolFailureData();
		const totalFailures = Array.from(counts.values()).reduce(
			(sum: number, value: number) => sum + value,
			0,
		);
		const gitStatus = this.options.gitView.getStatusSummary();
		const store = loadTodoStore(this.options.todoStorePath);
		let pending = 0;
		for (const goal of Object.values(store)) {
			pending += goal.items.filter(
				(item) => (item.status ?? "pending") === "pending",
			).length;
		}
		return {
			toolFailures: totalFailures,
			toolFailurePath: existsSync(TOOL_FAILURE_LOG_PATH)
				? TOOL_FAILURE_LOG_PATH
				: undefined,
			gitStatus,
			planGoals: Object.keys(store).length,
			planPendingTasks: pending,
		};
	}

	private copyTextToClipboard(value: string): boolean {
		try {
			clipboard.writeSync(value);
			return true;
		} catch {
			return false;
		}
	}
}
