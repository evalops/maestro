import { spawn, spawnSync } from "node:child_process";
import { normalize, resolve } from "node:path";
import type { Container, TUI } from "@evalops/tui";
import { Spacer, Text } from "@evalops/tui";
import chalk from "chalk";
import { formatGuardianResult, runGuardian } from "../../guardian/index.js";
import type { ModalManager } from "../modal-manager.js";
import { CommitModal } from "./commit-modal.js";
import {
	GitPreviewModal,
	type GitPreviewMode,
	type GitStatusEntry,
} from "./git-preview-modal.js";

interface GitViewOptions {
	chatContainer: Container;
	ui: TUI;
	showInfoMessage: (message: string) => void;
	showToast: (message: string, tone?: "info" | "warn" | "success") => void;
	modalManager: ModalManager;
}

export class GitView {
	private lastNotifiedChanges: string[] = [];
	private lastTodoFingerprint = "";
	private previewModal: GitPreviewModal | null = null;
	private commitModal: CommitModal | null = null;
	private previewEntries: GitStatusEntry[] = [];
	private previewSelection = 0;
	private previewMode: GitPreviewMode = "worktree";
	private previewRequestId = 0;

	constructor(private readonly options: GitViewOptions) {}

	async handlePreviewCommand(text: string): Promise<void> {
		const trimmed = text.trim();
		const spaceIndex = trimmed.indexOf(" ");
		const target =
			spaceIndex === -1 ? undefined : trimmed.slice(spaceIndex + 1).trim();
		await this.openPreviewModal(target);
	}

	private async openPreviewModal(target?: string): Promise<void> {
		if (!this.previewModal) {
			this.previewModal = new GitPreviewModal({
				onClose: () => this.closePreviewModal(),
				onNavigate: (delta) => void this.movePreviewSelection(delta),
				onStage: () => void this.stageSelectedEntry(),
				onUnstage: () => void this.unstageSelectedEntry(),
				onRefresh: () => void this.refreshPreviewEntries(),
				onToggleMode: () => void this.togglePreviewMode(),
				onCommit: () => this.openCommitModal(),
			});
			this.options.modalManager.push(this.previewModal);
		}
		await this.refreshPreviewEntries(target);
	}

	private closePreviewModal(): void {
		if (!this.previewModal) return;
		this.options.modalManager.pop();
		this.previewModal = null;
		this.previewEntries = [];
	}

	private openCommitModal(): void {
		this.commitModal = new CommitModal({
			onSubmit: (message) => void this.performCommit(message),
			onCancel: () => this.closeCommitModal(),
		});
		this.options.modalManager.push(this.commitModal);
	}

	private closeCommitModal(): void {
		this.commitModal = null;
		this.options.modalManager.pop();
	}

	private async performCommit(message: string): Promise<void> {
		const guardianOk = await this.runGuardianGate();
		if (!guardianOk) {
			return;
		}
		const result = await this.runGitAsync(["commit", "-m", message]);
		if (!result.success) {
			this.options.showInfoMessage(result.stderr || "Commit failed");
			return;
		}
		this.options.showToast("Committed changes.", "success");
		this.closeCommitModal();
		await this.refreshPreviewEntries();
	}

	private async runGuardianGate(): Promise<boolean> {
		const guardian = await runGuardian({
			trigger: "git commit",
			target: "staged",
		});
		if (guardian.status === "failed" || guardian.status === "error") {
			this.options.showInfoMessage(formatGuardianResult(guardian));
			return false;
		}
		return true;
	}

