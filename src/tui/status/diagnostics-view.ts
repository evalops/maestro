import { existsSync } from "node:fs";
import type { Container, TUI } from "@evalops/tui";
import { Spacer, Text } from "@evalops/tui";
import clipboard from "clipboardy";
import type { Agent } from "../../agent/agent.js";
import type { AppMessage } from "../../agent/types.js";
import { loadProjectContextFiles } from "../../cli/system-prompt.js";
import { buildConversationModel } from "../../conversation/render-model.js";
import { collectDiagnostics as collectLspDiagnostics } from "../../lsp/index.js";
import type { ApiKeyLookupResult } from "../../providers/api-keys.js";
import { lookupApiKey } from "../../providers/api-keys.js";
import type { SessionManager } from "../../session/manager.js";
import type { SessionModelMetadata } from "../../session/manager.js";
import { muted } from "../../style/theme.js";
import type { TelemetryStatus } from "../../telemetry.js";
import { getExaUsageSummary } from "../../tools/exa-usage.js";
import type { TrainingStatus } from "../../training.js";
import type { GitView } from "../git/git-view.js";
import type { ToolExecutionComponent } from "../tool-execution.js";
import {
	TOOL_FAILURE_LOG_PATH,
	type ToolStatusView,
} from "../tool-status-view.js";
import {
	buildBugReport,
	buildFeedbackTemplate,
	buildStatusSnapshot,
} from "./diagnostics-templates.js";
import { formatDiagnosticsReport } from "./diagnostics.js";
import {
	type HealthSnapshot,
	collectHealthSnapshot,
} from "./health-snapshot.js";

interface DiagnosticsViewOptions {
	agent: Agent;
	sessionManager: SessionManager;
	telemetryStatus: TelemetryStatus;
	trainingStatus: TrainingStatus;
	version: string;
	explicitApiKey?: string;
	chatContainer: Container;
	ui: TUI;
	getCurrentModelMetadata: () => SessionModelMetadata | undefined;
	getPendingTools: () => Map<string, ToolExecutionComponent>;
	toolStatusView: ToolStatusView;
	gitView: GitView;
	todoStorePath: string;
	getApprovalMode?: () => string;
}

export class DiagnosticsView {
	private currentApiKeyInfo?: ApiKeyLookupResult;
	private telemetryStatus: TelemetryStatus;
	private trainingStatus: TrainingStatus;

	constructor(private readonly options: DiagnosticsViewOptions) {
		this.telemetryStatus = options.telemetryStatus;
		this.trainingStatus = options.trainingStatus;
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
		const renderables = buildConversationModel(
			this.options.agent.state.messages as AppMessage[],
		);

		const text = buildBugReport({
			sessionId,
			sessionFile,
			modelLabel: model ? `${model.provider}/${model.id}` : "unknown",
			messageCount: renderables.length,
			toolNames: renderables
				.filter((message) => message.kind === "assistant")
				.flatMap((message) => message.toolCalls.map((tool) => tool.name)),
			filesToShare,
		});
		const copied = this.copyTextToClipboard(text);

		const copyNote = copied
			? muted("Bug info copied to clipboard.")
			: muted("(Could not copy bug info to clipboard.)");

		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(
			new Text(`${text}\n\n${copyNote}`, 1, 0),
		);
		this.options.ui.requestRender();
	}

