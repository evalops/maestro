/**
 * FooterHintsController — Manages footer hint aggregation, startup warnings,
 * and context usage warnings.
 *
 * Owns state: startupWarnings, contextWarningLevel, planHint.
 * TuiRenderer keeps a thin delegate: `public refreshFooterHint() { ... }`
 */

import type { ApprovalMode } from "../../agent/action-approval.js";
import type { ThinkingLevel } from "../../agent/types.js";
import { validateFrameworkPreference } from "../../config/framework.js";
import type { FooterHint, FooterStats } from "../utils/footer-utils.js";
import { formatTokenCount } from "../utils/footer-utils.js";
import { buildRuntimeBadges } from "../utils/runtime-badges.js";

// ─── Callback & Dependency Interfaces ────────────────────────────────────────

export interface FooterHintsControllerCallbacks {
	/** Show a toast notification. */
	showToast: (message: string, tone: "info" | "warn") => void;
	/** Set toast as a warning. */
	setToast: (message: string, tone: "warn") => void;
}

export interface FooterHintsControllerDeps {
	/** Whether the agent is currently running. */
	isAgentRunning: () => boolean;
	/** The idle footer hint string (from config). */
	idleFooterHint: string;
	/** Whether reduced motion is enabled. */
	isReducedMotion: () => boolean;
	/** Whether minimal mode is forced. */
	isMinimalMode: () => boolean;

	// ── Badge data ──
	/** Get sandbox mode string. */
	getSandboxMode: () => string | null;
	/** Whether sandbox is active. */
	isSandboxActive: () => boolean;
	/** Get the current approval mode. */
	getApprovalMode: () => ApprovalMode | null | undefined;
	/** Get queue controller data for badges. */
	getQueueData: () => {
		followUpMode: "all" | "one";
		queuedCount: number;
		hasQueue: boolean;
		queueHint: string | null;
	};
	/** Get the active running-state hint. */
	getRunningHint: () => string | null;
	/** Get the current thinking level. */
	getThinkingLevel: () => ThinkingLevel | null | undefined;
	/** Get unseen alert count. */
	getUnseenAlertCount: () => number;

	// ── Hint sources ──
	/** Get hook status hints. */
	getHookStatusHints: () => FooterHint[];
	/** Get the active toast for alert display. */
	getActiveToast: () => { message: string; tone: string } | null;
	/** Get background task counts. */
	getBackgroundCounts: () => { running: number; failed: number };
	/** Whether history compaction is in progress. */
	isCompacting: () => boolean;
	/** Whether a paste is pending summarization. */
	hasPendingPaste: () => boolean;
	/** Whether bash mode is active. */
	isBashModeActive: () => boolean;

	// ── Footer output ──
	/** Set runtime badges on the footer. */
	setRuntimeBadges: (badges: unknown) => void;
	/** Set hints on the footer. */
	setHints: (hints: FooterHint[]) => void;
}

export interface FooterHintsControllerOptions {
	deps: FooterHintsControllerDeps;
	callbacks: FooterHintsControllerCallbacks;
}

// ─── Controller ──────────────────────────────────────────────────────────────

export class FooterHintsController {
	private readonly deps: FooterHintsControllerDeps;
	private readonly callbacks: FooterHintsControllerCallbacks;
	private startupWarnings: FooterHint[] = [];
	private contextWarningLevel: "none" | "warn" | "danger" = "none";
	planHint: string | null = null;

	constructor(options: FooterHintsControllerOptions) {
		this.deps = options.deps;
		this.callbacks = options.callbacks;
	}

	/** Set the context warning level directly (used by compaction controller). */
	setContextWarningLevel(level: "none" | "warn" | "danger"): void {
		this.contextWarningLevel = level;
	}

