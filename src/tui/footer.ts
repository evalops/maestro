import { visibleWidth } from "@evalops/tui";
import chalk from "chalk";
import type { AgentState } from "../agent/types.js";
import { theme } from "../theme/theme.js";
import {
	GitBranchTracker,
	buildBadgeAndPathLine,
	buildSoloStatsLine,
	buildStatsLine,
	calculateFooterStats,
	formatPathWithBranch,
	mergeHints,
} from "./utils/footer-utils.js";
import type {
	FooterHint,
	FooterMode,
	FooterStats,
} from "./utils/footer-utils.js";

// Re-export FooterHint for external use
export type { FooterHint, HintType } from "./utils/footer-utils.js";

interface FooterToast {
	message: string;
	tone: "info" | "warn" | "success" | "danger";
	expiry: number;
}

interface ToastQueueItem extends FooterToast {
	id: number;
}

/**
 * Footer component that shows pwd, token stats, and context usage
 */
export class FooterComponent {
	private state: AgentState;
	private activeStage: string | null = null;
	private hints: FooterHint[] = [];
	private runtimeBadges: string[] = [];
	private mode: FooterMode;
	private activeToast: FooterToast | null = null;
	private toastQueue: ToastQueueItem[] = [];
	private nextToastId = 1;
	private unseenAlertCount = 0;
	private gitBranchTracker: GitBranchTracker;
	private currentBranch: string | null | undefined = undefined;

	constructor(
		state: AgentState,
		mode: FooterMode = "ensemble",
		gitBranchTracker = new GitBranchTracker(),
	) {
		this.state = state;
		this.mode = mode;
		this.gitBranchTracker = gitBranchTracker;
	}

	updateState(state: AgentState): void {
		this.state = state;
	}

	setRuntimeBadges(badges: string[]): void {
		this.runtimeBadges = badges;
	}

	setStage(stage: string | null): void {
		this.activeStage = stage;
	}

	setHint(hint: string | null): void {
		// Legacy method - convert single hint to hints array
		if (hint) {
			this.hints = [{ type: "custom", message: hint, priority: 150 }];
		} else {
			this.hints = [];
		}
	}

	setHints(hints: FooterHint[]): void {
		this.hints = hints;
	}

	addHint(hint: FooterHint): void {
		this.hints.push(hint);
	}

	clearHints(): void {
		this.hints = [];
	}

	setToast(
		message: string,
		tone: "info" | "warn" | "success" | "danger",
		durationMs?: number,
	): void {
		const toast: ToastQueueItem = {
			id: this.nextToastId++,
			message,
			tone,
			expiry: Date.now() + this.resolveToastDuration(tone, durationMs),
		};
		this.enqueueToast(toast);
		this.dequeueToast();
		if (tone === "danger" || tone === "warn") {
			this.unseenAlertCount += 1;
		}
	}

	private resolveToastDuration(
		tone: "info" | "warn" | "success" | "danger",
		override?: number,
	): number {
		if (override && override > 0) return override;
		switch (tone) {
			case "danger":
				return 8000;
			case "warn":
				return 6000;
			case "success":
				return 4500;
			default:
				return 4000;
		}
	}

	clearToast(): void {
		this.activeToast = null;
		this.toastQueue = [];
		this.unseenAlertCount = 0;
	}

	getToastHistory(limit = 5): FooterToast[] {
		const active = this.activeToast ? [this.activeToast] : [];
		return [...active, ...this.toastQueue].slice(0, limit);
	}

	getUnseenAlertCount(): number {
		return this.unseenAlertCount;
	}

	clearAlertCount(): void {
		this.unseenAlertCount = 0;
	}

	getActiveToast(): FooterToast | null {
		return this.activeToast;
	}

	private enqueueToast(toast: ToastQueueItem): void {
		const priority = this.toastPriority(toast.tone);
		let inserted = false;
		for (let i = 0; i < this.toastQueue.length; i++) {
			if (priority > this.toastPriority(this.toastQueue[i].tone)) {
				this.toastQueue.splice(i, 0, toast);
				inserted = true;
				break;
			}
		}
		if (!inserted) {
			this.toastQueue.push(toast);
		}
	}

