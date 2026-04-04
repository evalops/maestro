import { existsSync } from "node:fs";
import * as os from "node:os";
import { dirname } from "node:path";
import type { Container, TUI } from "@evalops/tui";
import { Spacer, Text } from "@evalops/tui";
import chalk from "chalk";
import clipboard from "clipboardy";
import type { ApprovalMode } from "../agent/action-approval.js";
import type { Agent } from "../agent/agent.js";
import type { AppMessage, ToolResultMessage } from "../agent/types.js";
import { loadProjectContextFiles } from "../cli/system-prompt.js";
import {
	buildConversationModel,
	isRenderableAssistantMessage,
} from "../conversation/render-model.js";
import type { ValidatorRunResult } from "../safety/safe-mode.js";
import type { SessionManager } from "../session/manager.js";
import type { GitView } from "./git/git-view.js";
import {
	TOOL_FAILURE_LOG_PATH,
	readToolFailureData,
} from "./tool-status-view.js";

interface FeedbackViewOptions {
	agent: Agent;
	sessionManager: SessionManager;
	chatContainer: Container;
	ui: TUI;
	gitView: GitView;
	version: string;
	getApprovalMode: () => ApprovalMode;
}

export class FeedbackView {
	constructor(private readonly options: FeedbackViewOptions) {}

	handleBugCommand(): void {
		const sessionFile = this.options.sessionManager.getSessionFile();
		const sessionDir = sessionFile ? dirname(sessionFile) : undefined;
		const sessionId = this.options.sessionManager.getSessionId();
		const model = this.options.agent.state.model;
		const attachments = this.buildAttachmentSection(
			[
				sessionDir ? { label: "Session directory", path: sessionDir } : null,
				existsSync(TOOL_FAILURE_LOG_PATH)
					? { label: "Tool failures log", path: TOOL_FAILURE_LOG_PATH }
					: null,
				...this.buildContextFileAttachments(),
			].filter((value): value is { label: string; path: string } =>
				Boolean(value),
			),
			this.buildRuntimeFlagsLine(),
		);

		const gitStatus =
			this.options.gitView.getStatusSummary() ?? "git status unavailable";
		const gitCommit = this.options.gitView.getCurrentCommit() ?? "unknown";
		const gitState = this.options.gitView.getWorkingTreeState();
		const gitBranch = gitState?.branch ?? "unknown";
		const gitDirty = gitState ? (gitState.dirty ? "yes" : "no") : "unknown";
		const toolFailureSummary = this.buildToolFailureSummary();
		const validatorSummary = this.buildValidatorSummary();
		const envSummary = this.buildEnvironmentSummary();
		const renderables = buildConversationModel(
			this.options.agent.state.messages as AppMessage[],
		);
		const toolsUsed = renderables
			.filter((message) => isRenderableAssistantMessage(message))
			.flatMap((message) => message.toolCalls.map((tool) => tool.name));
		const uniqueTools = Array.from(new Set(toolsUsed));
		const toolsLine = uniqueTools.join(", ") || "none";
		const sessionDirLine = sessionDir
			? `Session directory:\n  ${sessionDir}`
			: chalk.dim("Session directory has not been persisted yet.");

		const infoSection = [
			chalk.bold("Bug report info"),
			`Maestro: ${this.options.version || "unknown"}`,
			`Session ID: ${sessionId}`,
			sessionDirLine,
			`Model: ${model ? `${model.provider}/${model.id}` : "unknown"}`,
			`Messages: ${renderables.length}`,
			`Tools: ${toolsLine}`,
			`Env: ${envSummary}`,
			`Git: ${gitBranch} @ ${gitCommit} (dirty: ${gitDirty})`,
			this.buildRuntimeFlagsLine(),
		].join("\n");

		const sections: string[] = [
			infoSection,
			`${chalk.bold("Git status")}\n${this.formatBlock(gitStatus)}`,
		];
		if (toolFailureSummary) {
			sections.push(toolFailureSummary);
		}
		if (validatorSummary) {
			sections.push(validatorSummary);
		}
		sections.push(attachments);
		sections.push(
			"Attach them in the bug report so we can replay the session.",
		);

		const text = sections.filter(Boolean).join("\n\n");

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

	handleFeedbackCommand(): void {
		const sessionId = this.options.sessionManager.getSessionId();
		const sessionFile = this.options.sessionManager.getSessionFile();
		const model = this.options.agent.state.model
			? `${this.options.agent.state.model.provider}/${this.options.agent.state.model.id}`
			: "unknown";
		const snapshot = this.collectHealthSnapshot();
		const plain = `Maestro feedback\nVersion: ${this.options.version}\nSession: ${sessionId}\nSession file: ${sessionFile}\nModel: ${model}\nTool failures: ${snapshot.toolFailures}\nFlags: ${this.buildRuntimeFlagsLine()}\n\nWhat happened?\n\nWhat did you expect instead?\n\nAnything else we should know?`;

		const copied = this.copyTextToClipboard(plain);
		const body = `${chalk.bold("Feedback template")}\n${plain}\n\n${
			copied
				? chalk.dim("Copied to clipboard — paste this into Discord or GitHub.")
				: chalk.dim("Copy failed — select and copy manually.")
		}`;
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(body, 1, 0));
		this.options.ui.requestRender();
	}

	private buildContextFileAttachments(): Array<{
		label: string;
		path: string;
	}> {
		const files = loadProjectContextFiles();
		if (!files.length) {
			return [];
		}
		return files.map((file) => ({
			label: "Context file",
			path: file.path,
		}));
	}