	/** Compute and apply footer badges and idle-time hints. */
	refresh(): void {
		const sandboxMode = this.deps.getSandboxMode();
		const sandboxRequested = Boolean(sandboxMode);
		const sandboxActive = this.deps.isSandboxActive();
		const queueData = this.deps.getQueueData();

		this.deps.setRuntimeBadges(
			buildRuntimeBadges({
				approvalMode: this.deps.getApprovalMode(),
				promptQueueMode: queueData.followUpMode,
				queuedPromptCount: queueData.queuedCount,
				hasPromptQueue: queueData.hasQueue,
				thinkingLevel: this.deps.getThinkingLevel(),
				sandboxMode,
				isSafeMode: process.env.MAESTRO_SAFE_MODE === "1",
				sandboxRequestedButMissing: sandboxRequested && !sandboxActive,
				alertCount: this.deps.getUnseenAlertCount(),
				reducedMotion: this.deps.isReducedMotion(),
				compactForced: this.deps.isMinimalMode(),
			}),
		);

		const hints: FooterHint[] = [];
		const pushHint = (
			type: FooterHint["type"],
			message: string,
			priority: number,
		): void => {
			if (message.trim().length === 0) return;
			hints.push({ type, message, priority });
		};

		if (this.deps.isAgentRunning()) {
			const runningHint = this.deps.getRunningHint();
			if (runningHint) {
				pushHint("custom", runningHint, 150);
			}
			this.deps.setHints(hints);
			return;
		}

		if (this.deps.idleFooterHint) {
			pushHint("custom", this.deps.idleFooterHint, 20);
		}
		for (const hint of this.buildOperationalHints()) {
			pushHint("custom", hint, 40);
		}
		for (const hint of this.deps.getHookStatusHints()) {
			hints.push(hint);
		}
		const activeToast = this.deps.getActiveToast();
		if (
			activeToast &&
			(activeToast.tone === "danger" || activeToast.tone === "warn")
		) {
			pushHint("custom", `Alert: ${activeToast.message}`, 160);
		}
		if (this.startupWarnings.length > 0) {
			hints.push(...this.startupWarnings);
		}
		if (this.planHint) {
			pushHint("plan", `Plan ${this.planHint}`, 120);
		}
		const queueHint = queueData.queueHint;
		if (queueHint) {
			pushHint("queue", queueHint, 110);
		}
		this.deps.setHints(hints);
	}

	/** Check for framework preference warnings at startup. */
	surfaceStartupWarnings(): void {
		const warning = validateFrameworkPreference();
		if (!warning) return;
		this.startupWarnings.push({
			type: "custom",
			message: warning,
			priority: 140,
		});
		this.callbacks.setToast(warning, "warn");
	}

	/** Show a context usage warning if thresholds are crossed. */
	maybeShowContextWarning(stats: FooterStats): void {
		if (!stats.contextWindow) {
			this.contextWarningLevel = "none";
			return;
		}
		const percent = stats.contextPercent;
		let nextLevel: "none" | "warn" | "danger" = "none";
		if (percent >= 90) {
			nextLevel = "danger";
		} else if (percent >= 70) {
			nextLevel = "warn";
		}
		if (nextLevel === this.contextWarningLevel) {
			return;
		}
		if (nextLevel === "none") {
			this.contextWarningLevel = "none";
			return;
		}
		const label = `${formatTokenCount(stats.contextTokens)}/${formatTokenCount(
			stats.contextWindow,
		)}`;
		if (nextLevel === "warn") {
			this.callbacks.showToast(
				`Context ${percent.toFixed(1)}% used (${label}). Consider /compact before your next prompt.`,
				"info",
			);
		} else {
			this.callbacks.showToast(
				`Context ${percent.toFixed(1)}% used (${label}). Composer will auto-compact soon.`,
				"warn",
			);
		}
		this.contextWarningLevel = nextLevel;
	}

	// ─── Internal ──────────────────────────────────────────────────────────

	private buildOperationalHints(): string[] {
		const hints: string[] = [];
		const backgroundCounts = this.deps.getBackgroundCounts();
		if (backgroundCounts.running > 0 || backgroundCounts.failed > 0) {
			const runningLabel = `${backgroundCounts.running} background ${backgroundCounts.running === 1 ? "task" : "tasks"} running`;
			const failureSuffix =
				backgroundCounts.failed > 0
					? `; ${backgroundCounts.failed} failed`
					: "";
			hints.push(`${runningLabel}${failureSuffix} (use /background list)`);
		}
		if (this.deps.isCompacting()) {
			hints.push("Compacting history…");
		}
		if (this.deps.hasPendingPaste()) {
			hints.push("Summarizing pasted text…");
		}
		if (this.deps.isBashModeActive()) {
			hints.push("Bash mode active — type exit to leave");
		}
		return hints;
	}
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createFooterHintsController(
	options: FooterHintsControllerOptions,
): FooterHintsController {
	return new FooterHintsController(options);
}
