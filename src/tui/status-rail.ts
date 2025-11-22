import type { Component } from "@evalops/tui";
import chalk from "chalk";
import { centerText, padLine, truncateText } from "./utils/text-formatting.js";

export interface Toast {
	id: number;
	message: string;
	tone: "info" | "warn" | "success" | "danger";
	timestamp: number;
	shortcut?: string;
}

export interface StatusRailData {
	toasts: Toast[];
}

/**
 * Status rail component that displays toast notifications in a dedicated panel
 * separate from the chat flow.
 */
export class StatusRailComponent implements Component {
	private data: StatusRailData = {
		toasts: [],
	};
	private maxToasts = 5;
	private toastAutoRemoveMs = 10000; // 10 seconds

	updateData(data: Partial<StatusRailData>): void {
		this.data = { ...this.data, ...data };
		this.cleanupOldToasts();
	}

	addToast(
		message: string,
		tone: "info" | "warn" | "success" | "danger" = "info",
		shortcut?: string,
	): void {
		this.cleanupOldToasts();
		const toast: Toast = {
			id: Date.now(),
			message,
			tone,
			timestamp: Date.now(),
			shortcut,
		};
		this.data.toasts.push(toast);
		if (this.data.toasts.length > this.maxToasts) {
			this.data.toasts.shift(); // Remove oldest
		}
		this.cleanupOldToasts();
	}

	clearToasts(): void {
		this.data.toasts = [];
	}

	hasToasts(): boolean {
		return this.data.toasts.length > 0;
	}

	private cleanupOldToasts(): void {
		const now = Date.now();
		this.data.toasts = this.data.toasts.filter(
			(toast) => now - toast.timestamp < this.toastAutoRemoveMs,
		);
	}

	render(width: number): string[] {
		this.cleanupOldToasts();
		const toasts = this.data.toasts.slice(-this.maxToasts);
		if (toasts.length === 0) {
			return [];
		}

		const lines: string[] = [];
		const borderColor = "#1f2937";
		const innerWidth = Math.max(1, width - 4);
		const emptyRow = `${chalk.hex(borderColor)("│ ")}${" ".repeat(innerWidth)}${chalk.hex(borderColor)(" │")}`;

		// Top border
		lines.push(chalk.hex(borderColor)(`╭${"─".repeat(width - 2)}╮`));

		// Header
		const header = centerText("STATUS", innerWidth);
		lines.push(
			`${chalk.hex(borderColor)("│ ")}${chalk.hex("#94a3b8").bold(header)}${chalk.hex(borderColor)(" │")}`,
		);

		// Separator
		lines.push(chalk.hex(borderColor)(`├${"─".repeat(width - 2)}┤`));

		lines.push(emptyRow);

		// Toasts
		const renderedToasts = toasts.flatMap((toast) => {
			const badge = this.getToneBadge(toast.tone);
			const timestamp = new Intl.DateTimeFormat(undefined, {
				hour: "2-digit",
				minute: "2-digit",
			}).format(new Date(toast.timestamp));
			const header = padLine(
				truncateText(`${badge} ${chalk.dim(timestamp)}`, innerWidth),
				innerWidth,
			);
			const shortcutSuffix = toast.shortcut
				? chalk.dim(` (${toast.shortcut})`)
				: "";
			const body = padLine(
				truncateText(
					chalk.hex("#e2e8f0")(toast.message) + shortcutSuffix,
					innerWidth,
				),
				innerWidth,
			);
			return [header, body];
		});

		for (let i = 0; i < renderedToasts.length; i += 2) {
			const headerLine = renderedToasts[i];
			const bodyLine = renderedToasts[i + 1];
			lines.push(
				`${chalk.hex(borderColor)("│ ")}${headerLine}${chalk.hex(borderColor)(" │")}`,
			);
			lines.push(
				`${chalk.hex(borderColor)("│ ")}${bodyLine}${chalk.hex(borderColor)(" │")}`,
			);
			const isLastToast = i + 2 >= renderedToasts.length;
			if (!isLastToast) {
				lines.push(emptyRow);
			}
		}

		lines.push(emptyRow);

		// Bottom border
		lines.push(chalk.hex(borderColor)(`╰${"─".repeat(width - 2)}╯`));

		return lines;
	}

	private getToneBadge(tone: Toast["tone"]): string {
		switch (tone) {
			case "info":
				return chalk.bgHex("#3b82f6").hex("#f1f5f9")(" Info ");
			case "warn":
				return chalk.bgHex("#f59e0b").hex("#1e293b")(" Warning ");
			case "success":
				return chalk.bgHex("#10b981").hex("#f1f5f9")(" Success ");
			case "danger":
				return chalk.bgHex("#ef4444").hex("#f1f5f9")(" Error ");
		}
	}
}
