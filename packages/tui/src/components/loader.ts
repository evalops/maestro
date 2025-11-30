import chalk from "chalk";
import type { TUI } from "../tui.js";
import { Text } from "./text.js";

type LoaderMode = "default" | "compact";

interface LoaderOptions {
	mode?: LoaderMode;
	lowColor?: boolean;
	lowUnicode?: boolean;
}

/**
 * Loader component that shows a two-line animation with spinner and progress pulse
 */
export class Loader extends Text {
	private message: string;
	private spinnerFrames = [
		{ glyph: "●", color: "#a5b4fc" },
		{ glyph: "●", color: "#c4b5fd" },
		{ glyph: "●", color: "#f1c0e8" },
		{ glyph: "●", color: "#c4b5fd" },
	];
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
	private currentStage: string;

	constructor(ui: TUI, message = "Loading...", options: LoaderOptions = {}) {
		super("", 1, 0);
		this.message = message;
		this.ui = ui;
		this.mode = options.mode ?? "default";
		this.lowColor = Boolean(options.lowColor);
		this.lowUnicode = Boolean(options.lowUnicode);
		this.currentStage = message;
		this.start();
	}

	render(width: number): string[] {
		return ["", ...super.render(width)];
	}

	start(): void {
		this.updateDisplay();
		this.intervalId = setInterval(() => {
			this.progressOffset =
				(this.progressOffset + 1) % this.progressDots.length;
			this.updateDisplay();
		}, 150);
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
		this.currentStage = label;
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
		const accent = this.lowColor ? (s: string) => s : chalk.hex("#f1c0e8");
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
			const accentColors = ["#94a3b8", "#a5b4fc", "#c4b5fd"];
			const blocks: string[] = [];
			for (let i = 0; i < this.segments; i++) {
				const color = accentColors[i % accentColors.length];
				const char = i < filledUnits ? "━" : "─";
				const tint = i < filledUnits ? color : "#475569";
				blocks.push(chalk.hex(tint)(char));
			}
			const percentText = `${Math.round(this.progressPercent * 100)}%`.padStart(
				4,
				" ",
			);
			return `${chalk.gray("⟪")}${blocks.join("")}${chalk.gray("⟫")} ${chalk.gray(percentText)}`;
		}

		const baseColor = this.lowColor ? undefined : "#475569";
		const accentColor = this.lowColor ? undefined : "#c4b5fd";
		const glyph = this.lowUnicode ? "*" : "●";
		const dots = this.progressDots.map((dotIndex) => {
			const isActive =
				(this.progressOffset + dotIndex) % this.progressDots.length === 0;
			if (this.lowColor) return isActive ? glyph : glyph.toLowerCase();
			return isActive
				? chalk.hex(accentColor ?? "")(glyph)
				: chalk.hex(baseColor ?? "")(glyph);
		});
		const gray = this.lowColor ? (s: string) => s : chalk.gray;
		let line = `${gray("·· ")}${dots.join(" ")}${gray(" ··")}`;
		line = this.applyShimmerIfThinking(line);
		return line;
	}

	private formatCompactStage(): string {
		const trimmed = this.message.trim();
		if (!trimmed) return "";
		return chalk.hex("#f1c0e8")(trimmed.toUpperCase());
	}

	private formatCompactStepInfo(): string {
		if (!this.stageInfo) return "";
		const { step, total } = this.stageInfo;
		const safeStep = Math.max(1, Math.min(step, total));
		return chalk.hex("#94a3b8")(`step ${safeStep}/${total}`);
	}

	private buildCompactProgressLine(): string {
		if (this.progressPercent === null) {
			return "";
		}
		const filledUnits = Math.round(this.progressPercent * this.compactSegments);
		const parts: string[] = [];
		for (let index = 0; index < this.compactSegments; index++) {
			const color = index < filledUnits ? "#f1c0e8" : "#334155";
			const glyph = index < filledUnits ? "━" : "─";
			parts.push(chalk.hex(color)(glyph));
		}
		const percent = `${Math.round(this.progressPercent * 100)}%`.padStart(
			4,
			" ",
		);
		return `${chalk.gray("progress")} ${parts.join("")}${chalk.gray(` ${percent}`)}`;
	}

	private applyShimmerIfThinking(text: string): string {
		if (!text) return text;
		const normalized = this.currentStage.trim().toLowerCase();
		if (!normalized.startsWith("thinking")) {
			return text;
		}
		// Lightweight shimmer: cycle highlight across characters.
		const base = "#cbd5f5";
		const highlight = "#ffffff";
		const band = 6;
		let out = "";
		for (let i = 0; i < text.length; i++) {
			const char = text[i] ?? "";
			if (char === " ") {
				out += char;
				continue;
			}
			const phase = (this.progressOffset + i) % band;
			const color = phase <= 2 ? highlight : base;
			out += this.lowColor ? char : chalk.hex(color)(char);
		}
		return out;
	}

	private renderCompact(): void {
		const primaryParts = [
			this.formatCompactStage(),
			this.formatCompactStepInfo(),
		].filter((part): part is string => Boolean(part));
		const lineOne = primaryParts.join(chalk.gray("  ")).trim();
		const lineTwo = this.applyShimmerIfThinking(
			this.buildCompactProgressLine(),
		);
		const secondaryLine = lineTwo || "";
		this.setText(`${lineOne}
${secondaryLine}`);
		if (this.ui) {
			this.ui.requestRender();
		}
	}

	private updateDisplay(): void {
		if (this.mode === "compact") {
			this.renderCompact();
			return;
		}
		const spinner = this.spinnerFrames[this.progressOffset];
		const glyph = this.lowUnicode ? "*" : spinner.glyph;
		const spinnerGlyph = this.lowColor
			? glyph
			: chalk.hex(spinner.color)(glyph);
		const titlePart = this.title
			? `${(this.lowColor ? (s: string) => s : chalk.hex("#b3b8ff"))(
					this.title.toUpperCase(),
				)} `
			: "";
		const parts = [
			titlePart ? titlePart.trim() : "",
			spinnerGlyph,
			this.applyShimmerIfThinking(this.formatMessage()),
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
