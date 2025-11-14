import { spawnSync } from "node:child_process";
import chalk from "chalk";
import type { Container, TUI } from "../tui-lib/index.js";
import { Spacer, Text } from "../tui-lib/index.js";
import { runShellCommand } from "./run-shell-command.js";

interface GitViewOptions {
	chatContainer: Container;
	ui: TUI;
	showInfoMessage: (message: string) => void;
	showToast: (message: string, tone?: "info" | "warn" | "success") => void;
}

export class GitView {
	private lastNotifiedChanges: string[] = [];

	constructor(private readonly options: GitViewOptions) {}

	async handlePreviewCommand(text: string): Promise<void> {
		const parts = text.trim().split(/\s+/);
		if (parts.length < 2) {
			this.options.showInfoMessage("Usage: /preview <file>");
			return;
		}
		const target = parts.slice(1).join(" ");
		const quoted = JSON.stringify(target);
		const result = await runShellCommand(`git diff -- ${quoted}`);
		this.options.chatContainer.addChild(new Spacer(1));
		const content = result.stdout || result.stderr;
		const textOutput = content
			? content
			: chalk.dim(
					result.success
						? "(No diff output — file may not be tracked.)"
						: result.stderr || "git diff failed.",
				);
		this.options.chatContainer.addChild(new Text(textOutput, 1, 0));
		this.options.ui.requestRender();
	}

	handleReviewCommand(): void {
		const statusResult = this.runGitCommand(["status", "-sb"]);
		const diffResult = this.runGitCommand(["diff", "--stat"]);
		const statusText = statusResult.ok
			? statusResult.stdout.trim() || chalk.dim("Working tree clean.")
			: chalk.red(
					`git status failed: ${
						statusResult.stderr.trim() ||
						statusResult.stdout.trim() ||
						"unknown error"
					}`,
				);
		const diffLinesRaw = diffResult.ok
			? diffResult.stdout.trim()
			: chalk.red(
					`git diff --stat failed: ${
						diffResult.stderr.trim() ||
						diffResult.stdout.trim() ||
						"unknown error"
					}`,
				);
		const diffLines = diffLinesRaw.split("\n");
		const limit = 20;
		const preview = diffLines.slice(0, limit).join("\n");
		const remainder =
			diffLines.length > limit
				? `\n${chalk.dim(`(+${diffLines.length - limit} more lines)`)}`
				: "";
		const diffText =
			diffLinesRaw.trim().length > 0
				? `${preview}${remainder}`
				: chalk.dim("No pending changes.");

		const message = `${chalk.bold("Review snapshot")}
${chalk.dim("Git status")}:
${statusText}

${chalk.dim("Diff stats")}:
${diffText}

${chalk.dim("Next steps")}:
- Use /preview <file> for an inline diff
- Use /plan to revisit saved goals
- Use /status for a lightweight health check`;
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(message, 1, 0));
		this.options.ui.requestRender();
	}

	handleUndoCommand(text: string): void {
		const parts = text.trim().split(/\s+/);
		if (parts.length < 2) {
			this.options.showInfoMessage("Usage: /undo <file> [more files]");
			return;
		}
		const targets = parts.slice(1).filter(Boolean);
		if (!targets.length) {
			this.options.showInfoMessage("Usage: /undo <file> [more files]");
			return;
		}
		const result = this.runGitCommand(["checkout", "--", ...targets]);
		if (!result.ok) {
			const error =
				result.stderr.trim() ||
				result.stdout.trim() ||
				"Failed to undo changes.";
			this.options.showInfoMessage(error);
			return;
		}
		const summary = `${chalk.bold("Undo complete")}
Reverted changes in:
- ${targets.join("\n- ")}`;
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(summary, 1, 0));
		this.options.ui.requestRender();
	}

	notifyFileChanges(): void {
		try {
			const result = spawnSync("git", ["status", "-sb"], {
				cwd: process.cwd(),
				encoding: "utf-8",
			});
			if ((result.status ?? 0) !== 0) {
				return;
			}
			const lines = result.stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0 && !line.startsWith("##"));
			if (lines.length === 0) {
				this.lastNotifiedChanges = [];
				return;
			}
			const normalized = lines.slice().sort();
			if (
				normalized.length === this.lastNotifiedChanges.length &&
				normalized.every(
					(line, index) => line === this.lastNotifiedChanges[index],
				)
			) {
				return;
			}
			this.lastNotifiedChanges = normalized;
			const files = lines
				.map((line) => line.replace(/^[A-Z?]{1,2}\s+/, ""))
				.filter(Boolean);
			const previewTargets = files.slice(0, 3).join("\n- ");
			const message = `${files.length} file${files.length === 1 ? "" : "s"} modified.
- ${previewTargets}
Use /preview <file> to inspect diffs.`;
			this.options.showToast(message, "info");
		} catch {
			// ignore git errors
		}
	}

	runGitCommand(args: string[]): {
		ok: boolean;
		stdout: string;
		stderr: string;
	} {
		try {
			const result = spawnSync("git", args, {
				cwd: process.cwd(),
				encoding: "utf-8",
			});
			return {
				ok: (result.status ?? 0) === 0,
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
			};
		} catch (error) {
			return {
				ok: false,
				stdout: "",
				stderr:
					error instanceof Error ? error.message : String(error ?? "unknown"),
			};
		}
	}

	getStatusSummary(): string | undefined {
		const status = this.runGitCommand(["status", "-sb"]);
		if (!status.ok) return undefined;
		return status.stdout.trim() || "clean";
	}
}
