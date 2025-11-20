import { existsSync } from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { type Container, Spacer, type TUI, Text } from "@evalops/tui";
import chalk from "chalk";
import clipboard from "clipboardy";
import type { Agent } from "../agent/agent.js";
import { loadProjectContextFiles } from "../cli/system-prompt.js";
import type { SessionManager } from "../session-manager.js";
import type { GitView } from "./git-view.js";
import { TOOL_FAILURE_LOG_PATH } from "./tool-status-view.js";

interface AboutViewOptions {
	agent: Agent;
	sessionManager: SessionManager;
	gitView: GitView;
	chatContainer: Container;
	ui: TUI;
	version: string;
	telemetryStatus: () => string;
	getApprovalMode?: () => string;
}

export class AboutView {
	constructor(private readonly options: AboutViewOptions) {}

	handleAboutCommand(): void {
		const text = this.buildAboutCard();
		const copied = this.copyToClipboard(text);
		const copyNote = copied
			? chalk.dim("About snapshot copied to clipboard.")
			: chalk.dim("(Copy failed — select and copy manually.)");

		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(
			new Text(`${text}\n\n${copyNote}`, 1, 0),
		);
		this.options.ui.requestRender();
	}

	buildAboutCard(): string {
		const header = this.buildHeader();
		const sections = [
			this.buildMetaSection(),
			this.buildEnvSection(),
			this.buildGitSection(),
			this.buildPathSection(),
			this.buildContextSection(),
			this.buildAttachmentSection(),
		]
			.filter(Boolean)
			.join("\n\n");
		return `${header}\n\n${sections}`;
	}

	private buildHeader(): string {
		const top = chalk.hex("#7c3aed")(
			"╭─────────────────────────────✷────────────────────────────╮",
		);
		const title = chalk.hex("#f472b6")(
			"│           ✦ composer about ✦           │",
		);
		const bottom = chalk.hex("#7c3aed")(
			"╰──────────────────────────────────────────────────────────╯",
		);
		return `${top}\n${title}\n${bottom}`;
	}

	private buildMetaSection(): string {
		const model = this.options.agent.state.model
			? `${this.options.agent.state.model.provider}/${this.options.agent.state.model.id}`
			: "unknown";
		const sessionId = this.options.sessionManager.getSessionId();
		const safeMode = process.env.COMPOSER_SAFE_MODE === "1" ? "on" : "off";
		const pendingTools = this.options.agent.state.pendingToolCalls?.size ?? 0;
		const approvalMode = this.options.getApprovalMode
			? this.options.getApprovalMode()
			: "unknown";
		const lines = [
			`${this.badge("version")}${this.options.version}`,
			`${this.badge("model")}${model}`,
			`${this.badge("session")}${sessionId}`,
			`${this.badge("telemetry")}${this.options.telemetryStatus()}`,
			`${this.badge("safe-mode")}${safeMode}`,
			`${this.badge("approvals")}${approvalMode}`,
			`${this.badge("pending")}${pendingTools} tools`,
		];
		return this.section("status", lines);
	}

	private buildEnvSection(): string {
		const platform = process.platform;
		const osName =
			platform === "darwin"
				? "macOS"
				: platform === "win32"
					? "Windows"
					: "Linux";
		const release = os.release();
		const version = typeof os.version === "function" ? os.version() : "";
		const lines = [
			`${this.badge("os")}${osName} ${release}`,
			version && !version.includes(release) ? `  ${chalk.dim(version)}` : null,
			`${this.badge("node")}${process.version}`,
			process.versions?.bun
				? `${this.badge("bun")}${process.versions.bun}`
				: null,
			process.env.TERM ? `${this.badge("term")}${process.env.TERM}` : null,
		].filter(Boolean) as string[];
		return this.section("environment", lines);
	}

	private buildGitSection(): string {
		const gitState = this.options.gitView.getWorkingTreeState();
		const branch = gitState?.branch ?? "unknown";
		const dirty = gitState ? (gitState.dirty ? "yes" : "no") : "unknown";
		const commit = this.options.gitView.getCurrentCommit() ?? "unknown";
		const summary = `${branch} @ ${commit} (dirty: ${dirty})`;
		const status =
			this.options.gitView.getStatusSummary() ?? "git status unavailable";
		const lines = [summary, ...this.trimLines(status, 5)];
		return this.section("git", lines);
	}

	private buildPathSection(): string {
		const cwd = process.cwd();
		const sessionFile = this.options.sessionManager.getSessionFile();
		const sessionDir = sessionFile ? dirname(sessionFile) : "(pending)";
		const composerDir = join(os.homedir(), ".composer");
		const lines = [
			`${this.badge("cwd")}${cwd}`,
			`${this.badge("session")}${sessionDir}`,
			`${this.badge("composer")}${composerDir}`,
		];
		return this.section("paths", lines);
	}

	private buildAttachmentSection(): string {
		const sessionFile = this.options.sessionManager.getSessionFile();
		const sessionDir = sessionFile ? dirname(sessionFile) : null;
		const attachments: Array<{ label: string; path: string }> = [];
		if (sessionDir) {
			attachments.push({ label: "Session directory", path: sessionDir });
		}
		if (existsSync(TOOL_FAILURE_LOG_PATH)) {
			attachments.push({
				label: "Tool failures log",
				path: TOOL_FAILURE_LOG_PATH,
			});
		}
		if (attachments.length === 0) {
			return "";
		}
		const displayLines = attachments.map(
			(entry) => `${entry.label}: ${entry.path}`,
		);
		const tarLines = this.buildTarCommand(attachments.map((a) => a.path)).split(
			"\n",
		);
		return `${this.section("attachments", displayLines)}\n${this.section("tar", tarLines)}`;
	}

	private buildContextSection(): string {
		const systemPrompt = this.options.agent.state.systemPrompt || "";
		const files = loadProjectContextFiles();
		const promptLine = systemPrompt
			? `${this.badge("prompt")}${systemPrompt.length.toLocaleString()} chars`
			: `${this.badge("prompt")}${chalk.dim("none loaded")}`;
		const fileLines =
			files.length > 0
				? files.map((file) => `- ${file.path}`)
				: [chalk.dim("(no AGENTS/CLAUDE files found)")];
		return this.section("context", [promptLine, ...fileLines]);
	}

	private section(title: string, lines: string[]): string {
		const label = chalk.hex("#a5b4fc").bold(`[${title}]`);
		const body = lines.map((line) => `  ${line}`).join("\n");
		return `${label}\n${body}`;
	}

	private badge(label: string): string {
		return `${chalk.hex("#f472b6")("▣")} ${chalk.hex("#fbcfe8")(label)} `;
	}

	private trimLines(value: string, maxLines: number): string[] {
		const lines = value
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		if (lines.length <= maxLines) {
			return lines;
		}
		return [
			...lines.slice(0, maxLines),
			chalk.dim(`… +${lines.length - maxLines} more`),
		];
	}

	private buildTarCommand(paths: string[]): string {
		if (!paths.length) {
			return chalk.dim("(no files to archive)");
		}
		const quoted = paths.map((value) => this.quotePath(value));
		const firstLine = "tar czf composer-about.tgz";
		const subsequent = quoted.map((value) => `  ${value}`);
		return [firstLine, ...subsequent].join(" \\\n");
	}

	private quotePath(value: string): string {
		if (!value.includes(" ")) {
			return value;
		}
		return `"${value}"`;
	}

	private copyToClipboard(text: string): boolean {
		try {
			clipboard.writeSync(text);
			return true;
		} catch {
			return false;
		}
	}
}
