/**
 * @fileoverview Animated Loading Indicator Component
 *
 * This module provides an animated loader with spinner and progress bar
 * for displaying background operation status. It supports multiple visual
 * styles and both determinate and indeterminate progress modes.
 *
 * ## Features
 *
 * - **Multiple Spinner Styles**: braille, dots, pulse, line
 * - **Progress Modes**: Determinate (percentage) or indeterminate
 * - **Stage Tracking**: Show step X of Y
 * - **Hints**: Additional context below the main message
 * - **Accessibility**: Low color and low unicode fallback modes
 *
 * ## Visual Representation
 *
 * Default mode:
 * ```
 * TITLE ⠋ Loading files · step 2/5 (hint text)
 * [━━━━━━────────] 42%
 * ```
 *
 * Compact mode:
 * ```
 * LOADING step 2/5
 * progress ━━━━━━──────── 42%
 * ```
 *
 * @module components/loader
 */

import chalk from "chalk";
import type { TUI } from "../tui.js";
import { Text } from "./text.js";

/** Display mode for the loader */
type LoaderMode = "default" | "compact";

/** Available spinner animation styles */
type SpinnerStyle = "braille" | "dots" | "pulse" | "line";

/** Spinner frame definitions */
const SPINNERS: Record<
	SpinnerStyle,
	Array<{ glyph: string; color: string }>
> = {
	braille: [
		{ glyph: "⠋", color: "#7dd3fc" },
		{ glyph: "⠙", color: "#7dd3fc" },
		{ glyph: "⠹", color: "#93c5fd" },
		{ glyph: "⠸", color: "#93c5fd" },
		{ glyph: "⠼", color: "#c4b5fd" },
		{ glyph: "⠴", color: "#c4b5fd" },
		{ glyph: "⠦", color: "#93c5fd" },
		{ glyph: "⠧", color: "#93c5fd" },
		{ glyph: "⠇", color: "#7dd3fc" },
		{ glyph: "⠏", color: "#7dd3fc" },
	],
	dots: [
		{ glyph: "·  ", color: "#7dd3fc" },
		{ glyph: "·· ", color: "#93c5fd" },
		{ glyph: "···", color: "#c4b5fd" },
		{ glyph: " ··", color: "#93c5fd" },
		{ glyph: "  ·", color: "#7dd3fc" },
		{ glyph: "   ", color: "#64748b" },
	],
	pulse: [
		{ glyph: "◆", color: "#7dd3fc" },
		{ glyph: "◇", color: "#64748b" },
		{ glyph: "◇", color: "#64748b" },
		{ glyph: "◇", color: "#64748b" },
	],
	line: [
		{ glyph: "|", color: "#7dd3fc" },
		{ glyph: "/", color: "#93c5fd" },
		{ glyph: "-", color: "#c4b5fd" },
		{ glyph: "\\", color: "#93c5fd" },
	],
};

/** Low-unicode fallback spinners */
const LOW_UNICODE_SPINNERS: Record<SpinnerStyle, string[]> = {
	braille: ["|", "/", "-", "\\"],
	dots: [".", "..", "...", "..", "."],
	pulse: ["*", ".", ".", "."],
	line: ["|", "/", "-", "\\"],
};

/**
 * Configuration options for the Loader component.
 */
interface LoaderOptions {
	/** Display mode - "default" shows full details, "compact" is minimal */
	mode?: LoaderMode;
	/** Use plain colors (no hex colors) for reduced color mode */
	lowColor?: boolean;
	/** Use ASCII-only characters for terminals without Unicode support */
	lowUnicode?: boolean;
	/** Spinner animation style */
	spinner?: SpinnerStyle;
}

/**
 * Animated loading indicator with spinner and progress bar.
 *
 * The Loader extends the Text component to provide animated feedback
 * during long-running operations. It automatically starts animation
 * on construction and should be stopped when no longer needed.
 *
 * ## Modes
 *
 * - **default**: Two-line display with spinner, message, stages, and progress bar
 * - **compact**: Single-line display with minimal information
 *
 * ## Progress
 *
 * The loader supports two progress modes:
 * - **Indeterminate**: Animated dots when no progress percentage is set
 * - **Determinate**: Progress bar when percentage is provided (0.0 to 1.0)
 *
 * @example
 * ```typescript
 * const loader = new Loader(tui, "Loading files...", {
 *   mode: "default",
 *   spinner: "braille"
 * });
 *
 * // Update message
 * loader.setMessage("Processing...");
 *
 * // Show stage progress
 * loader.setStage("Indexing", 2, 5); // Step 2 of 5
 *
 * // Show percentage progress
 * loader.setProgress(0.42); // 42%
 *
 * // Add hint text
 * loader.setHint("This may take a while");
 *
 * // Clean up when done
 * loader.stop();
 * ```
 *
 * @extends Text
 */
export class Loader extends Text {
	/** Current status message */
	private message: string;

