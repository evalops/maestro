import chalk from "chalk";
import clipboard from "clipboardy";
import type { Agent } from "../agent/agent.js";
import type { SessionManager } from "../session-manager.js";
import type { Container, TUI } from "../tui-lib/index.js";
import { Spacer, Text } from "../tui-lib/index.js";
import { TOOL_FAILURE_LOG_PATH } from "./tool-status-view.js";

interface FeedbackViewOptions {
	agent: Agent;
	sessionManager: SessionManager;
	chatContainer: Container;
	ui: TUI;
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