	private async refreshPreviewEntries(targetPath?: string): Promise<void> {
		if (!this.previewModal) return;
		this.previewModal.setLoading(true);
		const status = await this.getStatusEntries();
		if (!status.ok) {
			this.previewModal.setEntries([], 0);
			this.previewModal.setDiff(status.message, this.previewMode);
			this.previewModal.setStatusMessage(status.message);
			this.previewModal.setLoading(false);
			if (!status.entries.length) {
				this.options.showInfoMessage(status.message);
				this.closePreviewModal();
			}
			return;
		}
		if (!status.entries.length) {
			this.previewModal.setEntries([], 0);
			this.previewModal.setDiff(
				chalk.dim("Working tree clean."),
				this.previewMode,
			);
			this.previewModal.setStatusMessage("Working tree clean");
			this.previewModal.setLoading(false);
			return;
		}
		this.previewEntries = status.entries;
		let nextIndex = this.previewSelection;
		if (typeof targetPath === "string" && targetPath.trim().length > 0) {
			const trimmed = targetPath.trim();
			const found = status.entries.findIndex((entry) => entry.path === trimmed);
			if (found >= 0) {
				nextIndex = found;
			}
		}
		nextIndex = Math.min(Math.max(0, nextIndex), status.entries.length - 1);
		this.previewSelection = nextIndex;
		this.previewModal.setEntries(this.previewEntries, this.previewSelection);
		this.previewModal.setStatusMessage(null);
		await this.loadPreviewDiff(this.previewEntries[this.previewSelection]);
	}

	private async movePreviewSelection(delta: number): Promise<void> {
		if (!this.previewEntries.length || !this.previewModal) {
			return;
		}
		const nextIndex = Math.min(
			Math.max(0, this.previewSelection + delta),
			this.previewEntries.length - 1,
		);
		if (nextIndex === this.previewSelection) {
			return;
		}
		this.previewSelection = nextIndex;
		this.previewModal.setEntries(this.previewEntries, this.previewSelection);
		await this.loadPreviewDiff(this.previewEntries[this.previewSelection]);
	}

	private async loadPreviewDiff(entry?: GitStatusEntry): Promise<void> {
		if (!this.previewModal || !entry) return;
		const token = ++this.previewRequestId;
		this.previewModal.setLoading(true);
		const diff = await this.getDiffForEntry(entry, this.previewMode);
		if (!this.previewModal || token !== this.previewRequestId) {
			return;
		}
		this.previewModal.setDiff(diff, this.previewMode);
		this.previewModal.setLoading(false);
	}

	private async getDiffForEntry(
		entry: GitStatusEntry,
		mode: GitPreviewMode,
	): Promise<string> {
		const args =
			mode === "staged"
				? ["diff", "--cached", "--", entry.path]
				: ["diff", "--", entry.path];
		if (mode === "staged" && !entry.stagedCode.trim()) {
			return chalk.dim("No staged changes for this file.");
		}
		const result = await this.runGitAsync(args);
		if (!result.success) {
			return chalk.red(
				result.stderr.trim() || result.stdout.trim() || "Failed to load diff",
			);
		}
		const raw = result.stdout.trim();
		if (!raw) {
			return chalk.dim("(no diff output)");
		}
		const lines = raw.split("\n");
		const limit = 200;
		const slice = lines.slice(0, limit).map((line) => {
			if (line.startsWith("+++") || line.startsWith("---")) {
				return chalk.blue(line);
			}
			if (line.startsWith("@@")) {
				return chalk.cyan(line);
			}
			if (line.startsWith("+")) {
				return chalk.green(line);
			}
			if (line.startsWith("-")) {
				return chalk.red(line);
			}
			return line;
		});
		if (lines.length > limit) {
			slice.push(
				chalk.dim(
					`… (+${lines.length - limit} more lines truncated for display)`,
				),
			);
		}
		return slice.join("\n");
	}

	private async stageSelectedEntry(): Promise<void> {
		const entry = this.previewEntries[this.previewSelection];
		if (!entry) {
			return;
		}
		const result = await this.runGitAsync(["add", "--", entry.path]);
		if (!result.success) {
			this.previewModal?.setStatusMessage(
				result.stderr.trim() || "Failed to stage file",
			);
			return;
		}
		this.options.showToast(`Staged ${entry.path}`, "success");
		await this.refreshPreviewEntries(entry.path);
	}