	handleStatusCommand(): void {
		const snapshot = this.buildHealthSnapshot();
		const sessionId = this.options.sessionManager.getSessionId();
		const sessionFile = this.options.sessionManager.getSessionFile();
		const model = this.options.agent.state.model
			? `${this.options.agent.state.model.provider}/${this.options.agent.state.model.id}`
			: "unknown";
		const thinking = this.options.agent.state.thinkingLevel ?? "off";
		const text = buildStatusSnapshot({
			version: this.options.version,
			modelLabel: model,
			thinkingLevel: thinking,
			telemetry: this.telemetryStatus,
			training: this.trainingStatus,
			health: snapshot,
			sessionId,
			sessionFile,
		});
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(text, 1, 0));
		this.options.ui.requestRender();
	}

	handleFeedbackCommand(): void {
		const snapshot = this.buildHealthSnapshot();
		const sessionId = this.options.sessionManager.getSessionId();
		const sessionFile = this.options.sessionManager.getSessionFile();
		const model = this.options.agent.state.model
			? `${this.options.agent.state.model.provider}/${this.options.agent.state.model.id}`
			: "unknown";
		const plain = buildFeedbackTemplate({
			version: this.options.version,
			modelLabel: model,
			sessionId,
			sessionFile,
			health: snapshot,
		});
		const copied = this.copyTextToClipboard(plain);
		const copyNote = copied
			? muted("Copied to clipboard — paste this into Discord or GitHub.")
			: muted("Copy failed — select and copy manually.");
		const body = `${plain}

${copyNote}`;
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(body, 1, 0));
		this.options.ui.requestRender();
	}

	async handleDiagnosticsCommand(commandText = "/diag"): Promise<void> {
		if (!this.currentApiKeyInfo) {
			this.currentApiKeyInfo = this.resolveApiKey();
		}

		const tokens = commandText.trim().split(/\s+/).slice(1);
		const isShort = tokens.includes("short");
		const health = this.buildHealthSnapshot();
		const lspDiagnostics = await collectLspDiagnostics().catch(() => undefined);
		const attachments = this.buildAttachmentList();

		if (isShort) {
			const short = this.buildShortDiagnostics({ health, attachments });
			this.options.chatContainer.addChild(new Spacer(1));
			this.options.chatContainer.addChild(new Text(short, 1, 0));
			this.options.ui.requestRender();
			return;
		}

		const report = formatDiagnosticsReport({
			sessionId: this.options.sessionManager.getSessionId(),
			sessionFile: this.options.sessionManager.getSessionFile(),
			state: this.options.agent.state,
			modelMetadata: this.options.getCurrentModelMetadata(),
			apiKeyLookup: this.currentApiKeyInfo,
			telemetry: this.telemetryStatus,
			training: this.trainingStatus,
			exaUsage: getExaUsageSummary(),
			pendingTools: Array.from(this.options.getPendingTools().entries()).map(
				([id, component]) => ({ id, name: component.getToolName() }),
			),
			explicitApiKey: this.options.explicitApiKey,
			health,
			lspDiagnostics,
			attachments,
		});

		const shouldCopy = /copy|share/.test(commandText.split(/\s+/)[1] ?? "");
		let copyNote = "";
		if (shouldCopy) {
			const copied = this.copyTextToClipboard(report);
			copyNote = `\n\n${copied ? muted("Diagnostics copied to clipboard.") : muted("(Could not copy diagnostics to clipboard.)")}`;
		}
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(`${report}${copyNote}`, 1, 0));
		this.options.ui.requestRender();
	}

	setTelemetryStatus(status: TelemetryStatus): void {
		this.telemetryStatus = status;
	}

	setTrainingStatus(status: TrainingStatus): void {
		this.trainingStatus = status;
	}

	private resolveApiKey(): ApiKeyLookupResult {
		const provider = this.options.agent.state.model.provider;
		return lookupApiKey(provider, this.options.explicitApiKey);
	}

	private buildShortDiagnostics({
		health,
		attachments,
	}: {
		health: HealthSnapshot;
		attachments: string[];
	}): string {
		const model = this.options.agent.state.model
			? `${this.options.agent.state.model.provider}/${this.options.agent.state.model.id}`
			: "unknown";
		const runtime = this.describeRuntime();
		const training =
			this.trainingStatus.preference === "opted-out"
				? "opted-out"
				: this.trainingStatus.preference === "opted-in"
					? "opted-in"
					: "provider default";
		const attachLine = attachments.length
			? attachments.map((entry) => `- ${entry}`).join("\n")
			: muted("(no attachments found)");
		const lines = [
			"Diagnostics (short)",
			`Model: ${model}`,
			`Session: ${this.options.sessionManager.getSessionFile() ?? muted("(pending)")}`,
			`Telemetry: ${this.telemetryStatus.enabled ? "enabled" : "disabled"}`,
			`Training: ${training}`,
			`Runtime: ${runtime}`,
			`Tool failures: ${health.toolFailures}${health.toolFailurePath ? ` (${health.toolFailurePath})` : ""}`,
			`Git: ${health.gitStatus ?? muted("unavailable")}`,
			health.backgroundTasks
				? `Background tasks: ${this.summarizeBackgroundTasks(health.backgroundTasks)}`
				: undefined,
			health.planGoals !== undefined
				? `Plans: ${health.planGoals} goals, ${health.planPendingTasks ?? 0} pending`
				: undefined,
			attachments.length ? "Attachments:" : undefined,
			attachments.length ? attachLine : undefined,
			muted("Use /diag for full report; add copy to copy to clipboard."),
		].filter(Boolean) as string[];
		return lines.join("\n");
	}

	private summarizeBackgroundTasks(
		state: HealthSnapshot["backgroundTasks"],
	): string {
		if (!state) {
			return "none running";
		}
		const parts = [`${state.running}/${state.total} running`];
		if (state.restarting > 0) {
			parts.push(`${state.restarting} restarting`);
		}
		if (state.failed > 0) {
			parts.push(`${state.failed} failed`);
		}
		return parts.join(", ");
	}

	private buildAttachmentList(): string[] {
		const entries: string[] = [];
		const sessionFile = this.options.sessionManager.getSessionFile();
		if (sessionFile) {
			entries.push(sessionFile);
		}
		if (existsSync(TOOL_FAILURE_LOG_PATH)) {
			entries.push(TOOL_FAILURE_LOG_PATH);
		}
		for (const file of loadProjectContextFiles()) {
			entries.push(file.path);
		}
		return entries;
	}

	private describeRuntime(): string {
		const safeMode = process.env.COMPOSER_SAFE_MODE === "1" ? "on" : "off";
		const approvalMode = this.options.getApprovalMode
			? this.options.getApprovalMode()
			: "unknown";
		const pendingTools = this.options.agent.state.pendingToolCalls?.size ?? 0;
		return `safe-mode ${safeMode}, approvals ${approvalMode}, pending tools ${pendingTools}`;
	}

	private buildHealthSnapshot(): HealthSnapshot {
		return collectHealthSnapshot({
			toolStatusView: this.options.toolStatusView,
			gitView: this.options.gitView,
			todoStorePath: this.options.todoStorePath,
		});
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