	/** Current spinner style */
	private spinnerStyle: SpinnerStyle;

	/** Dot positions for indeterminate progress animation */
	private progressDots = [0, 1, 2];

	/** Current animation frame offset */
	private progressOffset = 0;

	/** Timer for animation loop */
	private intervalId: NodeJS.Timeout | null = null;

	/** TUI instance for triggering re-renders */
	private ui: TUI;

	/** Number of segments in the progress bar */
	private segments = 12;

	/** Current stage information (step X of Y) */
	private stageInfo: { step: number; total: number } | null = null;

	/** Optional hint text shown below the message */
	private hint: string | null = null;

	/** Progress percentage (0.0-1.0) or null for indeterminate */
	private progressPercent: number | null = null;

	/** Optional title shown before the spinner */
	private title: string | null = null;

	/** Display mode */
	private readonly mode: LoaderMode;

	/** Number of segments in compact mode progress bar */
	private readonly compactSegments = 10;

	/** Whether to use reduced colors */
	private readonly lowColor: boolean;

	/** Whether to use ASCII-only characters */
	private readonly lowUnicode: boolean;

	/**
	 * Creates a new Loader instance.
	 *
	 * The loader starts animating immediately upon construction.
	 *
	 * @param ui - TUI instance for triggering re-renders
	 * @param message - Initial status message (default: "Loading...")
	 * @param options - Configuration options
	 */
	constructor(ui: TUI, message = "Loading...", options: LoaderOptions = {}) {
		super("", 1, 0);
		this.message = message;
		this.ui = ui;
		this.mode = options.mode ?? "default";
		this.lowColor = Boolean(options.lowColor);
		this.lowUnicode = Boolean(options.lowUnicode);
		this.spinnerStyle = options.spinner ?? "braille";
		this.start();
	}

	/**
	 * Renders the loader to terminal lines.
	 * Prepends an empty line for visual spacing.
	 *
	 * @param width - Available width for rendering
	 * @returns Array of rendered lines
	 */
	render(width: number): string[] {
		return ["", ...super.render(width)];
	}

	/**
	 * Starts the animation loop.
	 * Called automatically by the constructor.
	 */
	start(): void {
		this.updateDisplay();
		const frames = SPINNERS[this.spinnerStyle];
		this.intervalId = setInterval(() => {
			this.progressOffset = (this.progressOffset + 1) % frames.length;
			this.updateDisplay();
		}, 80); // Faster for smoother braille animation
	}

	/**
	 * Stops the animation loop and cleans up the timer.
	 * Should be called when the loader is no longer needed.
	 */
	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	/**
	 * Updates the status message.
	 * @param message - New message to display
	 */
	setMessage(message: string): void {
		this.message = message;
		this.updateDisplay();
	}

	/**
	 * Sets stage information for multi-step operations.
	 *
	 * @param label - Stage label (replaces message)
	 * @param step - Current step number (1-indexed)
	 * @param total - Total number of steps
	 */
	setStage(label: string, step: number, total: number): void {
		this.message = label;
		this.stageInfo = { step, total };
		this.updateDisplay();
	}

	/**
	 * Sets optional hint text shown in default mode.
	 * @param hint - Hint text, or null to clear
	 */
	setHint(hint: string | null): void {
		this.hint = hint;
		this.updateDisplay();
	}

	/**
	 * Sets the title shown before the spinner.
	 * @param title - Title text, or null to clear
	 */
	setTitle(title: string | null): void {
		this.title = title;
		this.updateDisplay();
	}

	/**
	 * Sets the progress percentage for determinate progress.
	 *
	 * @param percent - Progress value from 0.0 to 1.0, or null for indeterminate
	 */
	setProgress(percent: number | null): void {
		if (percent === null || Number.isNaN(percent)) {
			this.progressPercent = null;
		} else {
			this.progressPercent = Math.max(0, Math.min(1, percent));
		}
		this.updateDisplay();
	}

	private formatMessage(): string {
		const trimmed = this.message.trim();
		if (!trimmed) return "";
		const [first, ...rest] = trimmed.split(/\s+/);
		const accent = this.lowColor ? (s: string) => s : chalk.hex("#7dd3fc");
		const secondary = this.lowColor ? (s: string) => s : chalk.hex("#94a3b8");
		const highlightedFirst = accent(first ?? "");
		return rest.length
			? `${highlightedFirst} ${secondary(rest.join(" "))}`
			: highlightedFirst;
	}

	private formatStepInfo(): string {
		if (!this.stageInfo) return "";
		const { step, total } = this.stageInfo;
		const safeStep = Math.max(1, Math.min(step, total));
		return (this.lowColor ? (s: string) => s : chalk.gray)(
			`· step ${safeStep}/${total}`,
		);
	}

	private formatHint(): string {
		if (this.mode === "compact" || !this.hint) return "";
		return (this.lowColor ? (s: string) => s : chalk.gray)(this.hint);
	}

