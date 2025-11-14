import chalk from "chalk";
import type { TUI } from "../tui.js";
import { Text } from "./text.js";

/**
 * Loader component that shows a two-line animation with spinner and progress pulse
 */
export class Loader extends Text {
	private message: string;
	private spinnerFrames = [
		{ glyph: "◴", color: "#f1c0e8" },
		{ glyph: "◷", color: "#d0bfff" },
		{ glyph: "◶", color: "#a5b4fc" },
		{ glyph: "◵", color: "#c4b5fd" },
	];
	private progressWave = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█", "▇", "▆", "▅", "▄", "▃", "▂"];
	private currentFrame = 0;
	private progressOffset = 0;
	private intervalId: NodeJS.Timeout | null = null;
	private ui: TUI;
	private segments = 12;
	private stageInfo: { step: number; total: number } | null = null;
	private hint: string | null = null;
	private progressPercent: number | null = null;
	private title: string | null = null;

	constructor(ui: TUI, message: string = "Loading...") {
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
			this.currentFrame = (this.currentFrame + 1) % this.spinnerFrames.length;
			this.progressOffset = (this.progressOffset + 1) % this.progressWave.length;
			this.updateDisplay();
		}, 80);
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
			const accentColors = ["#a5b4fc", "#c4b5fd", "#f1c0e8"];
			const blocks: string[] = [];
			for (let i = 0; i < this.segments; i++) {
				const color = accentColors[i % accentColors.length];
				const char = i < filledUnits ? "█" : "░";
				const tint = i < filledUnits ? color : "#334155";
				blocks.push(chalk.hex(tint)(char));
			}
			const percentText = `${Math.round(this.progressPercent * 100)}%`.padStart(4, " ");
			return `${chalk.gray("[")}${blocks.join("")}${chalk.gray("]")} ${chalk.gray(percentText)}`;
		}

		const accentColors = ["#f1c0e8", "#d8b4fe", "#a5b4fc"];
		const blocks = [] as string[];
		for (let i = 0; i < this.segments; i++) {
			const waveIndex = (this.progressOffset + i) % this.progressWave.length;
			const char = this.progressWave[waveIndex];
			const color = accentColors[waveIndex % accentColors.length];
			blocks.push(chalk.hex(color)(char));
		}
		return `${chalk.gray("[")}${blocks.join("")}${chalk.gray("]")}`;
	}

	private updateDisplay(): void {
		const spinner = this.spinnerFrames[this.currentFrame];
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
