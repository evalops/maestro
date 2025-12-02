import chalk from "chalk";
import type { TUI } from "../tui.js";
import { Text } from "./text.js";

type LoaderMode = "default" | "compact";
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

interface LoaderOptions {
	mode?: LoaderMode;
	lowColor?: boolean;
	lowUnicode?: boolean;
	spinner?: SpinnerStyle;
}

/**
 * Loader component that shows a two-line animation with spinner and progress pulse
 */
export class Loader extends Text {
	private message: string;
	private spinnerStyle: SpinnerStyle;
	private progressDots = [0, 1, 2];
	private progressOffset = 0;
	private intervalId: NodeJS.Timeout | null = null;
	private ui: TUI;
	private segments = 12;
	private stageInfo: { step: number; total: number } | null = null;
	private hint: string | null = null;
	private progressPercent: number | null = null;
	private title: string | null = null;
	private readonly mode: LoaderMode;
	private readonly compactSegments = 10;
	private readonly lowColor: boolean;
	private readonly lowUnicode: boolean;

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

	render(width: number): string[] {
		return ["", ...super.render(width)];
	}

	start(): void {
		this.updateDisplay();
		const frames = SPINNERS[this.spinnerStyle];
		this.intervalId = setInterval(() => {
			this.progressOffset = (this.progressOffset + 1) % frames.length;
			this.updateDisplay();
		}, 80); // Faster for smoother braille animation
	}

	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	setMessage(message: string): void {
		this.message = message;
		this.updateDisplay();
	}

	setStage(label: string, step: number, total: number): void {
		this.message = label;
		this.stageInfo = { step, total };
		this.updateDisplay();
	}

	setHint(hint: string | null): void {
		this.hint = hint;
		this.updateDisplay();
	}

	setTitle(title: string | null): void {
		this.title = title;
		this.updateDisplay();
	}

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
