import { existsSync } from "node:fs";
import clipboard from "clipboardy";
import type { Agent } from "../agent/agent.js";
import { collectDiagnostics as collectLspDiagnostics } from "../lsp/index.js";
import type { ApiKeyLookupResult } from "../providers/api-keys.js";
import { lookupApiKey } from "../providers/api-keys.js";
import type { SessionManager } from "../session-manager.js";
import type { SessionModelMetadata } from "../session-manager.js";
import { muted } from "../style/theme.js";
import type { TelemetryStatus } from "../telemetry.js";
import { getExaUsageSummary } from "../tools/exa-usage.js";
import type { Container, TUI } from "../tui-lib/index.js";
import { Spacer, Text } from "../tui-lib/index.js";
import {
	buildBugReport,
	buildFeedbackTemplate,
	buildStatusSnapshot,
} from "./diagnostics-templates.js";
import { formatDiagnosticsReport } from "./diagnostics.js";
import type { GitView } from "./git-view.js";
import {
	type HealthSnapshot,
	collectHealthSnapshot,
} from "./health-snapshot.js";
import type { ToolExecutionComponent } from "./tool-execution.js";
import {
	TOOL_FAILURE_LOG_PATH,
	type ToolStatusView,
} from "./tool-status-view.js";

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
	private telemetryStatus: TelemetryStatus;

	constructor(private readonly options: DiagnosticsViewOptions) {
		this.telemetryStatus = options.telemetryStatus;
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

		const text = buildBugReport({
			sessionId,
			sessionFile,
			modelLabel: model ? `${model.provider}/${model.id}` : "unknown",
			messageCount: this.options.agent.state.messages.length,
			toolNames: this.options.agent.state.tools?.map((tool) => tool.name) ?? [],
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

		const health = this.buildHealthSnapshot();
		const lspDiagnostics = await collectLspDiagnostics().catch(() => undefined);
		const report = formatDiagnosticsReport({
			sessionId: this.options.sessionManager.getSessionId(),
			sessionFile: this.options.sessionManager.getSessionFile(),
			state: this.options.agent.state,
			modelMetadata: this.options.getCurrentModelMetadata(),
			apiKeyLookup: this.currentApiKeyInfo,
			telemetry: this.telemetryStatus,
			exaUsage: getExaUsageSummary(),
			pendingTools: Array.from(this.options.getPendingTools().entries()).map(
				([id, component]) => ({ id, name: component.getToolName() }),
			),
			explicitApiKey: this.options.explicitApiKey,
			health,
			lspDiagnostics,
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

	private resolveApiKey(): ApiKeyLookupResult {
		const provider = this.options.agent.state.model.provider;
		return lookupApiKey(provider, this.options.explicitApiKey);
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