	private async unstageSelectedEntry(): Promise<void> {
		const entry = this.previewEntries[this.previewSelection];
		if (!entry) {
			return;
		}
		let result = await this.runGitAsync([
			"restore",
			"--staged",
			"--",
			entry.path,
		]);
		if (!result.success) {
			result = await this.runGitAsync(["reset", "HEAD", "--", entry.path]);
		}
		if (!result.success) {
			this.previewModal?.setStatusMessage(
				result.stderr.trim() || "Failed to unstage file",
			);
			return;
		}
		this.options.showToast(`Unstaged ${entry.path}`, "info");
		await this.refreshPreviewEntries(entry.path);
	}

	private async togglePreviewMode(): Promise<void> {
		if (!this.previewEntries.length) {
			return;
		}
		this.previewMode = this.previewMode === "worktree" ? "staged" : "worktree";
		await this.loadPreviewDiff(this.previewEntries[this.previewSelection]);
	}

	private async getStatusEntries(): Promise<{
		ok: boolean;
		entries: GitStatusEntry[];
		message: string;
	}> {
		const result = await this.runGitAsync([
			"status",
			"--short",
			"--untracked-files=all",
			"--renames",
		]);
		if (!result.success) {
			return {
				ok: false,
				entries: [],
				message:
					result.stderr.trim() || result.stdout.trim() || "git status failed",
			};
		}
		const entries = this.parseStatusOutput(result.stdout);
		return {
			ok: true,
			entries,
			message: entries.length ? "" : "Working tree clean",
		};
	}

	private parseStatusOutput(output: string): GitStatusEntry[] {
		const lines = output
			.split("\n")
			.map((line) => line.trimEnd())
			.filter((line) => line.length > 0);
		return lines.map((line) => {
			const code = line.slice(0, 2);
			const rest = line.slice(3).trim();
			const renameParts = rest.split(" -> ");
			const displayPath =
				renameParts.length === 2 ? renameParts[1].trim() : rest;
			return {
				path: displayPath,
				displayPath,
				stagedCode: code[0] ?? " ",
				worktreeCode: code[1] ?? " ",
				renamePath:
					renameParts.length === 2 ? renameParts[0].trim() : undefined,
			};
		});
	}