	private buildRuntimeFlagsLine(): string {
		const safeMode = process.env.MAESTRO_SAFE_MODE === "1" ? "on" : "off";
		const approvalMode = this.options.getApprovalMode();
		const queueCount = this.options.agent.state.pendingToolCalls?.size ?? 0;
		return `safe-mode ${safeMode}, approvals ${approvalMode}, pending tools ${queueCount}`;
	}

	private buildToolFailureSummary(): string | undefined {
		const { recent, counts } = readToolFailureData(5);
		if (recent.length === 0) {
			return undefined;
		}
		const aggregates: Array<{
			tool: string;
			error: string;
			timestamp: string;
			count: number;
		}> = [];
		const indexes = new Map<string, number>();
		for (const entry of recent) {
			const key = `${entry.tool}|${entry.error}`;
			const position = indexes.get(key);
			if (position === undefined) {
				aggregates.push({
					tool: entry.tool,
					error: entry.error,
					timestamp: entry.timestamp,
					count: 1,
				});
				indexes.set(key, aggregates.length - 1);
			} else {
				aggregates[position]!.count += 1;
			}
		}
		const lines = aggregates
			.map((entry) => {
				const countLabel =
					entry.count > 1 ? chalk.dim(` (${entry.count}×)`) : "";
				return `  - ${entry.timestamp}: ${entry.tool} → ${entry.error}${countLabel}`;
			})
			.join("\n");
		const totalFailures = Array.from(counts.values()).reduce(
			(sum, value) => sum + value,
			0,
		);
		const header = chalk.bold(
			`Tool failures (last ${recent.length}, total ${totalFailures})`,
		);
		return `${header}\n${lines}`;
	}

	private buildValidatorSummary(): string | undefined {
		const latest = this.findLatestValidatorDetails();
		if (!latest) {
			return undefined;
		}
		const lines = latest.validators
			.map((validator) => {
				const stdout = this.condenseText(validator.stdout);
				const stderr = this.condenseText(validator.stderr);
				const parts = [`  - ${chalk.cyan(validator.command)}`];
				if (stdout) {
					parts.push(`    stdout: ${stdout}`);
				}
				if (stderr) {
					parts.push(`    stderr: ${stderr}`);
				}
				return parts.join("\n");
			})
			.join("\n");
		return `${chalk.bold(`Validator runs (from ${latest.toolName})`)}\n${lines}`;
	}

	private findLatestValidatorDetails(): {
		toolName: string;
		validators: ValidatorRunResult[];
	} | null {
		const messages = this.options.agent.state.messages;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (
				message &&
				typeof message === "object" &&
				"role" in message &&
				(message as ToolResultMessage).role === "toolResult"
			) {
				const toolMessage = message as ToolResultMessage;
				const validators = (toolMessage.details as { validators?: unknown })
					?.validators;
				if (Array.isArray(validators) && validators.length > 0) {
					return {
						toolName: toolMessage.toolName,
						validators: validators as ValidatorRunResult[],
					};
				}
			}
		}
		return null;
	}

	private condenseText(value: string): string {
		const trimmed = value?.trim();
		if (!trimmed) {
			return chalk.dim("(empty)");
		}
		const lines = trimmed.split(/\r?\n/);
		const preview = lines.slice(0, 2).join(" ");
		const normalized =
			preview.length > 160 ? `${preview.slice(0, 160)}…` : preview;
		return normalized;
	}

	private formatBlock(value: string, maxLines = 5): string {
		const lines = value
			?.split(/\r?\n/)
			.map((line) => line.trimEnd())
			.filter((line) => line.length > 0) ?? ["(no output)"];
		const limited = lines.slice(0, maxLines).map((line) => `  ${line}`);
		if (lines.length > maxLines) {
			limited.push(`  … (+${lines.length - maxLines} more lines)`);
		}
		return limited.join("\n");
	}

	private buildAttachmentSection(
		entries: Array<{ label: string; path: string }>,
		runtimeFlags?: string,
	): string {
		if (entries.length === 0) {
			return `${chalk.bold("Send these files")}
${chalk.dim("Session artifacts will appear once persisted.")}`;
		}
		const bulletLines = entries
			.map((entry) => `  • ${entry.label}:\n    ${entry.path}`)
			.join("\n");
		const tarCommand = this.buildTarCommand(entries.map((entry) => entry.path));
		return `${chalk.bold("Send these files")}
${bulletLines}

${chalk.bold("Quick tar command")}
${tarCommand}${
	runtimeFlags
		? `\n\n${chalk.bold("Runtime flags")}\n${chalk.dim(runtimeFlags)}`
		: ""
}`;
	}

	private buildTarCommand(paths: string[]): string {
		if (!paths.length) {
			return chalk.dim("(no files to archive)");
		}
		const quoted = paths.map((value) => this.quotePath(value));
		const firstLine = "tar czf maestro-bug-report.tgz";
		const subsequent = quoted.map((value) => `  ${value}`);
		return [firstLine, ...subsequent].join(" \\\n");
	}

	private quotePath(value: string): string {
		if (!value.includes(" ")) {
			return value;
		}
		return `"${value}"`;
	}

	private buildEnvironmentSummary(): string {
		const platform = process.platform;
		const osName =
			platform === "darwin"
				? "macOS"
				: platform === "win32"
					? "Windows"
					: "Linux";
		const release = os.release();
		const version = typeof os.version === "function" ? os.version() : "";
		const parts = [`${osName} ${release}`];
		if (version && !version.includes(release)) {
			parts.push(version);
		}
		parts.push(`node ${process.version}`);
		if (process.versions?.bun) {
			parts.push(`bun ${process.versions.bun}`);
		}
		return parts.join(" · ");
	}

	private collectHealthSnapshot(): { toolFailures: number } {
		const failures = this.options.agent.state.messages.filter(
			(message) => message.role === "toolResult" && message.isError,
		).length;
		return {
			toolFailures: failures,
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
