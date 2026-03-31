/**
 * WelcomeAnimation - Claude Code-inspired animated welcome screen
 *
 * Features:
 * - Shimmer animation on brand wordmark
 * - Model info display
 * - Keyboard shortcut hints
 *
 * Design: "Precision Brutalism" - clean typography, purposeful animation
 */

import { Container, Text, visibleWidth } from "@evalops/tui";
import { theme } from "../theme/theme.js";
import { getQueuedFollowUpEditBindingLabel } from "./queue/queued-follow-up-edit-binding.js";
import { PANEL_WIDTHS } from "./utils/layout.js";
import { shimmerText } from "./utils/shimmer.js";

// ── Constants ────────────────────────────────────────────────────────────────

const WORDMARK = "◆  c o m p o s e r";
const TAGLINE = "deterministic coding agent";
const CANVAS_WIDTH = PANEL_WIDTHS.welcome;

/** Keyboard shortcuts - Claude Code style */
function getShortcuts() {
	return [
		{ key: "Enter", desc: "send/steer" },
		{ key: "Tab", desc: "send/queue" },
		{ key: getQueuedFollowUpEditBindingLabel(), desc: "edit queue" },
		{ key: "/help", desc: "commands" },
	] as const;
}

// ── WelcomeAnimation Component ───────────────────────────────────────────────

export class WelcomeAnimation extends Container {
	private intervalId: NodeJS.Timeout | null = null;
	private readonly textComponent: Text;
	private readonly onRenderRequest?: () => void;
	private modelName = "";
	private readonly animate: boolean;

	constructor(
		onRenderRequest?: () => void,
		options: { animate?: boolean } = {},
	) {
		super();
		this.onRenderRequest = onRenderRequest;
		this.animate = options.animate ?? true;
		this.textComponent = new Text("", 0, 0);
		this.addChild(this.textComponent);
		this.updateFrame();
		if (this.animate) {
			this.startAnimation();
		}
	}

	private startAnimation(): void {
		this.intervalId = setInterval(() => {
			this.updateFrame();
			this.onRenderRequest?.();
		}, 120);
	}

	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	setModelName(modelName: string): void {
		this.modelName = modelName;
	}

	private updateFrame(): void {
		const nowSeconds = Date.now() / 1000;

		// Shimmer on wordmark
		const title = shimmerText(WORDMARK, {
			padding: 4,
			bandWidth: 3,
			sweepSeconds: 2.4,
			intensityScale: 0.85,
			baseColor: "#c084fc",
			highlightColor: "#f5d0fe",
			time: nowSeconds,
		});

		// Subtle shimmer on tagline
		const subline = shimmerText(TAGLINE, {
			padding: 2,
			bandWidth: 2.5,
			sweepSeconds: 3.5,
			intensityScale: 0.5,
			baseColor: "#64748b",
			highlightColor: "#94a3b8",
			time: nowSeconds + 0.4,
			bold: false,
		});

		// Model status
		const modelStatus = this.modelName
			? theme.fg("dim", `model: ${this.modelName}`)
			: "";

		// Shortcuts line - Claude Code style
		const shortcutsLine = this.buildShortcutsLine();

		const lines = [
			"",
			centerLine(title),
			"",
			centerLine(subline),
			"",
			modelStatus ? centerLine(modelStatus) : "",
			"",
			centerLine(shortcutsLine),
			"",
		].filter((line) => line !== undefined);

		this.textComponent.setText(lines.join("\n"));
	}

	private buildShortcutsLine(): string {
		const parts = getShortcuts().map(({ key, desc }) => {
			const keyPart = theme.fg("muted", key);
			const descPart = theme.fg("dim", desc);
			return `${keyPart}${theme.fg("borderMuted", ":")}${descPart}`;
		});
		return parts.join(theme.fg("borderMuted", "  │  "));
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function centerLine(text: string): string {
	const width = visibleWidth(text);
	const padding = Math.max(0, Math.floor((CANVAS_WIDTH - width) / 2));
	return `${" ".repeat(padding)}${text}`;
}