	private async runGitAsync(args: string[]): Promise<{
		success: boolean;
		stdout: string;
		stderr: string;
	}> {
		return await new Promise((resolve) => {
			const child = spawn("git", args, {
				cwd: process.cwd(),
				env: process.env,
			});
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (chunk) => {
				stdout += chunk.toString();
			});
			child.stderr?.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			child.on("close", (code) => {
				resolve({
					success: (code ?? 1) === 0,
					stdout,
					stderr,
				});
			});
			child.on("error", (error) => {
				resolve({
					success: false,
					stdout,
					stderr: error instanceof Error ? error.message : String(error ?? ""),
				});
			});
		});
	}

	getReviewContext(): {
		ok: boolean;
		status: string;
		diffStat: string;
		stagedDiff: string;
		worktreeDiff: string;
		cwd: string;
		error?: string;
	} {
		const cwd = process.cwd();
		const statusResult = this.runGitCommand(["status", "-sb"]);
		if (!statusResult.ok) {
			const error =
				statusResult.stderr.trim() ||
				statusResult.stdout.trim() ||
				"git status failed";
			return {
				ok: false,
				status: "",
				diffStat: "",
				stagedDiff: "",
				worktreeDiff: "",
				cwd,
				error,
			};
		}

		const diffStatResult = this.runGitCommand(["diff", "--stat"]);
		const stagedDiffResult = this.runGitCommand([
			"diff",
			"--cached",
			"--unified=5",
		]);
		const worktreeDiffResult = this.runGitCommand(["diff", "--unified=5"]);

		const errors: string[] = [];
		const normalize = (
			label: string,
			result: { ok: boolean; stdout: string; stderr: string },
		) => {
			if (result.ok) {
				return result.stdout.trim();
			}
			const msg = (result.stderr || result.stdout || "").trim();
			errors.push(msg ? `${label}: ${msg}` : `${label}: (no output)`);
			return "";
		};

		const status = statusResult.stdout.trim();
		const diffStat = normalize("git diff --stat", diffStatResult);
		const stagedDiff = normalize(
			"git diff --cached --unified=5",
			stagedDiffResult,
		);
		const worktreeDiff = normalize("git diff --unified=5", worktreeDiffResult);

		if (errors.length > 0) {
			return {
				ok: false,
				status,
				diffStat,
				stagedDiff,
				worktreeDiff,
				cwd,
				error: errors.join("; "),
			};
		}

		return {
			ok: true,
			status,
			diffStat,
			stagedDiff,
			worktreeDiff,
			cwd,
		};
	}

	handleUndoCommand(text: string): void {
		const parts = text.trim().split(/\s+/);
		if (parts.length < 2) {
			this.options.showInfoMessage("Usage: /undo <file> [more files]");
			return;
		}
		const targets = parts
			.slice(1)
			.filter(Boolean)
			.filter((path) => this.isSafePath(path));
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
				this.lastTodoFingerprint = "";
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
Use /diff <file> to inspect diffs.`;
			this.options.showToast(message, "info");
			this.maybeSuggestPlanUpdates();
		} catch {
			// ignore git errors
		}
	}

	private maybeSuggestPlanUpdates(): void {
		const hints = this.findTodoHints();
		if (!hints.length) {
			this.lastTodoFingerprint = "";
			return;
		}
		const fingerprint = hints.join("|");
		if (fingerprint === this.lastTodoFingerprint) {
			return;
		}
		this.lastTodoFingerprint = fingerprint;
		const preview = hints
			.slice(0, 3)
			.map((line) => `- ${line}`)
			.join("\n");
		const suffix =
			hints.length > 3
				? `\n… plus ${hints.length - 3} more TODO${hints.length - 3 === 1 ? "" : "s"}`
				: "";
		this.options.showToast(
			`TODO updates detected:\n${preview}${suffix}\nUse /plan add <goal> :: <task> to track follow-ups.`,
			"info",
		);
	}

	private findTodoHints(): string[] {
		const diff = this.runGitCommand(["diff", "--unified=0"]);
		if (!diff.ok || !diff.stdout) {
			return [];
		}
		const lines = diff.stdout.split("\n");
		const hints: string[] = [];
		let currentFile = "";
		for (const line of lines) {
			if (line.startsWith("+++ b/")) {
				currentFile = line.slice(6).trim();
				continue;
			}
			if (!currentFile) {
				continue;
			}
			if (line.startsWith("+")) {
				const content = line.slice(1);
				if (/TODO|FIXME|BUG:?/i.test(content)) {
					const snippet = content.trim().slice(0, 120);
					hints.push(`${currentFile}: ${snippet}`);
				}
			}
		}
		return hints;
	}

	protected runGitCommand(args: string[]): {
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

	getWorkingTreeState(): { branch?: string; dirty: boolean } | undefined {
		const status = this.runGitCommand(["status", "-sb"]);
		if (!status.ok) {
			return undefined;
		}
		const lines = status.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		if (lines.length === 0) {
			return { dirty: false };
		}
		const branch = lines[0]?.startsWith("##")
			? lines[0].slice(2).trim()
			: undefined;
		const dirty = lines.length > 1;
		return { branch, dirty };
	}

	getCurrentCommit(): string | undefined {
		const result = this.runGitCommand(["rev-parse", "--short", "HEAD"]);
		if (!result.ok) {
			return undefined;
		}
		const value = result.stdout.trim();
		return value.length > 0 ? value : undefined;
	}

	private isSafePath(path: string): boolean {
		if (!path.trim()) return false;
		if (path.startsWith("/") || path.startsWith("~")) return false;
		// Normalize to catch traversal segments
		const normalized = normalize(path);
		if (normalized.startsWith("..")) return false;
		const resolved = resolve(process.cwd(), path);
		return resolved.startsWith(process.cwd());
	}
}
