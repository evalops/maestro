import chalk from "chalk";
import type { Component } from "../tui.js";
import { visibleWidth } from "../utils.js";

type SpinnerFrame = string;

const ASCII_SPINNER: SpinnerFrame[] = ["-", "\\", "|", "/"];
const DOT_SPINNER: SpinnerFrame[] = ["●", "○", "●", "○"];

export interface StatusBarOptions {
	message?: string;
	interruptHint?: string;
	lowColor?: boolean;
	lowUnicode?: boolean;
}

export class StatusBar implements Component {
	private message: string;
	private interruptHint: string;
	private frame = 0;
	private interval: NodeJS.Timeout | null = null;
	private spinner: SpinnerFrame[];
	private lowColor: boolean;
	private lowUnicode: boolean;

	constructor(options: StatusBarOptions = {}) {
		this.message = options.message ?? "Working";
		this.interruptHint = options.interruptHint ?? "Ctrl+C to interrupt";
		this.lowColor = Boolean(options.lowColor);
		this.lowUnicode = Boolean(options.lowUnicode);
		this.spinner = this.lowUnicode ? ASCII_SPINNER : DOT_SPINNER;
		this.interval = setInterval(() => {
			this.frame = (this.frame + 1) % this.spinner.length;
		}, 120);
	}

	setMessage(message: string): void {
		this.message = message;
	}

	stop(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}

	handleInput(): void {
		// Status bar itself is passive
	}

	render(width: number): string[] {
		const spin = this.spinner[this.frame] || "";
		const coloredSpin = this.lowColor ? spin : chalk.hex("#a5b4fc")(spin);
		const hint = this.lowColor
			? this.interruptHint
			: chalk.hex("#94a3b8")(this.interruptHint);
		const msg = this.lowColor
			? this.message
			: chalk.hex("#f1c0e8")(this.message);
		const line = `${coloredSpin} ${msg}  ${hint}`;
		const pad = Math.max(0, width - visibleWidth(line));
		return [line + " ".repeat(pad)];
	}
}