	private dequeueToast(): void {
		if (this.activeToast) return;
		const next = this.toastQueue.shift();
		if (next) {
			this.activeToast = next;
		}
	}

	private toastPriority(tone: FooterToast["tone"]): number {
		switch (tone) {
			case "danger":
				return 4;
			case "warn":
				return 3;
			case "success":
				return 2;
			default:
				return 1;
		}
	}

	/**
	 * Begin watching for git branch changes and invoke a callback when the
	 * branch changes so the UI can re-render.
	 */
	startBranchTracking(onBranchChange?: () => void): void {
		this.currentBranch = this.gitBranchTracker.getCurrentBranch();
		this.gitBranchTracker.watchBranch(() => {
			this.gitBranchTracker.invalidate();
			this.currentBranch = this.gitBranchTracker.getCurrentBranch();
			onBranchChange?.();
		});
	}

	dispose(): void {
		this.gitBranchTracker.dispose();
	}

	setMode(mode: FooterMode): void {
		this.mode = mode;
	}

	getMode(): FooterMode {
		return this.mode;
	}

	render(width: number): string[] {
		// Refresh branch cache if needed
		if (this.currentBranch === undefined) {
			this.currentBranch = this.gitBranchTracker.getCurrentBranch();
		}
		const branch = this.currentBranch ?? null;

		// Check for expired toast
		if (this.activeToast && Date.now() > this.activeToast.expiry) {
			this.activeToast = null;
		}

		const stats = calculateFooterStats(this.state);
		if (this.mode === "solo") {
			return this.renderSoloFooter(stats, width);
		}

		// Use new 3-zone layout
		const pathLine = buildBadgeAndPathLine(
			process.cwd(),
			this.activeStage,
			this.runtimeBadges,
			width,
			branch,
		);
		const statsLine = buildStatsLine(stats, width, this.state);

		const lines = [pathLine, chalk.gray(statsLine)];

		// Render Toast if active, otherwise Hints
		if (this.activeToast) {
			const { message, tone } = this.activeToast;
			let coloredMessage: string;
			let prefix = "";

			switch (tone) {
				case "info":
					prefix = theme.fg("accent", "ℹ ");
					coloredMessage = theme.fg("text", message);
					break;
				case "warn":
					prefix = theme.fg("warning", "⚠ ");
					coloredMessage = theme.fg("warning", message);
					break;
				case "success":
					prefix = theme.fg("success", "✔ ");
					coloredMessage = theme.fg("success", message);
					break;
				case "danger":
					prefix = theme.fg("error", "✖ ");
					coloredMessage = theme.fg("error", message);
					break;
			}

			const fullMessage = `${prefix}${coloredMessage}`;
			lines.push(this.truncateToWidth(fullMessage, width));
		} else {
			// Use new multi-hint system
			const mergedHint = mergeHints(stats, this.hints, width);
			if (mergedHint) {
				const truncated = this.truncateToWidth(mergedHint, width);
				lines.push(chalk.hex("#94a3b8")(truncated));
			}
		}

		return lines;
	}

	private truncateToWidth(text: string, width: number): string {
		if (width <= 0) return "";
		if (visibleWidth(text) <= width) return text;
		if (width === 1) return text.slice(0, 1);
		let result = text;
		while (visibleWidth(result) > width - 1 && result.length > 0) {
			result = result.slice(0, -1);
		}
		return `${result.trimEnd()}…`;
	}

	private renderSoloFooter(stats: FooterStats, width: number): string[] {
		const branch = this.currentBranch ?? null;
		const pathLine = chalk.gray(
			formatPathWithBranch(process.cwd(), width, branch),
		);
		const statsLine = buildSoloStatsLine(stats, width, this.state);
		return [pathLine, chalk.gray(statsLine)];
	}
}
