import chalk from "chalk";
import type { TUI } from "../tui.js";
import { Text } from "./text.js";

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

	constructor(ui: TUI, message = "Loading...") {
		super("", 1, 0);
		this.message = message;
		this.ui = ui;
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
		const accent = chalk.hex("#f1c0e8");
		const secondary = chalk.hex("#94a3b8");
		const highlightedFirst = accent(first ?? "");
		return rest.length
			? `${highlightedFirst} ${secondary(rest.join(" "))}`
			: highlightedFirst;
	}

	private formatStepInfo(): string {
		if (!this.stageInfo) return "";
		const { step, total } = this.stageInfo;
		const safeStep = Math.max(1, Math.min(step, total));
		return chalk.gray(`· step ${safeStep}/${total}`);
	}

	private formatHint(): string {
		if (!this.hint) return "";
		return chalk.gray(this.hint);
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

		const baseColor = "#475569";
		const accentColor = "#c4b5fd";
		const dots = this.progressDots.map((dotIndex) => {
			const isActive =
				(this.progressOffset + dotIndex) % this.progressDots.length === 0;
			return isActive ? chalk.hex(accentColor)("●") : chalk.hex(baseColor)("●");
		});
		return `${chalk.gray("·· ")}${dots.join(" ")}${chalk.gray(" ··")}`;
	}

	private updateDisplay(): void {
		const spinner = this.spinnerFrames[this.progressOffset];
		const spinnerGlyph = chalk.hex(spinner.color)(spinner.glyph);
		const titlePart = this.title
			? `${chalk.hex("#b3b8ff")(this.title.toUpperCase())} `
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
