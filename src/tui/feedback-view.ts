import chalk from "chalk";
import clipboard from "clipboardy";
import type { Agent } from "../agent/agent.js";
import type { ToolResultMessage } from "../agent/types.js";
import type { ValidatorRunResult } from "../safety/safe-mode.js";
import type { SessionManager } from "../session-manager.js";
import type { Container, TUI } from "../tui-lib/index.js";
import { Spacer, Text } from "../tui-lib/index.js";
import type { GitView } from "./git-view.js";
import { TOOL_FAILURE_LOG_PATH } from "./tool-status-view.js";
import type { ToolStatusView } from "./tool-status-view.js";

interface FeedbackViewOptions {
	agent: Agent;
	sessionManager: SessionManager;
	chatContainer: Container;
	ui: TUI;
	toolStatusView: ToolStatusView;
	gitView: GitView;
}

export class FeedbackView {
	constructor(private readonly options: FeedbackViewOptions) {}

	handleBugCommand(): void {
		const sessionFile = this.options.sessionManager.getSessionFile();
		const sessionId = this.options.sessionManager.getSessionId();
		const model = this.options.agent.state.model;
		const toolFailureTips = TOOL_FAILURE_LOG_PATH
			? `- ${TOOL_FAILURE_LOG_PATH}`
			: null;
		const filesToShare = [sessionFile, toolFailureTips]
			.filter((value): value is string => Boolean(value))
			.map((path) => `- ${path}`)
			.join("\n");

		const gitStatus =
			this.options.gitView.getStatusSummary() ?? "git status unavailable";
		const gitCommit = this.options.gitView.getCurrentCommit() ?? "unknown";
		const toolFailureSummary = this.buildToolFailureSummary();
		const validatorSummary = this.buildValidatorSummary();

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

${chalk.bold("Git snapshot")}
${this.formatBlock(gitStatus)}
  commit: ${gitCommit}

${toolFailureSummary}

${validatorSummary}

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

	handleFeedbackCommand(version: string): void {
		const sessionId = this.options.sessionManager.getSessionId();
		const sessionFile = this.options.sessionManager.getSessionFile();
		const model = this.options.agent.state.model
			? `${this.options.agent.state.model.provider}/${this.options.agent.state.model.id}`
			: "unknown";
		const snapshot = this.collectHealthSnapshot();
		const plain = `Composer feedback
Version: ${version}
Session: ${sessionId}
Session file: ${sessionFile}
Model: ${model}
Tool failures: ${snapshot.toolFailures}

What happened?

What did you expect instead?

Anything else we should know?`;

		const copied = this.copyTextToClipboard(plain);
		const body = `${chalk.bold("Feedback template")}
${plain}

${
	copied
		? chalk.dim("Copied to clipboard — paste this into Discord or GitHub.")
		: chalk.dim("Copy failed — select and copy manually.")
}`;
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(body, 1, 0));
		this.options.ui.requestRender();
	}

	private buildToolFailureSummary(): string {
		const { recent, counts } =
			this.options.toolStatusView.getToolFailureData(5);
		if (recent.length === 0) {
			return `${chalk.bold("Tool failures")}
${chalk.dim("No tool failures captured yet.")}`;
		}
		const total = Array.from(counts.values()).reduce(
			(sum, value) => sum + value,
			0,
		);
		const lines = recent
			.map((entry) => `  - ${entry.timestamp}: ${entry.tool} → ${entry.error}`)
			.join("\n");
		const totalsLine =
			total > recent.length
				? `\n  ${chalk.dim(
						`Totals: ${Array.from(counts.entries())
							.map(([tool, value]) => `${tool}×${value}`)
							.join(", ")}`,
					)}`
				: "";
		return `${chalk.bold(`Tool failures (last ${recent.length})`)}
${lines}${totalsLine}`;
	}

	private buildValidatorSummary(): string {
		const latest = this.findLatestValidatorDetails();
		if (!latest) {
			return `${chalk.bold("Validator runs")}
${chalk.dim("No validator output captured in recent tool results.")}`;
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
		return `${chalk.bold(`Validator runs (from ${latest.toolName})`)}
${lines}`;
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