	private buildProgressLine(): string {
		if (this.progressPercent !== null) {
			const filledUnits = Math.round(this.progressPercent * this.segments);
			const blocks: string[] = [];
			for (let i = 0; i < this.segments; i++) {
				const char = i < filledUnits ? "━" : "─";
				const tint = i < filledUnits ? "#7dd3fc" : "#334155";
				blocks.push(this.lowColor ? char : chalk.hex(tint)(char));
			}
			const percentText = `${Math.round(this.progressPercent * 100)}%`.padStart(
				4,
				" ",
			);
			const gray = this.lowColor ? (s: string) => s : chalk.gray;
			return `${gray("[")}${blocks.join("")}${gray("]")} ${gray(percentText)}`;
		}

		// Indeterminate progress: show animated dots
		const baseColor = this.lowColor ? undefined : "#334155";
		const accentColor = this.lowColor ? undefined : "#7dd3fc";
		const glyph = this.lowUnicode ? "." : "·";
		const dots = this.progressDots.map((dotIndex) => {
			const isActive =
				(this.progressOffset + dotIndex) % this.progressDots.length === 0;
			if (this.lowColor) return isActive ? glyph.toUpperCase() : glyph;
			return isActive
				? chalk.hex(accentColor ?? "")(glyph)
				: chalk.hex(baseColor ?? "")(glyph);
		});
		const gray = this.lowColor ? (s: string) => s : chalk.gray;
		return `${gray("")}${dots.join(" ")}${gray("")}`;
	}

	private formatCompactStage(): string {
		const trimmed = this.message.trim();
		if (!trimmed) return "";
		return (this.lowColor ? (s: string) => s : chalk.hex("#7dd3fc"))(
			trimmed.toUpperCase(),
		);
	}

	private formatCompactStepInfo(): string {
		if (!this.stageInfo) return "";
		const { step, total } = this.stageInfo;
		const safeStep = Math.max(1, Math.min(step, total));
		return (this.lowColor ? (s: string) => s : chalk.hex("#94a3b8"))(
			`step ${safeStep}/${total}`,
		);
	}

	private buildCompactProgressLine(): string {
		if (this.progressPercent === null) {
			return "";
		}
		const filledUnits = Math.round(this.progressPercent * this.compactSegments);
		const parts: string[] = [];
		for (let index = 0; index < this.compactSegments; index++) {
			const color = index < filledUnits ? "#7dd3fc" : "#334155";
			const glyph = index < filledUnits ? "━" : "─";
			parts.push(this.lowColor ? glyph : chalk.hex(color)(glyph));
		}
		const percent = `${Math.round(this.progressPercent * 100)}%`.padStart(
			4,
			" ",
		);
		const gray = this.lowColor ? (s: string) => s : chalk.gray;
		return `${gray("progress")} ${parts.join("")}${gray(` ${percent}`)}`;
	}

	private renderCompact(): void {
		const primaryParts = [
			this.formatCompactStage(),
			this.formatCompactStepInfo(),
		].filter((part): part is string => Boolean(part));
		const lineOne = primaryParts.join(chalk.gray("  ")).trim();
		const lineTwo = this.buildCompactProgressLine();
		const secondaryLine = lineTwo || "";
		this.setText(`${lineOne}
${secondaryLine}`);
		if (this.ui) {
			this.ui.requestRender();
		}
	}

	private getSpinnerFrame(): { glyph: string; color: string } {
		const frames = SPINNERS[this.spinnerStyle];
		const frameIndex = this.progressOffset % frames.length;
		return frames[frameIndex];
	}

	private getLowUnicodeSpinnerFrame(): string {
		const frames = LOW_UNICODE_SPINNERS[this.spinnerStyle];
		const frameIndex = this.progressOffset % frames.length;
		return frames[frameIndex];
	}

	private updateDisplay(): void {
		if (this.mode === "compact") {
			this.renderCompact();
			return;
		}

		const frame = this.getSpinnerFrame();
		const glyph = this.lowUnicode
			? this.getLowUnicodeSpinnerFrame()
			: frame.glyph;
		const spinnerGlyph = this.lowColor ? glyph : chalk.hex(frame.color)(glyph);

		const titlePart = this.title
			? `${(this.lowColor ? (s: string) => s : chalk.hex("#7dd3fc"))(
					this.title.toUpperCase(),
				)} `
			: "";
		const parts = [
			titlePart ? titlePart.trim() : "",
			spinnerGlyph,
			this.formatMessage(),
			this.formatStepInfo(),
			this.formatHint(),
		].filter((part): part is string => Boolean(part));
		const lineOne = parts.join(" ").trim();
		const lineTwo = this.buildProgressLine();
		this.setText(`${lineOne}\n${lineTwo}`);
		if (this.ui) {
			this.ui.requestRender();
		}
	}
}
