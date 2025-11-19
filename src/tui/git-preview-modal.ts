import type { Component } from "@evalops/tui";
import chalk from "chalk";

export type GitPreviewMode = "worktree" | "staged";

export interface GitStatusEntry {
	path: string;
	displayPath: string;
	stagedCode: string;
	worktreeCode: string;
	renamePath?: string;
}

interface GitPreviewModalOptions {
	onClose: () => void;
	onNavigate: (delta: number) => void;
	onStage: () => void;
	onUnstage: () => void;
	onRefresh: () => void;
	onToggleMode: () => void;
}

export class GitPreviewModal implements Component {
	private entries: GitStatusEntry[] = [];
	private selectedIndex = 0;
	private diffContent: string = chalk.dim("Select a file to see the diff");
	private statusMessage: string | null = null;
	private loading = false;
	private mode: GitPreviewMode = "worktree";

	constructor(private readonly options: GitPreviewModalOptions) {}

	setEntries(entries: GitStatusEntry[], selectedIndex: number): void {
		this.entries = entries;
		this.selectedIndex = selectedIndex;
	}

	setDiff(content: string, mode: GitPreviewMode): void {
		this.diffContent = content;
		this.mode = mode;
		this.loading = false;
	}

	setStatusMessage(message: string | null): void {
		this.statusMessage = message;
	}

	setLoading(value: boolean): void {
		this.loading = value;
	}

	getSelectedEntry(): GitStatusEntry | undefined {
		return this.entries[this.selectedIndex];
	}

	getMode(): GitPreviewMode {
		return this.mode;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		lines.push(chalk.bold("Git Changes"));
		const modeLabel =
			this.mode === "staged"
				? chalk.green("Showing staged diff (enter to switch)")
				: chalk.yellow("Showing worktree diff (enter to switch)");
		lines.push(modeLabel);
		if (this.statusMessage) {
			lines.push(chalk.hex("#fbbf24")(this.statusMessage));
		}
		if (this.loading) {
			lines.push(chalk.dim("Loading…"));
		}
		lines.push("");
		lines.push(chalk.bold("Files"));
		const fileLines = this.renderFileList(width);
		lines.push(...fileLines);
		lines.push("");
		lines.push(chalk.bold("Diff"));
		lines.push(...this.renderDiff(width));
		lines.push("");
		lines.push(
			chalk.dim(
				"[↑/↓] select  [enter] toggle staged/worktree  [s] stage  [u] unstage  [r] refresh  [esc] close",
			),
		);
		return lines;
	}

	handleInput(data: string): void {
		if (data === "\x1b") {
			this.options.onClose();
			return;
		}
		if (data === "\x1b[A") {
			this.options.onNavigate(-1);
			return;
		}
		if (data === "\x1b[B") {
			this.options.onNavigate(1);
			return;
		}
		if (data === "s" || data === "S") {
			this.options.onStage();
			return;
		}
		if (data === "u" || data === "U") {
			this.options.onUnstage();
			return;
		}
		if (data === "r" || data === "R") {
			this.options.onRefresh();
			return;
		}
		if (data === "\r" || data === "\n") {
			this.options.onToggleMode();
		}
	}

	private renderFileList(width: number): string[] {
		if (!this.entries.length) {
			return [chalk.dim("No tracked changes.")];
		}
		const maxEntries = 12;
		const start = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(maxEntries / 2),
				this.entries.length - maxEntries,
			),
		);
		const slice = this.entries.slice(start, start + maxEntries);
		return slice.map((entry, idx) => {
			const actualIndex = start + idx;
			const selected = actualIndex === this.selectedIndex;
			const prefix = selected ? chalk.cyan(">") : " ";
			const staged = entry.stagedCode.trim()
				? chalk.green("S")
				: chalk.gray("s");
			const worktree = entry.worktreeCode.trim()
				? chalk.yellow("W")
				: chalk.gray("w");
			const label = `${prefix} [${staged} ${worktree}] ${entry.displayPath}`;
			return label.length > width ? `${label.slice(0, width - 1)}…` : label;
		});
	}

	private renderDiff(width: number): string[] {
		const diffLines = this.diffContent.split("\n");
		if (diffLines.length === 0) {
			return [chalk.dim("(no diff output)")];
		}
		return diffLines.map((line) => {
			if (line.length <= width) return line;
			return `${line.slice(0, Math.max(1, width - 1))}…`;
		});
	}
}
