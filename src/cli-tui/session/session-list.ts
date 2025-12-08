import { Input } from "@evalops/tui";
import type { Component } from "@evalops/tui";
import chalk from "chalk";
import type { SessionItem } from "./session-data-provider.js";

export class SessionList implements Component {
	private filteredSessions: SessionItem[];
	private selectedIndex = 0;
	private readonly searchInput: Input;
	private readonly maxVisible = 5;

	public onSelect?: (sessionPath: string) => void;
	public onCancel?: () => void;

	constructor(private readonly sessions: SessionItem[]) {
		this.filteredSessions = sessions;
		this.searchInput = new Input();
		this.searchInput.onSubmit = () => this.commitSelection();
	}

	render(width: number): string[] {
		const lines: string[] = [];
		lines.push(...this.searchInput.render(width));
		lines.push("");
		if (!this.filteredSessions.length) {
			lines.push(chalk.gray("  No sessions found"));
			return lines;
		}

		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(this.maxVisible / 2),
				this.filteredSessions.length - this.maxVisible,
			),
		);
		const endIndex = Math.min(
			startIndex + this.maxVisible,
			this.filteredSessions.length,
		);

		for (let i = startIndex; i < endIndex; i++) {
			const session = this.filteredSessions[i];
			const isSelected = i === this.selectedIndex;
			const cursor = isSelected ? chalk.blue("› ") : "  ";
			const message = session.firstMessage.replace(/\n/g, " ").trim();
			const truncated = message.substring(0, width - 2);
			lines.push(cursor + (isSelected ? chalk.bold(truncated) : truncated));
			lines.push(
				chalk.dim(
					`  ${this.formatDate(session.modified)} · ${session.messageCount} message${session.messageCount === 1 ? "" : "s"}`,
				),
			);
			lines.push("");
		}

		if (startIndex > 0 || endIndex < this.filteredSessions.length) {
			lines.push(
				chalk.gray(
					`  (${this.selectedIndex + 1}/${this.filteredSessions.length})`,
				),
			);
		}
		return lines;
	}

	handleInput(keyData: string): void {
		if (keyData === "\x1b[A") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			return;
		}
		if (keyData === "\x1b[B") {
			this.selectedIndex = Math.min(
				this.filteredSessions.length - 1,
				this.selectedIndex + 1,
			);
			return;
		}
		if (keyData === "\r") {
			this.commitSelection();
			return;
		}
		if (keyData === "\x1b") {
			this.onCancel?.();
			return;
		}
		if (keyData === "\x03") {
			process.exit(0);
		}
		this.searchInput.handleInput(keyData);
		this.applyFilter(this.searchInput.getValue());
	}

	private commitSelection(): void {
		const selected = this.filteredSessions[this.selectedIndex];
		if (selected) {
			this.onSelect?.(selected.path);
		}
	}

	private applyFilter(query: string): void {
		if (!query.trim()) {
			this.filteredSessions = this.sessions;
		} else {
			const tokens = query
				.toLowerCase()
				.split(/\s+/)
				.filter((t) => t.length);
			this.filteredSessions = this.sessions.filter((session) => {
				const haystack = session.allMessagesText.toLowerCase();
				return tokens.every((token) => haystack.includes(token));
			});
		}
		this.selectedIndex = Math.min(
			this.selectedIndex,
			Math.max(0, this.filteredSessions.length - 1),
		);
	}

	private formatDate(date: Date): string {
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMs / 3600000);
		const diffDays = Math.floor(diffMs / 86400000);
		if (diffMins < 1) return "just now";
		if (diffMins < 60)
			return `${diffMins} minute${diffMins !== 1 ? "s" : ""} ago`;
		if (diffHours < 24)
			return `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`;
		if (diffDays === 1) return "1 day ago";
		if (diffDays < 7) return `${diffDays} days ago`;
		return date.toLocaleDateString();
	}
}
